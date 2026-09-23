# Battery replacement tracking — design

**Date:** 2026-09-23
**Status:** awaiting review

## Problem

A Kerui sensor's battery dies silently. The device reports `battery_low` when
the sensor says so, and `functions/` already Telegrams on it — but that is
reactive: by then the sensor is close to useless, and a sensor that dies
between triggers is a blind spot nobody notices.

There is no record of when a battery was last changed, so there is no way to
answer "which of these is overdue?" before one fails.

`todo.txt` carries this as "battery last change".

## Scope

Record when each sensor's battery was last replaced, show its age, and Telegram
once when a battery is older than a project-wide threshold.

Explicitly **out** of scope:

- Per-sensor thresholds. All sensors here are Kerui with the same battery life,
  so the value would be one number repeated. Revisit if mixed hardware appears.
- A history of past replacements. One date per sensor, overwritten.
- Changing the existing `batteryStatus` / `battery_low` reactive alert. The two
  are complementary and stay independent — see "Relationship to batteryStatus".
- Any firmware change. The device neither knows nor needs to know a
  replacement date.

## Data model

### `Sensor` — two new fields

Added to **both** `web/src/types/index.ts` and `functions/src/types.ts`, which
are hand-mirrored (no shared package).

```ts
// When the battery was last replaced, as recorded by a human. Optional:
// sensor docs predate the field. Absent/null means never recorded, and
// readers fall back to pairedAt — see "Unrecorded sensors".
batteryChangedAt?: Timestamp | null;

// Set when the stale-battery alert fires, cleared when batteryChangedAt is
// written. Mirrors deadAlertSentAt exactly, for the same reason: without it
// the daily check would Telegram every day until the battery is replaced.
batteryAlertSentAt?: Timestamp | null;
```

Both optional and nullable. Existing sensor docs have neither and must keep
working untouched — the same "absent means the old behaviour" rule that
`Condition.quorum` and `Project.sirenBaseAddress` already follow.

### `Project` — one new field

```ts
// Months after which a sensor battery is considered overdue. Optional:
// project docs predate it. Absent means the default (12); 0 or negative
// disables the alert for the whole project.
batteryAlertMonths?: number;
```

Project-level, not per-sensor: one control to set and one to change.

## Age semantics

The age of a battery is measured from:

1. `batteryChangedAt`, when recorded; otherwise
2. `pairedAt`, as the fallback.

The fallback is what makes this useful from day one. A battery was presumably
fresh when the sensor was paired, so `pairedAt` is a defensible lower bound on
its age, and it means every sensor is covered with nothing to remember.
Recording a real date only makes it more accurate.

The alternative — skipping sensors with no recorded date — inverts the
incentive: the sensors most likely to hold a dying battery are exactly the ones
nobody got round to recording, and those would be the ones that never alert.

Because `pairedAt` is always present, **every sensor has an age**, and the
alert has no silent-skip case.

## Components

### `web/src/features/configure/batteryAge.ts` (new)

Pure functions, no Firestore. Follows the existing `lastSeenFormat.ts` /
`sensorRecency.ts` precedent in that directory: extracted so the rules are
testable without mounting the tab.

```ts
/** Effective battery start: the recorded change, else the pairing date. */
batteryStartedAt(sensor): Timestamp

/** Whole months between then and now, for display and for the threshold. */
batteryAgeMonths(startedAt, now): number

/** "today" | "3 days ago" | "11 months ago" — null when unknown. */
formatBatteryAge(startedAt, now, t): string | null

/** Whether the age is at or past the project threshold. */
isBatteryStale(startedAt, now, thresholdMonths): boolean

/** Timestamp <-> "yyyy-mm-dd" for <input type="date">. */
toDateInputValue(ts): string
fromDateInputValue(str): Timestamp | null
```

**The timezone trap.** `new Date("2026-09-23")` parses as UTC midnight. In
Asia/Jerusalem (UTC+2/+3) that renders as the *previous day*, so a date picked
as the 23rd would display as the 22nd. `fromDateInputValue` therefore builds
local midnight explicitly (`new Date(y, m - 1, d)`) rather than parsing the
string, and `toDateInputValue` reads local parts rather than calling
`toISOString()`. Both directions are pinned by tests.

**Future dates** are rejected: a replacement date in the future is a typo. The
input carries `max={today}` and `fromDateInputValue` returns null past today,
so nothing nonsensical is stored.

### `functions/src/batteryAgeCheck.ts` (new)

Pure threshold logic, separated from the Firestore walk so it is testable
without the emulator — the same split `deviceLiveness.ts` uses.

```ts
/** Whether this sensor should alert now, and why not if not. */
shouldAlertStaleBattery({ startedAt, alertSentAt, thresholdMonths, now }): boolean
```

Returns false when: the threshold is <= 0 (disabled), the age is under it, or
`batteryAlertSentAt` is already set.

### `functions/src/deadSensorCheck.ts` (extended)

The battery check joins the **existing** sensor loop rather than adding a pass.
That function already runs daily at noon, already walks every project's
sensors, and already guards on Telegram being configured. Adding a second
walk would double the reads for no benefit.

Inside the existing `for (const sensorDoc of sensorsSnap.docs)`, after the
dead-sensor block:

```ts
if (shouldAlertStaleBattery({ ... })) {
  await sendTelegram(token, chatId, formatStaleBattery(sensor.name, months));
  await sensorDoc.ref.update({ batteryAlertSentAt: FieldValue.serverTimestamp() });
}
```

The two checks are independent: a sensor can be both dead and battery-stale and
gets one message for each, because they mean different things — one says "this
stopped reporting", the other "this will stop soon".

`doSchedule.ts`'s table is **unchanged**. No new `onSchedule()`, and the
3-free-jobs-per-billing-account limit is untouched. Its daily-noon row's
`desc` is reworded to mention batteries, since the row now does three things.

### `functions/src/telegram.ts` (extended)

```ts
export function formatStaleBattery(sensorName: string, months: number): string {
  return `🔋 ${sensorName} battery is ${months} months old — consider replacing`;
}
```

A distinct formatter, not a reuse of `formatDeadSensor`, for the reason that
file already documents about `formatDeviceOffline`: different consequence,
different message. Wording is advisory — this is maintenance, not an incident.

### `web/src/features/configure/SensorsTab.tsx` (extended)

The date control goes **inside the existing Battery cell**, under the ok/low
badge. The table already has five columns and scrolls on a phone; battery
status and battery age are the same subject, so they share a cell and the
table stays five wide.

```
[ Battery OK ]
changed 11 months ago
[2025-10-14] [Today]
```

- Date input, `max` = today.
- A **Today** button for the common case: you just changed it, you are standing
  at the sensor, on a phone. Typing a date there is the annoying path.
- A stale battery shows the age in a warning style, so the page agrees with the
  Telegram message.

`handleBatteryChangedAt` mirrors `handleDeadAlertDaysChange` exactly:
`updateDoc` then an optimistic local `setSensors`. It writes
`batteryChangedAt` **and** `batteryAlertSentAt: null` in one update — recording
a replacement is what re-arms the alert for the next cycle. That pairing is the
single most important line in this design: without the clear, each sensor
alerts once ever and never again.

`handleAddSensor` sets `batteryChangedAt: null` and `batteryAlertSentAt: null`
alongside the existing `batteryStatus: "ok"`.

### `web/src/features/setup/SettingsPage.tsx` (extended)

One number input for `batteryAlertMonths`, next to the existing project
settings. Default 12, empty/0 disables. Follows whatever validation shape
`settingsForm.ts` already uses for numeric project fields.

### i18n

New keys in **both** `web/src/i18n/en.ts` and `he.ts`. The repo keeps full
Hebrew parity; real Hebrew strings, not English placeholders.

Keys: `cfg.sensors.batteryChanged`, `batteryChangedToday`,
`batteryNotRecorded`, `batteryAgeMonths`, `batteryStale`,
`settings.batteryAlertMonths` + its help text.

## Relationship to `batteryStatus`

These stay independent and both are shown:

- `batteryStatus` (`ok` / `low`) is **reported by the sensor**, reactive, and
  already alerts.
- Battery age is **recorded by a human**, preventive, and alerts on the
  threshold.

They are most useful together: a `low` on a battery changed last month means a
faulty sensor or a bad cell, while a `low` on a two-year-old one is simply due.
Neither is derived from the other, and recording a replacement date does
**not** reset `batteryStatus` — only the sensor itself can say it is no longer
low.

## Access control

`firestore.rules` needs **no change**. Sensors are already
`allow write: if isAdmin(projectId)`, and the project doc has its own admin
rule. The new fields inherit both.

`SensorsTab` will gate the control the same way it gates the existing
per-sensor controls; the design follows whatever that file already does rather
than introducing a second rule.

## Error handling

- A future date cannot be stored (`max` + a null return from the parser).
- A malformed or cleared date input leaves the field untouched rather than
  writing null, matching how `handleDeadAlertDaysChange` ignores `NaN`.
- `batteryAlertMonths <= 0` disables the alert project-wide; absent means 12.
- A Telegram send failure behaves as it does today: the marker is written only
  after a successful send, so a failure retries at the next noon.
- A sensor doc missing `pairedAt` (should not happen; it is written on create)
  is skipped rather than treated as epoch-old, which would fire an immediate
  bogus alert.

## Testing

**`web/src/features/configure/batteryAge.test.ts`** (new)

- `fromDateInputValue` builds local midnight, not UTC — the Asia/Jerusalem
  off-by-one-day case, asserted explicitly.
- `toDateInputValue(fromDateInputValue(s)) === s` round-trip.
- Future date rejected; malformed string rejected.
- `batteryStartedAt` prefers `batteryChangedAt`, falls back to `pairedAt`.
- `batteryAgeMonths` at month boundaries (30/31 days, year rollover).
- `isBatteryStale` exactly at, just under, and just over the threshold.

**`functions/src/batteryAgeCheck.test.ts`** (new)

- Fires when age exceeds the threshold and no marker is set.
- Silent when `batteryAlertSentAt` is set (the once-ever property).
- Silent when the threshold is 0 or negative (disabled).
- Silent just under the threshold.
- Uses `pairedAt` when `batteryChangedAt` is absent.

**`functions/src/telegram.test.ts`** (extended) — `formatStaleBattery` wording.

**Verification:** `cd web && npm run lint && npm test && npm run build` and
`cd functions && npx tsc --noEmit && npx vitest run && npm run build`.

Not deployed as part of implementation. Deploying this touches Firestore-backed
behaviour and a scheduled function, so it is a separate, explicit step.

## Implementation order

Each step leaves the tree green:

1. Types (`web` + `functions`), both optional — no behaviour change.
2. `batteryAge.ts` + tests. Pure, no callers yet.
3. `SensorsTab` UI + i18n. Recording works; nothing alerts.
4. `SettingsPage` threshold + i18n.
5. `batteryAgeCheck.ts` + tests. Pure, no callers yet.
6. `formatStaleBattery` + test.
7. Wire into `deadSensorCheck`, reword the `doSchedule` row's `desc`.

Steps 1-4 are independently useful: recording and seeing battery age has value
before any alert exists.

## Open questions

None. The three decisions that shaped this — project-level threshold,
`pairedAt` fallback, once-per-battery alerting — were settled before writing.
