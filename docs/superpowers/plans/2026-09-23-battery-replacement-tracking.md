# Battery Replacement Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record when each sensor's battery was last replaced, show its age in the Configure UI, and send one Telegram alert when a battery passes a project-wide age threshold.

**Architecture:** Two optional `Timestamp` fields on the `Sensor` Firestore doc (`batteryChangedAt`, `batteryAlertSentAt`) plus one optional number on `Project` (`batteryAlertMonths`). Age is measured from `batteryChangedAt`, falling back to `pairedAt` so every sensor has an age from day one. Pure date/threshold logic lives in two new unit-tested modules (`web/src/features/configure/batteryAge.ts`, `functions/src/batteryAgeCheck.ts`); the alert joins the sensor loop that already exists inside `deadSensorCheck` (daily at noon), so no new scheduled job is created.

**Tech Stack:** TypeScript throughout. Web: React 18 + Vite, Vitest, `firebase/firestore` client SDK. Functions: Cloud Functions gen-2, `firebase-admin/firestore`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-battery-replacement-tracking-design.md`

## Global Constraints

- **Do NOT add another `onSchedule()`.** Cloud Scheduler allows only 3 free jobs per BILLING ACCOUNT and all 3 are used. Periodic work goes in `functions/src/doSchedule.ts`'s table, and this feature adds work to an *existing* row's callback rather than a new row.
- **All new Firestore fields are optional and nullable** (`field?: T | null`). Existing sensor and project docs predate them and must keep working untouched. Same rule `Condition.quorum` and `Project.sirenBaseAddress` already follow.
- **`web/src/types/index.ts` and `functions/src/types.ts` are hand-mirrored.** There is no shared package. A field added to `Sensor` or `Project` must be added to BOTH, with the same name and compatible type.
- **i18n has full Hebrew parity.** Every key added to `web/src/i18n/en.ts` must also be added to `web/src/i18n/he.ts` with a real Hebrew translation, never an English placeholder. `TranslationKey` is derived from `en.ts`, so a key present in one and missing from the other is a compile error.
- **Timestamps:** web code uses `Timestamp` from `firebase/firestore`; functions code uses `Timestamp` / `FieldValue` from `firebase-admin/firestore`. Do not mix the two imports across the boundary.
- **Verification commands** (run from the repo root):
  - Web: `cd web && npm run lint && npm test && npm run build`
  - Functions: `cd functions && npx tsc --noEmit && npx vitest run && npm run build`
  - `npm run lint` in `web/` is `tsc --noEmit`, not ESLint.
- **Do NOT deploy.** Deployment is a separate explicit step the user controls.
- **Do NOT add role gating to the new controls.** `SensorsTab`'s existing per-sensor controls have none (the `/configure` route is not role-gated; Firestore rules are the real enforcement). Match that. Diverging would make the new field behave differently from the field beside it.
- **Two similarly-named functions exist on purpose, and are NOT a typo:** `batteryStartedAt` in `web/src/features/configure/batteryAge.ts` (Task 2) and `batteryStartedAtMs` in `functions/src/batteryAgeCheck.ts` (Task 6). `web/` and `functions/` are separate packages with separate `tsconfig`s and no shared module — the same reason `types.ts` exists twice — so the month arithmetic is deliberately duplicated rather than cross-imported. Do not attempt to unify them, and do not "fix" one name to match the other.

---

### Task 1: Add the Firestore fields to both type definitions

Types only — no behaviour change, nothing reads these yet. Both files in one task because they are two halves of one edit and a reviewer would reject them separately as incomplete.

**Files:**
- Modify: `web/src/types/index.ts` (the `Sensor` interface, ~line 111-120; the `Project` interface)
- Modify: `functions/src/types.ts` (the `Sensor` interface, ~line 69-78; the `Project` interface, ~line 151+)

**Interfaces:**
- Consumes: nothing.
- Produces: `Sensor.batteryChangedAt?: Timestamp | null`, `Sensor.batteryAlertSentAt?: Timestamp | null`, `Project.batteryAlertMonths?: number`. Every later task depends on these names.

- [ ] **Step 1: Add the two fields to the web `Sensor` interface**

In `web/src/types/index.ts`, inside `export interface Sensor`, after the existing `deadAlertSentAt` line:

```ts
  // When the battery was last replaced, as recorded by a human — NOT
  // reported by the sensor (batteryStatus is the sensor's own claim, and the
  // two are independent: see batteryAge.ts).
  //
  // Optional and nullable: sensor docs predate the field. Absent or null
  // means never recorded, and readers fall back to pairedAt so that every
  // sensor has an age from the day it was paired.
  batteryChangedAt?: Timestamp | null;
  // Set when the stale-battery alert fires, cleared when batteryChangedAt is
  // written. Mirrors deadAlertSentAt: without it the daily check would send
  // the same Telegram every noon until the battery was replaced.
  batteryAlertSentAt?: Timestamp | null;
```

- [ ] **Step 2: Add the threshold to the web `Project` interface**

In the same file, inside `export interface Project`, alongside the other optional fields (near `timezone?` / `notifyEverySensorTrigger?`):

```ts
  // Months after which a sensor battery is considered overdue for
  // replacement. Optional: project docs predate it, and absent means the
  // DEFAULT_BATTERY_ALERT_MONTHS default. Zero or negative disables the
  // stale-battery alert for the whole project.
  batteryAlertMonths?: number;
```

- [ ] **Step 3: Mirror all three fields into `functions/src/types.ts`**

Add the identical two fields to its `Sensor` interface and the identical one field to its `Project` interface, with the same comments. This file imports `Timestamp` from `firebase-admin/firestore` — do not change the import.

- [ ] **Step 4: Verify both sides compile**

Run: `cd web && npm run lint` — Expected: clean, no output past the `> tsc --noEmit` banner.
Run: `cd functions && npx tsc --noEmit` — Expected: clean, no output.

Nothing reads the fields yet, so no test changes and no test run is needed here.

- [ ] **Step 5: Commit**

```bash
git add web/src/types/index.ts functions/src/types.ts
git commit -m "feat(types): battery replacement date and alert threshold fields

Optional and nullable so existing sensor and project docs keep working.
Mirrored by hand into both type files, which have no shared package."
```

---

### Task 2: `batteryAge.ts` — pure date and age logic

The whole feature's correctness lives here. Pure functions, no Firestore, no React — following the `lastSeenFormat.ts` / `sensorRecency.ts` precedent in the same directory.

**The trap this task exists to avoid:** `new Date("2026-09-23")` parses as **UTC midnight**. In Asia/Jerusalem (UTC+2/+3) that is 02:00 or 03:00 local, and `getDate()` on it can return the *previous* day depending on how it is read back. A date picked as the 23rd would display as the 22nd. Both converters must work in local time and never touch `toISOString()`.

**Files:**
- Create: `web/src/features/configure/batteryAge.ts`
- Test: `web/src/features/configure/batteryAge.test.ts`

**Interfaces:**
- Consumes: `Sensor` from Task 1.
- Produces, relied on by Tasks 3 and 4:
  - `DEFAULT_BATTERY_ALERT_MONTHS: number` (= 12)
  - `batteryStartedAt(sensor: Pick<Sensor, "batteryChangedAt" | "pairedAt">): number | null` — epoch ms
  - `batteryAgeMonths(startedAtMs: number, nowMs: number): number`
  - `formatBatteryAge(startedAtMs: number | null, nowMs: number, t: Translate): string | null`
  - `isBatteryStale(startedAtMs: number | null, nowMs: number, thresholdMonths: number): boolean`
  - `toDateInputValue(ms: number): string` — `"yyyy-mm-dd"`
  - `fromDateInputValue(value: string, nowMs: number): number | null` — epoch ms at local midnight, or null if unparseable/future

- [ ] **Step 1: Write the failing test**

Create `web/src/features/configure/batteryAge.test.ts`:

```ts
// Pure battery-age logic. Extracted from SensorsTab so the date handling can
// be pinned without mounting the tab (which needs Firestore and auth context).
//
// The date-conversion tests are the point of this file: an <input type="date">
// speaks "yyyy-mm-dd" with no timezone, and the obvious conversions both go
// wrong by a day in Asia/Jerusalem.
import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  DEFAULT_BATTERY_ALERT_MONTHS,
  batteryStartedAt,
  batteryAgeMonths,
  formatBatteryAge,
  isBatteryStale,
  toDateInputValue,
  fromDateInputValue,
} from "./batteryAge";

const ts = (ms: number) => Timestamp.fromMillis(ms);
const DAY = 24 * 60 * 60 * 1000;

describe("batteryStartedAt", () => {
  it("prefers the recorded replacement date", () => {
    const sensor = { batteryChangedAt: ts(5000), pairedAt: ts(1000) };
    expect(batteryStartedAt(sensor)).toBe(5000);
  });

  it("falls back to pairedAt when no replacement is recorded", () => {
    // The battery was presumably fresh when the sensor was paired, so this is
    // a defensible lower bound on its age. It is what makes every sensor
    // covered with nothing to remember — the sensors nobody got round to
    // recording are exactly the ones likely to hold a dying battery.
    expect(batteryStartedAt({ batteryChangedAt: null, pairedAt: ts(1000) })).toBe(1000);
    expect(batteryStartedAt({ pairedAt: ts(1000) })).toBe(1000);
  });

  it("returns null when even pairedAt is missing", () => {
    // Should not happen (pairedAt is written on create), but treating a
    // missing date as epoch 0 would make the sensor look 56 years old and
    // fire a bogus alert on the next noon run.
    expect(batteryStartedAt({ pairedAt: null as unknown as Timestamp })).toBeNull();
    expect(batteryStartedAt({})).toBeNull();
  });
});

describe("batteryAgeMonths", () => {
  it("is zero for a battery changed today", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(batteryAgeMonths(now, now)).toBe(0);
  });

  it("counts whole months only", () => {
    const start = Date.parse("2026-01-15T00:00:00Z");
    // 30 days later is not yet two months.
    expect(batteryAgeMonths(start, Date.parse("2026-02-14T00:00:00Z"))).toBe(0);
    expect(batteryAgeMonths(start, Date.parse("2026-02-15T00:00:00Z"))).toBe(1);
    expect(batteryAgeMonths(start, Date.parse("2026-03-15T00:00:00Z"))).toBe(2);
  });

  it("counts across a year boundary", () => {
    expect(
      batteryAgeMonths(
        Date.parse("2025-11-15T00:00:00Z"),
        Date.parse("2026-09-15T00:00:00Z")
      )
    ).toBe(10);
  });

  it("never returns a negative age", () => {
    // A future start date is a typo, not a negative-age battery.
    expect(
      batteryAgeMonths(
        Date.parse("2027-01-01T00:00:00Z"),
        Date.parse("2026-09-23T00:00:00Z")
      )
    ).toBe(0);
  });
});

describe("isBatteryStale", () => {
  const start = Date.parse("2025-09-23T00:00:00Z");
  const now = Date.parse("2026-09-23T00:00:00Z"); // exactly 12 months later

  it("is stale at exactly the threshold", () => {
    expect(isBatteryStale(start, now, 12)).toBe(true);
  });

  it("is not stale just under the threshold", () => {
    expect(isBatteryStale(start, now, 13)).toBe(false);
  });

  it("is never stale when the threshold is zero or negative", () => {
    // Zero/negative is the project-wide "off" switch.
    expect(isBatteryStale(start, now, 0)).toBe(false);
    expect(isBatteryStale(start, now, -1)).toBe(false);
  });

  it("is not stale when the start date is unknown", () => {
    expect(isBatteryStale(null, now, 12)).toBe(false);
  });
});

describe("toDateInputValue / fromDateInputValue", () => {
  it("renders a local calendar date, not a UTC one", () => {
    // 2026-09-23 22:00 UTC is already the 24th in Asia/Jerusalem. The input
    // must show the local day, because that is the day the user means.
    // Asserted against the runtime's own local parts so this passes in CI
    // (UTC) as well as on a machine in Jerusalem.
    const d = new Date(2026, 8, 23, 22, 0, 0); // local 2026-09-23 22:00
    expect(toDateInputValue(d.getTime())).toBe("2026-09-23");
  });

  it("zero-pads month and day", () => {
    const d = new Date(2026, 0, 5); // local 2026-01-05
    expect(toDateInputValue(d.getTime())).toBe("2026-01-05");
  });

  it("parses to LOCAL midnight, not UTC midnight", () => {
    // The bug this guards: Date.parse("2026-09-23") is UTC midnight, which is
    // the 22nd at 21:00 in a UTC+3 zone. Round-tripping it would move the day.
    const ms = fromDateInputValue("2026-09-23", Date.parse("2027-01-01T00:00:00Z"));
    expect(ms).not.toBeNull();
    const d = new Date(ms as number);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8); // September
    expect(d.getDate()).toBe(23);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("round-trips any date back to the same string", () => {
    const later = Date.parse("2030-01-01T00:00:00Z");
    for (const s of ["2026-09-23", "2026-01-01", "2025-12-31", "2024-02-29"]) {
      const ms = fromDateInputValue(s, later);
      expect(ms).not.toBeNull();
      expect(toDateInputValue(ms as number)).toBe(s);
    }
  });

  it("rejects a future date", () => {
    // A replacement date in the future is a typo. The input also carries
    // max={today}, but a typed date bypasses that on some browsers.
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(fromDateInputValue("2026-09-24", now)).toBeNull();
  });

  it("accepts today", () => {
    // The Today button's case: same calendar day must not count as future.
    const now = new Date(2026, 8, 23, 15, 30).getTime();
    expect(fromDateInputValue("2026-09-23", now)).not.toBeNull();
  });

  it("rejects an empty or malformed value", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(fromDateInputValue("", now)).toBeNull();
    expect(fromDateInputValue("not-a-date", now)).toBeNull();
    expect(fromDateInputValue("2026-13-45", now)).toBeNull();
  });
});

describe("formatBatteryAge", () => {
  // The real t() is typed against en.ts's key union; this stub returns the key
  // plus its vars so the tests assert on which key was chosen, not on English.
  const t = (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;

  it("says today for a battery changed today", () => {
    const now = new Date(2026, 8, 23, 18, 0).getTime();
    const start = new Date(2026, 8, 23, 9, 0).getTime();
    expect(formatBatteryAge(start, now, t)).toBe("cfg.sensors.batteryToday");
  });

  it("counts days under a month", () => {
    const now = Date.parse("2026-09-23T00:00:00Z");
    expect(formatBatteryAge(now - 3 * DAY, now, t)).toBe(
      'cfg.sensors.batteryDaysAgo:{"count":3}'
    );
  });

  it("counts months at a month and over", () => {
    expect(
      formatBatteryAge(
        Date.parse("2025-10-23T00:00:00Z"),
        Date.parse("2026-09-23T00:00:00Z"),
        t
      )
    ).toBe('cfg.sensors.batteryMonthsAgo:{"count":11}');
  });

  it("returns null when the start date is unknown", () => {
    // The caller renders a muted "not recorded" rather than a fake age.
    expect(formatBatteryAge(null, Date.now(), t)).toBeNull();
  });
});

describe("DEFAULT_BATTERY_ALERT_MONTHS", () => {
  it("is a year", () => {
    expect(DEFAULT_BATTERY_ALERT_MONTHS).toBe(12);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/features/configure/batteryAge.test.ts`
Expected: FAIL — `Failed to resolve import "./batteryAge"`.

- [ ] **Step 3: Write the implementation**

Create `web/src/features/configure/batteryAge.ts`:

```ts
/** Battery replacement dates and ages for the sensor table.
 *
 *  A Kerui sensor's battery dies silently, and the device's own battery_low
 *  report is reactive — by the time it arrives the sensor is nearly useless.
 *  Recording when a battery was last changed makes the question "which of
 *  these is overdue?" answerable BEFORE one fails.
 *
 *  Independent of Sensor.batteryStatus, which is the sensor's own claim.
 *  Both are shown: a "low" on a battery changed last month means a faulty
 *  cell, while a "low" on a two-year-old one is simply due. Recording a
 *  replacement date deliberately does NOT reset batteryStatus — only the
 *  sensor can say it is no longer low.
 *
 *  Pure, like lastSeenFormat.ts and sensorRecency.ts beside it, so the date
 *  handling is testable without mounting SensorsTab. */

import type { Timestamp } from "firebase/firestore";
import type { TranslationKey } from "@/i18n/en";
import type { Sensor } from "@/types";

/** Used when a project has no batteryAlertMonths of its own. */
export const DEFAULT_BATTERY_ALERT_MONTHS = 12;

/** Matches useT()'s t, typed against the real key union so a renamed string
 *  is a compile error here rather than a raw key leaking into the table. */
type Translate = (
  key: TranslationKey,
  vars?: Record<string, string | number>
) => string;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the battery currently in this sensor started its life, in epoch ms.
 *
 * Falls back to pairedAt because a battery was presumably fresh when the
 * sensor was paired. That fallback is what gives EVERY sensor an age from day
 * one: the alternative — only ageing sensors with an explicit record — would
 * silently never alert on the sensors nobody got round to recording, which
 * are exactly the ones most likely to hold a dying battery.
 *
 * Null only when both dates are missing, which should not happen since
 * pairedAt is written on create. Treating that as epoch 0 would make the
 * sensor look decades old and fire a bogus alert, so it is excluded instead.
 */
export function batteryStartedAt(
  sensor: Pick<Sensor, "batteryChangedAt" | "pairedAt"> &
    Partial<Pick<Sensor, "pairedAt">>
): number | null {
  const changed = sensor.batteryChangedAt;
  if (changed) return changed.toMillis();
  const paired = sensor.pairedAt as Timestamp | null | undefined;
  if (paired) return paired.toMillis();
  return null;
}

/** Whole months elapsed, never negative — a future start date is a typo, not
 *  a negative age. Calendar months rather than 30-day blocks, so "changed on
 *  the 15th" stays the 15th regardless of month length. */
export function batteryAgeMonths(startedAtMs: number, nowMs: number): number {
  if (nowMs <= startedAtMs) return 0;
  const start = new Date(startedAtMs);
  const now = new Date(nowMs);
  let months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());
  // Not a full month until the day-of-month is reached.
  if (now.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

/** Whether this battery is at or past the project's threshold. A threshold of
 *  zero or less is the project-wide off switch. */
export function isBatteryStale(
  startedAtMs: number | null,
  nowMs: number,
  thresholdMonths: number
): boolean {
  if (startedAtMs === null) return false;
  if (thresholdMonths <= 0) return false;
  return batteryAgeMonths(startedAtMs, nowMs) >= thresholdMonths;
}

/** "today" / "3 days ago" / "11 months ago". Null when unknown, so the caller
 *  can render "not recorded" rather than inventing an age. */
export function formatBatteryAge(
  startedAtMs: number | null,
  nowMs: number,
  t: Translate
): string | null {
  if (startedAtMs === null) return null;
  const months = batteryAgeMonths(startedAtMs, nowMs);
  if (months >= 1) {
    return t("cfg.sensors.batteryMonthsAgo", { count: months });
  }
  const days = Math.floor(Math.max(0, nowMs - startedAtMs) / DAY_MS);
  if (days < 1) return t("cfg.sensors.batteryToday");
  return t("cfg.sensors.batteryDaysAgo", { count: days });
}

/** Epoch ms -> "yyyy-mm-dd" in LOCAL time, for <input type="date">.
 *
 *  Deliberately not toISOString().slice(0, 10): that is UTC, so an evening in
 *  Asia/Jerusalem renders as tomorrow's date. */
export function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "yyyy-mm-dd" -> epoch ms at LOCAL midnight, or null if unusable.
 *
 *  Built with the Date(y, m, d) constructor rather than parsed: Date.parse of
 *  a bare "2026-09-23" is UTC midnight, which is the PREVIOUS day in any
 *  UTC+ zone and would shift every date the user picked.
 *
 *  Future dates are rejected. The input carries max={today}, but a typed or
 *  pasted value bypasses that in some browsers, and a battery replaced
 *  tomorrow is a typo rather than a fact worth storing. */
export function fromDateInputValue(
  value: string,
  nowMs: number
): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const d = new Date(year, month - 1, day);
  // Rejects real-looking but nonexistent dates: new Date(2026, 1, 30) rolls
  // over to March 2nd, so the parts coming back out prove the date existed.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }

  // Compared by calendar day, not by instant: "today" must be accepted even
  // though local midnight is in the past relative to now.
  const today = new Date(nowMs);
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  if (d.getTime() > todayMidnight) return null;

  return d.getTime();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/features/configure/batteryAge.test.ts`
Expected: PASS, all assertions green.

The i18n keys referenced here (`cfg.sensors.batteryToday`, `batteryDaysAgo`, `batteryMonthsAgo`) do not exist yet, so `npm run lint` WILL fail at this point with a type error on `TranslationKey`. That is expected — Task 3 adds them. Do not add them here and do not loosen the `Translate` type to `string` to silence it.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/configure/batteryAge.ts web/src/features/configure/batteryAge.test.ts
git commit -m "feat(web): pure battery age and date-input logic

Age falls back to pairedAt when no replacement is recorded, so every
sensor has an age from day one rather than silently never ageing.

Both date converters work in local time on purpose: Date.parse of a bare
yyyy-mm-dd is UTC midnight, which is the previous day in Asia/Jerusalem,
and toISOString() has the same bug in the other direction. Pinned by
tests, since the wrong version looks correct in a UTC CI run."
```

---

### Task 3: i18n keys

Added before the UI that uses them so the UI task compiles cleanly, and so this task alone makes Task 2's `npm run lint` pass.

**Files:**
- Modify: `web/src/i18n/en.ts` (the `cfg.sensors.*` block, ~line 129-150; plus a `settings.*` key)
- Modify: `web/src/i18n/he.ts` (the same two places)

**Interfaces:**
- Consumes: nothing.
- Produces these `TranslationKey`s, used by Tasks 4 and 5 — exact strings, no other spelling:
  - `cfg.sensors.batteryToday`
  - `cfg.sensors.batteryDaysAgo`
  - `cfg.sensors.batteryMonthsAgo`
  - `cfg.sensors.batteryNotRecorded`
  - `cfg.sensors.batteryChangedLabel`
  - `cfg.sensors.batteryTodayButton`
  - `cfg.sensors.batteryStale`
  - `settings.batteryAlertMonths`
  - `settings.batteryAlertMonthsHelp`

- [ ] **Step 1: Add the English keys**

In `web/src/i18n/en.ts`, in the `cfg.sensors.*` block (after `"cfg.sensors.batteryLow"`):

```ts
  "cfg.sensors.batteryToday": "changed today",
  "cfg.sensors.batteryDaysAgo": "changed {count}d ago",
  "cfg.sensors.batteryMonthsAgo": "changed {count}mo ago",
  "cfg.sensors.batteryNotRecorded": "change date not recorded",
  "cfg.sensors.batteryChangedLabel": "Battery last changed",
  "cfg.sensors.batteryTodayButton": "Today",
  "cfg.sensors.batteryStale": "battery overdue",
```

And in the `settings.*` block:

```ts
  "settings.batteryAlertMonths": "Battery age alert (months)",
  "settings.batteryAlertMonthsHelp":
    "Telegram once when a sensor battery is older than this. 0 disables it. Sensors with no recorded change date are aged from when they were paired.",
```

Match the surrounding quoting and trailing-comma style exactly.

- [ ] **Step 2: Add the Hebrew keys**

In `web/src/i18n/he.ts`, in the same two places:

```ts
  "cfg.sensors.batteryToday": "הוחלפה היום",
  "cfg.sensors.batteryDaysAgo": "הוחלפה לפני {count} ימים",
  "cfg.sensors.batteryMonthsAgo": "הוחלפה לפני {count} חודשים",
  "cfg.sensors.batteryNotRecorded": "תאריך ההחלפה לא נרשם",
  "cfg.sensors.batteryChangedLabel": "החלפת סוללה אחרונה",
  "cfg.sensors.batteryTodayButton": "היום",
  "cfg.sensors.batteryStale": "הסוללה דורשת החלפה",
```

```ts
  "settings.batteryAlertMonths": "התראת גיל סוללה (חודשים)",
  "settings.batteryAlertMonthsHelp":
    "שליחת התראה בטלגרם פעם אחת כאשר גיל הסוללה של חיישן עולה על הערך הזה. 0 מבטל את ההתראה. חיישנים שלא נרשם להם תאריך החלפה נמדדים מתאריך השיוך.",
```

- [ ] **Step 3: Verify the key sets match and Task 2 now compiles**

Run: `cd web && npm run lint`
Expected: clean. This is the step that clears the expected failure left at the end of Task 2 — `TranslationKey` is derived from `en.ts`, and `he.ts` is checked against it, so a key missing from either side fails here.

Run: `cd web && npx vitest run src/i18n`
Expected: PASS — the existing i18n suite includes a parity check between the two files.

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/en.ts web/src/i18n/he.ts
git commit -m "i18n: battery replacement date strings (en + he)"
```

---

### Task 4: Record and show the date in `SensorsTab`

The date control goes **inside the existing Battery `<td>`**, under the ok/low badge. The table already has five columns and scrolls on a phone; battery status and battery age are the same subject, so they share a cell and the column count does not grow.

**Files:**
- Modify: `web/src/features/configure/SensorsTab.tsx` (the `handleAddSensor` new-sensor literal ~line 170-179; a new handler beside `handleDeadAlertDaysChange` ~line 256-262; the Battery `<td>` ~line 404-415)

**Interfaces:**
- Consumes: Task 1's fields, Task 2's `batteryStartedAt` / `formatBatteryAge` / `isBatteryStale` / `toDateInputValue` / `fromDateInputValue` / `DEFAULT_BATTERY_ALERT_MONTHS`, Task 3's keys.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Import the new helpers**

Add to the imports in `SensorsTab.tsx`:

```ts
import {
  batteryStartedAt,
  formatBatteryAge,
  isBatteryStale,
  toDateInputValue,
  fromDateInputValue,
  DEFAULT_BATTERY_ALERT_MONTHS,
} from "./batteryAge";
```

- [ ] **Step 2: Initialise both fields on a newly paired sensor**

In `handleAddSensor`, in the object literal that already sets `batteryStatus: "ok"` and `deadAlertSentAt: null`, add:

```ts
      // Explicitly null rather than "today": pairing a sensor is not evidence
      // about its battery, and batteryStartedAt() already falls back to
      // pairedAt, which is the same instant and needs no maintenance.
      batteryChangedAt: null,
      batteryAlertSentAt: null,
```

- [ ] **Step 3: Add the write handler**

Immediately after `handleDeadAlertDaysChange`, matching its shape (update, then optimistic local state):

```ts
  // Recording a replacement ALSO clears batteryAlertSentAt. That pairing is
  // what re-arms the alert for the next cycle — without it each sensor would
  // Telegram once, ever, and go quiet for every battery after the first.
  const handleBatteryChangedAt = async (sensor: Sensor, ms: number) => {
    if (!projectId) return;
    const changed = Timestamp.fromMillis(ms);
    await updateDoc(sensorDoc(projectId, sensor.id), {
      batteryChangedAt: changed,
      batteryAlertSentAt: null,
    });
    setSensors((prev) =>
      prev.map((s) =>
        s.id === sensor.id
          ? { ...s, batteryChangedAt: changed, batteryAlertSentAt: null }
          : s
      )
    );
  };
```

`Timestamp` is already imported in this file (it is used by `handleAddSensor`); confirm rather than adding a duplicate import.

- [ ] **Step 4: Render the control in the Battery cell**

Replace the existing Battery `<td>` (the one containing the `batteryStatus === "low"` ternary) with:

```tsx
                      <td>
                        {s.batteryStatus === "low" ? (
                          <span className="badge badge--danger">
                            {t("cfg.sensors.batteryLow")}
                          </span>
                        ) : (
                          <span className="badge">
                            {t("cfg.sensors.batteryOk")}
                          </span>
                        )}
                        {/* Age sits under the sensor's own ok/low claim
                            because they are the same subject seen two ways:
                            what the sensor reports, and what we recorded.
                            Sharing the cell also keeps the table at five
                            columns, which is as wide as it fits on a phone. */}
                        <div className="battery-age">
                          {(() => {
                            const startedAt = batteryStartedAt(s);
                            const age = formatBatteryAge(startedAt, now, t);
                            const stale = isBatteryStale(
                              startedAt,
                              now,
                              project?.batteryAlertMonths ??
                                DEFAULT_BATTERY_ALERT_MONTHS
                            );
                            if (age === null) {
                              return (
                                <span className="muted">
                                  {t("cfg.sensors.batteryNotRecorded")}
                                </span>
                              );
                            }
                            return (
                              <span className={stale ? "is-stale" : "muted"}>
                                {age}
                                {stale ? ` — ${t("cfg.sensors.batteryStale")}` : ""}
                              </span>
                            );
                          })()}
                          <div className="battery-age__controls">
                            <input
                              type="date"
                              className="input input--narrow"
                              max={toDateInputValue(now)}
                              value={
                                s.batteryChangedAt
                                  ? toDateInputValue(s.batteryChangedAt.toMillis())
                                  : ""
                              }
                              onChange={(e) => {
                                // A null return means empty, malformed or
                                // future: leave the stored value untouched
                                // rather than writing nonsense, the same way
                                // the alert-days input ignores NaN.
                                const ms = fromDateInputValue(e.target.value, now);
                                if (ms !== null) void handleBatteryChangedAt(s, ms);
                              }}
                              aria-label={t("cfg.sensors.batteryChangedLabel")}
                            />
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => void handleBatteryChangedAt(s, Date.now())}
                            >
                              {t("cfg.sensors.batteryTodayButton")}
                            </button>
                          </div>
                        </div>
                      </td>
```

Both variables this markup needs are **already in scope** — verified, do not re-declare either:
1. `now` — `SensorsTab.tsx:57`, `useState(() => Date.now())`, re-ticked every 10s by the interval at line 88. Reuse it; a second `Date.now()` in render would make the age jitter against the last-seen column.
2. `project` — `SensorsTab.tsx:49`, `const { project } = useProject();`. Read `project?.batteryAlertMonths` from it.

Note the staleness highlight here is cosmetic; the authoritative check is server-side in Task 7. If they ever disagree, the server wins.

- [ ] **Step 5: Add the two style hooks**

Append to `web/src/styles/components.css`:

```css
/* ---------- Battery age (sensor table) ---------- */

/* Stacked under the ok/low badge in the same cell, so the table stays five
   columns wide — it already scrolls on a phone. */
.battery-age {
  margin-block-start: var(--sp-2);
  font-size: var(--fs-sm);
}

.battery-age__controls {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-block-start: var(--sp-1);
  flex-wrap: wrap;
}

/* An overdue battery is a maintenance item, not an incident: warn, not
   danger, so it cannot be mistaken for a live alarm state. */
.battery-age .is-stale {
  color: var(--warn);
  font-weight: 600;
}
```

Verify `--sp-1`, `--sp-2`, `--fs-sm` and `--warn` exist before using them:

Run: `cd web && grep -rn -- "--sp-1:\|--warn:" src/styles/`
Expected: both found. If `--sp-1` is absent, use `var(--sp-2)`.

- [ ] **Step 6: Verify**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: lint clean, all tests pass, build succeeds.

There is no test for `SensorsTab` itself — the directory has no component tests and mounting it needs Firestore, RTDB and auth context, which is why Task 2 extracted every decision this markup makes. Do not add a component-test harness here; that is a separate piece of work.

- [ ] **Step 7: Commit**

```bash
git add web/src/features/configure/SensorsTab.tsx web/src/styles/components.css
git commit -m "feat(web): record and show each sensor's battery change date

Inside the existing Battery cell rather than a sixth column: status and
age are the same subject, and the table already scrolls on a phone.

The write clears batteryAlertSentAt alongside the new date, which is what
re-arms the stale-battery alert for the next battery."
```

---

### Task 5: The project-wide threshold in Settings

**Files:**
- Modify: `web/src/features/setup/settingsForm.ts` (`SettingsForm` ~line 8-17, `SettingsSource` ~line 20-28, `formFromProject` ~line 30, `isDirty` ~line 63)
- Modify: `web/src/features/setup/SettingsPage.tsx` (the save payload ~line 105, a new input near the `sirenDurationSec` one ~line 235)
- Test: `web/src/features/setup/settingsForm.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `Project.batteryAlertMonths`, Task 2's `DEFAULT_BATTERY_ALERT_MONTHS`, Task 3's two `settings.*` keys.
- Produces: `SettingsForm.batteryAlertMonths: number` and `SettingsSource.batteryAlertMonths?: number`.

The real exports in this file are `SettingsForm`, `SettingsSource`, `formFromProject(project: SettingsSource): SettingsForm` and `isDirty(saved, current)`. The test fixture is `const base: SettingsForm`. Note `formFromProject` takes a `SettingsSource`, **not** a `SettingsForm` — the two tests below use different fixtures for that reason.

- [ ] **Step 1: Write the failing test**

In `web/src/features/setup/settingsForm.test.ts`, add `DEFAULT_BATTERY_ALERT_MONTHS` to the imports:

```ts
import { DEFAULT_BATTERY_ALERT_MONTHS } from "@/features/configure/batteryAge";
```

Add `batteryAlertMonths: DEFAULT_BATTERY_ALERT_MONTHS,` to the existing `base` fixture object, then append:

```ts
describe("batteryAlertMonths", () => {
  // formFromProject takes a SettingsSource (the Project subset), not a
  // SettingsForm, so this fixture is separate from `base` above.
  const source = {
    name: "Home",
    telegramBotToken: "tok",
    telegramChatId: "-100",
    sirenDurationSec: 120,
    timezone: "Asia/Jerusalem",
    serverActions: { sendTelegram: true, triggerSiren: false },
  };

  it("defaults to a year when the project has no value", () => {
    // Project docs predate the field, so absent must mean the default rather
    // than 0 — 0 is the explicit "never alert" switch, a different intent.
    expect(formFromProject(source).batteryAlertMonths).toBe(
      DEFAULT_BATTERY_ALERT_MONTHS
    );
  });

  it("keeps an explicit zero, which disables the alert", () => {
    // Must not be swallowed by a `||` fallback — that is the bug this pins.
    expect(
      formFromProject({ ...source, batteryAlertMonths: 0 }).batteryAlertMonths
    ).toBe(0);
  });

  it("keeps an explicit value", () => {
    expect(
      formFromProject({ ...source, batteryAlertMonths: 6 }).batteryAlertMonths
    ).toBe(6);
  });

  it("is dirty when changed", () => {
    expect(isDirty(base, { ...base, batteryAlertMonths: 6 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/features/setup/settingsForm.test.ts`
Expected: FAIL — `batteryAlertMonths` is not on the form type.

- [ ] **Step 3: Thread the field through `settingsForm.ts`**

Import the default at the top of the file:

```ts
import { DEFAULT_BATTERY_ALERT_MONTHS } from "@/features/configure/batteryAge";
```

Add to `SettingsForm` (required — the form always holds a number):

```ts
  batteryAlertMonths: number;
```

Add to `SettingsSource` (optional — project docs predate it):

```ts
  batteryAlertMonths?: number;
```

In `formFromProject`, beside the `sirenDurationSec` line:

```ts
    // `??` and NOT `||`: an explicit 0 is the project-wide "never alert"
    // switch, and `||` would silently replace it with the 12-month default.
    batteryAlertMonths:
      project.batteryAlertMonths ?? DEFAULT_BATTERY_ALERT_MONTHS,
```

And one clause in `isDirty`, beside the `sirenDurationSec` one:

```ts
    saved.batteryAlertMonths !== current.batteryAlertMonths ||
```

- [ ] **Step 4: Add the input and save it**

In `SettingsPage.tsx`, add `batteryAlertMonths: form.batteryAlertMonths,` to the save payload beside `sirenDurationSec`. Then, next to the `sirenDurationSec` input, copy its surrounding label/help markup exactly and add:

```tsx
            <input
              type="number"
              min={0}
              className="input input--narrow"
              value={form.batteryAlertMonths}
              onChange={(e) =>
                setField("batteryAlertMonths", Number(e.target.value))
              }
              aria-label={t("settings.batteryAlertMonths")}
            />
```

with `t("settings.batteryAlertMonths")` as its label and `t("settings.batteryAlertMonthsHelp")` as the help text, in whatever wrapper the neighbouring field uses.

- [ ] **Step 5: Verify**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/setup/settingsForm.ts web/src/features/setup/settingsForm.test.ts web/src/features/setup/SettingsPage.tsx
git commit -m "feat(web): project-wide battery age alert threshold

One project setting rather than one per sensor: every sensor here is
Kerui with the same battery life. Absent means 12 months; 0 disables."
```

---

### Task 6: `batteryAgeCheck.ts` — the server-side decision

Pure, no Firestore, testable without the emulator — the split `deviceOnline.ts` / `deviceLiveness.ts` already uses.

**Files:**
- Create: `functions/src/batteryAgeCheck.ts`
- Test: `functions/src/batteryAgeCheck.test.ts`

**Interfaces:**
- Consumes: Task 1's `Sensor` / `Project` fields.
- Produces, used by Task 7:
  - `DEFAULT_BATTERY_ALERT_MONTHS: number` (= 12)
  - `batteryStartedAtMs(sensor: Pick<Sensor, "batteryChangedAt" | "pairedAt">): number | null`
  - `shouldAlertStaleBattery(args: { startedAtMs: number | null; alertSentAt: Timestamp | null | undefined; thresholdMonths: number; nowMs: number }): boolean`
  - `batteryAgeMonths(startedAtMs: number, nowMs: number): number`

This duplicates Task 2's month arithmetic rather than importing it: `web/` and `functions/` are separate packages with separate `tsconfig`s and no shared module, exactly as `types.ts` is duplicated. Do not try to cross-import.

- [ ] **Step 1: Write the failing test**

Create `functions/src/batteryAgeCheck.test.ts`:

```ts
// Whether a sensor's battery is overdue, and whether to say so again.
//
// Pure so it needs no emulator, matching deviceOnline.ts beside it. The
// Firestore and Telegram plumbing lives in deadSensorCheck.ts.
import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  DEFAULT_BATTERY_ALERT_MONTHS,
  batteryStartedAtMs,
  batteryAgeMonths,
  shouldAlertStaleBattery,
} from "./batteryAgeCheck";

const ts = (ms: number) => Timestamp.fromMillis(ms);
const NOW = Date.parse("2026-09-23T12:00:00Z");
const monthsAgo = (n: number) => {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - n);
  return d.getTime();
};

describe("batteryStartedAtMs", () => {
  it("prefers the recorded replacement date", () => {
    expect(batteryStartedAtMs({ batteryChangedAt: ts(5000), pairedAt: ts(1000) })).toBe(5000);
  });

  it("falls back to pairedAt", () => {
    // Means a long-paired sensor is already overdue on the first run after
    // deploy, which is correct: that battery really is old.
    expect(batteryStartedAtMs({ batteryChangedAt: null, pairedAt: ts(1000) })).toBe(1000);
    expect(batteryStartedAtMs({ pairedAt: ts(1000) })).toBe(1000);
  });

  it("returns null when both are missing", () => {
    // Never treated as epoch 0, which would fire a bogus alert immediately.
    expect(batteryStartedAtMs({})).toBeNull();
  });
});

describe("batteryAgeMonths", () => {
  it("counts whole calendar months", () => {
    expect(batteryAgeMonths(monthsAgo(13), NOW)).toBe(13);
    expect(batteryAgeMonths(NOW, NOW)).toBe(0);
  });

  it("never returns a negative age", () => {
    expect(batteryAgeMonths(monthsAgo(-5), NOW)).toBe(0);
  });
});

describe("shouldAlertStaleBattery", () => {
  const base = {
    startedAtMs: monthsAgo(13),
    alertSentAt: null,
    thresholdMonths: 12,
    nowMs: NOW,
  };

  it("fires when the battery is past the threshold and nothing was sent", () => {
    expect(shouldAlertStaleBattery(base)).toBe(true);
  });

  it("fires at exactly the threshold", () => {
    expect(
      shouldAlertStaleBattery({ ...base, startedAtMs: monthsAgo(12) })
    ).toBe(true);
  });

  it("stays silent just under the threshold", () => {
    expect(
      shouldAlertStaleBattery({ ...base, startedAtMs: monthsAgo(11) })
    ).toBe(false);
  });

  it("stays silent once an alert has been sent", () => {
    // The once-per-battery property. Recording a new change date clears this
    // marker in the web UI, which is what lets the NEXT battery alert.
    expect(
      shouldAlertStaleBattery({ ...base, alertSentAt: ts(NOW - 1000) })
    ).toBe(false);
  });

  it("stays silent when the threshold disables the alert", () => {
    expect(shouldAlertStaleBattery({ ...base, thresholdMonths: 0 })).toBe(false);
    expect(shouldAlertStaleBattery({ ...base, thresholdMonths: -1 })).toBe(false);
  });

  it("stays silent when the start date is unknown", () => {
    expect(shouldAlertStaleBattery({ ...base, startedAtMs: null })).toBe(false);
  });

  it("treats an undefined marker as not-yet-sent", () => {
    // Sensor docs predate the field, so undefined must mean "never alerted"
    // rather than being read as truthy and suppressing the alert forever.
    expect(shouldAlertStaleBattery({ ...base, alertSentAt: undefined })).toBe(true);
  });
});

describe("DEFAULT_BATTERY_ALERT_MONTHS", () => {
  it("matches the web default", () => {
    expect(DEFAULT_BATTERY_ALERT_MONTHS).toBe(12);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd functions && npx vitest run src/batteryAgeCheck.test.ts`
Expected: FAIL — cannot resolve `./batteryAgeCheck`.

- [ ] **Step 3: Write the implementation**

Create `functions/src/batteryAgeCheck.ts`:

```ts
// Whether a sensor's battery is overdue for replacement.
//
// Preventive, and deliberately separate from the sensor's own battery_low
// report: that one is reactive and already alerts elsewhere. A "low" on a
// battery changed last month means a faulty cell; a "low" on a two-year-old
// one is simply due. Neither derives from the other.
//
// Pure, like deviceOnline.ts — the Firestore walk and the Telegram send live
// in deadSensorCheck.ts, which already iterates every project's sensors.
//
// The month arithmetic is duplicated from web/src/features/configure/
// batteryAge.ts on purpose: web/ and functions/ are separate packages with no
// shared module, the same reason types.ts exists twice.

import { Timestamp } from "firebase-admin/firestore";
import { Sensor } from "./types";

/** Used when a project has no batteryAlertMonths of its own. Must match the
 *  web default in batteryAge.ts, or the UI would highlight a different set of
 *  sensors than the alert fires for. */
export const DEFAULT_BATTERY_ALERT_MONTHS = 12;

/**
 * When the battery currently in this sensor started its life, in epoch ms.
 *
 * Falls back to pairedAt, which is what gives every sensor an age even
 * before anyone records a replacement. One consequence worth knowing: on the
 * first run after this ships, every sensor paired longer ago than the
 * threshold is immediately overdue and will alert once. That is correct —
 * those batteries really are that old.
 *
 * Null when both dates are missing. pairedAt is written on create so this
 * should not happen, but treating it as epoch 0 would make the sensor look
 * decades old and fire a bogus alert on the next noon run.
 */
export function batteryStartedAtMs(
  sensor: Partial<Pick<Sensor, "batteryChangedAt" | "pairedAt">>
): number | null {
  if (sensor.batteryChangedAt) return sensor.batteryChangedAt.toMillis();
  if (sensor.pairedAt) return sensor.pairedAt.toMillis();
  return null;
}

/** Whole calendar months elapsed, never negative. */
export function batteryAgeMonths(startedAtMs: number, nowMs: number): number {
  if (nowMs <= startedAtMs) return 0;
  const start = new Date(startedAtMs);
  const now = new Date(nowMs);
  let months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Whether to send a stale-battery alert for this sensor right now.
 *
 * False once alertSentAt is set: the battery stays old until someone replaces
 * it, so without that marker this would Telegram the same sensor every noon.
 * The web UI clears the marker when a new change date is recorded, which is
 * what allows the next battery to alert in its turn.
 */
export function shouldAlertStaleBattery({
  startedAtMs,
  alertSentAt,
  thresholdMonths,
  nowMs,
}: {
  startedAtMs: number | null;
  alertSentAt: Timestamp | null | undefined;
  thresholdMonths: number;
  nowMs: number;
}): boolean {
  if (startedAtMs === null) return false;
  if (thresholdMonths <= 0) return false; // Project-wide off switch
  if (alertSentAt) return false; // Already alerted for this battery
  return batteryAgeMonths(startedAtMs, nowMs) >= thresholdMonths;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx vitest run src/batteryAgeCheck.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/batteryAgeCheck.ts functions/src/batteryAgeCheck.test.ts
git commit -m "feat(functions): stale-battery decision logic

Pure and unit-tested, like deviceOnline.ts; the Firestore walk comes next.

Fires once per battery via a batteryAlertSentAt marker, since the battery
stays old until replaced and a naive check would alert every noon."
```

---

### Task 7: The Telegram message and wiring it into the daily check

Last task, because it is the one that makes the feature send real messages.

**Files:**
- Modify: `functions/src/telegram.ts` (add a formatter near `formatDeadSensor`, ~line 114)
- Modify: `functions/src/telegram.test.ts` (extend the formatter suite)
- Modify: `functions/src/deadSensorCheck.ts` (inside the existing sensor loop, ~line 56-74)
- Modify: `functions/src/doSchedule.ts` (reword one `desc` string, ~line 52)

**Interfaces:**
- Consumes: Task 6's `shouldAlertStaleBattery` / `batteryStartedAtMs` / `batteryAgeMonths` / `DEFAULT_BATTERY_ALERT_MONTHS`, Task 1's fields.
- Produces: `formatStaleBattery(sensorName: string, months: number): string`.

- [ ] **Step 1: Write the failing formatter test**

In `functions/src/telegram.test.ts`, add `formatStaleBattery` to the existing import list from `./telegram`, then add inside the `describe("telegram formatters")` block:

```ts
  describe("formatStaleBattery", () => {
    it("names the sensor and the age", () => {
      expect(formatStaleBattery("Front door", 14)).toBe(
        "🔋 Front door battery is 14 months old — consider replacing"
      );
    });

    it("reads as advice, not as an incident", () => {
      // Distinct from formatDeadSensor's 💤 and from the alarm messages: this
      // is a maintenance reminder, and dressing it as an emergency would
      // train the reader to ignore the channel.
      const msg = formatStaleBattery("Kitchen", 12);
      expect(msg).toContain("🔋");
      expect(msg).not.toContain("🚨");
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd functions && npx vitest run src/telegram.test.ts`
Expected: FAIL — `formatStaleBattery` is not exported.

- [ ] **Step 3: Add the formatter**

In `functions/src/telegram.ts`, after `formatDeadSensor`:

```ts
// A battery approaching end of life, not a sensor that has already gone
// quiet — named separately from formatDeadSensor for the same reason
// formatDeviceOffline is: the consequence differs in kind. This one is
// advisory maintenance, so it reads as a suggestion rather than an incident.
export function formatStaleBattery(
  sensorName: string,
  months: number
): string {
  return `🔋 ${sensorName} battery is ${months} months old — consider replacing`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx vitest run src/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the check into the existing sensor loop**

In `functions/src/deadSensorCheck.ts`, extend the imports:

```ts
import { sendTelegram, formatDeadSensor, formatStaleBattery } from "./telegram";
import {
  shouldAlertStaleBattery,
  batteryStartedAtMs,
  batteryAgeMonths,
  DEFAULT_BATTERY_ALERT_MONTHS,
} from "./batteryAgeCheck";
```

The existing dead-sensor block ends each iteration with `continue` statements, so the battery check must go **before** them or it would be skipped. Restructure the loop body so the battery check runs first and independently:

```ts
      for (const sensorDoc of sensorsSnap.docs) {
        const sensor = { id: sensorDoc.id, ...sensorDoc.data() } as Sensor;

        // Battery age FIRST, and in its own block: the dead-sensor checks
        // below `continue` on several conditions (never seen, alerts
        // disabled, not silent long enough), and a stale battery is worth
        // reporting in every one of those cases. A sensor can be both dead
        // and battery-stale and gets one message for each, because they mean
        // different things: one stopped reporting, the other will soon.
        const startedAtMs = batteryStartedAtMs(sensor);
        if (
          shouldAlertStaleBattery({
            startedAtMs,
            alertSentAt: sensor.batteryAlertSentAt,
            thresholdMonths:
              project.batteryAlertMonths ?? DEFAULT_BATTERY_ALERT_MONTHS,
            nowMs: now,
          })
        ) {
          const months = batteryAgeMonths(startedAtMs as number, now);
          await sendTelegram(
            project.telegramBotToken,
            project.telegramChatId,
            formatStaleBattery(sensor.name, months)
          );
          // Written only after a successful send, so a Telegram failure
          // retries at the next noon instead of silently losing the alert.
          await sensorDoc.ref.update({
            batteryAlertSentAt: FieldValue.serverTimestamp(),
          });
        }

        // --- dead-sensor alerting (unchanged below this line) ---
        if (sensor.lastSeen === null) continue; // Never seen — skip (newly paired)
```

Leave the rest of the dead-sensor block exactly as it is.

- [ ] **Step 6: Reword the schedule table entry**

In `functions/src/doSchedule.ts`, the daily-noon row's `desc` currently reads `"Dead sensor alerts + RTDB event retention"`. Change it to:

```ts
    desc: "Dead sensor + stale battery alerts, RTDB event retention",
```

Change **only** the `desc` string. Do not add a row and do not add an `onSchedule()` — the callback it already points at is the one now doing the extra work.

- [ ] **Step 7: Verify**

Run: `cd functions && npx tsc --noEmit && npx vitest run && npm run build`
Expected: typecheck clean, all tests pass, build succeeds.

Run: `cd web && npm run lint && npm test && npm run build`
Expected: still green — nothing in this task touches `web/`, and this confirms it.

- [ ] **Step 8: Commit**

```bash
git add functions/src/telegram.ts functions/src/telegram.test.ts functions/src/batteryAgeCheck.ts functions/src/deadSensorCheck.ts functions/src/doSchedule.ts
git commit -m "feat(functions): Telegram once when a sensor battery is overdue

Joins the sensor loop already inside deadSensorCheck rather than adding a
pass or a scheduled job: doSchedule's table is unchanged and the
3-free-jobs-per-billing-account limit is untouched. Only that row's desc
changed, since the callback now does three things.

The battery check runs BEFORE the dead-sensor block, which continues on
several conditions a stale battery should still be reported under. A
sensor can be both dead and battery-stale and gets one message for each.

Expect a burst on the first noon after deploy: sensors paired longer ago
than the threshold with no recorded change date are aged from pairedAt
and are immediately overdue. That is correct, and each alerts only once."
```

---

## Post-Implementation Notes

**Not deployed.** Deploying this touches Firestore-backed behaviour and a scheduled function. Deployment is the user's explicit call. When it happens it needs `firebase deploy --only functions,hosting` — the web app and the functions ship together, since the UI writes fields the function reads.

**Expected first-run behaviour**, worth warning the user about before deploy: every sensor paired more than `batteryAlertMonths` ago with no recorded change date is immediately overdue, so the first noon run sends one Telegram per such sensor, then goes quiet. Setting `batteryAlertMonths` to 0 before deploying suppresses that entirely; recording real dates first avoids it per-sensor.

**`todo.txt`** carries two lines this feature addresses — `- battery last change` and part of `- battery/tamper handling`. Remove the first and leave tamper alone; that is a separate piece of work.

**Not done, deliberately:** per-sensor thresholds, replacement history, resetting `batteryStatus` when a date is recorded (only the sensor can say it is no longer low), and any firmware change (the device neither knows nor needs a replacement date).
