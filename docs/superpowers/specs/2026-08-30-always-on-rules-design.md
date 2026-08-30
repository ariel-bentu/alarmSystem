# Always-On Rules — Design
_2026-08-30_

## Overview

Some sensors must fire the alarm whether or not the system is armed. A smoke
detector is the motivating case: a fire at 14:00 on a Tuesday, with the house
occupied and disarmed, is exactly when you most want the siren.

A rule may be marked **always**. Always-rules are evaluated on every sensor
event regardless of arm state; ordinary rules keep their current behaviour and
are evaluated only when armed.

## Why a per-rule flag, not an always-on profile

The obvious shape — a special built-in `alwaysOn` profile — was considered and
rejected. It is the *more* complex option, not the simpler one.

Ten places in the codebase treat "the active profile" as exactly one thing:
`onProfileChange.ts:46`, `onAlarm.ts:70`, `onArmStateChange.ts:33` and
`onSensorEvent.ts:95` all query `.where("isActive…", "==", true).limit(1)`;
`scheduleTick.ts:81`, `OperationsPage.tsx:81,103` and `ProfilesTab.tsx:270,291,307`
maintain the invariant that activating one profile deactivates the others.

A profile that is *always* active breaks that invariant everywhere at once:

- `.limit(1)` queries would return the special profile or the real one,
  ambiguously and non-deterministically.
- `onAlarm` and `onArmStateChange` name the active profile in Telegram and the
  timeline; they would start naming "alwaysOn" instead of "Away".
- The Operations arm grid would need to hide it, since it is not armable.
- `ProfilesTab` would need to block renaming and deleting it.
- `buildConfig` would have to merge two profiles' rules into one RTDB config
  anyway — the same work the flag design needs, so it is not a saving.

The concept "profile" means *which set of rules is active right now*. "Always"
is not a value that concept can hold, so every site has to special-case it.
A flag on a rule adds no new concept: an always-rule is an ordinary rule in an
ordinary profile, and all ten sites are untouched.

**Grouping is still available without the data model change.** A user who
wants their always-on sensors in one place creates a profile named "Smoke &
Gas" and ticks `always` on its rules. It reads as one group in Configure while
the code still sees ordinary rules.

## Design Decisions

### An always-rule fires a full alarm

When an always-rule trips while disarmed, the outcome is identical to an armed
alarm: siren sounds, Telegram alert, timeline entry, `alarm_cause` written. A
notify-only variant was rejected — a sleeping household is not woken by a
Telegram message, which defeats the purpose for smoke.

### Always does not override the siren toggle

Always-rules respect `sirenEnabled` (project-wide) and
`serverActions.triggerSiren`, and Force Silence works on them normally.

Overriding those was rejected: a setting that silently does not apply is its
own trap. Disabling the siren is a deliberate act, and the alarm still reaches
Telegram and the timeline — the notification path is never suppressed.

This keeps the existing rule from the alarm-cause work intact: the alarm
*report* is never gated on the siren, only the sounding is.

### Always-rules are collected from every profile

This is the substantive cost of the feature, and it is unavoidable in any
design.

`buildConfig` currently ships only the `isActiveOnDevice` profile's rules to
the device. A smoke rule living in an inactive profile would therefore never
reach the device at all — the flag would appear to work in the UI and do
nothing on hardware.

So config building gains a second pass: after the active profile's rules,
collect `always` rules from **all** profiles. A rule already included by the
first pass is not added twice.

The same applies server-side. When disarmed there is no active-server profile,
so `onSensorEvent` cannot read rules from one; it queries always-rules across
all profiles instead.

### Absent means false

`Rule.always` is optional. Every existing rule doc lacks the field and must
keep its current behaviour, so `undefined` reads as `false` — not as a
tri-state and not defaulted to true anywhere.

On the wire, `RtdbCondition.x` is set to `1` only when true and omitted
otherwise, so the common case costs zero bytes. The device polls `/config`
every 5s (`cloud_client.h:163`), so payload size is a live concern.

### The device struct does not change size — measured, not assumed

`Condition` in `alarm_state.h` gains a `bool always`. This matters because
`Config` is persisted to EEPROM by `EepromStore`, and a size change would
misread stored config after an upgrade.

Measured on this machine before writing this spec, compiling the structs with
and without the field:

| struct | before | after |
|---|---|---|
| `Condition` | 34 | 34 |
| `SensorConfig` | 150 | 150 |
| `Config` | 2416 | 2416 |

`kLen` (a `uint8_t`) is followed by a padding byte to align the struct to its
`uint16_t` members; `always` occupies that byte. Nothing grows.

**Still assert it rather than trusting the table.** The measurement was taken
with the host compiler, and the target is xtensa-esp32s3 — same layout rules,
but the assert is what makes that a guarantee instead of an expectation:

```cpp
static_assert(sizeof(Config) == 2416, "EEPROM layout changed — bump kMagic");
```

If the assert ever fails, `EepromStore::kMagic` must be bumped so stale config
is discarded rather than misread.

### Disarmed no longer means "nothing can fire"

Once any always-rule exists, "Disarmed" is no longer a complete description of
the system's state. The Operations page must say so, or a smoke trigger at 3am
on a disarmed system is an inexplicable event.

The count spans all profiles, so it is a project-level fact, not a property of
the armed profile.

## Data Model

**Firestore** — `Rule` gains one optional field:

```ts
export interface Rule {
  id: string;
  name: string;
  sensors: string[];
  condition: Condition;
  always?: boolean; // fires even when disarmed; absent = false
}
```

**RTDB wire format** — `RtdbCondition` gains one optional field:

```ts
export interface RtdbCondition {
  t: 0 | 1 | 2 | 3;
  n?: number;
  w?: number;
  y?: number;
  k?: Record<string, number>;
  x?: 1; // always-on; omitted when false to keep the payload small
}
```

**Device** — `Condition` in `alarm_state.h` gains:

```cpp
bool always = false;
```

## Components

### 1. `functions/src/buildConfig.ts`

`buildRtdbConfig` takes the active profile's rules as today, plus a new
parameter carrying always-rules from every profile. Pass 1 (building `r`) and
pass 2 (translating conditions) both run over the union, de-duplicated by rule
id so a rule in the active profile is not counted twice.

`toRtdbCondition` sets `x: 1` when the rule is always, and omits the key
otherwise.

### 2. `functions/src/onProfileChange.ts`

`rebuildConfig` gathers always-rules across all profiles before calling
`buildRtdbConfig`. Note this makes the rebuild sensitive to rule changes in
*inactive* profiles — `onRuleChange` already fires for any profile's rules, so
no new trigger is needed, but the existing early-outs must not skip them.

### 3. `functions/src/onSensorEvent.ts`

The `if (project.serverArmed)` block at line 91 becomes a rule-gathering step
followed by shared evaluation:

- **Armed:** the active-server profile's rules, plus always-rules from all
  profiles (de-duplicated).
- **Disarmed:** always-rules from all profiles only.

If the resulting rule list is empty, skip evaluation entirely — preserving
today's behaviour for projects with no always-rules.

Everything downstream (`evaluateRules`, `alarm_cause`, siren, Telegram) is
unchanged.

### 4. `functions/src/alarmLogic.ts`

`evaluateRules` needs no change: it evaluates whatever rules it is handed. The
arm-state decision belongs to the caller, which keeps this module pure and its
27 existing tests valid.

### 5. `firmware/edge/device/src/alarm_state.cpp`

`onSensorEvent` currently starts with a single gate:

```cpp
if (!config_.armed) return false;
```

That becomes a per-condition check inside the existing loop, so a disarmed
device still evaluates always-conditions:

```cpp
// Disarmed no longer means "evaluate nothing": always-conditions (smoke,
// gas) must fire regardless. The sensor lookup and per-condition loop run
// either way; only non-always conditions are skipped when disarmed.
if (!config_.armed && !cond.always) continue;
```

**Why `continue` and not an early `return`.** `evaluateCondition` records
trigger history as a *side effect of being called* (`alarm_state.cpp:45-92` —
cases 1 and 3 append to `rt.triggerTimesMs` before deciding). So:

- Always-conditions are evaluated while disarmed, and therefore accumulate
  history — a disarmed `count_in_window` always-rule works.
- Ordinary conditions are skipped while disarmed and accumulate nothing, which
  is exactly today's behaviour (the current early `return false` has the same
  effect), so arming does not inherit a backlog of stale triggers.

An `entry_delay` always-rule is a contradiction — a grace period to disarm,
on a rule that ignores disarming. The UI should not offer `always` for
`entry_delay`; if one is somehow configured, it behaves as today (the delay
timer runs and `tickEntryDelay` fires it), which is harmless but pointless.

### 6. `firmware/edge/device/src/config_parser.cpp`

Parse `x` into `Condition::always`, defaulting to false when absent.

### 7. Web UI

**`RuleEditor.tsx`** gains a checkbox: "Always active — fires even when
disarmed", with help text explaining it ignores arm state and still respects
the siren setting.

**`ProfilesTab.tsx`** marks always-rules in the rule list, so a profile's rules
are not silently different from each other.

**`OperationsPage.tsx`** notes the presence of always-rules next to the
Disarmed state. Reads from the profiles/rules the page already subscribes to.

## Testing

- **`buildConfig`** (existing vitest suite): an always-rule in a non-active
  profile reaches `r`/`c`; the same rule in the active profile is not
  duplicated; `x: 1` is present only when always; the payload is byte-identical
  to today when no rule is always.
- **`onSensorEvent`** rule-gathering: extract the "which rules apply" decision
  into a pure helper so it is testable without Firestore — armed with and
  without always-rules, disarmed with and without.
- **`alarm_state`** (native Unity): disarmed + always fires; disarmed +
  ordinary does not; armed + both fire; a disarmed `count_in_window`
  always-rule accumulates across events.
- **`config_parser`** (native Unity): `x: 1` parses to `always = true`; absent
  parses to false.
- **`static_assert`** on `sizeof(Config)` guarding the EEPROM layout.

## Risks

- **A smoke rule that never reaches the device.** The all-profiles collection
  is the whole feature; if it regresses, the UI still shows the rule as always
  and nothing happens on hardware. The buildConfig test for a non-active
  profile is the guard.
- **EEPROM layout drift.** Covered by the static_assert.
- **This is not a substitute for a certified smoke alarm.** A 433MHz sensor
  relayed through a hobby receiver and evaluated on an ESP32 is a useful
  notification layer, not a life-safety device. Standalone detectors stay.
