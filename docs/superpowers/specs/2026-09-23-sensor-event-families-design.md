# Sensor event families — design

**Date:** 2026-09-23
**Status:** awaiting review

## Problem

A Kerui packet is 24 bits: **the top 20 bits are the sensor's identity, the
bottom 4 are an event code.** The system currently treats the whole 24-bit
value as the identity, so one physical sensor appears as several unrelated
"sensors" depending on what it did.

Measured on the live database (214 events, 10 sensors, project
`acdc2394-…`), the nibble census is:

```
0x0061d: 0xA×41  0xB×1     PIR, motion + one tamper
0x00927: 0xA×18  0xB×1     PIR, motion + one tamper
0x00216: 0xA×9              PIR
0x009bf: 0xA×3              PIR
0x4d6a7: 0xE×26             door contact (paired "דלת כניסה")
0x1520f: 0xE×5              door contact
0x170d0: 0x9×59             curtain
0x47100: 0x9×21             curtain (newest; 0x9 confirmed = beam cut)
0x516a0: 0x9×11             curtain
0x13a10: 0x9×1              curtain
0x3f010: 0x2×6  0x8×3       NOT a sensor — see "Out of scope"
0x62237: 0x2×4  0x4×3       NOT a sensor — see "Out of scope"
```

Consequences today:

- `0x0061DB` (a tamper) does not match the paired `0x0061DA`, so it is logged
  as an unpaired sensor and is invisible to rules and alerts.
- `onSensorEvent` reads `data.event === "tamper"` from RTDB, but the firmware
  hardcodes `"trigger"` at `main.cpp:258`. **The `tamper` event type already
  exists end to end in both type files, in `alwaysNotify`, and in
  `formatSensorAlert` — nothing ever emits it.**
- Water and battery-low codes would be equally invisible.

## The event table

Authoritative for this project. Sourced from
[rtl_433's `kerui.c`](https://github.com/merbanan/rtl_433/blob/master/src/devices/kerui.c)
and cross-checked against the census above.

| Nibble | Event | Sensor type implied | Evidence |
|---|---|---|---|
| `0x9` | trigger | **ambiguous** — curtain or door-open | our data only (4 curtains + 1 door) |
| `0xA` | trigger | motion | rtl_433 + our data |
| `0xE` | trigger | door | rtl_433 (`open`) + our data |
| `0x3` | close | door | our data only — `0x2E5B7`, ×40 |
| `0x7` | close | door | rtl_433 — never observed here |
| `0xB` | tamper | — | rtl_433 + our data (2 samples) |
| `0x5` | water | water | rtl_433 — never observed here |
| `0xF` | battery_low | — | rtl_433 — never observed here |
| `0x2` | unknown | — | smoke detector is paired on it; never fired |
| `0x1` | unknown | — | `0x11111`, 5 digits — simulator artefact |

**`0x9` is ambiguous, and this kills nibble-based type inference.** The full
3,089-event history shows family `0x2E5B7` sending **both** `0x3` (×40) and
`0x9` (×12) — a door sensor whose open code is `0x9` and close code is `0x3`.
That is exactly what `kerui_decoder.h`'s comment said all along
(`open=0x9, close=0x3 observed`), so **that comment was right and should be
kept, not corrected** — an earlier draft of this design wrongly called it
stale.

But four curtain sensors also use `0x9`, with no second code in 774 events. So
`0x9` means "this sensor's primary alarm event" — beam cut on a curtain, open
on that contact — and cannot identify a sensor *type*. This is consistent with
EV1527 nibbles being data-pin patterns rather than semantic codes, vendor-wired
per model.

**Two close codes, both real:** `0x7` (rtl_433's models) and `0x3` (ours).
Two door sensors in the same house use different codes for the same act, which
is the clearest single proof that no Kerui-wide table exists.

### Consequence: sensor type is dropped

The user asked for a type inferred from the captured trigger (curtain / door /
motion). The data does not support it: `0x9` maps to two types, and the smoke
detector's `0x2` maps to none. Inferring a type would mislabel real sensors
with no way to correct it — the user chose "derived, not editable", and a
wrong-and-uneditable label is worse than none.

**So this design ships no sensor type.** What it ships instead is the *event*
per packet (trigger / close / tamper / water / battery_low), which is what the
behaviour table actually needs and which the data does support. Revisit typing
if a future capture disambiguates `0x9` — or take the type from the user at
pairing, which was offered and declined.

**EV1527 has no notion of these names.** The chip latches whichever of its
four data pins the sensor's board pulls high, so the nibble meaning is
vendor-defined per model, not a protocol standard. rtl_433's table is the
mapping for the models that decoder was written against (D026, WD51, P831).
Ours agrees for `0xA`/`0xB`/`0xE`, and `0x9` is an addition we measured
ourselves. **This table is therefore a local finding, not a spec** — it lives
in one place per layer and is expected to grow.

`0x9` is the weakest entry: documented nowhere, and it means "primary alarm
event" for two different device classes (beam cut on four curtain sensors, door
open on `0x2E5B7`). It was confirmed as beam-cut only because the user
triggered a new unit 21 times while watching. Treat a future contradiction as
new data, not a bug.

**Not every sensor has tamper.** Anti-tamper is a per-model feature — Kerui
advertises it on the D026 and P829 but not the D025. Across 214 events only
the two `0xA` PIRs ever emitted `0xB`; the curtain and door sensors have each
sent exactly one code, ever. The design must therefore never assume a sensor
*can* tamper.

## Identity

**A sensor is its 20-bit prefix.** Stored as `"0x0061D"` (5 hex digits,
`0x`-prefixed, upper case) in a new `Sensor.familyId` field.

`Sensor.rfId` is **kept**, holding the full 24-bit code first seen at pairing.
It is what `SensorsTab` shows, what the pairing UI matches on, and what the
migration reads. It becomes descriptive rather than the matching key.

Matching moves to `familyId` in all three layers.

### Why not reuse `rfId` and mask at each comparison

Masking at every call site means every layer must agree on the mask forever,
and the device does `strcmp` on strings — masking would mean re-deriving a
string on every packet in `findSensorIndex`, inside the RF path. A stored
prefix is computed once at pairing and compared as-is.

## Behaviour per event type

Decided with the user; each row is a deliberate policy choice.

| Event | Siren | Telegram | Sensors tab | Alarm rules |
|---|---|---|---|---|
| `trigger` | via rules (unchanged) | via rules (unchanged) | last seen | yes — unchanged |
| `tamper` | **yes, even disarmed** | yes, always | status badge | no (own path) |
| `water` | no | once | status badge | no |
| `battery_low` | no | once | status badge (exists) | no |
| `close` | no | no | **ignored** | no |

### `tamper` — siren even while disarmed

Only for a **paired** sensor. An unpaired tamper is logged and left for
pairing, exactly as an unpaired trigger is.

Disarmed too, because that is the threat: an intruder disabling sensors before
a break-in does it while the house is empty and the system may be disarmed.
This mirrors the existing `always` rule semantics (smoke/gas) rather than
inventing a second mechanism.

**Accepted cost:** changing a PIR battery sounds the siren. No suppression
mechanism is being built — silence it with Disarm, which now also reaches the
device over the LAN. Revisit only if it proves annoying in practice.

### `water` and `battery_low` — notify once

"Once" means once per condition, not once ever: a marker field is set when the
alert fires and cleared when the sensor reports a normal `trigger` again. The
same shape as `deadAlertSentAt`, which `onSensorEvent` already clears on any
trigger. Without a marker a leaking sensor would Telegram on every packet.

### `close` — deliberately ignored

`0x7` is mirrored to the timeline (so the history is complete) but drives
nothing: no siren, no Telegram, no alarm evaluation, no status. Recorded here
because "we ignore it" is a decision, not an oversight — the system has no
concept of a door's open/closed *state*, only of events, and adding one is a
separate piece of work.

Our door contacts have never sent `0x7` anyway; only `0xE`.

## Sensor type — not shipped

Requested, then ruled out by the data. See "Consequence: sensor type is
dropped" above: `0x9` is sent by four curtain sensors *and* by a door contact
(`0x2E5B7`, alongside its `0x3` close), so the nibble cannot identify a type,
and the smoke detector's `0x2` maps to nothing at all.

The user chose "derived, not editable". Combined with an ambiguous table that
would have produced permanently-wrong labels on real sensors, the honest
outcome is to ship no type rather than a guess nobody can correct.

What ships instead is the per-packet **event** (trigger / close / tamper /
water / battery_low), which is what the behaviour table needs and what the
evidence supports.

## Layers

### Firmware (`firmware/edge/`)

1. `kerui_decoder.h` — `KeruiPacket` gains `familyId` (top 20 bits) and
   `eventNibble` (bottom 4). `sensorId` stays, so nothing that reads it
   breaks. Its existing comment (`open=0x9, close=0x3 observed`) is **correct
   and stays** — the 3,089-event history confirms both on family `0x2E5B7`.
   Extend it with the rest of the table and note that `0x9` is also the curtain
   sensors' trigger, so the same nibble is not type-specific.
2. New `kerui_event.h` — the nibble→event table as a pure function,
   `keruiEventOf(uint8_t nibble) -> KeruiEvent` (`enum { TRIGGER, CLOSE,
   TAMPER, WATER, BATTERY_LOW, UNKNOWN }`). Header-only and pure so the
   native Unity suite covers it with no hardware.
3. `alarm_state.h/.cpp` — `SensorConfig.rfId` becomes `familyId[8]`
   (`"0x0061D"` = 7 + null). `findSensorIndex` compares that. `onSensorEvent`
   takes a familyId.
4. `main.cpp` — split the decoded packet, map the nibble, and:
   - `TRIGGER` → `handleSensorEvent(familyId, …)` as today, reporting
     `"trigger"`
   - `TAMPER` → report `"tamper"`; if the family is a **paired** sensor, fire
     the siren directly (not through rule evaluation), regardless of `armed`,
     honouring `config.sirenEnabled`
   - `WATER` / `BATTERY_LOW` → report the event; no siren, no rule evaluation
   - `CLOSE` → report `"close"`; nothing else
   - `UNKNOWN` → report `"trigger"`, as today, so an unrecognised nibble is
     never silently dropped
   The full 24-bit code is still what gets written to `/events/{rfId}`, so the
   pairing UI keeps working and no RTDB path changes.
5. `config_parser.cpp` — parse `r` as familyIds. **Wire-compatible**: `r` is
   already `string[]`; only the contents get shorter.
6. EEPROM — `SensorConfig` shrinks, so the struct layout changes and the
   magic must be bumped. **The siren address must survive this.** A magic bump
   discards the whole record, and the siren address is write-only
   device→cloud, so losing it silently breaks the physical siren pairing (this
   has happened before — see `docs/history/siren-hub-free.md` and the
   `siren-address-never-restorable-from-cloud` note). Mitigation: the cloud
   now pushes the address back down as `RtdbConfig.s`, and
   `applyPendingConfigUpdate` re-adopts it when EEPROM has none. **Verify that
   path on hardware before shipping the magic bump** — it is the one
   irreversible failure here.

### Cloud (`functions/`)

1. New `keruiEvent.ts` — the same table, plus `familyIdOf(rfId)`. Duplicated
   from the firmware rather than shared: separate languages, no shared module,
   the same reason `types.ts` exists twice. Its test asserts the table matches
   the firmware's, by value.
2. `types.ts` — `Sensor.familyId`, `Sensor.waterAlertSentAt`,
   `Sensor.batteryAlertSentAt` (already added by the battery-age work —
   **reuse it, do not add a second field**). `EventType` gains `water` and
   `close`.
3. `onSensorEvent.ts` — look up by `familyId` derived from the event's
   `rfId`, not by exact `rfId`. Then branch per event type per the table
   above. The unpaired path is unchanged: log, keep in RTDB, do not mirror.
4. `buildConfig.ts` — emit familyIds in `r`. `rIndex` keys on familyId, so
   two codes from one sensor collapse to one entry, which is the point.
5. `telegram.ts` — `formatWater`. `formatSensorAlert(name, "tamper")` already
   exists and already reads "⚠️ … tampered".
6. **Migration** — see the dedicated section below.

### Web (`web/`)

1. `types/index.ts` — mirror `Sensor.familyId` and the new `EventType`s.
2. New `keruiEvent.ts` under `features/configure/` — the table again, for
   display: the event label per nibble. Pure, unit-tested. No sensor type —
   see "Sensor type — not shipped".
3. `unknownSensors.ts` — an observed code is "unknown" only if **no paired
   sensor shares its family**. This is what stops `0x0061DB` from appearing as
   an unpaired sensor alongside its own paired `0x0061DA`.
4. `SensorsTab` — show water / battery-low status beside the existing battery
   badge, and the last event type per sensor; pairing stores `familyId`
   alongside `rfId`.
5. Timeline / `ExplorePage` — render the new event types rather than
   falling through to "trigger".

## Migration

A **one-shot script**, not a Cloud Function: it runs once, by hand, against a
known dataset, and a Function would sit in the deployment forever re-checking
work that was already done. Lives at `functions/scripts/migrateFamilyIds.ts`,
run with `npx tsx`, and takes `--dry-run` (default) and `--commit`.

Audited against the live project (`acdc2394-…`) before writing this, which
changed what the migration has to handle.

### What needs migrating, and what does not

| Collection | Stores `rfId`? | Action |
|---|---|---|
| `sensors` (12 docs) | yes, the matching key | **add `familyId`** |
| `profiles/{id}/rules` (12 rules) | **no** — Firestore `sensorId` only | **nothing** |
| `schedules` (1 doc) | no — `profileId` only | **nothing** |
| `events` (3,089 docs) | yes, descriptive only | **nothing** — see below |
| RTDB `/events/{rfId}` | yes, as the path key | **nothing** — see below |
| RTDB `/config` | yes, in `r` | rewritten automatically |

**Rules and schedules were verified clean against live data**, not merely
assumed: every one of the 12 rules references Firestore document IDs in
`sensors: string[]`, and `condition.counts` is `undefined` in all of them.
`buildConfig.ts` resolves `sensorId → rfId` at config-build time, so the
indirection already exists. **No rule or profile is touched.** This is the
single most important audit result here — had `counts` been keyed by `rfId` in
Firestore, every multi-sensor rule would have needed rewriting.

**Firestore `events` are left alone.** All 3,089 carry `rfId` plus a
denormalised `sensorId` and `sensorName`. They are an append-only historical
record displayed in the timeline; the `rfId` on a 2026-08 event is a true
statement about what was received. Rewriting history to a field that did not
exist then would be a lie, and the timeline reads `sensorId`, not `rfId`.
Optionally the script can *add* `familyId` to events for querying, but this
design does not, on the grounds that 3,089 writes buy nothing the existing
`sensorId` does not already give.

**RTDB `/events/{rfId}/…` keys stay full 24-bit.** This is deliberate and
load-bearing: the pairing UI reads those keys to discover unpaired sensors, and
the *event code is the information* — `0x0061DB` appearing is how a tamper is
seen at all. Collapsing the path to a family would destroy the distinction the
whole design is built on. The device keeps writing full codes; only *matching*
uses the family.

**RTDB `/config` needs no migration step.** It is derived state, rewritten by
`buildConfig` on the next config change. Note it currently holds
`r: ["0xCC2682"]` — one sensor, the smoke detector — so the device's rule set
is nearly empty regardless (see Risks).

### The script

1. Read every `projects/*/sensors` doc.
2. Compute `familyId = "0x" + ((parseInt(rfId,16) >> 4) & 0xFFFFF)` as 5
   upper-case hex digits.
3. **Refuse to write if two sensors in one project share a familyId.** Print
   both and exit non-zero. Verified: all 12 sensors map to 12 distinct
   families today, so this is a guard against a future re-run, not a current
   problem.
4. Print a table of `rfId → familyId → nibble → event`, flagging any nibble
   absent from the event table (today: `0x2` on the smoke detector).
5. Under `--commit`, write `familyId` in one batch per project. Idempotent: a
   doc that already has the correct `familyId` is skipped, so a re-run is safe.

### Sensors whose nibble is not in the table

The 12 paired sensors map to 12 distinct families — **no collisions**, so the
migration is mechanical. Nibbles present across the full 3,089-event history:

| rfId | familyId | Nibble(s) seen | Name | Note |
|---|---|---|---|---|
| `0x2E5B73` | `0x2E5B7` | `0x3` ×40, **`0x9` ×12** | "new door sensor" | paired on its CLOSE code |
| `0xCC2682` | `0xCC268` | none, ever | גלאי עשן מסדרון (smoke) | `0x2` unverified |
| `0x24B47E` | `0x24B47` | `0xE` ×1 | חלון קטן חדר עבודה | |
| `0x00D91A` | `0x00D91` | `0xA` ×5 | תנועה חצר שירות | |

Two need naming individually:

- **`0x2E5B73` is paired on its CLOSE code, and this is a live behaviour
  change.** The history shows family `0x2E5B7` sending `0x3` (close, ×40) and
  `0x9` (open, ×12). The sensor is paired as `0x2E5B73` — the *close* code — so
  its 12 **open** events never matched it and were logged as an unpaired
  sensor. Its rule is `immediate`, so today the door firing an alarm depends on
  it being **closed**, which is almost certainly not what was intended.
  Migration to family `0x2E5B7` makes both codes match, so **after migration
  this sensor fires on open as well as close.** That is the bug being fixed,
  but it is a real change to a real door sensor's behaviour and must be stated
  before deploy rather than discovered after. It is also why `close` being
  "ignored" matters: post-migration, `0x3` stops firing the rule and `0x9`
  starts — the *opposite* of today.
- **`0xCC2682` (smoke) has never fired in 3,089 events**, so its `0x2` nibble
  is unverified — inferred only from the paired rfId. It carries the only
  `always: true` rule, the one that fires while disarmed. After migration it
  matches on family `0xCC268`, and `0x2` maps to `UNKNOWN → trigger`, so the
  always-rule still fires. **This must be covered by a test**: silently
  breaking the smoke alarm is the worst outcome this refactor could produce,
  and there is no live traffic to catch it.

Non-sensor codes in the history, for completeness: `0x11111` (×3, only 5 hex
digits — simulator, per the user) and `0xE45CA2` (×1 — the paired **remote
control** identity, not a sensor). Neither is a paired sensor; both are left
alone.

### Rollback

Deleting the `familyId` field from every sensor doc restores the previous
state exactly, because nothing else is modified. The script supports
`--rollback` for this. Note the *firmware* is not rollback-safe in the same
way (see Risks), which is why it ships last.

## Out of scope

- **`0x3f010` and `0x62237`.** Unpaired, multi-nibble, and `0x622374` is this
  device's own **siren** EV1527 address from the siren work. The device is
  almost certainly decoding its own transmissions as sensor events. That is a
  separate bug; it must be investigated before anyone pairs those IDs, and
  this design neither fixes nor depends on it. Filed to `todo.txt`.
- Door open/closed **state** tracking (see `close`, above).
- Tamper suppression for maintenance.
- Multi-siren.

## Testing

- **Firmware:** native Unity tests for `keruiEventOf` (every nibble in the
  table, plus unknown), the 20/4 split, and `findSensorIndex` on familyIds.
  Hardware: trigger one sensor of each family (`0x9`, `0xA`, `0xE`), tamper a
  `0xA` PIR and confirm the siren fires while **disarmed**, and confirm the
  siren address survives the EEPROM magic bump.
- **Cloud:** unit tests for `familyIdOf`, the table, per-event branching in
  `onSensorEvent`, once-only water/battery marker behaviour, and
  `buildConfig` collapsing two codes to one `r` entry. A test asserting the
  cloud and firmware tables agree.
- **Web:** unit tests for the display table and `unknownSensors` family
  matching (the `0x0061DB` case explicitly).
- Full suites: `cd web && npm run lint && npm test && npm run build`;
  `cd functions && npx tsc --noEmit && npx vitest run && npm run build`;
  `cd firmware/edge/device && pio test -e native`.

## Risks

1. **The EEPROM magic bump can lose the siren pairing.** Highest risk here,
   and it has bitten this project before. Verify `RtdbConfig.s` re-adoption on
   hardware first.
2. **Tamper sounds the siren while disarmed** — by design, but it is the first
   path that sounds the siren with no rule and no arm state involved. It must
   respect `sirenEnabled`.
3. **`0x9` is our own finding.** If it means something else on a model not
   yet owned, that sensor's type label is wrong and unfixable by the user.
4. **Migration is one-way.** Sensors gain `familyId`; a rollback to the
   current firmware still works (it reads `rfId`), but a device flashed with
   the new firmware needs the new config shape.

## Implementation order

Each step leaves every suite green.

1. Cloud + web + firmware tables and their tests. Pure, no callers.
2. `familyId` on the three type definitions. Optional at first.
3. Migration script; run it; every sensor has a `familyId`.
4. Cloud: `onSensorEvent` family lookup + per-event branching; `buildConfig`.
5. Web: `unknownSensors`, `SensorsTab`, timeline.
6. Firmware: decoder split, `alarm_state`, `main.cpp`, EEPROM bump. Last,
   because it is the only irreversible step and the only one needing hardware.

Steps 1–5 are deployable without touching the device: the firmware keeps
sending full 24-bit codes, and the cloud derives the family itself. **The
cloud-side half delivers tamper, water and battery-low alerting on its own** —
the firmware work adds only the local siren-on-tamper and the thinner config.

## Open questions

One, for the user, surfaced by the data audit rather than by design:

**`0x2E5B73` ("new door sensor") is paired on its close code**, so it currently
alarms on the door *closing* and ignores it *opening*. Migration reverses that.
Confirm this is the intended fix before the migration runs — it is the only
change here that alters how an existing sensor behaves in the house.

The three policy decisions — tamper sirens while disarmed, no maintenance
suppression, and no editable sensor type — were settled before writing. The
third was then overtaken by evidence: sensor type is dropped entirely, because
`0x9` is ambiguous across device classes (see "Sensor type — not shipped").
