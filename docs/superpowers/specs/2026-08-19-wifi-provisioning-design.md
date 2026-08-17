# WiFi Provisioning (AP Setup Portal) — Design
_2026-08-19_

## Overview

First real D1 Mini firmware module (beyond the Arduino Uno decode spike).
On boot, if the device has no saved WiFi credentials or fails to connect,
it opens a WiFi access point at `10.25.0.1` with a captive-portal setup
page. The page lets the user pick a WiFi network (scanned live), enter its
password, and enter the alarm system endpoint + API key. On successful
save + connect, the AP closes and the device continues on the home WiFi.

This task is firmware-only, no hardware in the loop yet — code must build
and be structurally sound, but end-to-end verification happens later once
the CC1101 / D1 Mini are wired up.

Not connected to alarm/sensor logic yet — this module's only job is to get
the device onto WiFi with a stored endpoint + API key. What happens after
("normal operation") is a stub / log line for now.

## Project Setup

New PlatformIO project at `firmware/edge/device/`:
- `platformio.ini` — platform `espressif8266`, board `d1_mini`, framework
  `arduino`. Libraries: built-in `ESP8266WiFi`, `ESP8266WebServer`,
  `DNSServer`, `LittleFS` (all bundled with the ESP8266 Arduino core — no
  external lib dependencies needed for this module).
- `src/main.cpp` — entry point / boot flow.
- `src/provision_store.h` / `.cpp` — persisted config.
- `src/provisioning_portal.h` / `.cpp` — AP + captive portal + web server.
- `src/setup_page.h` — embedded HTML/CSS for the setup page (raw string
  literal, `PROGMEM` if needed for size).

This directory is independent of `firmware/edge/kerui_decoder.h` and
`firmware/edge/spike_decode/` (Arduino Uno spike code, untouched).

## Components

### 1. `ProvisionStore`

Owns persisted provisioning data on LittleFS.

**Data:** `{ ssid, password, endpoint, apiKey }` stored as JSON at
`/provision.json`.

**Interface:**
- `begin()` — mounts LittleFS (formats on first boot if unformatted).
- `load()` — reads `/provision.json` into memory, if present.
- `save(ssid, password, endpoint, apiKey)` — writes JSON to LittleFS.
- `isConfigured()` — true when `ssid`, `endpoint`, and `apiKey` are all
  non-empty (password may legitimately be empty for open networks).
- `clear()` — deletes the file (not wired to anything yet; for future
  reset support).
- Accessors for the four fields.

Plain-text storage, no encryption — consistent with how arm state and
config are already handled in EEPROM per the main design doc, and
physical access to the device already allows flash extraction regardless.

### 2. `ProvisioningPortal`

Owns the AP + captive portal + web server lifecycle. Used only while the
device is not on WiFi.

**Startup (`start()`):**
- `WiFi.mode(WIFI_AP)`
- `WiFi.softAPConfig(IPAddress(10,25,0,1), IPAddress(10,25,0,1), IPAddress(255,255,255,0))`
- `WiFi.softAP("AlarmSystem-Setup")` — open network, no AP password (setup
  is the only thing exposed, and requiring a printed default password
  adds friction with no real security benefit here)
- `DNSServer` started on port 53, wildcard `*` → `10.25.0.1` (captive
  portal redirect so phones auto-prompt the sign-in page)
- `ESP8266WebServer` started on port 80 with routes:
  - `GET /` and unmatched paths (`onNotFound`) → setup page (captive
    portal detection on iOS/Android probes various paths; routing
    everything to the same page satisfies that)
  - `GET /scan` → triggers `WiFi.scanNetworks()`, returns JSON array of
    `{ ssid, rssi }`, sorted by signal strength, deduplicated by SSID
  - `POST /save` → see Save Flow below

**Loop (`handle()`):** called every iteration of the main loop while in
portal mode; services `DNSServer::processNextRequest()` and
`ESP8266WebServer::handleClient()`.

**Shutdown (`stop()`):** stops the web server, stops DNS server,
`WiFi.softAPdisconnect(true)`, `WiFi.mode(WIFI_STA)`.

### 3. Setup Page (`setup_page.h`)

Single self-contained HTML page, inline `<style>`, no external assets (AP
has no internet access). Minimal, mobile-friendly styling — usable on a
phone screen.

**Fields:**
- WiFi network — populated from `GET /scan` via JS `fetch()`, rendered as
  a `<select>` (falls back to manual text entry if scan returns nothing
  or user prefers — a "network not listed?" toggle reveals a text input)
- WiFi password — password-type input
- Alarm system endpoint — text input (e.g. Cloud Function base URL)
- API key — text input
- Submit button → `POST /save` with form-encoded body

**Error state:** page accepts an `?error=1` query param; when present,
renders a banner ("Couldn't connect — check the password and try again")
above the form. Form fields are not pre-filled with the previous
password (security hygiene) but SSID/endpoint/API key may be pre-filled
from the last attempt for convenience.

### 4. Boot Flow (`main.cpp`)

```
setup():
  Serial.begin(...)
  pinMode(GPIO0, INPUT_PULLUP)
  provisionStore.begin(); provisionStore.load()

  forcePortal = (digitalRead(GPIO0) == LOW)   // held during boot

  if (!forcePortal && provisionStore.isConfigured()):
    if connectToWifi(15s timeout): goto normalOperation
    // else fall through to portal

  enterPortalMode()   // blocks until connected

normalOperation:
  log "connected, IP: ..."
  // stub — alarm/RF logic lands here in a future task

enterPortalMode():
  portal.start()
  loop:
    portal.handle()
    if portal.hasPendingSave():
      creds = portal.takePendingSave()
      provisionStore.save(creds)
      if connectToWifi(15s timeout):
        portal.stop()
        return   // → normalOperation
      else:
        portal.showError()  // sets error flag; next GET / includes ?error=1
        // stay in loop, AP remains open
```

`connectToWifi(timeoutMs)`: `WiFi.begin(ssid, password)`, poll
`WiFi.status()` until `WL_CONNECTED` or timeout; returns bool. Runs with
the AP still up during the attempt (ESP8266 supports `WIFI_AP_STA` mode)
so the portal stays reachable if the attempt fails — avoids a dead period
where the user's phone shows "AP" but nothing responds.

### 5. GPIO0 Re-entry (future-facing, not wired to anything else)

Holding the FLASH button (GPIO0) during boot forces portal mode even if
valid credentials are stored, enabling reconfiguration later. This is the
only re-entry mechanism in scope — no remote/RTDB-triggered reset in this
pass.

## Data Flow

```
boot
 │
 ├─ GPIO0 held? ──yes──────────────┐
 │       no                        │
 ▼                                  │
saved config exists? ──no──────────┤
 │yes                               │
 ▼                                  │
WiFi.begin() (15s timeout)          │
 │success        │fail              │
 ▼               └──────────────────┤
normal op                           ▼
                          AP 10.25.0.1 (WIFI_AP_STA)
                          + DNSServer captive redirect
                          + web form (GET /, GET /scan)
                                     │
                          POST /save (ssid/pw/endpoint/apiKey)
                                     │
                          save to LittleFS
                                     │
                          WiFi.begin() (15s timeout)
                           │success        │fail
                           ▼               ▼
                      stop AP,        error banner on
                      normal op       reopened form, retry
```

## Error Handling

- WiFi connect timeout/failure → reopen form with `?error=1`, no reboot
  required, AP/portal stays up throughout (never a dead window).
- `POST /save` with missing required fields (ssid, endpoint, or apiKey
  empty) → `400`, re-render form with a validation message, no LittleFS
  write.
- LittleFS mount failure → format and retry once; if that fails, log to
  Serial and fall back to portal mode (nothing can be loaded, so treat as
  unconfigured).

## Testing

Hardware-dependent (WiFi radio, AP, LittleFS) — no meaningful unit tests
for this module. Verification is manual, once hardware is available:
build via `pio run`, flash to D1 Mini, confirm AP `AlarmSystem-Setup`
appears, connect a phone, confirm captive portal prompt (or browse to
`10.25.0.1`), submit valid credentials, confirm device joins WiFi and AP
closes; separately verify the wrong-password path shows the error banner
and lets retry without power-cycling.

This task's own definition of done is: code compiles cleanly under
PlatformIO (`pio run`) — actual on-device behavior is verified later.

## Out of Scope

- Alarm/RF/sensor logic — stubbed as "normal operation" placeholder
- Firebase/Cloud Function calls using the saved endpoint/apiKey
- Remote or RTDB-triggered reconfiguration
- Encrypted credential storage
- OTA updates
