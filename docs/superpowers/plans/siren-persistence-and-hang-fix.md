# Fix: device hangs, and siren pairing lost on EEPROM wipe

Two independent bugs, both root-caused with evidence. They touch disjoint code
and can land as two commits.

---

## Issue 1 — Occasional device hang

### Root cause (confirmed)

`CloudClient::loop()` calls `database_.get<String>()` (cloud_client.cpp:437), a
**synchronous** FirebaseClient call. It blocks inside:

```cpp
else if (!sData->async) // wait for non async
{
    while (!sData->response.tcpAvailable())
    {
        sys_idle();
        if (handleReadTimeout(sData)) break;
    }
}
```
`.pio/libdeps/esp32s3/FirebaseClient/src/core/AsyncClient/AsyncClient.h:1116-1123`

On ESP32 `sys_idle()` is `delay(0)` (`src/core/Core.h:12`) — it yields to
FreeRTOS but does **NOT** feed the Task Watchdog.

The wait is bounded by `FIREBASE_TCP_READ_TIMEOUT_SEC` = **30**
(`src/core/Options.h:182-184`, marked "Do not change"). That default applies
because `setSyncReadTimeout()` / `setSyncSendTimeout()` are **never called** in
our code, so `sync_read_timeout_sec` stays 0 and every call site takes the
`: -1` default branch.

`kWatchdogTimeoutSec` (main.cpp:112) is also **30**.

**So a single stalled network poll can consume the entire watchdog budget.**
The device appears stuck, then panics/reboots (matching the vanished-serial
signature already documented for this board).

`reportAlarm()` is the worst case: two sequential blocking `set` calls
(cloud_client.cpp:752 and 764) — up to 60s, a near-guaranteed watchdog reboot
*during an alarm*.

### Fix

1. In `CloudClient::openDataClient()`, immediately after the `AsyncClient` is
   constructed, cap the sync timeouts well below the watchdog budget:
   ```cpp
   dataClient_->setSyncReadTimeout(kSyncTimeoutSec);
   dataClient_->setSyncSendTimeout(kSyncTimeoutSec);
   ```
   with `static constexpr uint32_t kSyncTimeoutSec = 5;` in cloud_client.h,
   documented against `FIREBASE_TCP_READ_TIMEOUT_SEC` and the watchdog budget.

2. Raise `kWatchdogTimeoutSec` 30 -> 60 in main.cpp so the two no longer race
   even if some path ignores the cap. Update the comment on that constant: the
   worst legitimate blocking stretch is now bounded by `kSyncTimeoutSec`, and
   `reportAlarm`'s two calls are the reason the budget must exceed 2x it.

3. Bound the unbounded read loop in `mintCustomToken` (cloud_client.cpp:248-250):
   ```cpp
   while (client.available()) { response += (char)client.read(); }
   ```
   has no timeout and no watchdog feed. Add the same elapsed-time guard the
   wait loop above it already uses, and feed the watchdog inside it.

### Verification

- `pio test -e native` still passes (44 tests) — these files are compiled in
  the native suite only via config_parser/alarm_state, so this is a regression
  check, not proof.
- Hardware: flash, then confirm `[wdt] loopTask watched, timeout 60s` at boot.
- Hardware: leave running and confirm no unexplained reboots; `state/boot`
  should stop reporting `twdt` / `panic`.
- Negative test: block the device's DNS/route to firebaseio.com while it is
  running, and confirm a poll now fails within ~5s and the loop keeps running
  (siren, RF decode and the LAN UI stay responsive) instead of the board
  resetting.

---

## Issue 2 — Siren pairing lost, not persisted to the cloud

### Root cause (confirmed)

The siren base address is device-generated (`main.cpp:726-731`) and stored in
`Config::sirenBaseAddress` in EEPROM. The cloud path is **write-only**:

- device -> `reportEvent("SIREN0", "siren_address", ...)` (main.cpp:154)
- `onSirenAddress` mirrors to `/{projectId}/state/siren_base`
  (functions/src/onSirenAddress.ts:47)
- `web/src/lib/rtdb.ts:63` defines a path for it — **and no component reads it**

Nothing ever sends it back down: `buildConfig.ts` has no siren key,
`config_parser.cpp` parses only `a/d/e/m/r/c`, and `applyPendingConfigUpdate()`
(main.cpp:376) explicitly *preserves* the local value, commenting that the
cloud never sends it.

So when `EepromStore::kMagic` was bumped (adding `Config::remotes` changed
`sizeof(Config)` 2416 -> 2452), `decode()` rejected the whole record and took
the siren address with it. The physical siren stayed bound to an address the
device no longer knew.

### Design (decided with the user)

Firestore is the durable record; the device keeps EEPROM as its offline source
of truth; **generating a new address is the last resort**, not the first move.

```
pair siren
  device --reportEvent SIREN0--> RTDB /events
      onSirenAddress
        |-- state/siren_base                (existing, display)
        `-- Firestore projects/{id}.sirenBaseAddress   (NEW, durable)
              `-- onProjectConfigChange -> config { s } -> device -> EEPROM
```

Single scalar, not an array — multi-siren is a noted TODO, not this change.

### Changes

**functions/src/types.ts**
- Add `s?: number` to `RtdbConfig` (siren base address, 24-bit). Optional and
  omitted when unset, same spread pattern as `m`.
- Add `sirenBaseAddress?: string` to the project doc type near
  `sirenDurationSec` (types.ts:146).

**functions/src/onSirenAddress.ts**
- After the existing `state/siren_base` write, also persist to Firestore:
  `db.doc(projects/${projectId}).set({ sirenBaseAddress: value }, { merge: true })`.
- Store the canonical `0xRRGGBB` string form (what the device reported), so the
  Firestore value matches how remotes store `identity`.
- Guard: only write when the value actually differs, so this does not loop
  against `onProjectConfigChange` on every boot report.

**functions/src/buildConfig.ts**
- New optional `sirenBaseAddress?: string` parameter on `buildRtdbConfig`.
- Parse with `parseInt(..., 16)`, drop non-finite, emit as `...(s ? { s } : {})`.

**functions/src/onProfileChange.ts**
- Read `sirenBaseAddress` from the project doc alongside `sirenDurationSec` /
  `sirenEnabled` (line 126-132) and pass it to `buildRtdbConfig`.
- Carry it into the **thin** config shape too (the `!activeProfile` early return
  at line 108) — exactly the reasoning already applied to `m` there: a project
  with no active profile must still be able to drive its siren.
- Extend `onProjectConfigChange`'s change guard (line 45), which currently
  rebuilds only when `sirenEnabled` changes, to also fire on
  `sirenBaseAddress`. **Without this the new Firestore write never reaches the
  device.**

**firmware config_parser.cpp**
- Parse `s`: `out->sirenBaseAddress = doc["s"] | 0;`
- Must be parsed **before** the `r`/`c` early return (same trap the `m` block
  documents at line 17-19), or a project with no rules could never receive it.

**firmware main.cpp**
- `setup()` (line 726): do **not** generate when EEPROM is empty. Leave the
  address invalid and let `siren.begin()` receive it — `sendCommand()` already
  guards on `SirenAddress::isValid` (relay_siren.cpp:21), so an addressless
  device is silent rather than transmitting garbage.
- `applyPendingConfigUpdate()` (line 376): replace the unconditional preserve
  with adopt-if-empty:
  - local valid    -> keep local (device stays authoritative; ignore `s`)
  - local invalid + pushed `s` valid -> adopt, `siren.setBaseAddress()`, save EEPROM
- New: once the cloud is ready and a config push has been seen, if the address
  is *still* invalid, generate one, save, and report it — the existing
  `reportSirenAddressOnce()` path then carries it up to Firestore. This is the
  last-resort branch. Gate it on having actually received a config push, so a
  device that is merely slow to sync does not generate prematurely.

**todo.txt** — add: multi-siren support (schema is currently a single scalar `s`).

### Notes / traps

- **No EEPROM magic bump needed.** `Config::sirenBaseAddress` already exists;
  `sizeof(Config)` is unchanged. Bumping would re-trigger the very bug being
  fixed.
- Firestore stores the `0x`-prefixed string; RTDB config carries a **number**
  (matching `m`). Do not mix the two.
- The `onSirenAddress` -> Firestore -> `onProjectConfigChange` -> RTDB chain
  must not self-trigger; the differs-check is what prevents a write loop.

### Verification

- `cd functions && npx tsc --noEmit && npx vitest run`
- New unit tests:
  - `buildConfig.test.ts` — `s` present when an address is given, omitted when
    absent or unparseable.
  - `onSirenAddress.test.ts` — already covers parsing; add that a matching
    existing value is not rewritten.
  - firmware `test_config_parser` — `s` parsed, and parsed even when `r`/`c`
    are absent (the early-return trap).
- `pio test -e native`
- Hardware, the actual regression: pair the siren, confirm
  `projects/{id}.sirenBaseAddress` appears in Firestore, then **erase EEPROM /
  flash with a bumped magic** and confirm the device re-adopts the same address
  from the config push and the siren still sounds **without re-pairing by hand**.
