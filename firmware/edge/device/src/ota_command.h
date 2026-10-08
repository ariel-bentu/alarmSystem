#pragma once

// Pure decision logic for over-the-air firmware updates — no Arduino, no
// flash, no network — so every rule here is native-tested in
// test/test_ota_command. The device-only half (download, flash write,
// rollback bookkeeping) lives in ota_updater.h/.cpp.
//
// The request arrives on /{projectId}/commands/ota, written by the web UI
// from the Firestore `firmware/latest` manifest that
// functions/scripts/publishFirmware.ts publishes:
//
//   { n: <nonce>, version: "2026.10.08-1432-abc1234", path: "firmware/…/firmware.bin",
//     md5: "<32 hex>", size: <bytes>, until: <epoch sec> }
//
// /commands is writable by ANY signed-in user (database.rules.json), so this
// command is not trusted to choose WHAT gets flashed beyond a published
// release: the path must sit under firmware/, which only the admin SDK can
// write (storage.rules), and the image must match the md5 before
// Update.end() will switch the boot partition.

#include <ArduinoJson.h>

#include <cstdint>
#include <cstring>

struct OtaRequest {
  uint32_t nonce = 0;
  uint32_t untilEpochSec = 0;  // 0 = no deadline
  uint32_t size = 0;
  char version[40] = {};
  char path[112] = {};
  char md5[33] = {};
};

// One app slot in default_16MB.csv (app0/app1 are 0x640000 each). An image
// larger than this cannot be written, so reject it before erasing anything.
constexpr uint32_t kOtaMaxImageBytes = 0x640000;

// How long a freshly booted OTA image has to prove itself (cloud reached and
// config received) before it rolls itself back. Generous on purpose: it must
// cover a slow WiFi association plus the mint's retry backoff, and rolling
// back a GOOD image only costs a retry, while keeping a bad one costs a USB
// cable.
constexpr uint32_t kOtaVerifyTimeoutMs = 10UL * 60UL * 1000UL;
// …and must have stayed up at least this long, so an image that reaches the
// cloud and then crashes a few seconds later is not blessed.
constexpr uint32_t kOtaVerifyMinUptimeMs = 60UL * 1000UL;

inline bool otaIsHex32(const char* s) {
  if (std::strlen(s) != 32) return false;
  for (const char* p = s; *p; ++p) {
    const char c = *p;
    const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                     (c >= 'A' && c <= 'F');
    if (!hex) return false;
  }
  return true;
}

// Only characters that survive a URL path segment and an NVS string
// unescaped — the version is both. Matches what fw_version.py generates.
inline bool otaIsSafeVersion(const char* s) {
  if (*s == '\0') return false;
  for (const char* p = s; *p; ++p) {
    const char c = *p;
    const bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
                    (c >= 'A' && c <= 'Z') || c == '.' || c == '-' || c == '_';
    if (!ok) return false;
  }
  return true;
}

// Copy a JSON string field into a fixed buffer. A value that does not fit is
// a malformed request, not one to truncate: a truncated path or md5 would
// fetch or verify against something else.
inline bool otaCopyField(JsonVariantConst v, char* out, size_t cap) {
  if (!v.is<const char*>()) return false;
  const char* s = v.as<const char*>();
  if (s == nullptr || std::strlen(s) >= cap) return false;
  std::strcpy(out, s);
  return true;
}

// Parse /commands/ota. Returns false for anything malformed; the caller
// then ignores the command entirely.
inline bool parseOtaRequest(JsonVariantConst v, OtaRequest* out) {
  if (!v.is<JsonObjectConst>()) return false;
  OtaRequest r;
  if (!v["n"].is<uint32_t>()) return false;
  r.nonce = v["n"].as<uint32_t>();
  if (!v["size"].is<uint32_t>()) return false;
  r.size = v["size"].as<uint32_t>();
  r.untilEpochSec = v["until"].is<uint32_t>() ? v["until"].as<uint32_t>() : 0;
  if (!otaCopyField(v["version"], r.version, sizeof(r.version))) return false;
  if (!otaCopyField(v["path"], r.path, sizeof(r.path))) return false;
  if (!otaCopyField(v["md5"], r.md5, sizeof(r.md5))) return false;
  // Update.end() compares against MD5Builder's lowercase hex with a plain
  // string compare, so an uppercase hash would fail a perfectly good image.
  for (char* p = r.md5; *p; ++p) {
    if (*p >= 'A' && *p <= 'F') *p = (char)(*p - 'A' + 'a');
  }
  *out = r;
  return true;
}

enum class OtaVerdict {
  Accept,
  BadRequest,     // fails validation — wrong prefix, bad md5, oversize, …
  AlreadyHandled, // this nonce was already acted on (persisted across reboots)
  Expired,        // `until` has passed
  SameVersion,    // already running exactly this image
  SirenActive,    // never reboot mid-alarm, nor during a siren hold
  Busy,           // an update is already downloading
};

inline const char* otaVerdictName(OtaVerdict v) {
  switch (v) {
    case OtaVerdict::Accept:         return "accept";
    case OtaVerdict::BadRequest:     return "bad_request";
    case OtaVerdict::AlreadyHandled: return "already_handled";
    case OtaVerdict::Expired:        return "expired";
    case OtaVerdict::SameVersion:    return "same_version";
    case OtaVerdict::SirenActive:    return "siren_active";
    case OtaVerdict::Busy:           return "busy";
  }
  return "unknown";
}

inline bool otaRequestValid(const OtaRequest& r) {
  return std::strncmp(r.path, "firmware/", 9) == 0 &&
         std::strstr(r.path, "..") == nullptr && otaIsHex32(r.md5) &&
         otaIsSafeVersion(r.version) && r.size > 0 &&
         r.size <= kOtaMaxImageBytes;
}

// The ordering matters for what gets REPORTED: an already-handled nonce is
// checked first so a command still sitting in RTDB after the reboot it caused
// is silently ignored rather than re-reported as "same_version".
//
// `lastHandledNonce` is persisted in NVS, which is what stops a rolled-back
// image from seeing the same command and installing the bad build again.
// `nowEpochSec` is only trusted once NTP has synced (> 100000), the same rule
// the pairing command uses.
inline OtaVerdict otaDecide(const OtaRequest& r, bool hasLastHandled,
                            uint32_t lastHandledNonce,
                            const char* runningVersion, uint32_t nowEpochSec,
                            bool sirenBusy, bool updateInProgress) {
  if (hasLastHandled && r.nonce == lastHandledNonce)
    return OtaVerdict::AlreadyHandled;
  if (!otaRequestValid(r)) return OtaVerdict::BadRequest;
  if (r.untilEpochSec != 0 && nowEpochSec > 100000UL &&
      nowEpochSec > r.untilEpochSec)
    return OtaVerdict::Expired;
  if (std::strcmp(r.version, runningVersion) == 0)
    return OtaVerdict::SameVersion;
  if (updateInProgress) return OtaVerdict::Busy;
  if (sirenBusy) return OtaVerdict::SirenActive;
  return OtaVerdict::Accept;
}

// What this boot is, relative to an update that was installed before it.
// `pendingVersion` is the version written to NVS just before the post-install
// restart ("" when no update was in flight).
enum class OtaBootKind {
  Normal,      // no update was pending
  Verifying,   // we ARE the new image; must prove health or roll back
  RolledBack,  // the new image failed and the bootloader brought us back
};

inline OtaBootKind classifyOtaBoot(const char* pendingVersion,
                                   const char* runningVersion) {
  if (pendingVersion == nullptr || pendingVersion[0] == '\0')
    return OtaBootKind::Normal;
  return std::strcmp(pendingVersion, runningVersion) == 0
             ? OtaBootKind::Verifying
             : OtaBootKind::RolledBack;
}

enum class OtaVerifyAction { Wait, MarkValid, RollBack };

// Called every loop while Verifying. Healthy = the cloud is authenticated
// AND has answered with a config: that exercises WiFi, TLS, the mint and
// RTDB, which is everything a remote update could break that would also
// stop the NEXT update from reaching the device.
inline OtaVerifyAction otaVerifyStep(uint32_t uptimeMs, bool healthy) {
  if (healthy && uptimeMs >= kOtaVerifyMinUptimeMs)
    return OtaVerifyAction::MarkValid;
  if (uptimeMs >= kOtaVerifyTimeoutMs) return OtaVerifyAction::RollBack;
  return OtaVerifyAction::Wait;
}
