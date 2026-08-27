# Alarm System — Project Context

## What This Is

A self-owned home alarm system to replace dependency on Tuya/Kerui cloud. Existing Kerui W184 hub and sensors stay in place during transition — new system runs in parallel.

## Hardware

| Component | Status | Notes |
|---|---|---|
| ESP8266 D1 Mini | On hand, flashed | Edge controller — confirmed ESP8266, not ESP32 |
| CC1101 433MHz module | **Wired and working** | RF receive confirmed — decodes Kerui packets end-to-end |
| Kerui W184 hub | Existing, keep running | 192.168.0.46 on LAN |
| Kerui sensors | Existing, untouched | 433MHz RF, 24-bit OOK packets |
| Arduino Uno | On hand | Backup / spike testing |
| Physical siren | TBD | Wired via relay to D1 Mini GPIO |

## Architecture

**Edge (D1 Mini + CC1101 firmware):** `firmware/edge/device` — built, compiles clean, boots on real hardware and authenticates to Firebase (see Current Status).
- Listens to 433MHz Kerui sensor packets continuously (`Cc1101Receiver` + `kerui_decoder.h`)
- Decodes using Kerui protocol (24-bit OOK, timing-based)
- Arm state + config + local-web-toggle persisted to EEPROM (`EepromStore`) — survives power loss and WiFi outage
- Alarm logic (`AlarmState`): if armed + sensor conditions met → fire siren via GPIO relay (`RelaySiren`)
- WiFi optional: when connected, publishes events to Firebase RTDB and polls commands/config every 15s (`CloudClient`, using `mobizt/FirebaseClient`). Polling, not SSE — see the RAM note in Current Status.
- **Local web server** (`LocalWebServer`, LAN-only, no auth, `http://local.alarm.local`): arm/disarm and a sensor-trigger simulator, works fully offline (no internet needed) — toggle (`localWebEnabled`) lives in EEPROM, defaults on

**Firebase (backend):** deployed to project `alarm-system-100`, region `europe-west1`.
- Realtime Database for events, state, config, commands (namespaced per project) — thin, index-based config wire format (`{a, d, r, c}`, not the old verbose named-key shape)
- Firestore for structured app data (users, projects, sensors, profiles, rules, timeline)
- Cloud Functions: `deviceIngest` (legacy/simulated-event path, still used by `smoke/`), `mintDeviceToken` (device RTDB custom-token auth — deployed and **working from real hardware** as of 2026-08-20), event mirroring, server-side alarm evaluation, config sync, Telegram alerts, dead sensor detection
- Hosting: `https://alarm-system-100.web.app` — web UI for arm/disarm, sensor pairing, rule config, event timeline

**Telegram bot:**
- Alerts: sensor trigger, alarm, battery low, dead sensor
- Commands: /arm /disarm /status /siren off
- **Webhook not registered yet** — bot won't answer commands (see `todo.txt`)

## Sensor Trigger Conditions (config-driven)

Rules live under a profile; a profile is armed independently on the device and
on the server. Rules are OR'd — a sensor may appear in several rules of the same
profile. Condition types:
- `immediate` — single trigger fires alarm
- `count_in_window` — N triggers within W seconds
- `entry_delay` — grace period to disarm before alarm fires
- `multi_sensor` — several sensors, each with its own required trigger count
  (default 1), all of which must be met within one shared window (AND)

## Firebase Data Layout

Everything is multi-tenant: RTDB paths are namespaced under `{projectId}`, and
Firestore holds the structured app data.

**Realtime Database (device-facing):**
```
/{projectId}/events/{rfId}/{timestamp}  → { event, battery_low, rssi }
/{projectId}/state/armed                → bool
/{projectId}/state/siren_active         → bool
/{projectId}/commands/armed             → bool
/{projectId}/commands/siren             → bool
/{projectId}/config                     → { a: bool, d: number, r: string[], c: Condition[][] }
                                           (thin, index-based — see functions/src/buildConfig.ts)
```

**Firestore (app data):** `/users/{email}`, `/deviceKeys/{apiKeyHash}`,
`/projects/{projectId}` with `members`, `sensors`, `profiles/{id}/rules`, and
`events` subcollections. See the Firebase design spec for full field lists.

**Device auth (two paths):**
- `deviceIngest` (HTTPS, API-key auth) — legacy/simulated event-write path, still used by `smoke/` scripts. Not used by the real firmware anymore.
- `mintDeviceToken` (HTTPS, API-key auth) → returns `{ customToken, projectId }`, a Firebase custom token the device exchanges for RTDB access, scoped per-project via `database.rules.json`. **This is the real firmware's path — see the blocking issue below.**

## Siren Control (phased)

- Phase 1: GPIO pin → relay → siren — built (`RelaySiren`), untested (no siren wired yet)
- Phase 2: Sniff W184 siren RF packet with CC1101, replay it wirelessly —
  **RF transmit solved and proven (2026-08-28); not yet in the main firmware.**
  See "CC1101 transmit" below. Captured siren codes are static and replayable.

## Project Structure

```
firmware/edge/
  kerui_decoder.h          ← Kerui 433MHz decode logic + KeruiPacket struct
                              (bounded sync-wait loops — see Current Status)
  spike_decode/
    spike_decode.ino       ← Test sketch: prints sensor IDs via Serial Monitor
  device/                  ← D1 Mini main firmware (PlatformIO, esp8266/d1_mini)
    platformio.ini
    src/
      main.cpp                  ← boot flow, loop() wiring all components together
      provision_store.h/.cpp    ← LittleFS-persisted ssid/password/endpoint/databaseUrl/apiKey
      provisioning_portal.h/.cpp ← AP (10.25.0.1) + captive DNS + setup web server
      setup_page.h               ← embedded HTML setup page
      alarm_state.h/.cpp         ← Config/Condition structs + condition evaluation
      eeprom_store.h/.cpp        ← persists armed/localWebEnabled/Config
      cc1101_receiver.h/.cpp     ← SPI CC1101 RX feeding kerui_decoder.h
      relay_siren.h/.cpp         ← GPIO relay + auto-off timer
      cloud_client.h/.cpp        ← FirebaseClient wrapper: mint token, RTDB poll, event report
      config_parser.h/.cpp       ← pure JSON→Config parsing (native-testable)
      local_web_server.h/.cpp    ← LAN arm/disarm + sensor-trigger simulator
      local_web_page.h           ← embedded HTML for the local web server
    test/                        ← PlatformIO native env, Unity tests (20 tests, 3 suites)
web/                       ← React + TypeScript app (Vite), Firebase Hosting
  src/app/                 ← providers (auth, project), router, layout
  src/features/            ← auth, setup, configure, operations, explore, simulator
  src/lib/                 ← firebase init, typed Firestore/RTDB helpers
  src/types/               ← shared domain types (RtdbConfig mirrors functions/src/types.ts)
functions/                 ← Cloud Functions (TypeScript, gen-2, europe-west1)
smoke/                     ← emulator smoke test + manual event-firing scripts (uses deviceIngest)
firestore.rules, database.rules.json, firebase.json
docs/hardware-wiring.md    ← CC1101/relay pin-by-pin wiring + wire colours,
                              and the ESP32-S3 pins that must NOT be used
docs/superpowers/specs/
  2026-08-17-alarm-system-design.md              ← Firmware/edge architecture
  2026-08-18-firebase-webui-telegram-design.md   ← Cloud + web UI architecture
  2026-08-19-wifi-provisioning-design.md         ← AP setup portal design
  2026-08-19-firmware-rf-alarm-cloud-design.md   ← RF decode/alarm/cloud sync design
docs/superpowers/plans/
  2026-08-19-firmware-rf-alarm-cloud.md          ← implementation plan (11 tasks, done, merged)
  2026-08-19-local-web-server.md                 ← implementation plan (4 tasks, done, merged)
```

## Current Status / Next Steps

**RESOLVED (2026-08-20): the mint/WDT crash is fixed.** The device now
boots, mints its custom token, and stays up. Kept here because the root
cause is non-obvious and easy to reintroduce.

**Root cause: cont-stack exhaustion, not heap.** `loop()` runs on the
ESP8266's 4KB cont stack and is entered with ~1568 bytes left. GCC gives a
function ONE frame, sized for its worst-case path and allocated in full on
entry — so when `main.cpp`'s `loop()` inlined its helpers (a ~2.4KB
`Config`, `KeruiPacket` + decoder buffers, `String` temporaries), all those
locals merged into a single frame. By the time `CloudClient::loop()` ran the
mint, BearSSL's TLS handshake had **992 bytes** to work with. It could not
proceed, so it never yielded, so the ~3s software watchdog fired. That
presented as a *hang* inside `_run_until` rather than a clean allocation
failure, which is what made it look like a network or heap bug for so long.

**The fix** (`firmware/edge/device/src/main.cpp`):
- `handleSensorEvent`, `applyArmedCommand`, `pollCc1101`, and
  `applyPendingConfigUpdate` are marked `__attribute__((noinline))`. This is
  load-bearing, not a hint — it keeps each frame alive only while its call
  is on the stack.
- `cloudClient.loop()` is called FIRST in `loop()`, so the mint runs at the
  shallowest depth available.
- Handshake headroom went **992 → 3440 bytes**; `connect()` now succeeds in
  ~1.5s, and a 4596ms handshake was observed completing with no reset.

A second, independent bug was hiding behind it: `mintCustomToken()` parsed
its response with a `StaticJsonDocument<2048>` — a 2KB **stack** object in a
function with ~3.4KB total. HTTP 200s were being discarded as parse
failures. Now a heap-backed `JsonDocument`, parsed in place at the body
offset (no `substring()` copy).

**Measured facts — do not re-litigate without new evidence:**
- *Heap is not the constraint.* Fails at 22,008 free / 22,136 max block,
  succeeds at 23,192. A ~1KB delta cannot explain an 8.2KB allocation.
  Fragmentation was 1-2% in every run, good and bad. (An older note claimed
  the device crashed with MORE free heap than `spike_mint`. That was a
  mismeasurement — the spike runs at ~36,360 free, not ~20KB. The device
  always had less.)
- *A slow handshake is not fatal.* `spike_mint` completed one in **4093ms**,
  past the watchdog window, with no reset. BearSSL yields correctly while it
  is making progress. Being *stuck* is what kills it.
- *Not the board.* A second D1 Mini reproduced the crash identically.
- Also ruled out: TLS buffer size (1024/1024 still hung), LittleFS staying
  mounted, `cc1101.poll()` and its floating GDO0, the local web server,
  Cloud Function latency (<1s, warm), `CloudClient`'s object shape, and the
  device binary's statics (the mint succeeds in that same binary when
  `loop()` is shallow).

**Two measurement traps, recorded so nobody repeats them:**
- `ESP.getFreeContStack()` is a high-water mark, not live headroom — it
  reads 0 at the top of a perfectly healthy `loop()`. Measure live headroom
  as `(&local - g_pcont->stack)`; `cloud_client.cpp` keeps a probe that
  prints it on every mint as a regression guard.
- Adding a diagnostic `WiFi.hostByName()` before `connect()` warms lwIP's
  DNS cache and masks the failure, making it look like a DNS bug.

`-DCONT_STACKSIZE=8192` boot-loops this board — do not re-enable
(see `platformio.ini`). The `noinline` fix makes it unnecessary.

**Hardware bring-up commands** (device on `/dev/cu.usbserial-110`, 115200):

```bash
cd firmware/edge/device && pio run -e d1_mini -t upload --upload-port /dev/cu.usbserial-110
# NOTE: bare `pio run` also builds [env:native], which fails to link
# (no _main outside a test run). Always pass -e d1_mini. Tests: pio test -e native

# Readable serial capture (filters stack-dump hex); --reset toggles DTR/RTS.
python3 firmware/edge/read_serial.py 40 --reset
```

`platformio.ini` pins `upload_speed = 115200`. At the 460800 default this
CH340 fails partway through the stub upload (`A fatal error occurred:
Invalid head of packet (0x01)`) while esptool's own `chip_id` probe at
115200 works fine — that failure looks like dead hardware and is not.

`read_serial.py`'s reset holds EN low for 1s. A shorter pulse is NOT
reliable on this adapter — it leaves the board silent even at the ROM's
74880 baud, which looks exactly like dead hardware. The CH340 also
occasionally drops off the USB bus after many rapid flash cycles; replug it.

**Decoding crash addresses:**

```bash
~/.platformio/packages/toolchain-xtensa/bin/xtensa-lx106-elf-addr2line \
  -pfiaC -e .pio/build/d1_mini/firmware.elf 0x4021864a
```

`firmware/edge/spike_mint/` remains as a known-good minimal control (mint +
RTDB write/read). `spike_mint/src/local_secrets.h` is gitignored but present
on this machine. `device/data/provision.json` (gitignored) can pre-seed
LittleFS via `pio run -t uploadfs`, but note it landed at an offset the
firmware did not read on the second board — the setup portal is the reliable
path.

**Cloud sync works, but only with TWO TLS connections — not four.** The
original design used four `WiFiClientSecure` objects (auth, write, commands
SSE, config SSE). That does NOT fit: constructing them costs ~11.8KB,
dropping the heap from 21,568 to 9,808, after which BearSSL fails a
3424-byte allocation per handshake and the firmware dies with
`Unhandled C++ exception: OOM` in `_connectSSL`. `setBufferSizes(512,512)`
on all four did not save it — the number of *simultaneous* TLS connections
is the constraint, not their buffer size.

`spike_mint` was the clue: it does mint + RTDB auth + write + read on this
same board using only **two** clients and no SSE. `CloudClient` now matches
that shape — one auth client, one shared data client — and polls `/config`
and `/commands` alternately every 3s instead of streaming. Verified on
hardware: `app.ready() -> true`, `config updated (19 bytes, 0 sensors)`
polled from RTDB, stable for 70s+ with no resets, LAN web server still
serving throughout.

Trade-off: remote arm/disarm now has up to ~6s latency (two poll slots)
instead of being pushed. Acceptable for now; SSE becomes viable again on
hardware with more RAM.

**RESOLVED on ESP32-S3 (2026-08-27) — see "ESP32-S3 port" below. The rest
of this section describes the ESP8266, where it is still true.**

**Cloud event writes DO NOT work on ESP8266 hardware — heap fragmentation.**
This was the blocker that prompted the ESP32 order
(2026-08-20). Everything else on the cloud path works: mint, RTDB auth, and
polling `/config` and `/commands`. Only `reportEvent()`'s TLS write is
disabled, behind the `kMinBlockForEventWrite` floor, because attempting it
below ~5KB contiguous **resets the board** (Exception 29) instead of failing
cleanly.

Measured with `umm_info()` (the tool that finally settled this —
`getFreeHeap()` cannot see the problem):

| point | free | largest block | frag metric |
|---|---|---|---|
| at `app.ready()` | 15,072 | 10,568 | 54 |
| after 1st poll | 4,824 | 3,400 | 32 |
| after close | 10,648 | 3,472 | 50 |

After the first TLS cycle the largest contiguous block settles at ~3.4KB and
never recovers, even with ~10KB free. Small polls (51- and 14-byte reads)
fit; an event write does not. `umm_malloc` has no compaction.

Tried, measured, insufficient: eager client allocation at auth time (helps
polling — kept), `stop()` between operations to free BearSSL's buffers (frees
them, but reconnecting re-cuts from a fragmented heap: frag 32 -> 50 per
close), destroy-and-recreate (crashes — dangling entry in `FirebaseApp`'s
global client vector), and smaller `setBufferSizes`.

**Consequence on ESP8266:** a real sensor trigger fires the local siren and
updates LAN state, but produces no Firestore timeline entry and no Telegram
alert. Local alarm logic, EEPROM persistence and LAN arm/disarm are
unaffected and work offline.

---

## ESP32-S3 port (2026-08-27) — the fragmentation blocker is GONE

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

---

## CC1101 bring-up (2026-08-27) — RF decode confirmed end-to-end

CC1101 wired to ESP32-S3 (GPIO10=CS, GPIO12=SCK, GPIO11=MOSI, GPIO13=MISO, GPIO4=GDO0).
PARTNUM=0x00, VERSION=0x14 confirmed over SPI. MARCSTATE=0x0D (RX) confirmed.

**Kerui 433MHz protocol — measured from real hardware:**
- IOCFG0=0x0D (async serial): GDO0 idles LOW, pulses for data
- **Delimiter**: long LOW ~12,400µs between packet repetitions (NOT a long HIGH)
- After delimiter: 24 pairs of `(HIGH ~400µs)(LOW encodes bit)`
- **Bit encoding**: SHORT LOW ~400µs = bit 1, LONG LOW ~1200µs = bit 0
- Threshold 700µs cleanly separates short from long
- Packet repeats 5-7 times per sensor trigger (~300ms total burst)
- **24-bit layout**: top 20 bits = sensor identity, bottom 4 bits = event state flags
  - `0x2E5B73` = door closed, `0x2E5B79` = door opened (same sensor, different nibble)
  - Full 24-bit ID kept in RTDB — web UI can pair open and close independently

**`Cc1101Receiver` architecture (interrupt-based, not polling):**
- ISR on GDO0 CHANGE captures `(timestamp, level)` pairs into a 1024-entry ring buffer
- `poll()` drains the buffer after 600ms of silence OR >800 edges accumulated
- `decodeEdges()` finds all `long-LOW` delimiters, decodes 24 bits after each, majority-votes
- Requires ≥2 matching copies for a valid decode (noise rejection)
- 3s debounce on the same sensor ID prevents one physical trigger from counting multiple
  times in `count_in_window` rules

**Capture rate**: ~100% at sensor distance 10cm with antenna connected.
`almostFull` trigger (>800 edges) prevents misses when the 600ms window is tight.

**`spike_cc1101/`**: standalone diagnostic sketch used to develop and validate the
decode logic. Captures raw edges via interrupt, dumps burst timing, decodes packets.
Keep as a known-good minimal control for future RF debugging.

---

## CC1101 transmit (2026-08-28) — works, via the FIFO (NOT GDO0)

Board-to-board TX confirmed: `0x622374` transmitted from one ESP32-S3+CC1101
and decoded correctly by a second one, **5/5 trials**. Not yet integrated into
the device firmware — that is the next task.

**Captured W184 siren codes** (app-triggered SOS on, then off). Same 20-bit
identity / 4-bit command split as the door sensors:

| code | identity | nibble | reading |
|---|---|---|---|
| `0x622374` | `0x62237` | 4 | activate |
| `0x3F0108` | `0x3F010` | 8 | activate |
| `0x622372` | `0x62237` | 2 | deactivate |
| `0x3F0102` | `0x3F010` | 2 | deactivate |

Static, not rolling — `0x622372` repeated three times byte-identical. Two
distinct transmitters; which one drives the siren is **still unknown** (there
is no SOS remote, so both are mains-side). Untested against the real siren.

**Three findings, all measured — do not re-litigate:**

1. **Async serial TX via GDO0 does not work on this wiring.** RX is fine
   (the chip *drives* GDO0), but the ESP32 driving data *into* it radiates
   nothing. RSSI settles it: continuous carrier via GDO0 reads **-86dBm** at
   a receiver 10cm away (the noise floor); FIFO TX reads **-19dBm**. Every
   register reads back correct (`IOCFG0=0x2D`, `MARCSTATE=0x13`) the whole
   time — the chip claims to transmit and does not. GDO2, the conventional
   async-serial input pin, is **not connected** on this module
   (`docs/hardware-wiring.md`). Use the TX FIFO in normal packet mode.

2. **`FREND0` (0x22) must be `0x11`.** For OOK the PA switches between
   PATABLE[0] (off) and PATABLE[1] (on); FREND0's PA_POWER field selects the
   "on" index. Unset, the PA has no off entry and holds continuous carrier —
   a commanded 50ms pulse arrived as **158ms**. With `FREND0=0x11` and
   `PATABLE = {0x00, 0xC0}`, 50ms arrives as **50.088ms**.

3. **The received pulse width tracks the GAP, not the pulse.** The OOK
   demodulator's decay dominates: gap 500us gave uniform ~640us received
   pulses, gap 1500us gave uniform ~2030us — *independent of the transmitted
   pulse width*, even at a 12.5x ratio. So encode the bit in the carrier-OFF
   gap and keep the keying pulse constant. Working frame:

   ```
   delimiter: 6ms carrier ON, then 1.5ms off
   per bit:   gap (400us = bit 1, 1200us = bit 0), then a 300us keying pulse
   ```

   A full 12.4ms delimiter **saturates the AGC** and flattens every following
   pulse to a uniform width; 6ms still passes the receiver's >5ms delimiter
   test without saturating.

**Measurement trap:** the 433MHz band here is noisy — with the transmitter
silent the receiver still logs ~1156 edges of ~53us pulses. Establish that
baseline BEFORE interpreting a weak capture. Hours were lost tuning registers
against ambient noise that was mistaken for a weak signal.

**Also learned:** a single CC1101 cannot cleanly receive its own transmission,
so loopback cannot verify TX framing. Use two boards.

Diagnostic sketches (throwaway, kept as known-good controls):
- `spike_siren_tx/` — menu-driven transmitter: `g` sends a Kerui packet,
  `f` FIFO test, `o` continuous carrier, `v` raw pulse-width probe,
  `d` GPIO drive test, `z` timing self-check, plus register sweeps
- `spike_rx_monitor/` — independent receiver: per-burst RSSI, pulse-width
  census, ON-run widths, noise filtering
- `spike_siren_sniff/` — assumption-free sniffer (framing-agnostic)
- `txrx_test.py` — drives both boards at once; `python3 txrx_test.py <cmd> <secs>`

Note the boards enumerate as `/dev/cu.usbmodem101` and `/dev/cu.usbmodem1101`;
macOS reassigns those suffixes per port/session, so check `ls /dev/cu.*`.

---

Done:
- Web app: auth, project setup, sensor pairing, profiles/rules, operations
  (arm/disarm per profile), event timeline, dev simulator
- Cloud Functions: event ingest + mirroring, server-side alarm evaluation,
  config sync, arm/disarm notifications, dead-sensor check, Telegram alerts,
  `mintDeviceToken` (device RTDB auth) — all deployed to `alarm-system-100`
- Invite-only access model, per-project Telegram config
- ESP32-S3 firmware — WiFi provisioning, CC1101 RF decode (interrupt-based,
  confirmed end-to-end with real Kerui sensors), alarm-condition evaluation
  (native-tested), EEPROM persistence, relay siren (built, untested), cloud
  sync via `CloudClient`, local LAN web server for arm/disarm/simulation.
  Boots on real hardware, mints its Firebase custom token, serves the local
  web UI, decodes real sensor packets and writes events to Firebase with
  Telegram alerts confirmed. ESP8266 `[env:d1_mini]` still builds.
- 20 native unit tests (PlatformIO `[env:native]`, 3 suites: alarm_state,
  eeprom_store, config_parser) — all passing

Next (in order):
1. **Port CC1101 transmit into the device firmware** — use the SPEC-SHAPED
   frame from `spike_clean_tx` (see "Sounding the siren, hub-free" below), NOT
   the bit-in-the-gap encoding from `spike_siren_tx`, which does not drive the
   siren. `Cc1101Receiver` needs a TX counterpart and an RX/TX mode switch.
2. Wire a relay + siren, verify `RelaySiren` end-to-end (optional now that RF
   siren control works)
3. Run in parallel with W184
4. Register the Telegram webhook so bot commands work (see `todo.txt`)
5. Decommission W184

---

## Sounding the siren, hub-free (2026-08-28) — SOLVED

**The siren sounds and silences from our own CC1101, with the W184 uninvolved.**
It is paired to BOTH the panel and our transmitter at once — learn mode on this
unit is additive, so the existing hub pairing survived.

Working implementation: **`firmware/edge/spike_clean_tx`**, written from the
EV1527 spec alone. `spike_siren_tx` does NOT drive the siren and its
bit-in-the-gap encoding should not be reused.

**Root cause of the long failure: circular tuning.** `spike_siren_tx`'s bit
shape had been tuned so that OUR RECEIVER decoded our transmissions the same way
it decoded the panel's — but that receiver's decode rule came from those same
captures. The transmitter was optimised to agree with our own decoder's
interpretation: self-consistent, and wrong about the wire. Re-reading the code
could never surface this; only a from-spec rewrite did.

**The frame that works:**

```
sync   : 1T carrier pulse, then 31T silence
bit 1  : 3T carrier ON + 1T off
bit 0  : 1T carrier ON + 3T off
T      = 300us, 4 FIFO chips per T, DRATE solved from the datasheet formula
polarity: kCarrierBit = 1 (measured — the inverse yields malformed frames)
```

**Pairing:** short click on the siren's SET button (lights on) with the code
already looping on air (`L`). Success is **two beeps** — the first
acknowledgement our transmitter ever drew from the siren.

**Commands** — pair once, then the one-hot nibble family works:

| code | function |
|---|---|
| `0xA1B2C8` | **SOS / sound the siren** |
| `0xA1B2C4` | arm home (short ack beep) |
| `0xA1B2C1` | arm away |
| `0xA1B2C2` | **disarm / stop** |

Both directions verified on hardware. Use `s` (SOS, 5s, auto-disarm) for
testing; a bare `8` leaves the siren sounding until switched off by hand.

**Unexplained:** `spike_clean_tx` measures ~24dB weaker on air than
`spike_siren_tx` at the same PA, frequency and duty cycle with identical TX
registers — and the weaker one is the one that works.

**Superseded:** the "RF replay is a dead end" conclusion above, and the
hub-dependent ghost-sensor path. Both were consequences of the encoding bug.

See `todo.txt` for smaller known gaps (delete-project button, Telegram
webhook, RTDB events never cleaned up after Firestore mirroring, old-events
archive).

## Key Decisions

- WiFi independence: alarm logic never depends on cloud — EEPROM stores arm state and config
- No event buffering v1: events lost during WiFi outage are acceptable
- W184 hub stays running in parallel until fully replaced
- Unknown sensor IDs: log to Firebase, ignore for alarm logic until named in config
- Kerui protocol: 24-bit OOK, delimiter >5ms, bit timing ~500µs threshold
- Device-facing RTDB config format is thin and index-based (`{a, d, r, c}`)
  to minimize bandwidth to the ESP8266 — not the verbose named-key shape
  used in early design docs
- Local web server (LAN, no auth) is a deliberate choice, not an oversight —
  toggleable via EEPROM-persisted `localWebEnabled` (defaults on)
- ESP8266's software watchdog period (~3s) is fixed by the closed-source SDK
  and genuinely cannot be configured or extended — any fix for the
  mint/WDT issue must work within that constraint, not around it
