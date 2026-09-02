# ESP32-S3 port (2026-08-27) — the fragmentation blocker is GONE

`[env:esp32s3]` in `firmware/edge/device/platformio.ini`, alongside the
still-buildable `[env:d1_mini]`. Platform differences live in
`src/platform_compat.h`; the native test env is untouched (20/20 pass).

Hardware (probed, not assumed): **ESP32-S3 QFN56 rev v0.2, 8MB embedded
PSRAM, 16MB flash, native USB-Serial/JTAG** on `/dev/cu.usbmodem1101`.
None of the D1 Mini's CH340 workarounds apply — no 115200 upload cap, no
1s EN-pulse reset.

**Verified working on hardware, end to end:** WiFi, mint
(`tokenLen=888`), RTDB auth (`app.ready() -> true`), config poll, LAN web
server (HTTP 200 in 156ms), mDNS, **and cloud event writes — confirmed by
a Telegram alert arriving from a simulated trigger.** That last step is
what was impossible on the ESP8266.

| | ESP8266 | ESP32-S3 |
|---|---|---|
| heap at mint | ~22,000 | 258,532 |
| max contiguous block after auth | ~3,400 | 192,500 |

`kMinBlockForEventWrite` (5,000) is now far below the floor, so the gate
never trips. A 3,529ms TLS handshake also completed cleanly — that would
have tripped the ESP8266's ~3s software watchdog.

**ESP32-specific gotchas, all measured:**
- `-DARDUINO_USB_CDC_ON_BOOT=1` is REQUIRED for serial. The
  esp32-s3-devkitc-1 profile sets `ARDUINO_USB_MODE=1` but not this, so
  `Serial` binds to UART0 and the monitor is silent while flashing works
  perfectly — looks exactly like a boot loop.
- `setup()` must wait (bounded) for the USB CDC endpoint before its first
  print; native USB is not a UART and does not exist until the host
  enumerates it ~1s after reset.
- `board_build.partitions = default_16MB.csv` (profile assumes 8MB) and
  `board_build.filesystem = littlefs` (PlatformIO defaults `-t uploadfs`
  to SPIFFS, which `provision_store.cpp` cannot read).
- **PSRAM is deliberately OFF.** The stock profile is the N8 "No PSRAM"
  variant. Enabling it with `memory_type = qio_qspi` made the board boot
  SILENTLY — confirmed by A/B, that one line added -> no output, removed
  -> normal boot. Not needed: 61KB of 327KB internal SRAM is ample.
- ESP32 `EEPROM` has no `getConstDataPtr()`; `WiFiClientSecure` has no
  `setBufferSizes()` (mbedTLS, not BearSSL).
- `EepromStore::kMagic` needed a local copy before `memcpy` — taking a
  `static constexpr` member's address only links implicitly from C++17,
  and the ESP32 core builds at gnu++11.

**A full day was lost to a disconnected antenna.** The board scanned and
listed APs at -46dBm (receive is passive) but could not transmit strongly
enough for any AP to hear its auth reply, giving `reason=2 AUTH_EXPIRE`
against every network. Diagnostic rule learned: an identical failure
across multiple APs, multiple boards AND a minimal control sketch is the
shared *physical* layer, not software or AP config. Check the antenna
before touching router settings.

Useful diagnostics now in `connectToWifi()`: password FNV-1a fingerprint
(never the secret), decoded `STA_DISCONNECTED` reason codes, per-AP auth
mode, and strongest-BSSID pinning.

**Two hard-won constraints in `CloudClient`, both measured:**
- *The data client must NOT be destroyed between operations.*
  `FirebaseApp::loop()` walks a global client vector by address
  (`cvec_address_list` -> `staticLoop`) that `RealtimeDatabase` populated
  when the request was issued. Deleting the client after a request left that
  walk touching freed memory -> Exception 29 (StoreProhibited) on the SECOND
  event, *after* the first had already written successfully. Calling
  `stopAsync(true)` and draining `app_.loop()` first did NOT make it safe
  (still crashed at 11,424 bytes free — never a shortage).
- *Reuse must never be gated on free heap.* An earlier version checked
  `maxFreeBlockSize` before reusing the existing client, which wedged the
  device completely: at ~4KB contiguous every poll AND every event was
  skipped. Once the client exists its buffers are allocated; only the first
  allocation needs headroom.
- *Polling cadence is a heap budget, not a latency preference.* At a 5s
  cadence the board died with `Unhandled C++ exception: OOM` on a
  **540-byte** allocation inside `MDNSResponder::_readRRAnswer` — mDNS could
  not parse an inbound packet because the cloud path had eaten everything.
  15s leaves that margin. Remote command latency is therefore up to ~30s;
  LAN arm/disarm via the local web server is instant and unaffected.

**A silent-failure bug worth remembering:** `database_.set()` returns a bool
that was being discarded, so failed writes still logged "done" and the
device looked healthy while events never reached RTDB. Always check it.

**Unpaired sensors are intentionally kept in RTDB.** `onSensorEvent` skips
only the *Firestore mirroring* for an unknown `rfId` — the RTDB event stays,
and the web UI's Sensors tab reads `/{projectId}/events` directly to list
unrecognised ids for pairing (`web/src/features/configure/unknownSensors.ts`).
Dropping the RTDB node would make new sensors impossible to discover.

CC1101 decode is **confirmed working** (see "CC1101 bring-up" section below), and
`RelaySiren` is untested (no siren wired).
