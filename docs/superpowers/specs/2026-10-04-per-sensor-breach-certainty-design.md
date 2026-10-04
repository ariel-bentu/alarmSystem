# Per-sensor breach certainty, and judge escalation

**Date:** 2026-10-04
**Status:** design, awaiting approval

## Problem

Every alarm currently notifies at one level. Since the Pushover work
(2026-10-04) that level is `alarm` → Pushover priority 2: a Critical Alert
that repeats until acknowledged. That is right for a door opening at 3am and
wrong for the garden motion sensor catching a cat, and today they are
indistinguishable.

The sensors differ in what a trigger *means*:

- **Door open** is a break-in on its own. Nothing needs to confirm it.
- **Movement** is suggestive. A camera frame can confirm or clear it.

So certainty is a property of the sensor, and the notification tier should
follow from it:

| Sensor certainty | On alarm | After judge verdict |
|---|---|---|
| **Definite** | emergency (priority 2, repeats) | — judge does not change the tier |
| **Non-definite** | loud (priority 1, audible through mute, single shot) | `breach` → **escalate** to emergency; `safe` → quiet all-clear |

This extends the judge's role. It currently only ever *suppresses* (writes a
false-positive advisory to `commands/fp`). It now also *escalates*: a breach
verdict on a non-definite sensor raises the notification tier it already
sent.

## Decisions taken (and their costs)

Each of these was chosen deliberately; the cost is recorded so it is not
rediscovered as a bug.

1. **No verdict ⇒ stays at priority 1.** If the NVR is down, `nvrMode` is not
   `capture+judge`, or the sensor has no cameras ticked, a non-definite alarm
   never escalates. No timeout, no timer, no escalate-on-unjudgeable.

   ⚠️ **Cost — read this twice.** This makes NVR health load-bearing for night
   alerting. A real break-in through a non-definite sensor during an NVR
   outage sounds the siren but never nags the phone. It also creates an
   inversion: a sensor *deliberately* marked non-definite is less likely to
   wake you than one nobody has configured (which defaults to definite). The
   siren remains the backstop. Accepted to avoid crying wolf.

2. **`safe` verdict also sends a quiet all-clear** — priority -1, silent — on
   top of today's `commands/fp` advisory and timeline note, so a glance at the
   phone explains the earlier priority-1 alert.

3. **Unset defaults to definite.** A newly paired sensor wakes you. Matches
   the project's fail-safe stance elsewhere (a missing judge key yields a
   NullJudge that fails to "breach" — noisy, never suppressed).

4. **No UI warning for the unjudgeable combination** (non-definite + no
   cameras). Owner manages it.

5. **UI: a `Definite breach` checkbox** per sensor in the Sensors tab, beside
   the camera selection, with inline `Help` text.

## Scope: cloud and web only

`onAlarm` fires on `/{projectId}/state/siren_active`, which **both** the
device and the server write, and it is already the single notifier for every
alarm that sounds the siren. So the tier can be decided entirely in
`onAlarm`, cloud-side.

Consequences, all verified against the code:

- **No firmware change.** The device does not need to know about certainty.
- **No EEPROM magic bump**, so no risk to the siren pairing (see
  `docs/history/siren-hub-free.md` —
  `siren-address-never-restorable-from-cloud`).
- **No RTDB config change.** `definiteBreach` must therefore be **excluded**
  from `sensorConfigChanged`'s guard, exactly as `cameraNames` already is.
  Including it would churn the device config for a field the device never
  receives.

## The blocker this design had to solve

`alarm_cause` has two shapes (`functions/src/alarmCause.ts`):

| Writer | Shape |
|---|---|
| Device (`cloud_client.cpp`) | `{ rfId, ct, at }` |
| Server (`onSensorEvent.ts`) | `{ label, at }` — **no rfId** |

A server-evaluated alarm records only a label, so `onAlarm` **cannot
currently tell which sensor caused it** and has nothing to look certainty up
on. This is not hypothetical: it is both server-side alarm paths today (the
tamper path at `onSensorEvent.ts:183` and the rule path at `:272`).

**Fix:** server-written causes gain an `rfId` alongside `label`. Both server
write sites already hold the `sensor` object, so this is a one-line change at
each.

Verified in `alarmCause.ts`: `AlarmCause` **already declares both `label` and
`rfId` as optional**, and `parseCause` keeps whichever are present — so this
needs **no type change and no parser change**, only the two writes.
`resolveCauseLabel` prefers `label` when set, so adding `rfId` cannot alter
any existing label.

### Side effect of the `rfId` fix — stated, not slipped in

`onSnapshotUploaded`'s armed gate (`onSnapshotUploaded.ts:228`) requires
`causeFamily === family`, where `causeFamily` is derived from the cause's
`rfId`. A server-written cause has no `rfId` today, so `causeFamily` is
`null` and **the judge currently never runs on a server-evaluated alarm** —
it logs "no fresh matching alarm_cause" and returns.

Adding `rfId` to the server's writes therefore *enables* judging for
server-side alarms that are silently skipped today. This is a genuine
improvement — those alarms are exactly the rule-based ones that most want
camera confirmation — but it is a behaviour change beyond the stated feature,
and it means the judge (and the Anthropic/Gemini spend) starts running on a
path it never ran on before.

It is also load-bearing for this feature: without it, a non-definite sensor
alarming via a *server* rule would send priority 1 and then never escalate,
because no judge would run. Keeping the two halves together is what makes the
escalation path real rather than theoretical.

### Multi-sensor rules

A `multi_sensor` rule names several sensors; the recorded cause names the
rule, not one sensor. Resolution rule, stated explicitly:

> When the cause resolves to **no single sensor**, the alarm is treated as
> **definite**.

Rationale: a multi-sensor rule firing means several conditions were met at
once, which is stronger evidence than any single trigger — and the fail-safe
direction is loud. Same answer for an unresolvable `rfId`.

## Design

### 1. Data

`Sensor.definiteBreach?: boolean` on `projects/{projectId}/sensors/{id}`.

**Absent means definite** (decision 3). Encoded as a single helper so the
default lives in exactly one place and cannot drift between readers:

```ts
// functions/src/breachCertainty.ts
export function isDefiniteBreach(sensor: Pick<Sensor, "definiteBreach"> | null): boolean {
  // Absent/null → true. A sensor nobody has configured wakes you; and an
  // unresolvable cause (multi-sensor rule, unknown rfId) passes null here
  // and gets the same fail-loud answer.
  return sensor?.definiteBreach !== false;
}
```

Mirrored in `web/src/types/index.ts`. Not a device-visible field.

### 2. `onAlarm` picks the tier

`onAlarm` already loads every sensor to resolve the cause label. It gains the
sensor *object* for the cause, not just the name, and chooses:

```
definite (or unresolvable)  → severity "alarm",  title "Alarm"
non-definite                → severity "loud",   title "Alarm (unconfirmed)"
```

Both keep `link: true`. The Telegram text is unchanged in both cases —
Telegram has no tiering, and changing the wording would make the two channels
disagree about the same event.

Extracted as a pure function so the matrix is testable without the emulator,
following the `alarmLogic`/`onAlarm` split the codebase already uses:

```ts
// functions/src/breachCertainty.ts
export function alarmSeverity(definite: boolean): "alarm" | "loud" {
  return definite ? "alarm" : "loud";
}
```

### 3. `onSnapshotUploaded` escalates on breach

The breach branch currently always sends `severity: "alarm"`. It becomes
conditional on what was *already* sent:

- **Sensor was definite** → the alarm was already emergency. Send the breach
  photo and timeline note as today, but **no second emergency push** — it
  would be the second repeating alert for one event.
- **Sensor was non-definite** → the alarm went out as priority 1. The breach
  verdict is the escalation: send `severity: "alarm"`, title
  `"Confirmed breach"`, which is the first priority-2 push for this event.

```ts
const definite = isDefiniteBreach(sensor);
// A definite sensor already sent priority 2 from onAlarm; re-sending would
// mean two repeating alerts for one event.
const severity = definite ? "loud" : "alarm";
```

A definite sensor's breach confirmation therefore arrives as priority 1 —
loud, audible, single-shot — which is correct: you are already being nagged
by the original emergency alert.

### 4. `safe` verdict: quiet all-clear

In the existing `safe` branch, after the `commands/fp` write and the timeline
note, add:

```ts
await deps.notify(projectId, project, {
  text: `✓ Cleared — ${sensorName}, ${cameraLabel} — ${reason}`,
  severity: "notice",   // priority -1: silent, explains the earlier alert
});
```

Sent regardless of the sensor's certainty: a cleared trigger is worth
explaining either way. **Not** sent on the `alreadyHasBreach` path — that
branch deliberately withholds the advisory because a sibling channel saw a
breach, and an "all clear" there would contradict a standing alarm.

### 5. Web UI

`SensorsTab.tsx`: a `Definite breach` checkbox per sensor, beside the camera
picker, with `Help` text — *"An alarm from this sensor is a confirmed
break-in: sends an emergency notification that repeats until acknowledged.
Leave unticked for sensors that need camera confirmation, such as motion."*

Written through the existing sensor-update path. i18n keys in **both**
`en.ts` and `he.ts` (flat dotted keys, `sensors.*`; a locale-parity test
enforces this).

## Resulting matrix

| Sensor | Alarm fires | Judge: breach | Judge: safe | No verdict |
|---|---|---|---|---|
| Definite | **P2** repeats | P1 + photo | P-1 all-clear + `fp` | — |
| Non-definite | **P1** single | **P2** repeats (escalation) | P-1 all-clear + `fp` | stays P1 |

## Error handling

| Case | Behaviour |
|---|---|
| `definiteBreach` absent | definite (fail loud) |
| Cause has no `rfId` (legacy server write) | definite |
| Cause `rfId` matches no sensor | definite |
| Multi-sensor rule | definite (no single sensor) |
| Sensor deleted between alarm and verdict | `isDefiniteBreach(null)` → definite |
| `notify` fails | already non-throwing; unchanged |

Every unknown resolves to **definite**. The only way to get the quieter tier
is an explicit `definiteBreach: false` on a resolvable sensor.

## Testing

TDD. All pure logic, no emulator.

`breachCertainty.test.ts`
- `isDefiniteBreach`: absent → true, `true` → true, `false` → false,
  `null` → true
- `alarmSeverity`: true → `"alarm"`, false → `"loud"`

`onSnapshotUploaded.test.ts` (extends the existing injectable-deps suite)
- breach + non-definite → `notify` called with `severity: "alarm"`
- breach + definite → `severity: "loud"` (no duplicate emergency)
- safe → a `severity: "notice"` all-clear is sent
- safe + `alreadyHasBreach` → **no** all-clear sent
- the breach photo still goes out in both certainty cases

`alarmCause.test.ts` — regression guard, since the server now sends both
fields where it previously sent one:
- `parseCause` keeps `rfId` and `label` when both are present (already
  supported; pin it so a future narrowing cannot silently drop `rfId`)
- `resolveCauseLabel` still prefers `label` when both are set — adding `rfId`
  must not change any existing label

`onAlarm` has no unit test (per this codebase's convention: thin trigger
wrappers are covered by emulator smoke tests). Its new logic is entirely in
`breachCertainty.ts`, which is tested above. Verification for the wrapper is
`tsc` plus the end-to-end check below.

## Files touched

| File | Change |
|---|---|
| `functions/src/breachCertainty.ts` | new — `isDefiniteBreach`, `alarmSeverity` |
| `functions/src/breachCertainty.test.ts` | new |
| `functions/src/types.ts` | `Sensor.definiteBreach?` |
| `functions/src/alarmCause.ts` | **comment only** — `AlarmCause.rfId` and `parseCause` already support the server carrying `rfId`; note that it now does |
| `functions/src/onAlarm.ts` | resolve the sensor; pick severity |
| `functions/src/onSensorEvent.ts` | write `rfId` into both `alarm_cause` writes |
| `functions/src/onSnapshotUploaded.ts` | escalate on breach; all-clear on safe |
| `functions/src/sensorConfigChanged.ts` | **comment only** — record that `definiteBreach` is deliberately excluded |
| `web/src/types/index.ts` | mirror `definiteBreach` |
| `web/src/features/configure/SensorsTab.tsx` | the checkbox |
| `web/src/i18n/{en,he}.ts` | strings |
| `CLAUDE.md` | the new matrix; update the Pushover section's severity table |

Explicitly **not** touched: any firmware file, `buildConfig.ts`,
`database.rules.json`, `EepromStore::kMagic`.

## Open question

None blocking. One judgement call recorded above and worth re-reading before
implementation: **decision 1's cost** — non-definite sensors have no
escalation path when the judge is unavailable, and the siren is the only
backstop.
