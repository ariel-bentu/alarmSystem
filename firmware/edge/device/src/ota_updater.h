#pragma once

// Over-the-air firmware update: download from Firebase Storage, write to the
// inactive app slot, and the post-install verify-or-roll-back step.
//
// ESP32-only (Update, Preferences, esp_ota_ops). The decisions — whether to
// accept a command, what a boot means, when to bless or reject a new image —
// are pure and native-tested in ota_command.h; this class only carries them
// out.
//
// THE DOWNLOAD IS INCREMENTAL. start() opens the connection and reads the
// headers (bounded, watchdog-fed); every later loop() calls tick(), which
// moves at most ~kTickBudgetMs of data into flash and returns. RF decode,
// alarm evaluation and the siren keep running throughout, so an update never
// blinds the alarm for the length of a download — only for the reboot at the
// end. Flash erase/write does pause the cache (and so any non-IRAM code) for
// a few ms at a time; Kerui sensors repeat each packet, which covers that.
//
// ROLLBACK: the bootloader is built with CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE,
// and ota_updater.cpp overrides Arduino's weak verifyRollbackLater() to
// return true, so a freshly installed image boots in PENDING_VERIFY and is
// NOT blessed automatically. verifyTick() marks it valid once the cloud has
// been reached (see otaVerifyStep), or reverts to the previous image after
// kOtaVerifyTimeoutMs. A crash or watchdog reset before that reverts too —
// the bootloader does it on the next boot.

#include <Arduino.h>
#include <Preferences.h>
#include <WiFiClientSecure.h>

#include "ota_command.h"

class OtaUpdater {
 public:
  // Read the NVS record and classify this boot. Call once from setup().
  void beginBoot(const char* runningVersion);
  OtaBootKind bootKind() const { return bootKind_; }
  // The version an update was installing ("" if none). For a RolledBack boot
  // this is the image that FAILED — the one worth reporting.
  const char* pendingVersion() const { return pendingVersion_; }

  // Persisted dedupe for /commands/ota — see otaDecide().
  bool hasLastHandledNonce() const { return hasLastNonce_; }
  uint32_t lastHandledNonce() const { return lastNonce_; }
  void markHandled(uint32_t nonce);

  // Forget the pending record once its outcome has been reported.
  void clearPending();

  enum class VerifyResult { NotVerifying, Waiting, MarkedValid };
  // Call every loop. On RollBack this does not return — the board reboots
  // into the previous image, which then reports "rolled_back" itself.
  VerifyResult verifyTick(uint32_t uptimeMs, bool healthy);

  // Open the download and prepare the inactive slot. Blocks for the TLS
  // handshake and the response headers (each bounded, watchdog fed).
  // On failure returns false with a short reason in *err.
  bool start(const OtaRequest& req, const char* bucket, const String& idToken,
             String* err);

  enum class TickResult { Idle, Running, Done, Failed };
  // Move a bounded slice of the image into flash. Done means the image is
  // complete, md5-verified and set as the next boot partition; the caller
  // reports, records the pending version and restarts.
  TickResult tick(String* err);

  bool active() const { return client_ != nullptr; }
  // The new image is written, verified and set to boot, but the restart has
  // not happened yet (the caller defers it while the alarm is busy).
  bool installed() const { return installed_; }
  const char* activeVersion() const { return req_.version; }
  uint8_t progressPct() const {
    return req_.size ? (uint8_t)((uint64_t)received_ * 100 / req_.size) : 0;
  }

  // Record the installed version and restart into it. Does not return.
  [[noreturn]] void restartIntoNewImage();

 private:
  void fail(String* err, const String& why);
  void closeClient();

  static constexpr unsigned long kTickBudgetMs = 40;
  static constexpr unsigned long kStallTimeoutMs = 30000;
  static constexpr unsigned long kHeaderTimeoutMs = 15000;

  Preferences prefs_;
  OtaBootKind bootKind_ = OtaBootKind::Normal;
  bool verifying_ = false;
  char pendingVersion_[sizeof(OtaRequest::version)] = {};
  bool hasLastNonce_ = false;
  uint32_t lastNonce_ = 0;

  WiFiClientSecure* client_ = nullptr;
  OtaRequest req_;
  uint32_t received_ = 0;
  bool installed_ = false;
  unsigned long lastByteMs_ = 0;
  uint8_t buf_[4096];
};
