# Camera Snapshots on Sensor Trigger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a sensor trigger, the ESP32-S3 grabs JPEG stills from the LAN NVR over DVRIP and uploads them to Firebase Storage; a Storage-triggered Cloud Function records them in the timeline and — only for armed triggers of in-sight sensors — runs a swappable vision judge that either advises the device to cancel a false alarm or sends a "confirmed breach" Telegram photo.

**Architecture:** Three layers, matching the project's device/cloud split. The **device** captures + uploads + consumes a false-positive advisory over its existing `/commands` poll — its alarm logic is never gated by or made to wait on the cloud. The **cloud** judges (vision model behind a `SnapshotJudge` interface) and delivers. The **web** app shows photos and exposes the new config. The judge is strictly subtractive: it can cancel a false alarm the device already raised (if the advisory arrives in time) or confirm a breach, but can never raise, prevent, or delay an alarm.

**Tech Stack:** C++ (PlatformIO, ESP32-S3, ArduinoJson, Unity tests) · TypeScript (Cloud Functions gen-2, firebase-admin, vitest) · TypeScript/React (Vite, web) · Firebase Storage + RTDB + Firestore · Anthropic `@anthropic-ai/sdk` (vision).

**Spec:** `docs/superpowers/specs/2026-10-03-camera-snapshots-on-trigger-design.md` — read it alongside this plan. The NVR connection detail (IP / credential) is in the private memory `nvr-icsee-camera-access`, never in tracked files.

## Global Constraints

- **Repo is public** — never commit real IPs, MACs, credentials, or project IDs. NVR connection fields live in Firestore project config (access-controlled); the Anthropic API key is a Functions secret. Spec and code use placeholders only.
- **Device independence is inviolable** (CLAUDE.md Key Decision). Capture/upload run AFTER the `/events` write and siren decision and never block them. The false-positive advisory can only STOP a siren, never start/prevent one. Offline ⇒ no capture, alarm behaves exactly as today.
- **Firmware builds with `pio run -e esp32s3`** (never bare `pio run`). Native tests: `pio test -e native`. A `Config` struct size change REQUIRES bumping `EepromStore::kMagic` and updating the `static_assert(sizeof(Config) == …)` in `alarm_state.h` with a MEASURED value.
- **No new `onSchedule()`** — only 3 scheduled jobs allowed per billing account. Retention is a new ROW in the `doSchedule` table (`functions/src/doSchedule.ts`).
- **Matching is by 20-bit family**, never the 24-bit rfId. Reuse `familyIdOf` / `sensorFamilyId` on the cloud and `SensorConfig::familyId` on the device.
- **Cloud checks:** `cd functions && npx tsc --noEmit && npx vitest run && npm run build`. **Web checks:** `cd web && npm run lint && npm test && npm run build`.
- **Device-facing config is thin + index-based** (`{a,d,e,r,c,m,s}`). New NVR fields follow the same short-key, change-only-surfaces-once discipline (`applyConfigJson`).
- Work happens on branch `feat/camera-snapshots-on-trigger` (already created).

---

## Phase 0 — Storage setup (foundation)

### Task 0: Firebase Storage config + scoped rules

**Files:**
- Modify: `firebase.json` (add `storage` block)
- Create: `storage.rules`
- Modify: `README.md` / `SECURITY.md` (note the new Storage surface + NVR least-trust)

**Interfaces:**
- Produces: a `storage` bucket scoped so a device's minted token may write only under `{projectId}/snapshots/**` and project members may read their project's snapshots. Path convention `{projectId}/snapshots/{rfId}/{timestamp}/ch{N}.jpg`.

- [ ] **Step 1: Add the storage block to `firebase.json`**

Add alongside the existing `firestore` / `database` blocks:

```json
"storage": {
  "rules": "storage.rules"
},
```

- [ ] **Step 2: Write `storage.rules` scoped per project**

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Snapshots live under {projectId}/snapshots/**.
    // Reads: any signed-in member of the project (mirrors database.rules.json
    // scoping — membership is checked via the project's members collection by
    // the app's own queries; Storage rules cannot read Firestore cheaply, so
    // we gate on auth + path shape and rely on the per-project path for
    // isolation, same posture as RTDB config reads).
    // Writes: the device identity (custom-token uid == projectId) only, and
    // only JPEGs under its own project.
    match /{projectId}/snapshots/{allPaths=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
                   && request.auth.uid == projectId
                   && request.resource.contentType == 'image/jpeg'
                   && request.resource.size < 2 * 1024 * 1024;
    }
  }
}
```

- [ ] **Step 3: Verify rules compile via the emulator**

Run: `cd /Users/i022021/dev/alarmSystem && firebase emulators:start --only storage --project alarm-system-100` (Ctrl-C after it reports "Storage Emulator running")
Expected: starts without a rules-compilation error.

- [ ] **Step 4: Add a Known-Issue note to SECURITY.md**

Add a bullet under known issues: the Xiongmai NVR is the least-trusted LAN device (XMEye P2P backdoor history, Mirai lineage); recommend VLAN / blocking its outbound internet. Snapshots are premises images — Storage rules scope them per project.

- [ ] **Step 5: Commit**

```bash
git add firebase.json storage.rules SECURITY.md
git commit -m "feat(storage): add Firebase Storage with per-project snapshot rules"
```

---

## Phase 1 — Firmware: DVRIP protocol (pure, native-tested)

The protocol logic (sofia hash, request framing, response parsing) is pure and
lives in `dvrip_protocol.{h,cpp}` so it is unit-testable natively, exactly like
`siren_address` / `kerui_event`. Socket I/O is a thin wrapper added in Phase 2.

### Task 1: sofia password hash

**Files:**
- Create: `firmware/edge/device/src/dvrip_protocol.h`
- Create: `firmware/edge/device/src/dvrip_protocol.cpp`
- Test: `firmware/edge/device/test/test_dvrip_protocol/test_dvrip_protocol.cpp`

**Interfaces:**
- Produces: `namespace Dvrip { void sofiaHash(const char* password, char out[9]); }` — writes 8 chars + NUL. Charset `0-9A-Za-z`, `out[i] = charset[(md5[2i] + md5[2i+1]) % 62]`.
- Consumes: an MD5 implementation. Add a tiny public-domain MD5 in `dvrip_protocol.cpp` (the device has none exposed); or reuse one already vendored if present — check `.pio/libdeps` for `MD5Builder` (ESP32 core provides `MD5Builder`, but it is not available in the native test env, so the pure code must carry its own MD5).

- [ ] **Step 1: Write the failing test (known vector)**

```cpp
#include <unity.h>
#include "dvrip_protocol.h"
#include <cstring>

void test_sofia_hash_empty_password_vector() {
  char out[9] = {};
  Dvrip::sofiaHash("", out);
  // Documented Xiongmai vector: "" -> "tlJwpbo6"
  TEST_ASSERT_EQUAL_STRING("tlJwpbo6", out);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_sofia_hash_empty_password_vector);
  UNITY_END();
}
void loop() {}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd firmware/edge/device && pio test -e native -f test_dvrip_protocol`
Expected: FAIL (link error / header not found).

- [ ] **Step 3: Implement `sofiaHash` with a bundled MD5**

In `dvrip_protocol.h`:

```cpp
#pragma once
#include <cstdint>
#include <cstddef>

namespace Dvrip {
// Writes 8 chars + NUL into out (9 bytes). The Xiongmai "sofia" digest:
// MD5(password) -> 8 chars, out[i] = charset[(md5[2i]+md5[2i+1]) % 62].
void sofiaHash(const char* password, char out[9]);
}
```

In `dvrip_protocol.cpp`, add a self-contained MD5 (RFC 1321 reference impl is
public domain — paste the compact variant) exposing `md5(const uint8_t* data,
size_t len, uint8_t out[16])`, then:

```cpp
void Dvrip::sofiaHash(const char* password, char out[9]) {
  uint8_t md[16];
  md5(reinterpret_cast<const uint8_t*>(password),
      password ? std::strlen(password) : 0, md);
  static const char* cs =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  for (int i = 0; i < 8; i++) {
    int n = (md[2 * i] + md[2 * i + 1]) % 62;
    out[i] = cs[n];
  }
  out[8] = '\0';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd firmware/edge/device && pio test -e native -f test_dvrip_protocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/dvrip_protocol.h firmware/edge/device/src/dvrip_protocol.cpp firmware/edge/device/test/test_dvrip_protocol/
git commit -m "feat(firmware): sofia password hash for DVRIP (native-tested vector)"
```

### Task 2: DVRIP request framing + login/OPSNAP payloads

**Files:**
- Modify: `firmware/edge/device/src/dvrip_protocol.h`
- Modify: `firmware/edge/device/src/dvrip_protocol.cpp`
- Test: `firmware/edge/device/test/test_dvrip_protocol/test_dvrip_protocol.cpp`

**Interfaces:**
- Produces:
  - `size_t Dvrip::buildFrame(uint16_t msgId, const char* jsonBody, uint32_t sessionId, uint8_t* out, size_t outCap)` — returns bytes written (20-byte header + body + `\x0a\x00`). Header: `0xFF 0x00 0x00 0x00` then LE `sessionId` (u32), LE seq `0` (u32), 2 pad bytes, LE `msgId` (u16), LE bodyLen (u32). Returns 0 if `outCap` too small.
  - `void Dvrip::loginBody(const char* user, const char* sofiaHashedPw, char* out, size_t outCap)` — writes the login JSON.
  - `void Dvrip::snapBody(uint8_t channel, const char* sessionIdHex, char* out, size_t outCap)` — writes the OPSNAP JSON.
  - Constants: `kMsgLogin = 1000`, `kMsgSnap = 1560`.

- [ ] **Step 1: Write the failing tests**

```cpp
void test_build_frame_header_layout() {
  uint8_t buf[64] = {};
  size_t n = Dvrip::buildFrame(/*msgId=*/1000, "{}", /*session=*/0, buf, sizeof(buf));
  TEST_ASSERT_EQUAL_UINT8(0xFF, buf[0]);
  // msgId at bytes 14..15 little-endian
  TEST_ASSERT_EQUAL_UINT8(0xE8, buf[14]); // 1000 = 0x03E8
  TEST_ASSERT_EQUAL_UINT8(0x03, buf[15]);
  // body len at 16..19 LE = strlen("{}") + 2 (0x0a 0x00) = 4
  TEST_ASSERT_EQUAL_UINT8(0x04, buf[16]);
  // total written = 20 + 4
  TEST_ASSERT_EQUAL_UINT32(24u, n);
  // trailer
  TEST_ASSERT_EQUAL_UINT8(0x0a, buf[22]);
  TEST_ASSERT_EQUAL_UINT8(0x00, buf[23]);
}

void test_build_frame_rejects_small_buffer() {
  uint8_t buf[8] = {};
  TEST_ASSERT_EQUAL_UINT32(0u, Dvrip::buildFrame(1000, "{}", 0, buf, sizeof(buf)));
}

void test_login_body_contains_user_and_hash() {
  char body[256];
  Dvrip::loginBody("someuser", "tlJwpbo6", body, sizeof(body));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"UserName\" : \"someuser\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"PassWord\" : \"tlJwpbo6\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"EncryptType\" : \"MD5\""));
}

void test_snap_body_contains_channel() {
  char body[160];
  Dvrip::snapBody(/*channel=*/2, "0x1", body, sizeof(body));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"Channel\" : 2"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"Name\" : \"OPSNAP\""));
}
```

Add each to `setup()` with `RUN_TEST`.

- [ ] **Step 2: Run to verify failure**

Run: `cd firmware/edge/device && pio test -e native -f test_dvrip_protocol`
Expected: FAIL (undefined `buildFrame` / `loginBody` / `snapBody`).

- [ ] **Step 3: Implement framing + body builders**

```cpp
// in header
namespace Dvrip {
constexpr uint16_t kMsgLogin = 1000;
constexpr uint16_t kMsgSnap  = 1560;
size_t buildFrame(uint16_t msgId, const char* jsonBody, uint32_t sessionId,
                  uint8_t* out, size_t outCap);
void loginBody(const char* user, const char* sofiaHashedPw, char* out, size_t outCap);
void snapBody(uint8_t channel, const char* sessionIdHex, char* out, size_t outCap);
}
```

```cpp
// in cpp
size_t Dvrip::buildFrame(uint16_t msgId, const char* body, uint32_t session,
                         uint8_t* out, size_t cap) {
  size_t bodyLen = std::strlen(body) + 2; // + 0x0a 0x00
  size_t total = 20 + bodyLen;
  if (cap < total) return 0;
  std::memset(out, 0, 20);
  out[0] = 0xFF;
  out[4] = session & 0xFF; out[5] = (session >> 8) & 0xFF;
  out[6] = (session >> 16) & 0xFF; out[7] = (session >> 24) & 0xFF;
  out[14] = msgId & 0xFF; out[15] = (msgId >> 8) & 0xFF;
  out[16] = bodyLen & 0xFF; out[17] = (bodyLen >> 8) & 0xFF;
  out[18] = (bodyLen >> 16) & 0xFF; out[19] = (bodyLen >> 24) & 0xFF;
  std::memcpy(out + 20, body, bodyLen - 2);
  out[20 + bodyLen - 2] = 0x0a;
  out[20 + bodyLen - 1] = 0x00;
  return total;
}

void Dvrip::loginBody(const char* user, const char* pw, char* out, size_t cap) {
  std::snprintf(out, cap,
    "{ \"EncryptType\" : \"MD5\", \"LoginType\" : \"DVRIP-Web\", "
    "\"PassWord\" : \"%s\", \"UserName\" : \"%s\" }", pw, user);
}

void Dvrip::snapBody(uint8_t channel, const char* sid, char* out, size_t cap) {
  std::snprintf(out, cap,
    "{ \"Name\" : \"OPSNAP\", \"SessionID\" : \"%s\", "
    "\"OPSNAP\" : { \"Channel\" : %u } }", sid, (unsigned)channel);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd firmware/edge/device && pio test -e native -f test_dvrip_protocol`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/dvrip_protocol.* firmware/edge/device/test/test_dvrip_protocol/
git commit -m "feat(firmware): DVRIP frame + login/OPSNAP payload builders"
```

### Task 3: Response parsing (header + login Ret + JPEG vs Ret:108)

**Files:**
- Modify: `firmware/edge/device/src/dvrip_protocol.{h,cpp}`
- Test: `firmware/edge/device/test/test_dvrip_protocol/test_dvrip_protocol.cpp`

**Interfaces:**
- Produces:
  - `struct Dvrip::Header { uint16_t msgId; uint32_t sessionId; uint32_t bodyLen; bool ok; }`
  - `Dvrip::Header Dvrip::parseHeader(const uint8_t* buf, size_t len)` — `ok=false` if `len < 20`.
  - `int Dvrip::loginRet(const char* jsonBody)` — returns the `Ret` field (100 = success), or -1 if absent.
  - `const char* Dvrip::sessionIdFromLogin(const char* jsonBody, char out[16])` — extracts `"SessionID" : "0x..."` into `out`, returns `out` or nullptr.
  - `bool Dvrip::isJpeg(const uint8_t* body, size_t len)` — true iff `len>=2 && body[0]==0xFF && body[1]==0xD8`.

- [ ] **Step 1: Write the failing tests**

```cpp
void test_parse_header_reads_fields() {
  uint8_t buf[20] = {};
  buf[0]=0xFF; buf[4]=0x5F; // session 0x5F
  buf[14]=0x29; buf[15]=0x06; // msgId 1577? use 0x0629 = 1577 — pick snap resp 1561=0x0619
  buf[14]=0x19; buf[15]=0x06; // msgId 1561
  buf[16]=0x10; // bodyLen 16
  Dvrip::Header h = Dvrip::parseHeader(buf, sizeof(buf));
  TEST_ASSERT_TRUE(h.ok);
  TEST_ASSERT_EQUAL_UINT16(1561, h.msgId);
  TEST_ASSERT_EQUAL_UINT32(0x5F, h.sessionId);
  TEST_ASSERT_EQUAL_UINT32(16, h.bodyLen);
}

void test_parse_header_rejects_short() {
  uint8_t buf[10] = {};
  TEST_ASSERT_FALSE(Dvrip::parseHeader(buf, sizeof(buf)).ok);
}

void test_login_ret_and_session() {
  const char* body =
    "{ \"Ret\" : 100, \"SessionID\" : \"0x0000007B\" }";
  TEST_ASSERT_EQUAL_INT(100, Dvrip::loginRet(body));
  char sid[16] = {};
  TEST_ASSERT_NOT_NULL(Dvrip::sessionIdFromLogin(body, sid));
  TEST_ASSERT_EQUAL_STRING("0x0000007B", sid);
}

void test_is_jpeg_true_and_false() {
  uint8_t jpeg[4] = {0xFF, 0xD8, 0x12, 0x34};
  uint8_t notjpeg[4] = {'{', '"', 'R', 'e'};
  TEST_ASSERT_TRUE(Dvrip::isJpeg(jpeg, 4));
  TEST_ASSERT_FALSE(Dvrip::isJpeg(notjpeg, 4));
}
```

Register each in `setup()`.

- [ ] **Step 2: Run to verify failure**

Run: `cd firmware/edge/device && pio test -e native -f test_dvrip_protocol`
Expected: FAIL.

- [ ] **Step 3: Implement the parsers**

```cpp
Dvrip::Header Dvrip::parseHeader(const uint8_t* b, size_t len) {
  Header h{}; if (len < 20) { h.ok = false; return h; }
  h.sessionId = (uint32_t)b[4] | ((uint32_t)b[5]<<8) | ((uint32_t)b[6]<<16) | ((uint32_t)b[7]<<24);
  h.msgId = (uint16_t)b[14] | ((uint16_t)b[15]<<8);
  h.bodyLen = (uint32_t)b[16] | ((uint32_t)b[17]<<8) | ((uint32_t)b[18]<<16) | ((uint32_t)b[19]<<24);
  h.ok = true; return h;
}

int Dvrip::loginRet(const char* body) {
  const char* p = std::strstr(body, "\"Ret\"");
  if (!p) return -1;
  p = std::strchr(p, ':'); if (!p) return -1;
  return std::atoi(p + 1);
}

const char* Dvrip::sessionIdFromLogin(const char* body, char out[16]) {
  const char* p = std::strstr(body, "\"SessionID\"");
  if (!p) return nullptr;
  p = std::strchr(p, '"'); if (!p) return nullptr;      // opening of "SessionID"
  p = std::strchr(p + 1, '"'); if (!p) return nullptr;  // closing
  p = std::strchr(p + 1, '"'); if (!p) return nullptr;  // opening of value
  const char* start = p + 1;
  const char* end = std::strchr(start, '"'); if (!end) return nullptr;
  size_t n = (size_t)(end - start); if (n > 15) n = 15;
  std::memcpy(out, start, n); out[n] = '\0';
  return out;
}

bool Dvrip::isJpeg(const uint8_t* b, size_t len) {
  return len >= 2 && b[0] == 0xFF && b[1] == 0xD8;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd firmware/edge/device && pio test -e native -f test_dvrip_protocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/dvrip_protocol.* firmware/edge/device/test/test_dvrip_protocol/
git commit -m "feat(firmware): DVRIP response parsing (header, login Ret, JPEG detect)"
```

---

## Phase 2 — Firmware: config, capture wiring, advisory

### Task 4: Extend `Config` with NVR fields (EEPROM magic bump)

**Files:**
- Modify: `firmware/edge/device/src/alarm_state.h` (Config + SensorConfig)
- Modify: `firmware/edge/device/src/eeprom_store.h` (bump `kMagic`)
- Test: `firmware/edge/device/test/test_config_parser/` (size assert is compile-time)

**Interfaces:**
- Produces, on `Config`: `char nvrHost[32] = {}; uint16_t nvrPort = 34567; char nvrUser[24] = {}; char nvrPassword[24] = {}; uint8_t nvrMode = 0; uint16_t captureCooldownSec = 45;` (`nvrMode`: 0=off, 1=capture, 2=capture+judge).
- Produces, on `SensorConfig`: `bool outOfSight = false; uint8_t cameraChannel = 0;` (0 = all channels).
- **Critical:** this changes `sizeof(Config)`. The `static_assert(sizeof(Config) == 2548 …)` MUST be updated to the new measured value, and `EepromStore::kMagic` bumped. The siren address survives via RtdbConfig.s re-adoption — do NOT skip the hardware verification in Phase 6.

- [ ] **Step 1: Add the fields, then let the static_assert fail to reveal the real size**

Add the `Config` fields after `remoteCount` and the `SensorConfig` fields after `conditionCount`. Leave the existing `static_assert(sizeof(Config) == 2548, …)` unchanged for now.

- [ ] **Step 2: Build native tests to read the compiler's reported size**

Run: `cd firmware/edge/device && pio test -e native -f test_config_parser 2>&1 | grep -A2 static_assert`
Expected: FAIL — the assert message / compiler note reveals the new `sizeof(Config)`. Record that number.

- [ ] **Step 3: Update the static_assert with the MEASURED value + a comment**

Replace the assert's expected number with the measured one and append a comment line documenting the bump (follow the existing comment block's style: "2548 -> NNNN when NVR fields were added …"). Bump `EepromStore::kMagic` to a new value (e.g. increment the last byte).

- [ ] **Step 4: Run native tests to verify pass**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS (all suites — the size assert now matches).

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/alarm_state.h firmware/edge/device/src/eeprom_store.h
git commit -m "feat(firmware): add NVR config fields to Config (EEPROM magic bump)"
```

### Task 5: Parse NVR config fields in `parseConfigJson`

**Files:**
- Modify: `firmware/edge/device/src/config_parser.cpp`
- Test: `firmware/edge/device/test/test_config_parser/test_config_parser.cpp`

**Interfaces:**
- Consumes: the thin RTDB keys (added cloud-side in Task 11): `nh` (host), `np` (port), `nu` (user), `nw` (password), `nm` (mode), `cc` (cooldown). Per-sensor (inside `r`/`c` alignment): a parallel array `os` (out-of-sight flags) and `cch` (camera channel). **Decision:** per-sensor flags ride as two index-aligned arrays `os: boolean[]` and `cch: number[]` next to `r`, so the existing r/c loop stays untouched and the arrays are optional.
- Produces: populated `Config.nvr*`, `Config.captureCooldownSec`, and per-`SensorConfig` `outOfSight` / `cameraChannel`.

- [ ] **Step 1: Write the failing test**

```cpp
void test_parses_nvr_fields() {
  const char* json =
    "{ \"a\":true, \"d\":30, "
    "\"nh\":\"cam.local\", \"np\":34567, \"nu\":\"u\", \"nw\":\"p\", "
    "\"nm\":2, \"cc\":60, "
    "\"r\":[\"0x0061D\"], \"c\":[[{\"t\":0}]], "
    "\"os\":[true], \"cch\":[3] }";
  Config cfg;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &cfg));
  TEST_ASSERT_EQUAL_STRING("cam.local", cfg.nvrHost);
  TEST_ASSERT_EQUAL_UINT16(34567, cfg.nvrPort);
  TEST_ASSERT_EQUAL_STRING("u", cfg.nvrUser);
  TEST_ASSERT_EQUAL_STRING("p", cfg.nvrPassword);
  TEST_ASSERT_EQUAL_UINT8(2, cfg.nvrMode);
  TEST_ASSERT_EQUAL_UINT16(60, cfg.captureCooldownSec);
  TEST_ASSERT_TRUE(cfg.sensors[0].outOfSight);
  TEST_ASSERT_EQUAL_UINT8(3, cfg.sensors[0].cameraChannel);
}

void test_nvr_fields_default_when_absent() {
  const char* json = "{ \"a\":false, \"d\":0, \"r\":[\"0x0061D\"], \"c\":[[{\"t\":0}]] }";
  Config cfg;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &cfg));
  TEST_ASSERT_EQUAL_UINT8(0, cfg.nvrMode);      // off
  TEST_ASSERT_EQUAL_UINT16(45, cfg.captureCooldownSec); // default
  TEST_ASSERT_FALSE(cfg.sensors[0].outOfSight);
  TEST_ASSERT_EQUAL_UINT8(0, cfg.sensors[0].cameraChannel); // all
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd firmware/edge/device && pio test -e native -f test_config_parser`
Expected: FAIL.

- [ ] **Step 3: Implement parsing**

Before the `r`/`c` early-return block (same placement rationale as `s`/`m`), add:

```cpp
strncpy(out->nvrHost, doc["nh"] | "", sizeof(out->nvrHost) - 1);
out->nvrHost[sizeof(out->nvrHost) - 1] = '\0';
out->nvrPort = doc["np"] | 34567;
strncpy(out->nvrUser, doc["nu"] | "", sizeof(out->nvrUser) - 1);
out->nvrUser[sizeof(out->nvrUser) - 1] = '\0';
strncpy(out->nvrPassword, doc["nw"] | "", sizeof(out->nvrPassword) - 1);
out->nvrPassword[sizeof(out->nvrPassword) - 1] = '\0';
out->nvrMode = doc["nm"] | 0;
out->captureCooldownSec = doc["cc"] | 45;
```

Inside the per-sensor loop (where `sensor.familyId` is set), after reading conditions, read the index-aligned optional arrays:

```cpp
JsonArray os = doc["os"];
JsonArray cch = doc["cch"];
sensor.outOfSight = (!os.isNull() && i < os.size()) ? (os[i] | false) : false;
sensor.cameraChannel = (!cch.isNull() && i < cch.size()) ? (cch[i] | 0) : 0;
```

Note: bump the `StaticJsonDocument<4096>` size if the added fields risk overflow — measure with a full config; raise to `6144` if needed and note why.

- [ ] **Step 4: Run to verify pass**

Run: `cd firmware/edge/device && pio test -e native -f test_config_parser`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/config_parser.cpp firmware/edge/device/test/test_config_parser/
git commit -m "feat(firmware): parse NVR connection + per-sensor camera config"
```

### Task 6: `CameraClient` — capture gate (pure logic) + socket wrapper

**Files:**
- Create: `firmware/edge/device/src/camera_client.h`
- Create: `firmware/edge/device/src/camera_client.cpp`
- Test: `firmware/edge/device/test/test_camera_client/test_camera_client.cpp`

**Interfaces:**
- Produces (pure, tested): `bool CameraClient::shouldCapture(const Config& cfg, const SensorConfig& sensor, bool online, uint32_t nowMs, uint32_t lastCaptureMs)` — true iff `online && cfg.nvrMode != 0 && !sensor.outOfSight && (lastCaptureMs == 0 || nowMs - lastCaptureMs >= cfg.captureCooldownSec * 1000UL)`.
- Produces (pure, tested): `void CameraClient::channelsFor(const SensorConfig& sensor, uint8_t* out, uint8_t& count)` — if `sensor.cameraChannel != 0`, `{that}`; else `{1,2,3}` (the known live channels; probing can refine later).
- Produces (I/O, hardware only): `bool CameraClient::grab(const Config& cfg, uint8_t channel, std::vector<uint8_t>& out)` — DVRIP connect→login→OPSNAP→read JPEG, using the Phase-1 pure helpers over `WiFiClient` (plain TCP). Returns false on any failure; logs one line. Not native-tested (socket I/O), exercised in Phase 6.

- [ ] **Step 1: Write the failing tests (pure gate + channel selection)**

```cpp
#include <unity.h>
#include "camera_client.h"

static Config offCfg()  { Config c; c.nvrMode = 0; c.captureCooldownSec = 45; return c; }
static Config onCfg()   { Config c; c.nvrMode = 1; c.captureCooldownSec = 45; return c; }

void test_no_capture_when_mode_off() {
  SensorConfig s;
  TEST_ASSERT_FALSE(CameraClient::shouldCapture(offCfg(), s, true, 100000, 0));
}
void test_no_capture_when_offline() {
  SensorConfig s;
  TEST_ASSERT_FALSE(CameraClient::shouldCapture(onCfg(), s, false, 100000, 0));
}
void test_no_capture_when_out_of_sight() {
  SensorConfig s; s.outOfSight = true;
  TEST_ASSERT_FALSE(CameraClient::shouldCapture(onCfg(), s, true, 100000, 0));
}
void test_capture_first_time() {
  SensorConfig s;
  TEST_ASSERT_TRUE(CameraClient::shouldCapture(onCfg(), s, true, 100000, 0));
}
void test_cooldown_blocks_then_allows() {
  SensorConfig s;
  // last capture at 100000ms, cooldown 45s: 120000 blocked, 146000 allowed
  TEST_ASSERT_FALSE(CameraClient::shouldCapture(onCfg(), s, true, 120000, 100000));
  TEST_ASSERT_TRUE(CameraClient::shouldCapture(onCfg(), s, true, 146000, 100000));
}
void test_channels_named_single() {
  SensorConfig s; s.cameraChannel = 2;
  uint8_t ch[3]; uint8_t n = 0;
  CameraClient::channelsFor(s, ch, n);
  TEST_ASSERT_EQUAL_UINT8(1, n);
  TEST_ASSERT_EQUAL_UINT8(2, ch[0]);
}
void test_channels_all_when_unset() {
  SensorConfig s; // cameraChannel 0
  uint8_t ch[3]; uint8_t n = 0;
  CameraClient::channelsFor(s, ch, n);
  TEST_ASSERT_EQUAL_UINT8(3, n);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd firmware/edge/device && pio test -e native -f test_camera_client`
Expected: FAIL.

- [ ] **Step 3: Implement the pure logic (and declare `grab`)**

`camera_client.h` declares all three methods; guard the `grab`/socket includes behind `#ifndef NATIVE_BUILD` (or the project's existing native guard — check `platform_compat.h`) so the native test only compiles the pure parts. Implement `shouldCapture` and `channelsFor` inline-exactly per the Interfaces block above.

- [ ] **Step 4: Run to verify pass**

Run: `cd firmware/edge/device && pio test -e native -f test_camera_client`
Expected: PASS.

- [ ] **Step 5: Implement `grab` (hardware path, compiled only for esp32s3)**

Using the Phase-1 helpers: `WiFiClient tcp; tcp.connect(cfg.nvrHost, cfg.nvrPort)`; `sofiaHash(cfg.nvrPassword,…)`; `buildFrame(kMsgLogin, loginBody(...))`; read 20-byte header via `parseHeader`, read body, `loginRet == 100`, `sessionIdFromLogin`; `buildFrame(kMsgSnap, snapBody(channel, sid, …), sessionId)`; read response header + body; if `isJpeg` copy into `out`, else (Ret:108) return false. Apply an overall deadline consistent with `io_deadline.h`.

- [ ] **Step 6: Build the firmware to confirm it compiles for the device**

Run: `cd firmware/edge/device && pio run -e esp32s3`
Expected: builds (no upload).

- [ ] **Step 7: Commit**

```bash
git add firmware/edge/device/src/camera_client.* firmware/edge/device/test/test_camera_client/
git commit -m "feat(firmware): CameraClient capture gate (tested) + DVRIP grab (hardware)"
```

### Task 7: Upload path + capture invocation in `handleSensorEvent`

**Files:**
- Modify: `firmware/edge/device/src/cloud_client.h` / `cloud_client.cpp` (add `uploadSnapshot`)
- Modify: `firmware/edge/device/src/main.cpp` (invoke capture after `reportEvent`)
- Test: hardware only (Phase 6); no new native test (socket I/O)

**Interfaces:**
- Produces: `bool CloudClient::uploadSnapshot(const char* rfId, uint64_t ts, uint8_t channel, const uint8_t* jpeg, size_t len)` — PUTs the bytes to Firebase Storage object `{projectId}/snapshots/{rfId}/{ts}/ch{N}.jpg` using the already-minted Firebase token. Best-effort: returns false and logs on failure, never blocks. NOTE: `ts` MUST be epoch-milliseconds wall-clock (`(uint64_t)time(nullptr) * 1000ULL`), computed once per trigger — the SAME value `reportEvent` uses for its `/events/{rfId}/{ts}` key (cloud_client.cpp ~893). It is NOT `handleSensorEvent`'s `now` (that is `millis()` uptime) and NOT `uint32_t` (epoch-ms overflows 32 bits). The two keys must be identical or the cloud cannot correlate the image to its event.
- Consumes: `CameraClient::shouldCapture`, `channelsFor`, `grab`; per-family `lastCaptureMs` map in `main.cpp` (RAM only).

- [ ] **Step 1: Add the capture call in `main.cpp`**

In `handleSensorEvent` (main.cpp:257), AFTER the existing `cloudClient.reportEvent(rfId, event, batteryLow, rssi);` (line ~269) and the alarm reporting, add a capture block that:
- looks up the `SensorConfig` for `familyId` in the current `config`;
- calls `CameraClient::shouldCapture(config, sensor, cloudClient.isReady(), millis(), lastCaptureMs[familyIndex])`;
- if true: `channelsFor(...)`, loop `grab(...)` + `cloudClient.uploadSnapshot(rfId, now, ch, buf.data(), buf.size())`, update `lastCaptureMs`.

This block must be strictly after the event/alarm reporting so it can never delay the alarm path.

- [ ] **Step 2: Implement `uploadSnapshot` in cloud_client.cpp**

Use the same authenticated Firebase client the device already uses. Storage REST upload: `POST https://firebasestorage.googleapis.com/v0/b/<bucket>/o?uploadType=media&name=<urlencoded objectPath>` with `Authorization: Bearer <idToken>` and `Content-Type: image/jpeg`. The bucket name is derivable from the project (`<project>.appspot.com` or `<project>.firebasestorage.app` — confirm the live bucket in the Firebase console and store as a constant next to the RTDB host). Reuse the existing TLS client; this is the second large-TLS path flagged in the spec — keep it best-effort and off the alarm path.

- [ ] **Step 3: Build for the device**

Run: `cd firmware/edge/device && pio run -e esp32s3`
Expected: builds.

- [ ] **Step 4: Run full native suite (no regressions)**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/cloud_client.* firmware/edge/device/src/main.cpp
git commit -m "feat(firmware): capture + upload snapshots on trigger (best-effort, off alarm path)"
```

### Task 8: Consume the false-positive advisory

**Files:**
- Modify: `firmware/edge/device/src/cloud_client.cpp` (`applyCommandsJson`) / `cloud_client.h` (pending accessor)
- Modify: `firmware/edge/device/src/main.cpp` (act on it)
- Test: `firmware/edge/device/test/test_config_parser/` or a new small parse test — the match logic is pure

**Interfaces:**
- Consumes: a new `/commands` key `fp` (false-positive) = `{ rfId: "0x..", ts: <number> }`, written cloud-side in Task 13.
- Produces: `bool CloudClient::consumeFalsePositive(char* rfIdOut, size_t cap, uint32_t* tsOut)` — returns true once per new advisory, mirroring the change-only-surfaces-once pattern of `consumeConfigUpdate`.
- Produces: in `main.cpp`, logic that stops the siren ONLY if `{rfId, ts}` matches the trigger currently sustaining the alarm; otherwise a no-op.

- [ ] **Step 1: Write the failing test for the advisory parse + match**

Add a pure helper `bool CloudClient::parseFalsePositive(const char* json, char* rfIdOut, size_t cap, uint32_t* tsOut)` and test it:

```cpp
void test_parse_false_positive() {
  char rf[16] = {}; uint32_t ts = 0;
  const char* json = "{ \"fp\": { \"rfId\": \"0x2E5B73\", \"ts\": 1696000000 } }";
  TEST_ASSERT_TRUE(CloudClient::parseFalsePositive(json, rf, sizeof(rf), &ts));
  TEST_ASSERT_EQUAL_STRING("0x2E5B73", rf);
  TEST_ASSERT_EQUAL_UINT32(1696000000u, ts);
}
void test_parse_false_positive_absent() {
  char rf[16] = {}; uint32_t ts = 0;
  TEST_ASSERT_FALSE(CloudClient::parseFalsePositive("{ \"armed\": true }", rf, sizeof(rf), &ts));
}
```

(Place in a native-compilable test; if `CloudClient` is too heavy to link natively, extract `parseFalsePositive` into a tiny free function in a `*_pure.h` the way other pure bits are split — check whether `cloud_client` links in the native env; if not, put the parser in `config_parser.cpp` next to the others and test it there.)

- [ ] **Step 2: Run to verify failure**

Run: `cd firmware/edge/device && pio test -e native -f test_config_parser`
Expected: FAIL.

- [ ] **Step 3: Implement the parser + change-detection + main.cpp action**

Parser as above. In `applyCommandsJson`, surface a pending advisory only when `{rfId,ts}` differs from the last seen (so re-polling the same one doesn't re-fire). In `main.cpp`, on a consumed advisory, compare against the alarm's current cause (`AlarmState` exposes the triggering family/rfId + timestamp — read `alarm_state.h`); if it matches the active alarm, call the SAME siren-off path a disarm uses; else log "stale/mismatched advisory, no-op".

- [ ] **Step 4: Run to verify pass + full native suite**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS.

- [ ] **Step 5: Build for device**

Run: `cd firmware/edge/device && pio run -e esp32s3`
Expected: builds.

- [ ] **Step 6: Commit**

```bash
git add firmware/edge/device/src/cloud_client.* firmware/edge/device/src/main.cpp firmware/edge/device/test/
git commit -m "feat(firmware): consume false-positive advisory, stop siren only for the matching trigger"
```

---

## Phase 3 — Cloud: types, config, judge, upload trigger

### Task 9: Extend domain types

**Files:**
- Modify: `functions/src/types.ts` (Project, Sensor, RtdbConfig)
- Modify: `web/src/types.ts` (keep the mirror in sync — the header comment on `types.ts` says "Mirror of web/src/types")

**Interfaces:**
- Produces, on `Project`: `nvrMode?: "off" | "capture" | "capture+judge";` (absent = off) `nvrHost?: string; nvrPort?: number; nvrUser?: string; nvrPassword?: string; captureCooldownSec?: number; snapshotRetentionDays?: number; judgeProvider?: "claude" | "null"; judgeModel?: string; judgePrompt?: string;`
- Produces, on `Sensor`: `outOfSight?: boolean; cameraChannel?: number;`
- Produces, on `RtdbConfig`: `nh?: string; np?: number; nu?: string; nw?: string; nm?: 0 | 1 | 2; cc?: number; os?: boolean[]; cch?: number[];`

- [ ] **Step 1: Add the fields with doc comments**

Add each field above with a one-line comment matching the file's style (why optional, what absent means). `nvrMode` numeric mapping for the device: off→0, capture→1, capture+judge→2.

- [ ] **Step 2: Typecheck both halves**

Run: `cd functions && npx tsc --noEmit` then `cd ../web && npx tsc --noEmit` (or `npm run build`)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add functions/src/types.ts web/src/types.ts
git commit -m "feat(types): NVR/judge project config + per-sensor camera fields"
```

### Task 10: `SnapshotJudge` interface + `NullJudge`

**Files:**
- Create: `functions/src/snapshotJudge.ts`
- Test: `functions/src/snapshotJudge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Verdict = "safe" | "breach";
  export interface JudgeContext {
    sensorName: string; channel: number; armed: boolean;
    timeOfDay: string; prompt: string;
  }
  export interface SnapshotJudge {
    judge(jpeg: Buffer, ctx: JudgeContext): Promise<{ verdict: Verdict; reason: string }>;
  }
  export class NullJudge implements SnapshotJudge { … } // always { verdict: "breach", reason: "judge disabled" }
  export function judgeFor(provider: string | undefined, apiKey: string | undefined, model: string | undefined): SnapshotJudge
  ```
- `judgeFor` returns `NullJudge` for `provider !== "claude"` or a missing key; otherwise `ClaudeJudge` (Task 11).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { NullJudge, judgeFor } from "./snapshotJudge";

describe("NullJudge", () => {
  it("fails safe: always breach (nothing is suppressed when judging is off)", async () => {
    const v = await new NullJudge().judge(Buffer.from([0xff, 0xd8]), {
      sensorName: "Front", channel: 1, armed: true, timeOfDay: "day", prompt: "",
    });
    expect(v.verdict).toBe("breach");
  });
});

describe("judgeFor", () => {
  it("returns NullJudge when provider is not claude", () => {
    expect(judgeFor("null", "key", "m")).toBeInstanceOf(NullJudge);
  });
  it("returns NullJudge when the api key is missing", () => {
    expect(judgeFor("claude", undefined, "m")).toBeInstanceOf(NullJudge);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && npx vitest run snapshotJudge`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement interface + NullJudge + judgeFor (ClaudeJudge stubbed to throw for now)**

Implement the types, `NullJudge`, and `judgeFor` returning `NullJudge` unless `provider === "claude" && apiKey`. For the claude branch, construct `ClaudeJudge` (added next task); temporarily `judgeFor`'s claude branch can `return new NullJudge()` until Task 11, but prefer wiring `ClaudeJudge` in Task 11 and keeping this task's tests green via the two NullJudge paths.

- [ ] **Step 4: Run to verify pass**

Run: `cd functions && npx vitest run snapshotJudge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/snapshotJudge.ts functions/src/snapshotJudge.test.ts
git commit -m "feat(functions): SnapshotJudge interface + fail-safe NullJudge"
```

### Task 11: `ClaudeJudge` (vision) — read the claude-api skill first

**Files:**
- Modify: `functions/src/snapshotJudge.ts` (add `ClaudeJudge`, wire into `judgeFor`)
- Modify: `functions/package.json` (add `@anthropic-ai/sdk`)
- Test: `functions/src/snapshotJudge.test.ts` (mock the SDK; no real API calls)

**Interfaces:**
- Consumes: `@anthropic-ai/sdk`. **REQUIRED:** invoke the `claude-api` skill for the exact current TypeScript SDK call shape (model id, vision image block, structured output). Default model `claude-haiku-4-5`. Parse the verdict via structured output, NOT string matching.
- Produces: `ClaudeJudge implements SnapshotJudge`. The prompt embeds `ctx.prompt` (scene quirks) and asks for `{verdict: "safe"|"breach", reason: string}` on a single still; breach iff a person/intruder is visible.

- [ ] **Step 1: Add the dependency**

Run: `cd functions && npm install @anthropic-ai/sdk`

- [ ] **Step 2: Write the failing test with a mocked SDK**

Mock `@anthropic-ai/sdk` so `messages.create`/`parse` returns a canned `{verdict:"safe", reason:"empty yard"}`; assert `ClaudeJudge.judge` returns it. Also assert a malformed model response falls back to `{verdict:"breach"}` (fail-safe).

- [ ] **Step 3: Run to verify failure**

Run: `cd functions && npx vitest run snapshotJudge`
Expected: FAIL.

- [ ] **Step 4: Implement `ClaudeJudge` per the claude-api skill**

Use the structured-output pattern from the skill; base64-encode the JPEG into an image content block; model from config; API key from the Functions secret. On any error or unparseable result, return `{verdict:"breach", reason:"judge error (fail-safe)"}`.

- [ ] **Step 5: Run to verify pass + full suite**

Run: `cd functions && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add functions/src/snapshotJudge.ts functions/src/snapshotJudge.test.ts functions/package.json functions/package-lock.json
git commit -m "feat(functions): ClaudeJudge vision implementation (fail-safe on error)"
```

### Task 12: Extend `buildRtdbConfig` with NVR + per-sensor camera fields

**Files:**
- Modify: `functions/src/buildConfig.ts`
- Test: `functions/src/buildConfig.test.ts`

**Interfaces:**
- Consumes: new `Project` + `Sensor` fields (Task 9).
- Produces: `buildRtdbConfig` writes `nh/np/nu/nw/nm/cc` from the project, and `os[]`/`cch[]` index-aligned with `r` (same order as `r` is built). `nm` maps off→0/capture→1/capture+judge→2. Omit `os`/`cch` when all-default (keep the polled payload small, like `m`/`s`).
- **Signature change:** `buildRtdbConfig` gains an NVR-settings param object. Update ALL callers (`onProfileChange.ts` and anywhere else `buildRtdbConfig` is invoked — grep first).

- [ ] **Step 1: Write the failing test**

```ts
it("emits NVR fields and index-aligned per-sensor camera flags", () => {
  const cfg = buildRtdbConfig(
    [{ id: "r1", name: "R", sensors: ["s1"], condition: { type: "immediate" } }],
    [{ /* Sensor s1 */ id: "s1", familyId: "0x0061D", outOfSight: true, cameraChannel: 2, /* …required fields… */ } as any],
    true, 30, true, [], [], undefined,
    { nvrMode: "capture+judge", nvrHost: "h", nvrPort: 34567, nvrUser: "u", nvrPassword: "p", captureCooldownSec: 60 }
  );
  expect(cfg.nm).toBe(2);
  expect(cfg.nh).toBe("h");
  expect(cfg.cc).toBe(60);
  expect(cfg.os).toEqual([true]);
  expect(cfg.cch).toEqual([2]);
});

it("omits os/cch when every sensor is default", () => {
  const cfg = buildRtdbConfig(/* …one in-sight sensor, no channel, nvr off… */);
  expect(cfg.os).toBeUndefined();
  expect(cfg.cch).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && npx vitest run buildConfig`
Expected: FAIL.

- [ ] **Step 3: Implement — add the param + emit fields index-aligned with `r`**

After `r` is finalized (pass 1), build `os`/`cch` by walking `r` back to its sensor (you already have `sensorMap` and the family→sensor relation). Add the NVR fields from the settings param. Omit `os`/`cch` arrays when all entries are default. Update callers.

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `cd functions && npx vitest run buildConfig && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/buildConfig.ts functions/src/buildConfig.test.ts functions/src/onProfileChange.ts
git commit -m "feat(functions): project NVR config + per-sensor camera flags in device config"
```

### Task 13: `onSnapshotUploaded` — timeline, judge gate, advisory/Telegram

**Files:**
- Create: `functions/src/onSnapshotUploaded.ts`
- Create: `functions/src/snapshotPath.ts` (pure path parse + bucket helpers)
- Modify: `functions/src/telegram.ts` (add `sendTelegramPhoto`)
- Modify: `functions/src/index.ts` (export `onSnapshotUploaded`)
- Test: `functions/src/snapshotPath.test.ts`, `functions/src/onSnapshotUploaded.test.ts`

**Interfaces:**
- Produces (pure): `parseSnapshotPath(objectName: string): { projectId: string; rfId: string; ts: number; channel: number } | null` for `"{projectId}/snapshots/{rfId}/{ts}/ch{N}.jpg"`.
- Produces: `sendTelegramPhoto(botToken: string, chatId: string, jpeg: Buffer, caption: string): Promise<void>` in telegram.ts (multipart `sendPhoto`, mirrors `sendTelegram`).
- Produces: `onSnapshotUploaded` (`onObjectFinalized`, region `europe-west1`): parse path → augment Firestore timeline entry with the image URL (always) → gate (project `nvrMode === "capture+judge"` AND the `{rfId,ts}` event's RECORDED arm state was armed) → `judge` → `"safe"` writes `/{projectId}/commands/fp = {rfId, ts, at}` + timeline note; `"breach"` sends the Telegram photo + timeline note.
- Consumes: `judgeFor` (Task 10/11), the Anthropic key from a Functions secret, `familyIdOf` + the in-memory sensor match from `onSensorEvent` for the sensor name. For "all channels" (sensor had no `cameraChannel`): first breach wins; a `"safe"` advisory is written only once every captured channel for that `{rfId,ts}` has been judged safe — track per-`{rfId,ts}` channel verdicts in a small Firestore doc (`projects/{id}/snapshotJudging/{rfId}_{ts}`) to coordinate across the per-object invocations.

- [ ] **Step 1: Write the failing pure path test**

```ts
import { parseSnapshotPath } from "./snapshotPath";
it("parses a valid snapshot object path", () => {
  expect(parseSnapshotPath("proj1/snapshots/0x2E5B73/1696000000/ch2.jpg"))
    .toEqual({ projectId: "proj1", rfId: "0x2E5B73", ts: 1696000000, channel: 2 });
});
it("rejects non-snapshot paths", () => {
  expect(parseSnapshotPath("proj1/other/x.jpg")).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && npx vitest run snapshotPath`
Expected: FAIL.

- [ ] **Step 3: Implement `parseSnapshotPath` + `sendTelegramPhoto`**

Regex the path; implement `sendTelegramPhoto` as a multipart POST to `https://api.telegram.org/bot<token>/sendPhoto` (model it on the existing `sendTelegram` fetch in telegram.ts).

- [ ] **Step 4: Write + run the handler test (judge gate + advisory + breach)**

Mock Firestore/RTDB and `judgeFor` (inject a stub judge). Assert: (a) timeline augmented regardless of mode; (b) judge NOT called when `nvrMode !== "capture+judge"`; (c) judge NOT called when the event's recorded arm state was disarmed; (d) `"safe"` → `/commands/fp` written with `{rfId,ts}`; (e) `"breach"` → `sendTelegramPhoto` called with a caption naming sensor + channel.

Run: `cd functions && npx vitest run onSnapshotUploaded`
Expected: PASS after implementation.

- [ ] **Step 5: Implement the handler + export it**

Implement per the Interfaces block; export from `index.ts`. Declare the Anthropic key as a secret (`defineSecret`) and bind it to this function.

- [ ] **Step 6: Full cloud checks**

Run: `cd functions && npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add functions/src/onSnapshotUploaded.ts functions/src/snapshotPath.ts functions/src/snapshotPath.test.ts functions/src/onSnapshotUploaded.test.ts functions/src/telegram.ts functions/src/index.ts
git commit -m "feat(functions): onSnapshotUploaded — timeline, armed-gated judge, advisory/breach delivery"
```

---

## Phase 4 — Web: config UI + timeline photos

### Task 14: Per-sensor out-of-sight + camera-channel controls

**Files:**
- Modify: `web/src/features/configure/SensorsTab.tsx`
- Create: `web/src/features/configure/cameraSensorConfig.ts` (pure helpers)
- Test: `web/src/features/configure/cameraSensorConfig.test.ts`

**Interfaces:**
- Produces (pure): `cameraChannelLabel(channel: number | undefined): string` ("All channels" when 0/undefined, else "Camera N"); `normalizeChannel(raw: string): number | undefined` (empty/"all" → undefined, 1-8 → number, else undefined).
- Produces (UI): in each sensor row/editor, an "Out of sight" checkbox (writes `Sensor.outOfSight`) and a channel selector (writes `Sensor.cameraChannel`), with inline guidance text: "Flag in-sight only when the camera reliably shows an intruder on trigger."

- [ ] **Step 1: Write the failing pure test**

```ts
import { cameraChannelLabel, normalizeChannel } from "./cameraSensorConfig";
it("labels unset channel as all", () => {
  expect(cameraChannelLabel(undefined)).toBe("All channels");
  expect(cameraChannelLabel(0)).toBe("All channels");
  expect(cameraChannelLabel(2)).toBe("Camera 2");
});
it("normalizes channel input", () => {
  expect(normalizeChannel("")).toBeUndefined();
  expect(normalizeChannel("all")).toBeUndefined();
  expect(normalizeChannel("3")).toBe(3);
  expect(normalizeChannel("99")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run cameraSensorConfig`
Expected: FAIL.

- [ ] **Step 3: Implement the pure helpers**

Implement exactly per the Interfaces block.

- [ ] **Step 4: Wire the controls into SensorsTab (follow the existing field-edit pattern in that file)**

Add the checkbox + selector; persist via the same Firestore update path SensorsTab already uses for sensor edits. Use the helpers for labels/normalization.

- [ ] **Step 5: Web checks**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/configure/SensorsTab.tsx web/src/features/configure/cameraSensorConfig.*
git commit -m "feat(web): per-sensor out-of-sight + camera channel config"
```

### Task 15: Project NVR / judge settings panel

**Files:**
- Create: `web/src/features/configure/CameraTab.tsx` (new tab; follow SirenTab.tsx structure)
- Modify: `web/src/features/configure/ConfigurePage.tsx` (register the tab)
- Create: `web/src/features/configure/cameraSettings.ts` + test (pure validation)

**Interfaces:**
- Produces (pure): `validateNvrSettings(input): { ok: true; value: {...} } | { ok: false; error: string }` — mode in off/capture/capture+judge, port 1-65535, cooldown ≥ 5, retentionDays ≥ 1.
- Produces (UI): a form editing `Project.nvrMode/nvrHost/nvrPort/nvrUser/nvrPassword/captureCooldownSec/snapshotRetentionDays/judgeProvider/judgeModel/judgePrompt`. The password field is write-only-style (masked). Saves to the project doc.

- [ ] **Step 1: Write the failing validation test**

```ts
import { validateNvrSettings } from "./cameraSettings";
it("accepts a valid config", () => {
  const r = validateNvrSettings({ nvrMode: "capture", nvrPort: 34567, captureCooldownSec: 45, snapshotRetentionDays: 14 });
  expect(r.ok).toBe(true);
});
it("rejects a bad port", () => {
  expect(validateNvrSettings({ nvrMode: "capture", nvrPort: 0, captureCooldownSec: 45, snapshotRetentionDays: 14 }).ok).toBe(false);
});
it("rejects cooldown below 5", () => {
  expect(validateNvrSettings({ nvrMode: "capture", nvrPort: 34567, captureCooldownSec: 2, snapshotRetentionDays: 14 }).ok).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run cameraSettings`
Expected: FAIL.

- [ ] **Step 3: Implement validation, then the tab UI**

Implement `validateNvrSettings`; build `CameraTab.tsx` modeled on `SirenTab.tsx` (same save/load-from-project pattern); register it in `ConfigurePage.tsx`.

- [ ] **Step 4: Web checks**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/configure/CameraTab.tsx web/src/features/configure/ConfigurePage.tsx web/src/features/configure/cameraSettings.*
git commit -m "feat(web): project NVR + judge settings tab"
```

### Task 16: Show snapshots + verdict in the timeline

**Files:**
- Modify: `web/src/features/explore/ExplorePage.tsx`
- Create: `web/src/features/explore/snapshotThumb.ts` + test (pure: derive thumb/full state from a timeline entry)
- Test: `web/src/features/explore/snapshotThumb.test.ts`

**Interfaces:**
- Consumes: timeline entries now carrying `snapshots?: {channel,url}[]` and `judge?: {verdict,reason,model,channel,at}` (written by Task 13).
- Produces (pure): `snapshotSummary(entry): { hasImages: boolean; verdictLabel?: string }` — verdictLabel "Confirmed breach (AI)" / "False positive (AI)" / undefined.
- Produces (UI): a thumbnail row on entries with snapshots, click-to-expand, and a verdict badge when present.

- [ ] **Step 1: Write the failing pure test**

```ts
import { snapshotSummary } from "./snapshotThumb";
it("summarizes a breach entry with images", () => {
  const s = snapshotSummary({ snapshots: [{ channel: 1, url: "u" }], judge: { verdict: "breach" } } as any);
  expect(s.hasImages).toBe(true);
  expect(s.verdictLabel).toBe("Confirmed breach (AI)");
});
it("no images, no verdict", () => {
  const s = snapshotSummary({} as any);
  expect(s.hasImages).toBe(false);
  expect(s.verdictLabel).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run snapshotThumb`
Expected: FAIL.

- [ ] **Step 3: Implement helper + wire into ExplorePage rows**

Implement `snapshotSummary`; render thumbnails + badge in the timeline row (follow the existing row-rendering in ExplorePage).

- [ ] **Step 4: Web checks**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/explore/ExplorePage.tsx web/src/features/explore/snapshotThumb.*
git commit -m "feat(web): show snapshots and AI verdict in the timeline"
```

---

## Phase 5 — Retention

### Task 17: `snapshotCleanup` row in the doSchedule table

**Files:**
- Create: `functions/src/snapshotCleanup.ts`
- Test: `functions/src/snapshotCleanup.test.ts`
- Modify: `functions/src/doSchedule.ts` (add a daily row — NOT a new onSchedule)

**Interfaces:**
- Produces (pure): `isExpired(objectTimeMs: number, nowMs: number, retentionDays: number): boolean`.
- Produces: `snapshotCleanup(): Promise<void>` — for each project, list Storage objects under `{projectId}/snapshots/`, delete those older than `snapshotRetentionDays` (default 14). Mirrors `eventRetention`.

- [ ] **Step 1: Write the failing pure test**

```ts
import { isExpired } from "./snapshotCleanup";
const DAY = 86400_000;
it("expires objects older than retention", () => {
  const now = 100 * DAY;
  expect(isExpired(now - 15 * DAY, now, 14)).toBe(true);
  expect(isExpired(now - 13 * DAY, now, 14)).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && npx vitest run snapshotCleanup`
Expected: FAIL.

- [ ] **Step 3: Implement `isExpired` + `snapshotCleanup`, add the table row**

Add a row to the `doSchedule` task table: `{ desc: "snapshot retention", min: 0, hour: 12, weekDay: "*", callback: snapshotCleanup }` (daily noon, alongside dead-sensors). Use the Storage Admin SDK to list+delete.

- [ ] **Step 4: Cloud checks**

Run: `cd functions && npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/snapshotCleanup.ts functions/src/snapshotCleanup.test.ts functions/src/doSchedule.ts
git commit -m "feat(functions): daily snapshot retention cleanup (doSchedule row)"
```

---

## Phase 6 — Integration, deploy, hardware soak

### Task 18: Emulator smoke test

**Files:**
- Create/modify: `smoke/` — a smoke test that uploads a fixture JPEG to the snapshot path and asserts the pipeline.

**Interfaces:**
- Consumes: the deployed-to-emulator functions, a fixture JPEG (use a tiny valid 2-byte-header JPEG or a real small one in `smoke/fixtures/`).

- [ ] **Step 1: Write the smoke test**

Upload `proj/snapshots/0x2E5B73/<ts>/ch1.jpg` to the Storage emulator; assert (a) timeline entry augmented; (b) with `nvrMode=capture+judge` + a stubbed `"safe"` judge, `/commands/fp` appears; (c) with a stubbed `"breach"`, the Telegram photo call fires (assert against a mocked endpoint).

- [ ] **Step 2: Run the smoke suite**

Run: the project's smoke runner (check `smoke/` README / package scripts).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add smoke/
git commit -m "test(smoke): snapshot upload -> timeline, advisory, breach photo"
```

### Task 19: Deploy cloud + web (capture path, NullJudge first)

- [ ] **Step 1: Confirm siren-address re-adoption is safe BEFORE any device flash**

Run: `cd functions && npm run check:sirenAddress`
Expected: Firestore `sirenBaseAddress` / RTDB `config.s` present. If ABSENT, STOP — do not flash the device (the EEPROM magic bump would lose the siren pairing).

- [ ] **Step 2: Deploy Storage rules + functions + hosting**

Run: `firebase deploy --only storage,functions,hosting --project alarm-system-100`
Expected: success. Set the Anthropic key secret first: `firebase functions:secrets:set ANTHROPIC_API_KEY`.

- [ ] **Step 3: Configure NVR settings in the web app (capture-only first)**

Set `nvrMode=capture`, host/port/user/password (real values entered in the UI, never committed), via the new Camera tab. Leave judge off initially.

- [ ] **Step 4: Verify config reached the device**

Run: `curl -s http://alarm.local/status` and `python3 ../read_serial.py 40 --port /dev/cu.<port>`
Expected: device logs show the NVR config applied.

### Task 20: Hardware soak + safety verification

- [ ] **Step 1: Flash the firmware**

Run: `cd firmware/edge/device && pio run -e esp32s3 -t upload --upload-port /dev/cu.<port>`
Expected: upload succeeds; device boots and re-adopts its siren address (verify in serial + RTDB `state/siren_base`).

- [ ] **Step 2: Capture smoke on hardware**

Trigger a sensor (or `curl -s -X POST "http://alarm.local/trigger?rfId=0x..."`); confirm JPEGs appear in Storage and the timeline shows them.

- [ ] **Step 3: Advisory safety tests (the safety-critical checks from the spec)**

Enable `capture+judge`. Then verify on hardware:
- (a) An armed trigger the judge rules **"safe"** → the siren STOPS for that trigger (advisory matched).
- (b) A **mismatched/stale** advisory (different `{rfId,ts}`) → **no-op**, siren unaffected.
- (c) **WiFi pulled** → a trigger alarms and sirens exactly as today; no capture attempted; alarm never waits.

Record results in `docs/testing-device-liveness.md` or a new `docs/history/` entry.

- [ ] **Step 4: Stability soak**

Run a multi-hour soak (target the existing watchdog/socket-death baseline — reference the 18h clean-run in CLAUDE.md). Confirm no new `twdt` reboots or socket deaths introduced by the upload path. Capture the serial log with `read_serial.py ... -f log2file`.

- [ ] **Step 5: Update docs + status**

Update `CLAUDE.md` Status/Next and `SECURITY.md` as needed; add a `docs/history/` record if the soak surfaced anything. Update `todo.txt` for any deferred follow-ups.

- [ ] **Step 6: Commit docs**

```bash
git add docs/ CLAUDE.md SECURITY.md todo.txt
git commit -m "docs: camera-snapshot hardware soak + safety verification results"
```

---

## Notes for the executor

- **Do Phase 2's EEPROM bump (Task 4) carefully** — measure `sizeof(Config)`, update the `static_assert` with the real number, bump `kMagic`, and treat Task 19 Step 1 (siren re-adoption check) as a hard gate before flashing.
- **Task 11 requires the `claude-api` skill** for the current SDK shape — do not write the Anthropic call from memory.
- **The judge is subtractive.** Any time you're unsure, default to NOT suppressing (fail-safe = breach). The `NullJudge` and all error paths return `"breach"` on purpose.
- Real NVR host/credential are entered in the UI at deploy time (Task 19 Step 3); they must never appear in a commit.
