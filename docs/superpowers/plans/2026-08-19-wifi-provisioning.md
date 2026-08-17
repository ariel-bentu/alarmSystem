# WiFi Provisioning (AP Setup Portal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first D1 Mini firmware module — on boot, connect to
saved WiFi, or if unconfigured/failed, open a `10.25.0.1` AP with a
captive setup page to collect WiFi credentials + alarm endpoint + API key,
then join WiFi and close the AP.

**Architecture:** New PlatformIO project at `firmware/edge/device/`.
`ProvisionStore` (LittleFS JSON) persists credentials. `ProvisioningPortal`
owns the AP/DNS/web server lifecycle. `main.cpp` drives the boot flow:
try saved WiFi → on failure/absence, run the portal loop until a
successful save+connect closes it.

**Tech Stack:** PlatformIO, `espressif8266` platform, `d1_mini` board,
Arduino framework. Libraries used are all bundled with the ESP8266
Arduino core: `ESP8266WiFi`, `ESP8266WebServer`, `DNSServer`, `LittleFS`,
`ArduinoJson` (needs adding — see Task 1).

**Spec:** `docs/superpowers/specs/2026-08-19-wifi-provisioning-design.md`

## Global Constraints

- Board: `d1_mini`, platform `espressif8266`, framework `arduino` (per spec Project Setup).
- AP SSID: `AlarmSystem-Setup`, open network, no AP password (per spec §2).
- AP IP: `10.25.0.1` / gateway `10.25.0.1` / netmask `255.255.255.0` (per spec §2).
- WiFi connect timeout: 15 seconds (per spec §4).
- Credential storage: plain JSON at `/provision.json` on LittleFS, no encryption (per spec §1).
- AP stays up during connect attempts (`WIFI_AP_STA` mode) — no dead window (per spec §4).
- No unit tests for this module — hardware-dependent. Definition of done per task is a clean `pio run` build, verified by running it (per spec Testing section).

---

## File Structure

```
firmware/edge/device/
  platformio.ini
  src/
    main.cpp                  — boot flow / orchestration
    provision_store.h         — struct + class declaration
    provision_store.cpp       — LittleFS JSON load/save
    provisioning_portal.h     — class declaration
    provisioning_portal.cpp   — AP/DNS/web server + routes
    setup_page.h              — embedded HTML string constant
```

---

### Task 1: Project scaffold — PlatformIO project that builds and boots

**Files:**
- Create: `firmware/edge/device/platformio.ini`
- Create: `firmware/edge/device/src/main.cpp`

**Interfaces:**
- Produces: a working `pio run` target others build on. No other task depends on symbols from this one beyond the project existing.

- [ ] **Step 1: Create the PlatformIO project files**

`firmware/edge/device/platformio.ini`:
```ini
[env:d1_mini]
platform = espressif8266
board = d1_mini
framework = arduino
monitor_speed = 9600
lib_deps =
    bblanchon/ArduinoJson@^7.1.0
build_flags =
    -DPIO_FRAMEWORK_ARDUINO_MMU_CACHE16_IRAM48
```

`firmware/edge/device/src/main.cpp`:
```cpp
#include <Arduino.h>

void setup() {
  Serial.begin(9600);
  delay(200);
  Serial.println("Alarm system device booting...");
}

void loop() {
}
```

- [ ] **Step 2: Build to verify the toolchain and board package resolve**

Run: `~/.platformio/penv/bin/pio run -d firmware/edge/device`
Expected: `SUCCESS` — this downloads the `espressif8266` platform package
on first run, which can take a few minutes.

- [ ] **Step 3: Commit**

```bash
git add firmware/edge/device/platformio.ini firmware/edge/device/src/main.cpp
git commit -m "Scaffold PlatformIO project for D1 Mini device firmware"
```

---

### Task 2: `ProvisionStore` — persisted WiFi/endpoint/API key config

**Files:**
- Create: `firmware/edge/device/src/provision_store.h`
- Create: `firmware/edge/device/src/provision_store.cpp`
- Modify: `firmware/edge/device/src/main.cpp` (exercise it from `setup()` to prove it links and runs)

**Interfaces:**
- Produces:
  ```cpp
  class ProvisionStore {
   public:
    bool begin();                 // mounts LittleFS, formats if needed. Returns true on success.
    void load();                  // reads /provision.json into memory, if present
    bool save(const String& ssid, const String& password,
              const String& endpoint, const String& apiKey);  // writes JSON, returns true on success
    bool isConfigured() const;    // true when ssid, endpoint, apiKey are all non-empty
    void clear();                 // deletes /provision.json

    const String& ssid() const;
    const String& password() const;
    const String& endpoint() const;
    const String& apiKey() const;

   private:
    String ssid_, password_, endpoint_, apiKey_;
  };
  ```
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the header**

`firmware/edge/device/src/provision_store.h`:
```cpp
#pragma once

#include <Arduino.h>

class ProvisionStore {
 public:
  bool begin();
  void load();
  bool save(const String& ssid, const String& password,
            const String& endpoint, const String& apiKey);
  bool isConfigured() const;
  void clear();

  const String& ssid() const { return ssid_; }
  const String& password() const { return password_; }
  const String& endpoint() const { return endpoint_; }
  const String& apiKey() const { return apiKey_; }

 private:
  static constexpr const char* kPath = "/provision.json";

  String ssid_;
  String password_;
  String endpoint_;
  String apiKey_;
};
```

- [ ] **Step 2: Write the implementation**

`firmware/edge/device/src/provision_store.cpp`:
```cpp
#include "provision_store.h"

#include <ArduinoJson.h>
#include <LittleFS.h>

bool ProvisionStore::begin() {
  if (LittleFS.begin()) {
    return true;
  }
  Serial.println("LittleFS mount failed, formatting...");
  if (!LittleFS.format()) {
    Serial.println("LittleFS format failed");
    return false;
  }
  return LittleFS.begin();
}

void ProvisionStore::load() {
  if (!LittleFS.exists(kPath)) {
    return;
  }
  File f = LittleFS.open(kPath, "r");
  if (!f) {
    return;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    Serial.print("provision.json parse error: ");
    Serial.println(err.c_str());
    return;
  }
  ssid_ = doc["ssid"] | "";
  password_ = doc["password"] | "";
  endpoint_ = doc["endpoint"] | "";
  apiKey_ = doc["apiKey"] | "";
}

bool ProvisionStore::save(const String& ssid, const String& password,
                           const String& endpoint, const String& apiKey) {
  JsonDocument doc;
  doc["ssid"] = ssid;
  doc["password"] = password;
  doc["endpoint"] = endpoint;
  doc["apiKey"] = apiKey;

  File f = LittleFS.open(kPath, "w");
  if (!f) {
    Serial.println("Failed to open provision.json for write");
    return false;
  }
  bool ok = serializeJson(doc, f) > 0;
  f.close();
  if (ok) {
    ssid_ = ssid;
    password_ = password;
    endpoint_ = endpoint;
    apiKey_ = apiKey;
  }
  return ok;
}

bool ProvisionStore::isConfigured() const {
  return ssid_.length() > 0 && endpoint_.length() > 0 && apiKey_.length() > 0;
}

void ProvisionStore::clear() {
  LittleFS.remove(kPath);
  ssid_ = "";
  password_ = "";
  endpoint_ = "";
  apiKey_ = "";
}
```

- [ ] **Step 3: Wire a smoke check into `main.cpp`**

Replace `firmware/edge/device/src/main.cpp` with:
```cpp
#include <Arduino.h>

#include "provision_store.h"

ProvisionStore provisionStore;

void setup() {
  Serial.begin(9600);
  delay(200);
  Serial.println("Alarm system device booting...");

  if (!provisionStore.begin()) {
    Serial.println("FATAL: LittleFS unavailable");
  }
  provisionStore.load();

  Serial.print("Configured: ");
  Serial.println(provisionStore.isConfigured() ? "yes" : "no");
}

void loop() {
}
```

- [ ] **Step 4: Build to verify it compiles and links**

Run: `~/.platformio/penv/bin/pio run -d firmware/edge/device`
Expected: `SUCCESS`

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/provision_store.h firmware/edge/device/src/provision_store.cpp firmware/edge/device/src/main.cpp
git commit -m "Add ProvisionStore for persisted WiFi/endpoint/API key config"
```

---

### Task 3: `setup_page.h` — embedded captive portal HTML

**Files:**
- Create: `firmware/edge/device/src/setup_page.h`

**Interfaces:**
- Produces: `extern const char SETUP_PAGE_HTML[];` — a self-contained HTML
  page string, used by `ProvisioningPortal` (Task 4) to serve `GET /`.
  Contains `{{ERROR_BANNER}}`, `{{SSID}}`, `{{ENDPOINT}}`, `{{API_KEY}}`
  placeholder tokens that `ProvisioningPortal` replaces via simple string
  substitution before sending (documented here so Task 4 can rely on the
  exact token spelling).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the header**

`firmware/edge/device/src/setup_page.h`:
```cpp
#pragma once

// Self-contained setup page: no external assets (AP has no internet).
// Placeholders {{ERROR_BANNER}}, {{SSID}}, {{ENDPOINT}}, {{API_KEY}} are
// substituted by ProvisioningPortal before the page is served.
const char SETUP_PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alarm System Setup</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #111; color: #eee;
         margin: 0; padding: 24px 16px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.sub { color: #999; margin-top: 0; font-size: 14px; }
  form { max-width: 400px; margin: 0 auto; }
  label { display: block; margin-top: 16px; font-size: 14px; color: #ccc; }
  select, input { width: 100%; box-sizing: border-box; padding: 10px;
                  margin-top: 4px; border-radius: 6px; border: 1px solid #444;
                  background: #222; color: #eee; font-size: 16px; }
  button { width: 100%; margin-top: 24px; padding: 12px; border-radius: 6px;
           border: none; background: #2d7dff; color: white; font-size: 16px;
           font-weight: 600; }
  .error { background: #4a1414; border: 1px solid #a33; color: #f5b5b5;
           padding: 10px 12px; border-radius: 6px; margin-top: 16px; font-size: 14px; }
  .manual-toggle { font-size: 13px; color: #7aa7ff; margin-top: 8px;
                    display: inline-block; }
</style>
</head>
<body>
<h1>Alarm System Setup</h1>
<p class="sub">Connect this device to your WiFi</p>
{{ERROR_BANNER}}
<form method="POST" action="/save">
  <label for="ssidSelect">WiFi network</label>
  <select id="ssidSelect" name="ssidSelect"><option value="">Scanning...</option></select>
  <a class="manual-toggle" id="manualToggle" href="#">Network not listed? Enter manually</a>
  <input type="text" id="ssidManual" name="ssid" placeholder="SSID"
         value="{{SSID}}" style="display:none; margin-top:8px;">

  <label for="password">WiFi password</label>
  <input type="password" id="password" name="password">

  <label for="endpoint">Alarm system endpoint</label>
  <input type="text" id="endpoint" name="endpoint" value="{{ENDPOINT}}"
         placeholder="https://...">

  <label for="apiKey">API key</label>
  <input type="text" id="apiKey" name="apiKey" value="{{API_KEY}}">

  <button type="submit">Save &amp; Connect</button>
</form>
<script>
  var sel = document.getElementById('ssidSelect');
  var manual = document.getElementById('ssidManual');
  var toggle = document.getElementById('manualToggle');
  toggle.addEventListener('click', function(e) {
    e.preventDefault();
    var showManual = manual.style.display === 'none';
    manual.style.display = showManual ? 'block' : 'none';
    sel.style.display = showManual ? 'none' : '';
    sel.name = showManual ? '' : 'ssidSelect';
    manual.name = 'ssid';
  });
  fetch('/scan').then(function(r) { return r.json(); }).then(function(list) {
    sel.innerHTML = '';
    if (!list.length) {
      sel.innerHTML = '<option value="">No networks found</option>';
      return;
    }
    list.forEach(function(n) {
      var opt = document.createElement('option');
      opt.value = n.ssid;
      opt.textContent = n.ssid + ' (' + n.rssi + ' dBm)';
      sel.appendChild(opt);
    });
  }).catch(function() {
    sel.innerHTML = '<option value="">Scan failed — enter manually</option>';
  });
</script>
</body>
</html>
)HTML";
```

- [ ] **Step 2: Confirm it's syntactically inert on its own**

This file has no `.cpp`/build target yet (it's consumed in Task 4), so
there's nothing to compile standalone. Just re-read the file to confirm
the raw string literal delimiter `R"HTML( ... )HTML"` is balanced and
there's no stray `)HTML"` sequence inside the HTML/JS body (which would
terminate the literal early). Confirmed: no such sequence appears above.

- [ ] **Step 3: Commit**

```bash
git add firmware/edge/device/src/setup_page.h
git commit -m "Add embedded captive portal setup page"
```

---

### Task 4: `ProvisioningPortal` — AP, DNS captive redirect, web server routes

**Files:**
- Create: `firmware/edge/device/src/provisioning_portal.h`
- Create: `firmware/edge/device/src/provisioning_portal.cpp`
- Modify: `firmware/edge/device/platformio.ini` (add `DNSServer` — already
  bundled, no change actually needed, but verify)
- Modify: `firmware/edge/device/src/main.cpp` (start portal unconditionally
  for this task's smoke test; Task 5 wires the real boot decision)

**Interfaces:**
- Consumes: `ProvisionStore` (Task 2) — `save()`, `ssid()`, `endpoint()`, `apiKey()`. `SETUP_PAGE_HTML` (Task 3).
- Produces:
  ```cpp
  class ProvisioningPortal {
   public:
    void begin(ProvisionStore* store);   // wires the store reference, no side effects yet
    void start();                         // brings up AP + DNS + web server
    void stop();                          // tears everything down, switches to WIFI_STA
    void handle();                        // call every loop() iteration while active
    bool hasPendingSave() const;          // true once POST /save has been received
    void takePendingSave(String* ssid, String* password,
                          String* endpoint, String* apiKey);  // consumes the pending save, clears the flag
    void showError();                     // next served page includes the error banner
  };
  ```

- [ ] **Step 1: Write the header**

`firmware/edge/device/src/provisioning_portal.h`:
```cpp
#pragma once

#include <Arduino.h>
#include <DNSServer.h>
#include <ESP8266WebServer.h>

#include "provision_store.h"

class ProvisioningPortal {
 public:
  void begin(ProvisionStore* store);
  void start();
  void stop();
  void handle();

  bool hasPendingSave() const { return pendingSave_; }
  void takePendingSave(String* ssid, String* password, String* endpoint,
                        String* apiKey);

  void showError() { showError_ = true; }

 private:
  void handleRoot();
  void handleScan();
  void handleSave();
  String renderPage();

  ProvisionStore* store_ = nullptr;
  DNSServer dnsServer_;
  ESP8266WebServer webServer_{80};

  bool pendingSave_ = false;
  bool showError_ = false;
  String pendingSsid_, pendingPassword_, pendingEndpoint_, pendingApiKey_;
};
```

- [ ] **Step 2: Write the implementation**

`firmware/edge/device/src/provisioning_portal.cpp`:
```cpp
#include "provisioning_portal.h"

#include <ESP8266WiFi.h>

#include "setup_page.h"

namespace {
const IPAddress kApIp(10, 25, 0, 1);
const IPAddress kApNetmask(255, 255, 255, 0);
const char* kApSsid = "AlarmSystem-Setup";
const uint16_t kDnsPort = 53;
}  // namespace

void ProvisioningPortal::begin(ProvisionStore* store) { store_ = store; }

void ProvisioningPortal::start() {
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(kApIp, kApIp, kApNetmask);
  WiFi.softAP(kApSsid);

  dnsServer_.start(kDnsPort, "*", kApIp);

  webServer_.on("/", HTTP_GET, [this]() { handleRoot(); });
  webServer_.on("/scan", HTTP_GET, [this]() { handleScan(); });
  webServer_.on("/save", HTTP_POST, [this]() { handleSave(); });
  webServer_.onNotFound([this]() { handleRoot(); });
  webServer_.begin();

  Serial.print("Portal AP started: ");
  Serial.println(kApSsid);
}

void ProvisioningPortal::stop() {
  webServer_.stop();
  dnsServer_.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
}

void ProvisioningPortal::handle() {
  dnsServer_.processNextRequest();
  webServer_.handleClient();
}

void ProvisioningPortal::takePendingSave(String* ssid, String* password,
                                          String* endpoint, String* apiKey) {
  *ssid = pendingSsid_;
  *password = pendingPassword_;
  *endpoint = pendingEndpoint_;
  *apiKey = pendingApiKey_;
  pendingSave_ = false;
}

String ProvisioningPortal::renderPage() {
  String page(FPSTR(SETUP_PAGE_HTML));
  page.replace("{{ERROR_BANNER}}",
               showError_
                   ? "<div class=\"error\">Couldn't connect &mdash; check the password and try again.</div>"
                   : "");
  page.replace("{{SSID}}", store_->ssid());
  page.replace("{{ENDPOINT}}", store_->endpoint());
  page.replace("{{API_KEY}}", store_->apiKey());
  showError_ = false;
  return page;
}

void ProvisioningPortal::handleRoot() {
  webServer_.send(200, "text/html", renderPage());
}

void ProvisioningPortal::handleScan() {
  int count = WiFi.scanNetworks();
  String json = "[";
  for (int i = 0; i < count; i++) {
    if (i > 0) json += ",";
    json += "{\"ssid\":\"" + WiFi.SSID(i) + "\",\"rssi\":" + WiFi.RSSI(i) + "}";
  }
  json += "]";
  WiFi.scanDelete();
  webServer_.send(200, "application/json", json);
}

void ProvisioningPortal::handleSave() {
  String ssid = webServer_.arg("ssid");
  String password = webServer_.arg("password");
  String endpoint = webServer_.arg("endpoint");
  String apiKey = webServer_.arg("apiKey");

  if (ssid.length() == 0 || endpoint.length() == 0 || apiKey.length() == 0) {
    webServer_.send(400, "text/plain", "Missing required field");
    return;
  }

  pendingSsid_ = ssid;
  pendingPassword_ = password;
  pendingEndpoint_ = endpoint;
  pendingApiKey_ = apiKey;
  pendingSave_ = true;

  webServer_.send(200, "text/html",
                   "<html><body><p>Connecting&hellip; check your device.</p></body></html>");
}
```

Note: `ssidSelect` and manual `ssid` fields both post under the `name="ssid"`
attribute once the manual toggle is active (per Task 3's JS, which renames
the manual input to `ssid` and clears the select's `name`), so
`webServer_.arg("ssid")` picks up whichever one was active. When the
dropdown is used, its field is named `ssidSelect` — add that fallback:

- [ ] **Step 3: Fix the SSID field fallback in `handleSave()`**

Replace the first line of `handleSave()`:
```cpp
  String ssid = webServer_.arg("ssid");
  if (ssid.length() == 0) {
    ssid = webServer_.arg("ssidSelect");
  }
```

- [ ] **Step 4: Wire a smoke test into `main.cpp`**

Replace `firmware/edge/device/src/main.cpp` with:
```cpp
#include <Arduino.h>

#include "provision_store.h"
#include "provisioning_portal.h"

ProvisionStore provisionStore;
ProvisioningPortal portal;

void setup() {
  Serial.begin(9600);
  delay(200);
  Serial.println("Alarm system device booting...");

  if (!provisionStore.begin()) {
    Serial.println("FATAL: LittleFS unavailable");
  }
  provisionStore.load();

  portal.begin(&provisionStore);
  portal.start();
}

void loop() {
  portal.handle();
  if (portal.hasPendingSave()) {
    String ssid, password, endpoint, apiKey;
    portal.takePendingSave(&ssid, &password, &endpoint, &apiKey);
    provisionStore.save(ssid, password, endpoint, apiKey);
    Serial.println("Saved provisioning data (connect flow lands in Task 5)");
  }
}
```

- [ ] **Step 5: Build to verify it compiles and links**

Run: `~/.platformio/penv/bin/pio run -d firmware/edge/device`
Expected: `SUCCESS`

- [ ] **Step 6: Commit**

```bash
git add firmware/edge/device/src/provisioning_portal.h firmware/edge/device/src/provisioning_portal.cpp firmware/edge/device/src/main.cpp
git commit -m "Add ProvisioningPortal: AP, captive DNS redirect, setup web server"
```

---

### Task 5: Boot flow — connect-or-portal orchestration in `main.cpp`

**Files:**
- Modify: `firmware/edge/device/src/main.cpp`

**Interfaces:**
- Consumes: `ProvisionStore` (Task 2) full interface, `ProvisioningPortal` (Task 4) full interface.
- Produces: final boot behavior for this plan — no further tasks depend on new symbols from this one.

- [ ] **Step 1: Replace `main.cpp` with the full boot flow**

`firmware/edge/device/src/main.cpp`:
```cpp
#include <Arduino.h>
#include <ESP8266WiFi.h>

#include "provision_store.h"
#include "provisioning_portal.h"

namespace {
const uint8_t kForcePortalPin = 0;  // GPIO0 / FLASH button
const unsigned long kWifiConnectTimeoutMs = 15000;

ProvisionStore provisionStore;
ProvisioningPortal portal;
bool portalActive = false;

bool connectToWifi(const String& ssid, const String& password,
                    unsigned long timeoutMs) {
  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);
  WiFi.begin(ssid.c_str(), password.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > timeoutMs) {
      Serial.println("WiFi connect timed out");
      return false;
    }
    delay(250);
  }
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

void enterPortalMode() {
  portalActive = true;
  portal.begin(&provisionStore);
  portal.start();
  Serial.println("Portal mode active — waiting for setup submission");
}

void onNormalOperation() {
  Serial.println("Entering normal operation (stub)");
  // Alarm/RF logic lands here in a future task.
}
}  // namespace

void setup() {
  Serial.begin(9600);
  delay(200);
  Serial.println("Alarm system device booting...");

  pinMode(kForcePortalPin, INPUT_PULLUP);
  bool forcePortal = digitalRead(kForcePortalPin) == LOW;

  if (!provisionStore.begin()) {
    Serial.println("FATAL: LittleFS unavailable");
  }
  provisionStore.load();

  if (forcePortal) {
    Serial.println("Boot button held — forcing portal mode");
    enterPortalMode();
    return;
  }

  if (provisionStore.isConfigured() &&
      connectToWifi(provisionStore.ssid(), provisionStore.password(),
                     kWifiConnectTimeoutMs)) {
    onNormalOperation();
    return;
  }

  enterPortalMode();
}

void loop() {
  if (!portalActive) {
    return;
  }

  portal.handle();
  if (portal.hasPendingSave()) {
    String ssid, password, endpoint, apiKey;
    portal.takePendingSave(&ssid, &password, &endpoint, &apiKey);
    provisionStore.save(ssid, password, endpoint, apiKey);

    if (connectToWifi(ssid, password, kWifiConnectTimeoutMs)) {
      portal.stop();
      portalActive = false;
      onNormalOperation();
    } else {
      portal.showError();
    }
  }
}
```

- [ ] **Step 2: Build to verify it compiles and links**

Run: `~/.platformio/penv/bin/pio run -d firmware/edge/device`
Expected: `SUCCESS`

- [ ] **Step 3: Commit**

```bash
git add firmware/edge/device/src/main.cpp
git commit -m "Wire boot flow: saved WiFi or GPIO0-forced portal fallback"
```

---

## Self-Review Notes

- **Spec coverage:** Project setup (Task 1), `ProvisionStore` (Task 2),
  setup page (Task 3), `ProvisioningPortal` incl. AP/DNS/routes/error
  banner (Task 4), boot flow incl. GPIO0 force-portal and WIFI_AP_STA
  (Task 5) — all spec sections covered. Testing section is satisfied by
  each task's "build to verify" step; manual on-device verification is
  explicitly out of scope per spec (no hardware yet).
- **Placeholder scan:** none found — every step has literal code.
- **Type consistency:** `ProvisionStore` accessor names (`ssid()`,
  `password()`, `endpoint()`, `apiKey()`) match between Task 2's
  production and Task 4/5's consumption. `ProvisioningPortal::takePendingSave`
  signature matches its one call site in Task 5. `SETUP_PAGE_HTML` name
  matches between Task 3's definition and Task 4's `FPSTR` usage.
