# D1 Mini Firmware — RF Decode, Alarm Logic, Cloud Sync
_2026-08-19_

## Overview

Extends `firmware/edge/device` (currently: boot flow + WiFi provisioning only)
with the actual alarm functionality: CC1101 RF receive, Kerui packet decode,
local trigger-condition evaluation, relay-driven siren, EEPROM-persisted
arm state and config, and two-way Firebase RTDB sync — commands/config in via
a live SSE stream, events out via direct RTDB write (with `deviceIngest` kept
as a secondary path for simulated/no-hardware testing).

Builds on `docs/superpowers/specs/2026-08-17-alarm-system-design.md`, which
already specifies condition types and general data flow. This spec covers the
concrete implementation: RTDB auth model, the on-wire/on-EEPROM config format
(now shrunk and index-based), library choice, and file layout.

---

## Decisions

### RF receiver: CC1101 (not the existing analog OOK path)

The project has an analog-OOK spike (`firmware/edge/kerui_decoder.h`,
`spike_decode.ino`) using `analogRead` on an RX module. That logic is
hardware-agnostic in its bit-timing math but assumes a continuously polled
analog signal. New firmware targets CC1101 over SPI instead, since that's the
actual hardware being built against (CC1101 module already ordered per
CLAUDE.md). The bit-timing decode logic in `kerui_decoder.h` is reused
as-is; only the signal source changes (SPI-fed sample stream instead of
`analogRead`).

Kerui bit layout is still only partially known — sensorId decodes reliably,
`batteryLow` bit position is unconfirmed. Firmware decodes and reports
`batteryLow` as a placeholder (`false`) until real packets are captured and
the layout is confirmed, matching the existing TODO in `kerui_decoder.h`.

### Cloud transport: FirebaseClient (mobizt), CustomToken auth, SSE for commands/config, direct RTDB write for events

Requirements: sensor events must reach the server quickly (server-side alarm
evaluation + Telegram alerts depend on it), and remote disarm / siren-off
commands must reach the device quickly (a user disarming via Telegram or web
should stop a triggering siren without meaningful lag).

Evaluated two ESP8266-compatible Arduino Firebase libraries:

- **`Rupakpoddar/FirebaseArduino`** — plain REST GET/PUT/POST over
  `WiFiClientSecure`, static token auth only. No streaming/SSE support at
  all. Ruled out — commands would need polling, and Firebase doesn't offer
  the low-latency guarantee the design needs without a persistent connection.
- **`mobizt/FirebaseClient`** — async, ESP8266-supported, has real RTDB SSE
  streaming (`Database.get(streamClient, path, callback, true /* SSE */)`)
  with automatic reconnect. Selected.

**Auth:** `FirebaseClient` supports a `LegacyToken` (RTDB database secret) —
rejected because it's a single admin-level credential valid for the *entire*
database; since this system is multi-tenant (every project shares one RTDB
under `/{projectId}`), a leaked device secret would expose every tenant, not
just its own project. Instead: **`CustomToken`** auth. The device holds a
short-lived custom JWT (minted server-side, embedding `{projectId, role:
"device"}` claims) which `FirebaseClient`'s `FirebaseApp` exchanges for a
real ID token and refreshes automatically thereafter — no manual refresh
logic needed in firmware. Security rules restrict device tokens to their own
project's paths (see Backend Changes below).

**Transport split:**
- **In (commands, config):** one persistent SSE stream per path (or a single
  stream on `/{projectId}` if practical — see Open Questions) via
  `FirebaseClient`'s streaming client. Near-instant delivery.
- **Out (events):** direct async `Database.set`/`push` to
  `/{projectId}/events/{rfId}/{timestamp}`, now that the device holds an
  RTDB-scoped auth token. Fire-and-forget; no buffering (per existing "no
  event buffering v1" decision in CLAUDE.md).
- **`deviceIngest` is kept, unchanged**, as the entry point for the
  `smoke/` simulated-event scripts and any future testing that doesn't run
  real firmware. It is not used by the production firmware path.

### Config format: thin, index-based, identical on wire and in EEPROM

The device only needs enough to evaluate alarm conditions — not sensor names
or per-sensor enabled flags (both are Firestore/UI-only concerns; disabling a
sensor server-side simply omits it from the published config). rfIds are
6-hex-char strings and were previously repeated as object keys once per
sensor and again inside every `multi_sensor.counts` map. New format:
flat parallel arrays, sensors referenced by index instead of by rfId string.

```json
{
  "a": true,
  "d": 120,
  "r": ["A1B2C3", "D4E5F6", "A1B2C4", "AA11BB", "CC22DD"],
  "c": [
    [{ "t": 0 }],
    [{ "t": 1, "n": 2, "w": 30 }],
    [{ "t": 2, "y": 30 }],
    [{ "t": 3, "w": 60, "k": { "3": 2, "4": 1 } }],
    [{ "t": 3, "w": 60, "k": { "3": 2, "4": 1 } }]
  ]
}
```

- `a` = armed, `d` = siren_duration_sec, `r[i]` = rfId, `c[i]` = that
  sensor's condition list (OR semantics, as before). `r` and `c` are always
  the same length, index-aligned.
- `t`: `0`=immediate, `1`=count_in_window, `2`=entry_delay,
  `3`=multi_sensor. Only the fields each type needs are present:
  `n`=count, `w`=window_sec, `y`=delay_sec, `k`=counts (map of
  **index-as-string** → required count, for every participant including
  self, exactly mirroring today's rfId-keyed `counts` but using indices).
- A sensor whose rfId never appears in `r` is unknown to the device and is
  logged (via `deviceIngest`/direct event write) but not evaluated — same
  behavior as today, just expressed by absence instead of an `enabled` flag.

This is the same shape used both over the wire (`/{projectId}/config`) and
in EEPROM — the device parses once with ArduinoJson and persists the parsed
bytes directly; no re-encoding step.

Device-side lookup: on each decoded packet, linear-scan `r` for the matching
rfId to get its index, then read `c[index]`. Sensor counts are small (tens),
so this is cheap; no hash map needed.

---

## Backend Changes

- **`functions/src/types.ts`, `web/src/types/index.ts`**: replace
  `RtdbConfig`/`RtdbConfigSensor`/`RtdbCondition` with the new short-key,
  index-based shape (`armed`→`a`, etc., `sensors` record → `r`/`c` parallel
  arrays, condition `counts` re-keyed by index instead of rfId).
- **`functions/src/buildConfig.ts`**: rewrite `buildRtdbConfig` to emit the
  new shape — build the `r` array first (stable ordering, e.g. insertion
  order), then build `c` and any `multi_sensor.k` maps using indices into
  `r` instead of rfId strings. Update `buildConfig.test.ts` accordingly.
- **New Cloud Function `mintDeviceToken`** (HTTPS POST, `europe-west1`,
  mirrors `deviceIngest`'s auth pattern): body `{ apiKey: string }` →
  resolves `projectId` via the same `hashApiKey` + `deviceKeys` lookup →
  returns `{ customToken: string }` via
  `admin.auth().createCustomToken(deviceUid, { projectId, role: "device" })`.
  Called once at provisioning (and again after a device reboot, since custom
  tokens are short-lived — `FirebaseClient` handles refresh via the returned
  refresh token for the life of one session, but a full device reboot starts
  a fresh session and re-mints).
- **`database.rules.json`**: current rules only check `auth != null` — no
  per-project scoping exists yet. Add device-scoped rules so a device's
  custom-token claims restrict it to its own project:
  ```json
  "events": {
    ".write": "auth.token.role === 'device' && auth.token.projectId === $projectId"
  },
  "commands": {
    ".read": "auth.token.role === 'device' && auth.token.projectId === $projectId || auth != null"
  },
  "config": {
    ".read": "auth.token.role === 'device' && auth.token.projectId === $projectId || auth != null"
  }
  ```
  (exact rule expressions to be finalized during implementation; existing
  user-facing `auth != null` reads are preserved alongside the new
  device-write grant for `events`).
- **`deviceIngest`**: no change. Stays as-is for simulated testing.

---

## Firmware Components (new, under `firmware/edge/device/src/`)

- **`cc1101_receiver.h/.cpp`** — SPI driver for CC1101 in RX mode at
  433.92MHz OOK. Feeds a signal-level stream into the existing
  `kerui_decoder.h` bit-timing logic (reused unmodified — it already reads
  an abstract "signal high/low" source).
- **`alarm_state.h/.cpp`** — in-memory `Config` matching the `r`/`c`
  index-based shape; evaluates a decoded `KeruiPacket` (resolved to an
  index via `r`) against `c[index]`'s conditions; tracks per-condition
  sliding-window/count/entry-delay state; decides siren on/off. Pure logic,
  no I/O — the condition-evaluation piece is unit-testable without hardware
  (see Testing).
- **`eeprom_store.h/.cpp`** — persists `{armed, config}` using ESP8266
  `EEPROM.h` emulation. Separate from `provision_store` (LittleFS-backed
  WiFi/API credentials), since arm/config state changes far more often and
  has a different format. Reserves a fixed EEPROM region (e.g. 4KB) sized
  for the JSON-serialized config; fails safe (logs, keeps last-good
  in-memory copy, does not corrupt storage) if an incoming config exceeds
  the reserved size.
- **`cloud_client.h/.cpp`** — wraps `FirebaseClient`: mints/holds the
  `CustomToken`, opens SSE streams on `/{projectId}/commands` and
  `/{projectId}/config`, exposes callbacks for command/config changes, and
  `reportEvent(rfId, event, batteryLow, rssi)` for direct async writes to
  `/{projectId}/events/{rfId}/{timestamp}`.
- **`relay_siren.h/.cpp`** — GPIO relay control with auto-off timer driven
  by `siren_duration_sec` (`d` in config); siren can be disabled via
  `d <= 0` or a dedicated flag (TBD during implementation, matching the
  "also allow siren disabled" note in the earlier design doc).
- **`main.cpp`** — extends `onNormalOperation()`: load `{armed, config}`
  from EEPROM (works fully offline from cold boot) → mint/restore
  CustomToken → start command/config streams → loop: poll CC1101, decode,
  evaluate via `alarm_state`, act via `relay_siren`, report via
  `cloud_client`. Alarm evaluation and siren firing never block on network
  state, matching the existing WiFi-independence principle.

---

## Data Flow

```
CC1101 RX → kerui_decoder → KeruiPacket{sensorId, batteryLow}
    → alarm_state: resolve rfId → index via r[], evaluate c[index]
        using in-memory Config (loaded from EEPROM at boot, offline-safe)
        → siren decision → relay_siren
    → cloud_client.reportEvent() [async, skipped if WiFi/stream unavailable]

RTDB /{projectId}/commands (SSE) → cloud_client callback
    → update EEPROM armed / trigger siren off
RTDB /{projectId}/config   (SSE) → cloud_client callback
    → replace in-memory Config, persist to EEPROM
```

---

## Testing

- **`alarm_state` condition evaluation** is pure C++ with no hardware
  dependency — plan to build it against a PlatformIO `native` test
  environment so `immediate`/`count_in_window`/`entry_delay`/`multi_sensor`
  logic is verified without a device. This is the highest-value test
  surface since it's the actual alarm-decision logic.
- **`cc1101_receiver`** and **`cloud_client`** are hardware/network-bound —
  manual verification once the CC1101 module and a flashed D1 Mini are
  available, per the existing project "Next" steps.
- **`smoke/`** scripts continue to exercise `deviceIngest` directly for
  server-side (Cloud Functions, Telegram, alarm evaluation) testing without
  needing real firmware.

---

## Open Questions

- Whether commands and config should be one combined SSE stream
  (`/{projectId}` root, filtered) or two separate streams — affects
  `FirebaseClient` stream-client count and heap usage on the ESP8266.
  Decide during implementation based on measured memory headroom (`Free
  Heap` diagnostics available directly from `FirebaseClient`'s `AsyncResult`
  API).
- Exact `database.rules.json` expressions for `commands`/`config` reads
  (device vs. authenticated web user) — sketched above, to be finalized
  alongside the `mintDeviceToken` function.
- EEPROM reserved size (4KB assumed) may need tuning once real sensor
  counts and condition complexity are known.
