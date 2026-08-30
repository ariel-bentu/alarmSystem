# Scheduled Arming — Design
_2026-08-30_

## Overview

Arm and disarm the system on a schedule, without touching the app. Two
shapes cover the need:

- **Recurring** — "arm Away on the device at 23:00, disarm at 07:00, Mon–Fri"
- **One-time** — "arm at 23:00 tonight, disarm at 08:00 tomorrow"

A schedule is a **window**: one record holding an arm time, a disarm time, a
profile and a side. The arm time is optional, which covers the case that
motivated the shape — some people want to arm manually at bedtime but have
the house release itself in the morning. The disarm time is required, so
every window closes.

The feature is **operational**, not configuration. Like a phone's alarm
clock, you check it and toggle it on the screen you already use, so it lives
on the Operations page rather than under Configure.

Nothing about the device firmware changes. The scheduler writes the same
Firestore and RTDB fields a person pressing a button writes, so every
existing downstream path — config rebuild, timeline mirroring, Telegram,
the device's own polling — is reused unmodified.

## Scope

In scope: Firestore schema for schedules, a pure next-occurrence module, a
Firestore trigger keeping derived timestamps fresh, one new scheduled Cloud
Function, a project-level timezone, silent Telegram for arm/disarm, and the
Operations UI.

Out of scope: skip-one-occurrence (the enable toggle covers it), sunrise/
sunset-relative times, per-schedule timezones, and any firmware change.

## Design Decisions

Decisions taken during design that constrain the implementation. Each is
recorded with its reasoning so it is not silently reversed later.

### A window, not an edge

A record pairs an arm and a disarm. The alternative — each record being a
single edge, with two records to express a night — was rejected because the
user's intent genuinely is one window, and because nothing would stop a
half-configured pair that arms and never disarms. Making `disarmTime`
required turns "every window closes" into a structural property rather than
a validation rule.

### Side and profile are per-window

The system arms two independent sides: **device** (`commands/armed` in RTDB
plus `isActiveOnDevice` on a profile) and **server** (`serverArmed` on the
project doc plus `isActiveOnServer`). Each window names exactly one side
and one profile. Arming both sides at 23:00 is therefore two windows.

This is deliberate: the two sides are currently run in parallel to validate
the server evaluation path against the device path while the W184 is being
retired, and a schedule that silently drove both would erase that
distinction.

### Edges fire; they do not enforce state

The scheduler acts **only at an edge instant**. It never reconciles the
system's current arm state against what a schedule implies.

This is a load-bearing invariant, not an implementation detail. A
reconciler that kept the armed state matching the schedule would re-arm a
user who had just manually disarmed at 03:00 — fighting them at the worst
possible moment. A manual override therefore stands until the next edge,
and that is the correct behaviour.

The corollary: disarming an already-disarmed side is a harmless no-op, so a
missed or overridden window needs no repair.

### Stale edges are skipped, not fired late

An edge is fired if it is late by **less than 15 minutes**, and skipped
(advancing straight to the next occurrence) otherwise. Downtime from a
deploy or an outage should not arm the house at 08:00 because a 23:00 edge
was still pending.

Same reasoning as the existing 60-second cutoff on `alarm_cause` in
`onAlarm.ts`: a stale trigger is worse than a missed one.

### Overlaps are last-write-wins, warned but not blocked

Two windows may target the same side and overlap. Each edge is an
independent action — an arm edge sets its side to its profile, a disarm
edge disarms that side — so no window "owns" a side and there is no
ownership to arbitrate.

An overlapping pair can therefore disarm earlier than the user expected.
That is what was configured, and both rows are visible. The UI warns when a
newly saved window overlaps an existing one on the same side; it does not
block. Priority schemes or interval merging would be substantial machinery
producing behaviour the user still could not predict.

### Timezone is per project, IANA, DST-correct

The project doc gains `timezone` (e.g. `Asia/Jerusalem`), defaulting at
creation to the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`
and editable afterwards.

A fixed UTC offset was rejected: it is wrong for months at a time wherever
DST is observed, and an alarm that silently shifts by an hour twice a year
undermines confidence in the whole system. Per-schedule timezones were
rejected as a control nobody would ever change.

Note that `deadSensorCheck`'s existing `every day 12:00` schedule is UTC,
not local. That is harmless for a dead-sensor sweep and is left alone.

### No new dependency for time arithmetic

`functions/` has exactly two runtime dependencies today. Node 20 on Cloud
Functions ships full ICU, so `Intl` can resolve zone offsets without
`luxon` or `date-fns-tz`. The arithmetic is fiddly enough to isolate in a
pure, unit-tested module — matching how `alarmLogic.ts`, `buildConfig.ts`
and `parseCommand.ts` are already pure and tested.

### DST edge behaviour

The two genuinely ambiguous cases get a decided answer rather than an
accidental one:

- **Skipped wall-clock time** (spring forward — 02:30 does not exist):
  fire at the instant the clock jumps, so the edge is not silently lost.
- **Repeated wall-clock time** (autumn — 02:30 happens twice): fire on the
  first occurrence only, never twice.

Both are covered by explicit unit tests.

### One scheduled function, ticking every minute

Cloud Scheduler's free tier is **3 jobs per billing account** (not per
project); `deadSensorCheck` uses one, so this makes two, leaving one spare.
Billing beyond the free tier is per *job*, not per execution — about
$0.10/job/31 days — so tick frequency costs nothing at the Scheduler level.

Frequency does cost Firestore reads, which is what the precomputed
`nextArmAt` / `nextDisarmAt` fields exist to control: an idle minute costs
two collection-group queries that match zero documents. Reading every
schedule document 1,440 times a day was the alternative and was rejected.

Cloud Tasks (enqueue each edge at its exact instant) was rejected as a
second product with its own quota, requiring cancel-and-re-enqueue on every
edit. Minute granularity is ample for arming.

### All arm/disarm Telegram messages are silent

Telegram's `disable_notification` delivers a message into the chat without
sound or vibration. Arm/disarm — **manual and scheduled alike** — is a
notice, not a demand for attention, so both are silent.

Because manual and scheduled arming are treated identically here, the
scheduler needs no marker for notification purposes and
`onArmStateChange` / `onServerArmChange` pass `silent: true`
unconditionally. Alarms, dead sensors and sensor events stay loud, keeping
the loud channel meaningful.

| Message | Source | Silent |
|---|---|---|
| Alarm triggered | `onAlarm`, `onSensorEvent` | no |
| Dead sensor | `deadSensorCheck` | no |
| Sensor trigger / tamper / battery low | `onSensorEvent` | no |
| Arm/disarm (manual and scheduled) | `onArmStateChange`, `onServerArmChange` | **yes** |
| Bot command replies | `telegramWebhook` | **yes** |

### The scheduler writes what a human would

The tick sets exactly the fields the Operations page sets. It gets no
private path to the device. Everything downstream already exists and is
already tested.

## Data Model

### `projects/{projectId}/schedules/{scheduleId}`

```ts
export interface Schedule {
  id: string;
  name: string;                   // user-facing, e.g. "Weeknights"
  enabled: boolean;               // pause without deleting
  side: "device" | "server";
  profileId: string;              // profile the arm edge activates
  armTime: string | null;         // "23:00" local; null = manual-arm window
  disarmTime: string;             // "07:00" local; required — windows close
  days: number[];                 // 0–6, Sun–Sat. Empty = one-time
  date: string | null;            // "2026-09-01" for one-time; null if recurring
  nextArmAt: Timestamp | null;    // derived — see onScheduleChange
  nextDisarmAt: Timestamp | null; // derived
  lastFiredAt: Timestamp | null;
  createdAt: Timestamp;
}
```

Invariants, enforced on write:

- Exactly one of `days` (non-empty) or `date` (non-null) is populated.
  Non-empty `days` means recurring; a set `date` means one-time. Recurrence
  is expressed by which field is populated, not by a mode enum.
- `disarmTime` is always present. `armTime` may be null.
- `profileId` is required even for an arm-less window, so the UI can label
  the row; it is unused at the disarm edge.

The **disarm edge is derived, never stored as its own day-set**. When the
window has an arm edge, `nextDisarmAt` is computed forward from
`nextArmAt`, so a 23:00→07:00 Friday window disarms on Saturday morning
with no wraparound flag. For an arm-less window, `disarmTime` resolves
against `days` directly.

`nextArmAt` and `nextDisarmAt` are denormalized derived state. They earn
that twice: they make the tick's query cheap, and they are exactly what the
UI displays as "next: arms 23:00 tonight".

### Project doc

One added field:

```ts
timezone: string;  // IANA, e.g. "Asia/Jerusalem"
```

### Firestore index

The tick queries across projects, so collection-group indexes are needed on
the `schedules` group for `enabled` + `nextArmAt` and `enabled` +
`nextDisarmAt`.

**`firestore.indexes.json` does not currently exist** — it must be created,
and `firebase.json` extended to reference it (its `firestore` block lists
only `rules` today). Named here because a missing index does not fail until
the query runs in production.

### Security rules

`firestore.rules` gains a `schedules` block inside `match /projects/{projectId}`.
Writes are **admin-only**, matching `sensors`, `sirens` and
`profiles/{id}/rules` — creating a schedule is a configuration act.

One carve-out, mirroring the existing one on `profiles`: a plain member may
update a schedule when the change touches **only `enabled`**, and only for a
`side == "device"` schedule. The reasoning is already established in the
`profiles` rule — a member may arm and disarm the device but not the server,
because server-side arming changes what the cloud evaluates for the whole
project. Pausing a device schedule is the same class of act as arming the
device; pausing a server schedule is not.

The derived fields (`nextArmAt`, `nextDisarmAt`, `lastFiredAt`) are written
by `onScheduleChange` and `scheduleTick` under the admin SDK, which bypasses
rules entirely, so they need no client-write allowance.

### Type mirroring

`web/src/types/index.ts` mirrors `functions/src/types.ts` by hand. The
`Schedule` interface and the project's new `timezone` field must be added to
both, with the web copy using the client SDK's `Timestamp`.

## Components

### 1. `functions/src/nextOccurrence.ts` — pure

The only place a wall-clock time becomes an instant.

```ts
nextArmInstant(schedule: Schedule, tz: string, after: Date): Date | null
nextDisarmInstant(
  schedule: Schedule, tz: string, armAt: Date | null, after: Date
): Date | null
```

No Firestore, no ambient clock — `after` is injected so tests pin time
exactly. Returns `null` when a one-time schedule's occurrence has passed.
Holds the DST rules above.

### 2. `functions/src/onScheduleChange.ts` — Firestore trigger

Fires on any write to `projects/{projectId}/schedules/{scheduleId}`.
Recomputes `nextArmAt` / `nextDisarmAt` via `nextOccurrence` and writes them
back. **One place computes derived state** — the invariant that keeps the
cheap-query design honest.

Must skip when only the derived fields changed, or it recurses.

Disabling a schedule clears the derived timestamps; re-enabling recomputes
from the current time, so a schedule paused for three weeks does not wake
believing it owes a fire from the past. The staleness cutoff would catch
that anyway; being explicit is cheaper than leaning on the backstop.

### 3. `functions/src/scheduleTick.ts` — the new scheduled function

Runs every minute in `europe-west1`.

1. Collection-group query: schedules with `enabled == true` and
   `nextArmAt <= now`. Repeat for `nextDisarmAt`.
2. For each due edge: if late by more than 15 minutes, skip and advance.
3. Otherwise fire it:
   - **device** — set `isActiveOnDevice` on the target profile (clearing it
     on the others) and write `commands/armed`.
   - **server** — set `isActiveOnServer` likewise and write `serverArmed`
     on the project doc.
   - Disarm sets the side's flags false; no profile is activated.
4. Recompute the next occurrence and write it back, with `lastFiredAt`.

**A disabled profile is not armed.** If the target profile has
`enabled: false`, the arm edge is skipped and logged — arming a profile the
Operations page hides would be invisible and unpredictable. The **disarm**
edge still fires, because releasing is always safe. The UI flags a schedule
pointing at a disabled profile.

### 4. `functions/src/telegram.ts` — one added parameter

`sendTelegram(botToken, chatId, text, silent = false)`, passing
`disable_notification`. Defaulting to `false` means no existing call site
changes behaviour unless it opts in. `onArmStateChange`,
`onServerArmChange` and `telegramWebhook`'s replies pass `true`.

Nine call sites exist and `sendTelegram` is the single choke point, so this
is a contained change.

### 5. Web UI — Operations page

Schedules live entirely on Operations; Configure gets nothing. One place to
look, no split-brain about where schedules are managed.

Modelled on a phone's alarm-clock app: each schedule is one compact row —
large time, small subtitle, toggle on the right — so the list stays
scannable. A `+` opens a modal editor, following the modal pattern
established for rules and sensor pairing.

```
┌──────────────────────────────────────────────┐
│  23:00 → 07:00                    [ ●━━ ]    │
│  Away · device · Mon–Fri                     │
├──────────────────────────────────────────────┤
│  → 05:00                          [ ━━○ ]    │
│  disarm only · server · every day            │
└──────────────────────────────────────────────┘
                                          [ + ]
```

An arm-less window shows a single time behind an arrow, making its shape
obvious at a glance. Tapping the row opens the editor; tapping the toggle
only toggles and never navigates — the toggle is the control most often
reached for ("skip tonight"), so it must not be a navigation trap.

Placement: **below the arm grid and SOS, above the siren panel.** The arm
grid is what you came to press; schedules are what you check on the way
past.

The section header carries the next upcoming edge in plain language —
*"Next: device arms 23:00 tonight"* — read straight from the precomputed
timestamps. It is not repeated per row; with a handful of schedules the
rows already say it.

Live via `onSnapshot` on the schedules collection, as the page already does
for profiles and sensors.

Permissions follow the security rules above, and the UI must match them
rather than rely on them: non-admins see the `+` button and the row editor
disabled, and the toggle enabled only on device-side schedules. Operations
already hides the Server card from non-admins, so a server schedule row is
hidden from them entirely for the same reason.

The editor modal collects: name, side, profile, arm time (clearable),
disarm time, and recurrence (weekday toggles, or a date for one-time). It
warns on same-side overlap and on a disabled target profile.

All user-facing strings go through the existing i18n layer — added to both
`web/src/i18n/en.ts` and `he.ts`. Two things need care in Hebrew: the
`23:00 → 07:00` arrow reads right-to-left, so the row must lay out with
logical CSS properties rather than hardcoded left/right; and weekday
abbreviations for the toggle row need real Hebrew forms, not transliterated
English.

## Data Flow

A 23:00 device arm:

```
scheduleTick (23:00) → profile.isActiveOnDevice = true
                     → commands/armed = true
                          ↓                    ↓
                   onProfileChange        onArmStateChange
                   rebuilds RTDB config   timeline + silent Telegram
                          ↓
                   device polls, arms
```

The device is never addressed directly. Because the tick writes the fields
a human writes, remote arming latency is unchanged from manual arming —
`kPollIntervalMs` is 5s and the device alternates `/config` with
`/commands`, so worst case is roughly 10s. (CLAUDE.md still describes a 15s
cadence; the code is the 5s value.) Well inside the minute granularity the
scheduler works at.

The Firestore timeline records whether an arm was scheduled or manual, so
event history explains *why* the house armed. That is a display concern
only — it does not affect notification, since both are silent.

## Testing

Pure modules, unit-tested with vitest alongside the existing suites:

- **`nextOccurrence`** — the bulk of the value. Recurring weekday sets
  including wraparound (Friday 23:00 → Saturday 07:00); one-time windows
  before, during and after their occurrence; arm-less windows; both DST
  transitions in a DST-observing zone (skipped and repeated wall-clock
  times); a zone without DST as a control.
- **Overlap detection** and the row-label formatter — pure, testable
  without Firestore, mirroring how `profileRules.ts` and `alarmState.ts`
  are tested on the web side.
- **`scheduleTick` firing logic** — extract the decision (fire / skip-stale
  / skip-disabled-profile / advance) into a pure function taking the
  schedule, the profile's enabled flag and `now`, so it is tested without
  emulating Firestore. The Firestore reads and writes around it stay thin.

Manual verification on hardware: set a window one minute out, confirm the
device arms, the timeline shows a scheduled arm, and the Telegram message
arrives silently.

## Risks

- **Derived timestamps going stale.** Mitigated by making
  `onScheduleChange` the single writer, and by the staleness cutoff as a
  backstop. A bug here means a schedule silently stops firing — the UI's
  "next" line is the user-visible canary.
- **Missing collection-group index.** Fails only in production. Listed
  explicitly above.
- **DST arithmetic.** The reason `nextOccurrence` is pure and separately
  tested rather than inlined into the tick.
