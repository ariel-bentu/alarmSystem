# Alarm System — Project Context

A self-owned home alarm system replacing dependency on the Tuya/Kerui cloud.
The existing Kerui W184 hub and sensors stay in place during the transition —
the new system runs in parallel.

**Detailed history lives in `docs/history/`.** Those files hold measurements
that cost days to establish; read the relevant one before re-investigating
anything it covers. Do not re-litigate their conclusions without new evidence.

## Hardware

| Component | Status | Notes |
|---|---|---|
| ESP32-S3 | **Current edge controller** | 8MB PSRAM, 16MB flash, native USB |
| ESP8266 D1 Mini | **ABANDONED** | Too little RAM — [why](docs/history/esp8266-abandoned.md). Does not compile |
| CC1101 433MHz | Wired, working | RF receive + transmit confirmed |
| Kerui W184 hub | Keep running | 192.168.0.46, until decommissioned |
| Kerui sensors | Untouched | 433MHz, 24-bit OOK |
| Siren (YF-SG-081) | Paired over RF | EV1527 via CC1101, hub-free |

Wiring: `docs/hardware-wiring.md` (includes ESP32-S3 pins that must NOT be used).

## Architecture

**Edge** (`firmware/edge/device`, PlatformIO `[env:esp32s3]`) — runs on real
hardware: decodes Kerui packets, evaluates alarm rules, drives the siren over
RF, reports to Firebase.

- Continuous 433MHz receive (`Cc1101Receiver`, interrupt-driven) → `kerui_decoder.h`
- Arm state + config + siren address persisted to EEPROM (`EepromStore`) —
  survives power loss and WiFi outage
- `AlarmState` evaluates conditions; fires siren via RF (`ev1527_frame.h`)
- WiFi **optional**: when up, `CloudClient` mints a Firebase custom token and
  polls commands/config every 15s (polling, not SSE)
- **Local web server** (`http://alarm.local`, LAN-only, no auth): arm/disarm +
  sensor simulator, works fully offline. Toggle persisted in EEPROM
- Task watchdog (30s) reboots on a hang; `state/boot` reports why it last
  restarted — see [watchdog notes](docs/history/watchdog-and-offline-alerts.md)

**Firebase** — project `alarm-system-100`, region `europe-west1`.

- **RTDB**: events, state, config, commands (namespaced per project)
- **Firestore**: users, projects, sensors, profiles, rules, schedules, timeline
- **Functions**: `deviceIngest` (legacy), `mintDeviceToken` (device auth),
  event mirroring, server-side alarm evaluation, config sync, Telegram alerts,
  `doSchedule` (see below)
- **Hosting**: https://alarm-system-100.web.app

**Telegram** — alerts for sensor trigger, alarm, battery low, dead sensor,
device offline/back-online. Commands `/arm /disarm /status /siren off`.
⚠️ **Webhook not registered yet**, so commands do not work (`todo.txt`).

## Scheduled work — ONE function only

`doSchedule` (`functions/src/doSchedule.ts`) is the **only** scheduled
function: it runs every minute and dispatches a declarative cron-style table
(`min`/`hour`/`weekDay`, resolved in Asia/Jerusalem).

**Cloud Scheduler allows only 3 free jobs per BILLING ACCOUNT. Do not add
another `onSchedule()` — add a row to the table instead.** Current tasks:
schedule edges (every minute), device liveness (every minute), dead sensors +
event retention (daily noon).

## Sensor Trigger Conditions

Rules live under a profile; a profile is armed independently on device and
server. Rules are OR'd; a sensor may appear in several rules.

- `immediate` — single trigger fires
- `count_in_window` — N triggers within W seconds
- `entry_delay` — grace period to disarm
- `multi_sensor` — several sensors, each with a required count, all within
  one shared window (AND)
- `always` — single-sensor immediate rules that fire even while disarmed

## Firebase Data Layout

```
/{projectId}/events/{rfId}/{timestamp}  → { event, battery_low, rssi }
/{projectId}/state/armed                → bool
/{projectId}/state/siren_active         → bool   (latches — see history doc)
/{projectId}/state/alarm_cause          → { rfId, ct, at } | { label, at }
/{projectId}/state/last_seen            → device UPTIME seconds, NOT epoch
/{projectId}/state/boot                 → { reason, at }
/{projectId}/commands/{armed,siren,pair}
/{projectId}/config                     → { a, d, r, c }  thin, index-based
```

Firestore: `/users/{email}`, `/deviceKeys/{apiKeyHash}`, `/projects/{projectId}`
with `members`, `sensors`, `profiles/{id}/rules`, `schedules`, `events`.

**Device auth:** `mintDeviceToken` (API-key → Firebase custom token, scoped
per project by `database.rules.json`). This is the real firmware's path.
`deviceIngest` is legacy, still used by `smoke/`.

## Project Structure

```
firmware/edge/
  kerui_decoder.h        ← Kerui 433MHz decode + KeruiPacket
  device/                ← main firmware (PlatformIO)
    src/                 ← main.cpp, alarm_state, cloud_client, cc1101_receiver,
                           ev1527_frame, eeprom_store, local_web_server,
                           provisioning_portal, platform_compat, siren_address
    test/                ← native Unity tests (98 tests, 11 suites)
  spike_*/               ← throwaway diagnostic sketches, kept as known-good controls
web/                     ← React + TypeScript (Vite), Firebase Hosting
functions/               ← Cloud Functions (TypeScript, gen-2)
smoke/                   ← emulator smoke tests
docs/history/            ← dated investigation records (see below)
docs/superpowers/        ← design specs and implementation plans
```

## Commands

```bash
# Firmware. ALWAYS pass -e esp32s3: a bare `pio run` also builds [env:native],
# which fails to link. Check `ls /dev/cu.*` — macOS reassigns the suffix.
#
# The esp32s3 build runs `patch_firebase.py` first, which patches FirebaseClient
# in .pio/libdeps (gitignored, so re-applied after every install). If a library
# update moves the code it anchors on, the patch FAILS THE BUILD by design —
# see docs/upstream/ISSUE.md and update the anchors rather than removing it.
cd firmware/edge/device
pio run -e esp32s3 -t upload --upload-port /dev/cu.usbmodem101
pio test -e native
python3 ../read_serial.py 40 --port /dev/cu.usbmodem101   # --port is REQUIRED

# Decode a crash address
~/.platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-addr2line \
  -pfiaC -e .pio/build/esp32s3/firmware.elf 0x42000abc

# Bench testing over LAN
curl -s http://alarm.local/status
curl -s -X POST "http://alarm.local/trigger?rfId=0x2E5B73"

# Web / functions
cd web && npm run lint && npm test && npm run build
cd functions && npx tsc --noEmit && npx vitest run && npm run build
```

## History / investigation records

Read the relevant file before re-investigating. Each records what was
measured, what was ruled out, and the traps that wasted time.

| Doc | Covers |
|---|---|
| [esp8266-abandoned](docs/history/esp8266-abandoned.md) | Why the D1 Mini was dropped: cont-stack exhaustion, TLS budget, heap fragmentation |
| [esp32-s3-port](docs/history/esp32-s3-port.md) | The port that unblocked event writes; ESP32 gotchas (USB CDC, PSRAM, partitions) |
| [cc1101-receive](docs/history/cc1101-receive.md) | Kerui protocol timing, interrupt-based decode |
| [cc1101-transmit](docs/history/cc1101-transmit.md) | TX via FIFO not GDO0, FREND0, the gap-not-pulse finding |
| [siren-hub-free](docs/history/siren-hub-free.md) | Clean-room EV1527 that actually drives the siren; pairing and command codes |
| [alarm-cause-telegram](docs/history/alarm-cause-telegram.md) | Naming what caused an alarm; the `siren_active` latch bug |
| [watchdog-and-offline-alerts](docs/history/watchdog-and-offline-alerts.md) | The 28h silent death, watchdog, boot reporting, offline alerts |
| [cloud-auth-silent-death](docs/history/cloud-auth-silent-death.md) | Dead auth session the watchdog cannot see; why `tokenMinted_` was a one-way latch |
| [tls-handshake-watchdog-reboot](docs/history/tls-handshake-watchdog-reboot.md) | The `twdt` reboots: 120s TLS handshake default vs a 60s watchdog; `vTaskDelay` does not feed the TWDT |

**Testing guide:** `docs/testing-device-liveness.md` — what to verify for the
watchdog / offline-alert work (untested on hardware as of 2026-09-02).

## Key Decisions

- **WiFi independence**: alarm logic never depends on the cloud. EEPROM holds
  arm state and config. An offline device still protects the premises — this
  is why the WiFi-loss reboot waits 2h, not minutes.
- **No event buffering v1**: events lost during an outage are acceptable.
- W184 hub stays running in parallel until fully replaced.
- Unknown sensor IDs: logged to RTDB (never dropped — the pairing UI reads
  them from `/events`), ignored for alarm logic until named.
- Device-facing RTDB config is thin and index-based (`{a,d,r,c}`) to minimise
  bandwidth, not the verbose named-key shape in early design docs.
- Local web server (LAN, no auth) is deliberate, toggleable via EEPROM.
- **Most heap/RAM/TLS comments in the firmware describe the ESP8266** and are
  NOT constraints on the S3 (258KB free vs ~5KB). Check which board a comment
  measured before citing it.
- The Kerui decoder and the EV1527 siren encoder are different protocols
  sharing one chip. **Never validate one against the other** — ground truth
  for TX is the siren's physical response, not our own receiver.

## Status

**Working on real hardware:** ESP32-S3 boots, provisions WiFi, mints its
Firebase token, decodes real Kerui sensors, evaluates rules, drives the siren
over RF hub-free, serves the LAN web UI, and writes events to Firebase with
Telegram alerts confirmed. 98 native unit tests pass.

**Stability: 23h16m clean run (2026-09-07)** — single boot, zero `twdt` reboots,
zero stall dumps, flat heap. Proves the TLS-handshake, blocking-DNS and
dead-socket fixes in
[tls-handshake-watchdog-reboot](docs/history/tls-handshake-watchdog-reboot.md).
Does NOT yet clear the silent auth death, seen at 28h/31.76h — that needs ~36h.

**Deployed:** full web app (auth, pairing, profiles/rules, operations,
schedules, timeline, simulator), all Cloud Functions, invite-only access,
per-project Telegram config.

**Untested:** the watchdog / boot-reporting / offline-alert work (2026-09-02)
is committed but **not deployed and not hardware-tested** — see the testing
guide below. `RelaySiren` is built but unused (the RF path supersedes it).

## Next

1. Test and deploy the watchdog / offline-alert work (`docs/testing-device-liveness.md`)
2. Run in parallel with W184
3. Register the Telegram webhook so bot commands work
4. Decommission W184

See `todo.txt` for smaller known gaps.
