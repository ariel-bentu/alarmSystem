# Local Web Server (Arm/Disarm + Sensor Simulator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a LAN-reachable local web server (`http://local.alarm`, no auth)
that lets a user arm/disarm the device and simulate a sensor RF trigger
without WiFi internet access or CC1101 hardware, running during normal
operation (not just AP-provisioning mode), toggleable via a new
EEPROM-persisted flag that defaults on.

**Architecture:** New `LocalWebServer` class (`ESP8266WebServer` +
`ESP8266mDNS`), mirroring the existing `ProvisioningPortal`/`setup_page.h`
pattern but running in STA mode alongside normal operation. The simulate-
trigger endpoint calls a new shared `handleSensorEvent()` function extracted
from `main.cpp`'s existing CC1101-decode path, so simulated triggers exercise
the exact same `AlarmState` → `RelaySiren` → `CloudClient::reportEvent`
pipeline a real RF packet would. `EepromStore`'s persisted blob gains a
`localWebEnabled` bool alongside `armed`/`Config`; the magic number bumps
since this is a breaking format change (acceptable — no device is
provisioned yet).

**Tech Stack:** ESP8266WebServer, ESP8266mDNS (both already available via
the `arduino`/`d1_mini` PlatformIO framework, no new `lib_deps` needed),
existing `AlarmState`/`RelaySiren`/`CloudClient`/`EepromStore` firmware
components (all already built and reviewed on `main`).

**Spec:** No separate spec doc — this plan is self-contained; the design was
resolved via brainstorming in conversation. `firmware/edge/device/src/`
(`provisioning_portal.h/.cpp`, `setup_page.h`, `eeprom_store.h/.cpp`,
`main.cpp`) is the reference codebase this plan extends.

## Global Constraints

- No authentication on the local web server — open to anyone on the LAN.
  This is an explicit, deliberate choice; do not add auth.
- The enable/disable toggle (`localWebEnabled`) must be readable at boot
  before any WiFi/cloud access, since "arm without internet" is the whole
  point — it lives in the same `EepromStore` blob as `armed`/`Config`, not
  in `ProvisionStore` (LittleFS) or cloud config.
- Defaults to `true` on first boot / no valid EEPROM state.
- The simulate-trigger endpoint must invoke the *same code path* a real
  CC1101 decode uses (`AlarmState::onSensorEvent` → `RelaySiren::turnOn` →
  `CloudClient::reportEvent`), not a separate shortcut — extract shared
  logic into one function both paths call.
- Free-text rfId input for the simulator (not a dropdown) — must be able to
  simulate both known and unknown sensor IDs.
- This is a breaking EEPROM format change: bump `EepromStore::kMagic` so old
  (pre-this-plan) EEPROM contents are correctly rejected as invalid rather
  than misread, matching `decode()`'s existing magic-check behavior.
- Hardware is available for real bring-up testing once this lands — the
  final task's manual verification step should actually be run on real
  hardware, not just noted as out of scope.

---

## File Structure

**Firmware (`firmware/edge/device/`):**
- Modify `src/eeprom_store.h` / `src/eeprom_store.cpp` — add
  `localWebEnabled` to the persisted blob, bump `kMagic`.
- Modify `test/test_eeprom_store/test_eeprom_store.cpp` — cover the new
  field's round-trip.
- Create `src/local_web_server.h` / `src/local_web_server.cpp` — the new
  server, mirrors `provisioning_portal.h/.cpp`'s shape (`begin`/`start`/
  `stop`/`handle`, route handlers, `renderPage()`).
- Create `src/local_web_page.h` — embedded HTML/JS for the status/control
  page, mirrors `setup_page.h`'s self-contained-page pattern.
- Modify `src/main.cpp` — extract `handleSensorEvent()` shared function,
  wire `LocalWebServer` start (gated on the loaded `localWebEnabled` flag)
  and `handle()` into `onNormalOperation()`/`loop()`, start mDNS.

---

## Task 1: EepromStore — add localWebEnabled field, bump magic number

**Files:**
- Modify: `firmware/edge/device/src/eeprom_store.h`
- Modify: `firmware/edge/device/src/eeprom_store.cpp`
- Modify: `firmware/edge/device/test/test_eeprom_store/test_eeprom_store.cpp`

**Interfaces:**
- Consumes: nothing new (existing `Config` struct from `alarm_state.h`,
  unchanged).
- Produces: `EepromStore::load(bool* armed, bool* localWebEnabled, Config* config)`
  and `EepromStore::save(bool armed, bool localWebEnabled, const Config& config)`
  — signatures gain a new `bool* localWebEnabled` / `bool localWebEnabled`
  parameter, inserted between `armed` and `config` (arbitrary but consistent
  ordering). `encode`/`decode` gain the same parameter. Task 4 (`main.cpp`)
  calls these new signatures directly — there is no backward-compatible
  overload, since this is an intentional breaking change per the Global
  Constraints.

- [ ] **Step 1: Write the failing test**

Replace `firmware/edge/device/test/test_eeprom_store/test_eeprom_store.cpp`:

```cpp
#include <unity.h>
#include "eeprom_store.h"

void test_encode_decode_round_trips_armed_localweb_and_config() {
  Config config;
  config.armed = true; // note: EepromStore tracks armed separately; this
                        // field on Config itself is unused by the store,
                        // included here only for struct completeness
  config.sirenDurationSec = 90;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "0xA1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1;
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 30;

  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(true, false, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = false;
  bool localWebOut = true;
  Config configOut;
  bool ok = EepromStore::decode(buffer, written, &armedOut, &localWebOut, &configOut);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_TRUE(armedOut);
  TEST_ASSERT_FALSE(localWebOut);
  TEST_ASSERT_EQUAL(90, configOut.sirenDurationSec);
  TEST_ASSERT_EQUAL(1, configOut.sensorCount);
  TEST_ASSERT_EQUAL_STRING("0xA1B2C3", configOut.sensors[0].rfId);
  TEST_ASSERT_EQUAL(1, configOut.sensors[0].conditions[0].t);
  TEST_ASSERT_EQUAL(2, configOut.sensors[0].conditions[0].n);
  TEST_ASSERT_EQUAL(30, configOut.sensors[0].conditions[0].w);
}

void test_localweb_enabled_true_round_trips() {
  Config config;
  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(false, true, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = true;
  bool localWebOut = false;
  Config configOut;
  bool ok = EepromStore::decode(buffer, written, &armedOut, &localWebOut, &configOut);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_FALSE(armedOut);
  TEST_ASSERT_TRUE(localWebOut);
}

void test_decode_rejects_garbage_buffer() {
  uint8_t buffer[EepromStore::kReservedBytes];
  memset(buffer, 0xFF, sizeof(buffer)); // erased-flash pattern, no valid magic/header

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  bool ok = EepromStore::decode(buffer, sizeof(buffer), &armedOut, &localWebOut, &configOut);

  TEST_ASSERT_FALSE(ok);
}

void test_decode_rejects_old_pre_localweb_magic() {
  // Simulates a buffer written by the OLD EepromStore format (magic +
  // armed byte + Config, no localWebEnabled byte) — decode() must reject
  // it via the bumped magic number rather than misreading the Config bytes
  // as if the missing localWebEnabled byte were present.
  uint8_t buffer[EepromStore::kReservedBytes] = {};
  uint32_t oldMagic = 0xA1A2B3B4; // the pre-this-plan magic value
  memcpy(buffer, &oldMagic, sizeof(oldMagic));

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  bool ok = EepromStore::decode(buffer, sizeof(buffer), &armedOut, &localWebOut, &configOut);

  TEST_ASSERT_FALSE(ok);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_encode_decode_round_trips_armed_localweb_and_config);
  RUN_TEST(test_localweb_enabled_true_round_trips);
  RUN_TEST(test_decode_rejects_garbage_buffer);
  RUN_TEST(test_decode_rejects_old_pre_localweb_magic);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd firmware/edge/device && pio test -e native -f test_eeprom_store`
Expected: FAIL to compile — `EepromStore::encode`/`decode`/`load`/`save`
don't yet accept the new `localWebEnabled` parameter.

- [ ] **Step 3: Update eeprom_store.h**

Replace `firmware/edge/device/src/eeprom_store.h`:

```cpp
#pragma once

#include <cstddef>
#include <cstdint>

#include "alarm_state.h"

class EepromStore {
 public:
  static constexpr size_t kReservedBytes = 4096;
  // Bumped from 0xA1A2B3B4 — this is a breaking format change (added
  // localWebEnabled byte between armed and Config). Old EEPROM contents
  // written before this change must be rejected, not misread; a magic
  // mismatch is decode()'s existing rejection mechanism.
  static constexpr uint32_t kMagic = 0xA1A2B3B5;

  bool begin();
  bool load(bool* armed, bool* localWebEnabled, Config* config);
  bool save(bool armed, bool localWebEnabled, const Config& config);

  // Pure encode/decode, exposed for native unit testing. Layout: magic
  // (4 bytes) | armed (1 byte) | localWebEnabled (1 byte) | Config (raw
  // struct bytes, fixed size).
  static size_t encode(bool armed, bool localWebEnabled, const Config& config,
                        uint8_t* buffer, size_t bufferLen);
  static bool decode(const uint8_t* buffer, size_t bufferLen, bool* armed,
                      bool* localWebEnabled, Config* config);
};
```

- [ ] **Step 4: Update eeprom_store.cpp**

Replace `firmware/edge/device/src/eeprom_store.cpp`:

```cpp
#include "eeprom_store.h"

#include <cstring>

#if defined(ARDUINO)
#include <EEPROM.h>
#endif

size_t EepromStore::encode(bool armed, bool localWebEnabled, const Config& config,
                            uint8_t* buffer, size_t bufferLen) {
  size_t needed = sizeof(kMagic) + sizeof(uint8_t) + sizeof(uint8_t) + sizeof(Config);
  if (bufferLen < needed) return 0;

  size_t offset = 0;
  memcpy(buffer + offset, &kMagic, sizeof(kMagic));
  offset += sizeof(kMagic);

  uint8_t armedByte = armed ? 1 : 0;
  memcpy(buffer + offset, &armedByte, sizeof(armedByte));
  offset += sizeof(armedByte);

  uint8_t localWebByte = localWebEnabled ? 1 : 0;
  memcpy(buffer + offset, &localWebByte, sizeof(localWebByte));
  offset += sizeof(localWebByte);

  memcpy(buffer + offset, &config, sizeof(Config));
  offset += sizeof(Config);

  return offset;
}

bool EepromStore::decode(const uint8_t* buffer, size_t bufferLen, bool* armed,
                          bool* localWebEnabled, Config* config) {
  size_t needed = sizeof(kMagic) + sizeof(uint8_t) + sizeof(uint8_t) + sizeof(Config);
  if (bufferLen < needed) return false;

  uint32_t magic = 0;
  size_t offset = 0;
  memcpy(&magic, buffer + offset, sizeof(magic));
  offset += sizeof(magic);
  if (magic != kMagic) return false;

  uint8_t armedByte = 0;
  memcpy(&armedByte, buffer + offset, sizeof(armedByte));
  offset += sizeof(armedByte);
  *armed = armedByte != 0;

  uint8_t localWebByte = 0;
  memcpy(&localWebByte, buffer + offset, sizeof(localWebByte));
  offset += sizeof(localWebByte);
  *localWebEnabled = localWebByte != 0;

  memcpy(config, buffer + offset, sizeof(Config));
  offset += sizeof(Config);

  return true;
}

#if defined(ARDUINO)

bool EepromStore::begin() {
  EEPROM.begin(kReservedBytes);
  return true;
}

bool EepromStore::load(bool* armed, bool* localWebEnabled, Config* config) {
  uint8_t buffer[kReservedBytes];
  for (size_t i = 0; i < kReservedBytes; i++) {
    buffer[i] = EEPROM.read(i);
  }
  return decode(buffer, kReservedBytes, armed, localWebEnabled, config);
}

bool EepromStore::save(bool armed, bool localWebEnabled, const Config& config) {
  uint8_t buffer[kReservedBytes];
  size_t written = encode(armed, localWebEnabled, config, buffer, kReservedBytes);
  if (written == 0) return false;

  for (size_t i = 0; i < written; i++) {
    EEPROM.write(i, buffer[i]);
  }
  return EEPROM.commit();
}

#endif  // defined(ARDUINO)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd firmware/edge/device && pio test -e native -f test_eeprom_store`
Expected: PASS — all 4 tests green.

- [ ] **Step 6: Run the full native suite to confirm no regression**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS — `test_eeprom_store`, `test_alarm_state`, `test_config_parser`
all green (the latter two don't touch `EepromStore` so should be unaffected,
but confirm).

- [ ] **Step 7: Commit**

```bash
git add firmware/edge/device/src/eeprom_store.h firmware/edge/device/src/eeprom_store.cpp firmware/edge/device/test/test_eeprom_store/test_eeprom_store.cpp
git commit -m "Add localWebEnabled to EepromStore, bump magic for format change"
```

---

## Task 2: main.cpp — extract shared handleSensorEvent(), update EepromStore call sites

**Files:**
- Modify: `firmware/edge/device/src/main.cpp`

**Interfaces:**
- Consumes: `EepromStore::load`/`save`'s new 3-bool-plus-config signature
  from Task 1.
- Produces: a free function
  `void handleSensorEvent(const char* rfId, unsigned long now)` in the
  anonymous namespace, called both from the existing CC1101-decode branch
  in `loop()` and — in Task 3 — from `LocalWebServer`'s simulate-trigger
  handler via a small trampoline `main.cpp` exposes. This task only does
  the extraction and updates `EepromStore` call sites; it does NOT yet wire
  in `LocalWebServer` (that's Task 4).

This task is a pure refactor of already-reviewed, working code — no new
behavior. Verification is compile-clean plus confirming `loop()`'s observable
behavior for a real CC1101 decode is unchanged (same three calls, same
order, just moved into a named function).

- [ ] **Step 1: Extract handleSensorEvent() and update EepromStore calls**

In `firmware/edge/device/src/main.cpp`, inside the anonymous namespace,
add the new function (place it near the top of the namespace, after the
existing global variables, before `connectToWifi`):

```cpp
bool localWebEnabled = true;

// Shared by the real CC1101 decode path (loop()) and LocalWebServer's
// simulate-trigger endpoint (Task 3/4) — both must exercise the exact same
// alarm-evaluation pipeline, not a duplicated shortcut.
void handleSensorEvent(const char* rfId, unsigned long now) {
  bool shouldFire = alarmState.onSensorEvent(rfId, now);
  if (shouldFire) {
    siren.turnOn(config.sirenDurationSec, now);
  }
  cloudClient.reportEvent(rfId, "trigger", false, 0);
}
```

Note: the real CC1101 path passes `packet.batteryLow` and a real `rssi`
into `cloudClient.reportEvent`; the simulated path has neither. Change
`handleSensorEvent`'s signature to accept them as parameters so behavior is
identical for both callers, defaulting sensibly for the simulated case:

```cpp
void handleSensorEvent(const char* rfId, unsigned long now, bool batteryLow = false, int rssi = 0) {
  bool shouldFire = alarmState.onSensorEvent(rfId, now);
  if (shouldFire) {
    siren.turnOn(config.sirenDurationSec, now);
  }
  cloudClient.reportEvent(rfId, "trigger", batteryLow, rssi);
}
```

Update the existing CC1101-decode block in `loop()` (currently lines
143-157) to call it:

```cpp
KeruiPacket packet;
int rssi;
if (cc1101.poll(&packet, &rssi)) {
  char rfIdHex[11];
  // 0x-prefixed to match the format used everywhere else in the system
  // (Firestore sensor.rfId, buildConfig.ts, smoke scripts, web pairing UI
  // reading event keys) — see alarm_state.h's SensorConfig::rfId sizing.
  snprintf(rfIdHex, sizeof(rfIdHex), "0x%06X", packet.sensorId);
  handleSensorEvent(rfIdHex, now, packet.batteryLow, rssi);
}
```

Update `onNormalOperation()`'s `EepromStore::load` call and the two
`EepromStore::save` call sites in `loop()` (armed-command branch and
config-update branch) to pass `&localWebEnabled` / `localWebEnabled`:

```cpp
// in onNormalOperation():
if (!eepromStore.load(&armed, &localWebEnabled, &config)) {
  Serial.println("No valid EEPROM state found — starting disarmed, local web enabled, empty config");
  armed = false;
  localWebEnabled = true;
  config = Config();
}
```

```cpp
// in loop(), armed-command branch:
eepromStore.save(armed, localWebEnabled, config);
```

```cpp
// in loop(), config-update branch:
eepromStore.save(armed, localWebEnabled, config);
```

- [ ] **Step 2: Build for the real target**

Run: `cd firmware/edge/device && pio run -e d1_mini`
Expected: PASS (compiles cleanly).

- [ ] **Step 3: Run native tests to confirm no regression**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS — all suites still green (`main.cpp` isn't part of the
native build, so this just confirms Task 1's `EepromStore` changes still
hold and nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add firmware/edge/device/src/main.cpp
git commit -m "Extract shared handleSensorEvent(), thread localWebEnabled through EepromStore calls"
```

---

## Task 3: LocalWebServer — status/control page, arm/disarm/trigger endpoints

**Files:**
- Create: `firmware/edge/device/src/local_web_page.h`
- Create: `firmware/edge/device/src/local_web_server.h`
- Create: `firmware/edge/device/src/local_web_server.cpp`

**Interfaces:**
- Consumes: nothing firmware-internal at construction time — this class is
  handed callbacks/pointers by `main.cpp` in Task 4, mirroring how
  `ProvisioningPortal` takes a `ProvisionStore*`. To keep this task
  self-contained and testable in isolation via compile-check, define the
  class with a small callback-based interface rather than directly
  depending on `AlarmState`/`CloudClient`/etc. — this avoids a circular
  dependency and matches the existing `ProvisioningPortal` pattern of
  taking pending-action flags that `main.cpp`'s `loop()` drains, not
  synchronous calls into other components.
- Produces:
  ```cpp
  class LocalWebServer {
   public:
    void begin();  // registers routes; does NOT start the server (call start())
    void start();  // begins ESP8266WebServer + starts mDNS responder
    void stop();
    void handle(); // call every loop() iteration when active

    // Status shown on the page — main.cpp updates these each loop()
    // iteration before handle() is called, so the page always reflects
    // current state without LocalWebServer reaching into other components.
    void setStatus(bool armed, bool sirenActive);

    // Drained by main.cpp's loop(), same pattern as
    // ProvisioningPortal::hasPendingSave()/takePendingSave().
    bool hasPendingArmCommand() const { return pendingArmCommand_; }
    bool takePendingArmCommand();  // returns the requested armed state, clears the flag

    bool hasPendingTrigger() const { return pendingTrigger_; }
    void takePendingTrigger(String* rfId); // clears the flag
  };
  ```
  Task 4 (`main.cpp`) owns one `LocalWebServer` instance, calls
  `setStatus(armed, siren.isActive())` once per `loop()` iteration before
  `handle()`, and drains `hasPendingArmCommand()`/`hasPendingTrigger()`
  the same way it already drains `cloudClient.consumeArmedCommand()` etc.,
  calling `handleSensorEvent()` (Task 2) for a drained trigger.

- [ ] **Step 1: Write local_web_page.h**

```cpp
#pragma once

// Self-contained status/control page: arm/disarm buttons, siren state,
// and a free-text sensor-trigger simulator. No external assets. Polls
// /status every 2s via fetch() to stay current without a full reload.
// Placeholders {{ARMED}}, {{SIREN}} are substituted by
// LocalWebServer::renderPage() before the page is served.
const char LOCAL_WEB_PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alarm System</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #111; color: #eee;
         margin: 0; padding: 24px 16px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .status { font-size: 14px; color: #999; margin-bottom: 20px; }
  .status b { color: #eee; }
  .row { max-width: 400px; margin: 0 auto 24px; display: flex; gap: 10px; }
  button { flex: 1; padding: 14px; border-radius: 6px; border: none;
           font-size: 16px; font-weight: 600; }
  .arm { background: #2d7dff; color: white; }
  .disarm { background: #444; color: #eee; }
  .sim { max-width: 400px; margin: 0 auto; border-top: 1px solid #333; padding-top: 20px; }
  .sim label { display: block; font-size: 14px; color: #ccc; margin-bottom: 4px; }
  .sim input { width: 100%; box-sizing: border-box; padding: 10px;
               border-radius: 6px; border: 1px solid #444; background: #222;
               color: #eee; font-size: 16px; margin-bottom: 10px; }
  .sim button { width: 100%; background: #a33; color: white; }
</style>
</head>
<body>
<h1>Alarm System</h1>
<p class="status">Armed: <b id="armedStatus">{{ARMED}}</b> &middot;
   Siren: <b id="sirenStatus">{{SIREN}}</b></p>
<div class="row">
  <button class="arm" onclick="post('/arm')">Arm</button>
  <button class="disarm" onclick="post('/disarm')">Disarm</button>
</div>
<div class="sim">
  <label for="rfId">Simulate sensor trigger (rfId)</label>
  <input type="text" id="rfId" placeholder="0xA1B2C3">
  <button onclick="trigger()">Trigger</button>
</div>
<script>
  function post(path) {
    fetch(path, { method: 'POST' }).then(refresh);
  }
  function trigger() {
    var rfId = document.getElementById('rfId').value;
    if (!rfId) return;
    fetch('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'rfId=' + encodeURIComponent(rfId)
    }).then(refresh);
  }
  function refresh() {
    fetch('/status').then(function(r) { return r.json(); }).then(function(s) {
      document.getElementById('armedStatus').textContent = s.armed ? 'yes' : 'no';
      document.getElementById('sirenStatus').textContent = s.siren ? 'ACTIVE' : 'off';
    });
  }
  setInterval(refresh, 2000);
</script>
</body>
</html>
)HTML";
```

- [ ] **Step 2: Write local_web_server.h**

```cpp
#pragma once

#include <Arduino.h>
#include <ESP8266WebServer.h>

class LocalWebServer {
 public:
  void begin();
  void start();
  void stop();
  void handle();

  void setStatus(bool armed, bool sirenActive);

  bool hasPendingArmCommand() const { return pendingArmCommand_; }
  bool takePendingArmCommand();

  bool hasPendingTrigger() const { return pendingTrigger_; }
  void takePendingTrigger(String* rfId);

 private:
  void handleRoot();
  void handleStatus();
  void handleArm();
  void handleDisarm();
  void handleTrigger();
  String renderPage();

  ESP8266WebServer webServer_{80};

  bool statusArmed_ = false;
  bool statusSirenActive_ = false;

  bool pendingArmCommand_ = false;
  bool pendingArmCommandValue_ = false;

  bool pendingTrigger_ = false;
  String pendingTriggerRfId_;
};
```

- [ ] **Step 3: Write local_web_server.cpp**

```cpp
#include "local_web_server.h"

#include "local_web_page.h"

void LocalWebServer::begin() {
  webServer_.on("/", HTTP_GET, [this]() { handleRoot(); });
  webServer_.on("/status", HTTP_GET, [this]() { handleStatus(); });
  webServer_.on("/arm", HTTP_POST, [this]() { handleArm(); });
  webServer_.on("/disarm", HTTP_POST, [this]() { handleDisarm(); });
  webServer_.on("/trigger", HTTP_POST, [this]() { handleTrigger(); });
}

void LocalWebServer::start() {
  webServer_.begin();
  Serial.println("Local web server started on port 80");
}

void LocalWebServer::stop() {
  webServer_.stop();
}

void LocalWebServer::handle() {
  webServer_.handleClient();
}

void LocalWebServer::setStatus(bool armed, bool sirenActive) {
  statusArmed_ = armed;
  statusSirenActive_ = sirenActive;
}

bool LocalWebServer::takePendingArmCommand() {
  pendingArmCommand_ = false;
  return pendingArmCommandValue_;
}

void LocalWebServer::takePendingTrigger(String* rfId) {
  *rfId = pendingTriggerRfId_;
  pendingTrigger_ = false;
}

String LocalWebServer::renderPage() {
  String page(FPSTR(LOCAL_WEB_PAGE_HTML));
  page.replace("{{ARMED}}", statusArmed_ ? "yes" : "no");
  page.replace("{{SIREN}}", statusSirenActive_ ? "ACTIVE" : "off");
  return page;
}

void LocalWebServer::handleRoot() {
  webServer_.send(200, "text/html", renderPage());
}

void LocalWebServer::handleStatus() {
  String json = "{\"armed\":";
  json += statusArmed_ ? "true" : "false";
  json += ",\"siren\":";
  json += statusSirenActive_ ? "true" : "false";
  json += "}";
  webServer_.send(200, "application/json", json);
}

void LocalWebServer::handleArm() {
  pendingArmCommand_ = true;
  pendingArmCommandValue_ = true;
  webServer_.send(200, "text/plain", "ok");
}

void LocalWebServer::handleDisarm() {
  pendingArmCommand_ = true;
  pendingArmCommandValue_ = false;
  webServer_.send(200, "text/plain", "ok");
}

void LocalWebServer::handleTrigger() {
  String rfId = webServer_.arg("rfId");
  if (rfId.length() == 0) {
    webServer_.send(400, "text/plain", "Missing rfId");
    return;
  }
  pendingTriggerRfId_ = rfId;
  pendingTrigger_ = true;
  webServer_.send(200, "text/plain", "ok");
}
```

- [ ] **Step 4: Build for the real target**

Run: `cd firmware/edge/device && pio run -e d1_mini`
Expected: PASS. Note: `LocalWebServer` isn't referenced from `main.cpp` yet
(that's Task 4) — if PlatformIO's build doesn't compile unreferenced `.cpp`
files under `src/` automatically for the `d1_mini` env (unlike the native
env's explicit `build_src_filter`), this step may need Task 4's wiring to
actually exercise compilation. If `pio run -e d1_mini` succeeds trivially
without compiling the new files (check the build log for
`local_web_server.cpp` in the compile output), note this in the task
report — it's not a failure, just means full verification lands in Task 4.

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/local_web_page.h firmware/edge/device/src/local_web_server.h firmware/edge/device/src/local_web_server.cpp
git commit -m "Add LocalWebServer: LAN status page, arm/disarm, sensor-trigger simulator"
```

---

## Task 4: Wire LocalWebServer + mDNS into main.cpp

**Files:**
- Modify: `firmware/edge/device/src/main.cpp`

**Interfaces:**
- Consumes: `LocalWebServer` from Task 3, `handleSensorEvent()` from Task 2,
  `EepromStore`'s `localWebEnabled` from Task 1.
- Produces: the fully wired feature — no later task depends on this.

- [ ] **Step 1: Add includes, mDNS, and LocalWebServer instance**

In `firmware/edge/device/src/main.cpp`, add includes near the top:

```cpp
#include <ESP8266mDNS.h>

#include "local_web_server.h"
```

In the anonymous namespace, add the instance alongside the other component
globals (near `EepromStore eepromStore;` etc.):

```cpp
LocalWebServer localWebServer;
```

- [ ] **Step 2: Start LocalWebServer + mDNS in onNormalOperation()**

At the end of `onNormalOperation()` (after the existing `configTime(...)`
call), add:

```cpp
  if (localWebEnabled) {
    if (MDNS.begin("local.alarm")) {
      Serial.println("mDNS responder started: http://local.alarm.local "
                      "(exact resolution depends on OS/browser mDNS support)");
    } else {
      Serial.println("mDNS responder failed to start — local web server "
                      "still reachable via IP");
    }
    localWebServer.begin();
    localWebServer.start();
    Serial.println("Local web server enabled");
  } else {
    Serial.println("Local web server disabled (localWebEnabled=false)");
  }
```

- [ ] **Step 3: Service LocalWebServer and drain its pending actions in loop()**

After the existing `cloudClient.loop();` line in `loop()`, and after the
existing `cloudClient.consumeArmedCommand`/`consumeSirenCommand`/
`consumeConfigUpdate` blocks, add:

```cpp
  if (localWebEnabled) {
    MDNS.update();
    localWebServer.setStatus(armed, siren.isActive());
    localWebServer.handle();

    if (localWebServer.hasPendingArmCommand()) {
      bool newArmedFromWeb = localWebServer.takePendingArmCommand();
      armed = newArmedFromWeb;
      config.armed = armed;
      alarmState.setConfig(config);
      if (!armed) {
        alarmState.disarm();
        siren.turnOff();
      }
      eepromStore.save(armed, localWebEnabled, config);
    }

    if (localWebServer.hasPendingTrigger()) {
      String rfId;
      localWebServer.takePendingTrigger(&rfId);
      handleSensorEvent(rfId.c_str(), now);
    }
  }
```

Note: this duplicates the arm/disarm state-update logic already present in
the `cloudClient.consumeArmedCommand()` branch above it. If the implementer
judges this duplication is worth eliminating, factor both into a shared
`applyArmedCommand(bool newArmed)` free function (same extraction pattern
as Task 2's `handleSensorEvent`) — this is a reasonable in-task improvement
consistent with the plan's spirit, not scope creep, since both branches
must stay behaviorally identical and duplicated state-mutation logic is a
real maintenance risk. Do this refactor as part of this task if it's
straightforward; otherwise implement as shown above and note the
duplication as a self-review finding.

- [ ] **Step 4: Add mDNS as a d1_mini dependency check**

`ESP8266mDNS` ships as part of the `arduino`/`d1_mini` ESP8266 core
framework already used by this project (same as `ESP8266WiFi`,
`ESP8266WebServer`, `EEPROM` — all currently used without explicit
`lib_deps` entries in `platformio.ini`). Confirm this by checking
`platformio.ini`'s existing `lib_deps` (Task 1's read of it shows only
`ArduinoJson` and `FirebaseClient` listed — the ESP8266-core libraries are
implicit). No `platformio.ini` change should be needed; if the build fails
to find `ESP8266mDNS.h`, report this as a concern rather than guessing at
a fix.

- [ ] **Step 5: Build for the real target**

Run: `cd firmware/edge/device && pio run -e d1_mini`
Expected: PASS (compiles cleanly, and this time `local_web_server.cpp`
should genuinely be part of the build since `main.cpp` now references it —
confirm in the build log).

- [ ] **Step 6: Run native tests to confirm no regression**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS — all suites green (native build doesn't include
`main.cpp`/`local_web_server.cpp`, so this just confirms nothing else
broke).

- [ ] **Step 7: Manual hardware verification**

Hardware is available for this plan (unlike the CC1101/relay pieces in the
prior plan, which needed parts that hadn't arrived). Flash this build to
the D1 Mini, connect to a WiFi network with internet available (so cloud
sync also works for comparison), and verify:
(a) the device boots into normal operation and prints the mDNS/local-web
startup messages over Serial;
(b) `http://<device-IP>/` (check Serial output for the IP, or try
`http://local.alarm.local` per common mDNS browser resolution) loads the
status page;
(c) clicking Arm/Disarm updates the page's status within ~2s and persists
across a power cycle (re-load the page after reboot, confirm armed state
matches what was set);
(d) entering an rfId in the simulator and clicking Trigger — with the
device armed and a matching sensor configured (via the existing cloud
config sync, or by testing with an rfId that has no matching sensor
configured to confirm it's safely ignored) — correctly fires the siren
per `AlarmState`'s existing condition logic, and the event shows up under
`/{projectId}/events` in the Firebase console if cloud sync is connected;
(e) disconnecting the device's WiFi from internet (but keeping it on the
LAN, e.g. via router settings or a hotspot with no upstream) and
confirming arm/disarm/trigger still work locally even though
`cloudClient.isReady()` would be false.

- [ ] **Step 8: Commit**

```bash
git add firmware/edge/device/src/main.cpp
git commit -m "Wire LocalWebServer and mDNS into normal operation boot/loop"
```

---

## Self-Review Notes

- **Spec coverage:** arm/disarm without internet (Tasks 3-4), sensor
  simulation through the real `AlarmState` pipeline (Task 2's
  `handleSensorEvent` extraction + Task 3's trigger endpoint + Task 4's
  wiring), EEPROM-persisted enable toggle readable before any network
  access (Task 1), no-auth-on-LAN (Task 3, no auth code added, matches the
  explicit Global Constraint), free-text rfId simulator input (Task 3's
  page/endpoint), `http://local.alarm` mDNS reachability (Task 4) — all
  covered. Real hardware verification (Task 4, Step 7) is included since
  hardware is now available, unlike the prior plan's CC1101-dependent
  tasks.
- **Known caveat surfaced, not silently glossed over:** mDNS hostname
  resolution from a browser is typically `local.alarm.local`, not the bare
  `http://local.alarm` originally requested — Task 4 documents this in a
  Serial log message and the manual verification step rather than
  asserting the bare form works, since that depends on OS/browser mDNS
  behavior this plan can't control.
- **Type consistency:** `EepromStore::load`/`save`/`encode`/`decode`
  signatures introduced in Task 1 are used identically in Task 2's
  `main.cpp` call sites and Task 4's new save-on-web-arm-command call site
  — same parameter order (`armed, localWebEnabled, config`) throughout.
  `handleSensorEvent`'s signature from Task 2 (`rfId, now, batteryLow,
  rssi` with defaults) is called with all 4 args from the real CC1101 path
  and with just `rfId, now` (relying on defaults) from Task 4's simulated
  path — intentional, both produce the same alarm-evaluation behavior.
