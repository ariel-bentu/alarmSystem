# Remote control pairing — design (2026-09-02)

Adds support for 433MHz 4-button remotes that arm, disarm, and trigger SOS
directly on the device, with no cloud dependency once paired.

## Measured facts (established on hardware, not assumed)

The remote is a fixed-code EV1527-family device in the same 24-bit OOK
format the existing `kerui_decoder.h` already decodes. Confirmed by pressing
buttons and reading `/events`:

```
0xE45CA2   identity 0xE45CA, nibble 0x2
0xE45CA4   identity 0xE45CA, nibble 0x4
```

**Top 20 bits = remote identity. Bottom nibble = which button**, as a
one-hot bitmask:

| Nibble | Bits   | Button | Action |
|--------|--------|--------|--------|
| `0x1`  | `0001` | S      | arm-home — **decoded, ignored** |
| `0x2`  | `0010` | disarm | disarm locally |
| `0x4`  | `0100` | arm    | arm with current config |
| `0x8`  | `1000` | SOS    | fire siren immediately |

This is the same identity/nibble split the Kerui sensors use (bottom 4 bits
are state flags there), so no new protocol work is required. The receive
path is already complete and proven.

**Trap that cost time and must not be re-investigated:** the W184 hub is
still paired to the remote and relays button presses to the siren. Our
CC1101 hears *both* the remote's transmission and the hub's relay, so a
single press appears as two unrelated identities (`0xE45CA` and `0x3F010`).
`0x3F010` is the HUB, not a second remote. Unpairing a button from the hub
isolates the remote. Never bind a remote to a code observed while the hub
is relaying — it would break on decommission and fire on unrelated hub
chatter.

## Scope

In scope:

- Pair up to 8 remotes; **any single button press** pairs the whole remote
  (identity is shared across buttons)
- Arm / disarm / SOS work fully offline, from EEPROM
- S button decoded and deliberately ignored
- Telegram + timeline for device-originated arm/disarm (fixes an existing
  gap — see below)

Out of scope (deliberate, per decisions below):

- Profile selection from the remote. `arm` arms with whatever config is
  currently loaded, matching what the W184 does today.
- Rolling-code / anti-replay. Fixed-code remotes are replayable by design;
  mitigated by notification, not prevented. See Security.

## Decisions taken

| Question | Decision |
|---|---|
| Profile switching from remote | **No.** `arm` uses current config. |
| S / arm-home | **Decode, do nothing.** Reserved for later. |
| SOS while disarmed | **Always fires**, gated only on `sirenEnabled`. |
| Offline operation | **Required.** Identities live in EEPROM. |
| Pairing trigger | **Any one button.** |
| Notify on remote disarm | **Yes** — and also for `alarm.local` disarm. |

## Existing gap this fixes

`onArmStateChange` triggers on RTDB **`commands/armed`** — the *intent*
channel the web app writes. Device-originated arm/disarm calls
`applyArmedCommand()` → `reportArmedState()`, which writes **`state/armed`**.
Nothing in `functions/src/` triggers on `state/armed` (verified: it is only
ever read, by `onProfileChange`, `telegramWebhook`, `deviceLiveness`).

**Therefore disarming via `alarm.local` today produces no Telegram and no
timeline entry — it is completely silent.** That is a pre-existing defect,
independent of this feature, and it is exactly what makes a replayable
remote disarm dangerous. This design fixes it for all device-originated
sources at once.

## Architecture

### Device: identity/nibble split in `pollCc1101`

`main.cpp:262` currently formats every decoded packet as a full 6-hex-digit
rfId and passes it to `handleSensorEvent()`. New behaviour, inserted before
that call:

1. Split `packet.sensorId` into `identity = id >> 4` and `nibble = id & 0xF`.
2. If `identity` matches a paired remote, dispatch on the nibble and
   **return** — the packet never reaches `handleSensorEvent()`.
3. Otherwise fall through unchanged.

Step 2's early return is the important isolation property: **a remote can
never trigger an alarm rule**, because it never enters the sensor path.
A paired remote's codes are also never written to `/events` as triggers.

Dispatch:

- `0x4` → `applyArmedCommand(true)`
- `0x2` → `applyArmedCommand(false)`
- `0x8` → `siren.turnOn(...)` if `sirenEnabled`, plus an alarm report
- `0x1` → log only
- anything else (multi-bit / zero) → log and ignore; do **not** guess

`applyArmedCommand()` is reused as-is: it already handles state, EEPROM
persistence, siren-off on disarm, and cloud reporting, and is already the
shared path for the cloud and LAN routes. The remote becomes a third caller.

**SOS reporting.** `reportAlarm(rfId, conditionType)` takes an rfId, but SOS
has no rule and no sensor behind it. `state/alarm_cause` already supports a
`{label, at}` shape alongside `{rfId, ct, at}` (see `alarmCause.ts` — a
label wins outright over rfId mapping), so SOS writes
`alarm_cause = {label: "SOS (remote)", at}` rather than inventing a
synthetic rfId. This needs a small `reportAlarmLabel(const char*)` addition
to `CloudClient`; do NOT pass the remote's raw code as an rfId, which would
make the Telegram alert name an unpaired sensor.

SOS is not gated on arm state, matching an `always` rule. It IS gated on
`sirenEnabled`, per the decision table.

**Debounce.** `Cc1101Receiver` already suppresses repeated decodes of the
same id within 3s (`lastDecodedId_`/`lastDecodedMs_`), which covers the
5-7x burst repetition a single press produces. No new debounce needed; a
deliberate second press after 3s is correctly treated as a new press.

### Device: EEPROM storage

`Config` gains:

```c
uint32_t remotes[8] = {};   // 20-bit identities; 0 = empty slot
uint8_t  remoteCount = 0;
```

**Budget (measured, not estimated):** `sizeof(Config)` is currently 2416,
record 2422, reserved 2486 — headroom is 64 bytes. Adding 8 remotes costs
`8*4 + 1 = 33` bytes, which **fits inside the existing headroom**.
`kReservedBytes` does NOT change, so the heap/stack reasoning documented on
`EepromStore::kRecordBytes` is untouched. 16 remotes would need 65 bytes and
overflow it by one — hence the cap of 8.

Two consequences that must be handled, not discovered later:

- `static_assert(sizeof(Config) == 2416)` in `alarm_state.h` must be updated
  to the new measured size.
- `kMagic` must bump (`0xA1A2B3B6` → `0xA1A2B3B7`) so records written by
  older firmware are rejected rather than misread.

**Accepted cost of the magic bump:** on first boot after flashing, stored
config is discarded — the device starts disarmed with an empty config and
re-pulls from the cloud. Paired remotes survive because they are re-pushed
from Firestore. A device with no WiFi at that moment has no remotes until it
reconnects once. This is a one-time cost at upgrade, and is the same
mechanism used when `sirenBaseAddress` was added.

### Device: pairing

Non-blocking, receive-only. A `remotePairUntilMs` timestamp opens a 30s
window; while open, the next decoded packet whose identity is not already
paired is adopted, stored to EEPROM, and reported to the cloud.

**Deliberately NOT modelled on `runSirenPairing()`.** That function blocks
the loop for 10s (deaf to sensors) and is permitted while armed — flagged as
a real weakness in `todo.txt`'s stability review. Remote pairing is
receive-only, so it needs no blocking at all: it is a flag checked inside
the existing `pollCc1101` path.

Guards:

- **Refused while armed.** Pairing while armed would let an attacker in
  RF range pair their own remote and then disarm.
- Window expires on its own; no persistent "pairing mode".
- Identity already paired → no-op, report success (idempotent).
- Remote list full (8) → refuse, report a distinguishable error.

Two entry points, because offline pairing must work:

1. **Cloud**: RTDB `commands/pair_remote` with a nonce + `until`, mirroring
   the existing siren-pair command shape.
2. **Local web UI**: a `POST /pair-remote` endpoint on `alarm.local`,
   alongside the existing arm/disarm/trigger/pair-siren endpoints. This is
   what makes a fresh, internet-less device able to learn a remote.

Unpairing is cloud-side only (remove from Firestore → config rebuild →
device overwrites its list). No local unpair endpoint: removing a remote is
not an emergency, and the LAN UI has no auth.

### Cloud: data model

New Firestore collection `projects/{projectId}/remotes/{remoteId}`:

```ts
interface Remote {
  id: string;          // doc id
  identity: string;    // hex, e.g. "0xE45CA" (20-bit, no nibble)
  name: string;        // "Ariel's keyfob"
  pairedAt: Timestamp;
  lastSeen: Timestamp | null;
}
```

Kept **separate from `sensors`** deliberately. A sensor means "can trigger
the alarm"; a remote means "can control the alarm". Merging them would allow
a rule to be built on a remote button — e.g. arming the house when disarm is
pressed — which is a footgun with no legitimate use.

The thin device-facing RTDB config gains one key:

```
/{projectId}/config → { a, d, e, r, c, m }
```

`m` = array of 20-bit identities as numbers. Follows the existing thin,
index-based convention. `buildRtdbConfig()` gains a `remotes` parameter;
`rebuildConfig()` in `onProfileChange.ts` loads the collection and passes it.
Absent `m` must parse as "zero remotes", matching how missing `r`/`c` is
already handled in `parseConfigJson`.

### Cloud: notification on device-originated arm/disarm

New function `onDeviceArmStateChange`, triggered on RTDB
`/{projectId}/state/armed`. Mirrors `onArmStateChange`'s structure: writes a
timeline event and sends Telegram.

**Double-notification must be avoided.** When the web app disarms, it writes
`commands/armed` (→ `onArmStateChange` fires) and the device then echoes to
`state/armed` (→ the new function would fire too). Suppression rule: the new
function reads `commands/armed` and returns early if it already equals the
new `state/armed` value — that means the change was cloud-initiated and
already reported. Only a device-originated change will differ.

This is the one genuinely subtle part of the design and gets dedicated unit
tests for both orderings.

Message wording distinguishes the source, since "who disarmed my house" is
the entire point:

- `🔓 Disarmed by remote`
- `🔓 Disarmed from local web UI`

Source is inferred from a new `state/armed_by` field (`"remote"`,
`"local"`, `"cloud"`) written by the device in the same update as
`state/armed`. Without it the function cannot tell a remote disarm from a
LAN disarm, and the distinction is the security-relevant part.

### Web UI

A "Remotes" section in the Configure area, mirroring the existing sensor
pairing flow:

- List paired remotes with name, last seen, unpair
- "Pair remote" → opens the 30s window, prompts *"press any button on the
  remote"*, polls for the new identity, then asks for a name
- Button legend showing the fixed mapping (arm / disarm / SOS / S ignored),
  since it is not configurable and users will ask

## Security

**Fixed-code remotes are trivially replayable.** Anyone with an SDR who
records a disarm press can replay it. This is stated plainly rather than
designed around, because the mitigations available at this protocol layer
are illusory.

The W184 has this exact weakness today, so the remote does not make the
system worse than its current state. Accepted, with two mitigations:

1. **Every remote disarm sends a Telegram.** A replayed disarm cannot be
   prevented, but it is never silent. This is why the `state/armed` gap
   above is fixed as part of this work rather than deferred — without it,
   the mitigation does not exist.
2. **Pairing is refused while armed**, so an attacker cannot pair their own
   remote against an armed system.

Explicitly NOT claimed: that this makes remote disarm secure. A user who
wants strong disarm authentication should use the app, which is behind
Firebase Auth.

## Testing

Native unit tests (`pio test -e native`, currently 44 tests / 5 suites):

- identity/nibble split for known codes, including `0xE45CA2` → `(0xE45CA, 0x2)`
- dispatch: each of the 4 nibbles maps to the right action
- multi-bit and zero nibbles are ignored, not guessed
- unpaired identity falls through to the sensor path unchanged
- **paired identity never reaches the sensor path** (the isolation property)
- pairing: adopts on any nibble; idempotent; refused while armed; refused
  when full; expires
- EEPROM round-trip with remotes populated; old-magic record rejected

Functions tests (`npx vitest run`):

- `buildRtdbConfig` emits `m`; absent remotes omit it
- `onDeviceArmStateChange` suppression: no double-send when cloud-initiated,
  does send when device-initiated, both orderings

Hardware verification (the only ground truth for RF):

- Press each button; confirm arm, disarm, SOS, and that S does nothing
- Confirm a paired remote produces **no** trigger event in `/events`
- Pull WiFi; confirm arm/disarm/SOS still work from EEPROM
- Confirm Telegram arrives for remote disarm and for `alarm.local` disarm
- Confirm pairing is refused while armed

## Risks

- **Device stability.** The controller went silent for 31.76h ending
  2026-09-02 16:17 (second occurrence; ~28h previously) and the root cause
  is still open. Testing RF pairing against a device that dies every ~30h
  will be frustrating, and a failure during testing may be the crash rather
  than this feature. Consider landing the crash fix first.
- **`kMagic` bump** resets stored config on first boot after flash. Expected,
  documented above, recoverable from cloud.
- **Hub interference during testing.** Until the W184 is decommissioned it
  will keep relaying presses to the siren, so the siren may sound from the
  hub rather than from our device. Not a defect; do not chase it.

## Implementation order

1. Fix the `state/armed` notification gap (independent, useful alone)
2. Device: identity/nibble split + dispatch + unit tests
3. Device: EEPROM storage + `kMagic` bump + `static_assert` update
4. Device: pairing window + local endpoint
5. Cloud: `remotes` collection, `m` in config, pairing command
6. Web: Remotes UI
7. Hardware verification
