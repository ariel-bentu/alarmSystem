# Scheduled Arming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arm and disarm the system automatically on recurring or one-time schedules, managed from the Operations page.

**Architecture:** A schedule is a *window* — an optional arm time plus a required disarm time, bound to one profile and one side (device or server). A pure `nextOccurrence` module converts wall-clock times into instants in the project's IANA timezone; a Firestore trigger keeps precomputed `nextArmAt`/`nextDisarmAt` fields fresh; one new every-minute Cloud Function queries those fields and fires due edges by writing exactly the fields a human would write, so every existing downstream path is reused.

**Tech Stack:** TypeScript, Firebase Cloud Functions gen-2 (`europe-west1`), Firestore, Realtime Database, React 18 + Vite, vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-scheduled-arming-design.md`

## Global Constraints

- **No new runtime dependencies.** `functions/` has exactly two (`firebase-admin`, `firebase-functions`); `web/` has four. Timezone arithmetic uses Node 20's built-in `Intl` — do not add `luxon` or `date-fns-tz`.
- **Region is `europe-west1`** for every Cloud Function.
- **Types are mirrored by hand** between `functions/src/types.ts` and `web/src/types/index.ts`. Both must be updated; the web copy imports `Timestamp` from `firebase/firestore`, functions from `firebase-admin/firestore`.
- **Every user-facing string goes through i18n.** Add to both `web/src/i18n/en.ts` and `web/src/i18n/he.ts`. `he.ts` is typed `Record<TranslationKey, string>`, so a missing key is a typecheck failure.
- **Staleness cutoff is 15 minutes.** An edge later than this is skipped, not fired.
- **Tick cadence is every minute.** This makes 2 of Cloud Scheduler's 3 free jobs per billing account (`deadSensorCheck` is the other).
- **`functions/tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`.** Unused imports fail the build.
- Test commands: `cd functions && npm test` and `cd web && npm test`. Typecheck: `npm run lint` in either.

## File Structure

**Create:**
- `functions/src/nextOccurrence.ts` — pure wall-clock → instant conversion, DST rules
- `functions/src/nextOccurrence.test.ts`
- `functions/src/scheduleTick.ts` — the every-minute function; thin Firestore I/O
- `functions/src/scheduleDecision.ts` — pure fire/skip decision
- `functions/src/scheduleDecision.test.ts`
- `functions/src/onScheduleChange.ts` — Firestore trigger recomputing derived fields
- `firestore.indexes.json` — does not exist yet
- `web/src/features/operations/SchedulesPanel.tsx` — list + rows + `+` button
- `web/src/features/operations/ScheduleEditor.tsx` — the modal editor
- `web/src/features/operations/scheduleFormat.ts` — pure row labels, next-edge sentence
- `web/src/features/operations/scheduleFormat.test.ts`
- `web/src/features/operations/scheduleOverlap.ts` — pure overlap detection
- `web/src/features/operations/scheduleOverlap.test.ts`

**Modify:**
- `functions/src/types.ts` — add `Schedule`, add `timezone` to `Project`
- `functions/src/telegram.ts:9-25` — add `silent` param to `sendTelegram`
- `functions/src/onArmStateChange.ts:61` — pass `silent: true`
- `functions/src/onServerArmChange.ts:55` — pass `silent: true`
- `functions/src/telegramWebhook.ts:54,60,66,71,75` — pass `silent: true`
- `functions/src/index.ts` — export the two new functions
- `web/src/types/index.ts` — mirror `Schedule` and `timezone`
- `web/src/lib/firestore.ts` — add `schedulesCol`, `scheduleDoc`
- `web/src/features/operations/OperationsPage.tsx` — mount `SchedulesPanel`
- `web/src/i18n/en.ts`, `web/src/i18n/he.ts` — new strings
- `firestore.rules` — `schedules` block
- `firebase.json` — reference `firestore.indexes.json`
- `web/src/styles/components.css` — schedule row styles

**Task order rationale:** types → pure modules → backend wiring → rules/indexes → UI. Tasks 1–7 are backend and independently verifiable; 8–11 are UI. The Telegram silent change (Task 2) is independent of everything else and can land first.

---

### Task 1: Schedule types and project timezone

**Files:**
- Modify: `functions/src/types.ts`
- Modify: `web/src/types/index.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Schedule` interface and `Project.timezone`, used by every later task.

- [ ] **Step 1: Add the Schedule interface to functions types**

In `functions/src/types.ts`, after the `Profile` interface, add:

```ts
// A scheduled arming window. armTime is optional (a manual-arm/auto-disarm
// window); disarmTime is required, so every window closes.
// Exactly one of `days` (non-empty) or `date` (non-null) is populated:
// non-empty days = recurring, a set date = one-time.
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  side: "device" | "server";
  profileId: string;
  armTime: string | null; // "HH:MM" local, or null
  disarmTime: string; // "HH:MM" local, required
  days: number[]; // 0-6, Sun-Sat. Empty = one-time
  date: string | null; // "YYYY-MM-DD" for one-time, else null
  // Derived — written only by onScheduleChange/scheduleTick (admin SDK).
  nextArmAt: Timestamp | null;
  nextDisarmAt: Timestamp | null;
  lastFiredAt: Timestamp | null;
  createdAt: Timestamp;
}
```

- [ ] **Step 2: Add timezone to the functions Project interface**

In `functions/src/types.ts`, inside `interface Project`, after `sirenDurationSec: number;` add:

```ts
  // IANA zone, e.g. "Asia/Jerusalem". Schedules resolve wall-clock times in it.
  timezone?: string;
```

Optional because existing project docs predate the field; readers fall back to `"UTC"`.

- [ ] **Step 3: Mirror both into the web types**

In `web/src/types/index.ts`, add the identical `Schedule` interface after `Profile` and the same `timezone?: string;` to `Project`. The file already imports `Timestamp` from `firebase/firestore` — do not add an import.

- [ ] **Step 4: Typecheck both packages**

Run: `cd functions && npm run lint && cd ../web && npm run lint`
Expected: both pass with no output.

- [ ] **Step 5: Commit**

```bash
git add functions/src/types.ts web/src/types/index.ts
git commit -m "Schedule type and project timezone"
```

---

### Task 2: Silent Telegram notifications

**Files:**
- Modify: `functions/src/telegram.ts`
- Modify: `functions/src/onArmStateChange.ts`
- Modify: `functions/src/onServerArmChange.ts`
- Modify: `functions/src/telegramWebhook.ts`
- Test: `functions/src/telegram.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `sendTelegram(botToken, chatId, text, silent?: boolean)` — Task 6 relies on the default staying `false`.

This task is independent of the rest of the plan.

- [ ] **Step 1: Write the failing test**

Append to `functions/src/telegram.test.ts`:

```ts
describe("sendTelegram silent flag", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits disable_notification by default", async () => {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return { ok: true } as Response;
    }) as typeof fetch;

    await sendTelegram("tok", "chat", "hello");
    expect(captured.disable_notification).toBeUndefined();
  });

  it("sets disable_notification when silent", async () => {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return { ok: true } as Response;
    }) as typeof fetch;

    await sendTelegram("tok", "chat", "hello", true);
    expect(captured.disable_notification).toBe(true);
  });
});
```

Ensure the file's imports include `sendTelegram` and that `afterEach` is imported from vitest.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd functions && npx vitest run src/telegram.test.ts`
Expected: FAIL — the second test gets `undefined` because the parameter does not exist.

- [ ] **Step 3: Add the parameter**

In `functions/src/telegram.ts`, replace the `sendTelegram` signature and body:

```ts
/**
 * Send a message via Telegram Bot API using global fetch (Node 20).
 * `silent` sets disable_notification: the message lands in the chat with no
 * sound or vibration. Used for notices (arm/disarm, command replies); alarms
 * and dead-sensor alerts stay loud so the loud channel keeps its meaning.
 */
export async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  silent = false
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (silent) body.disable_notification = true;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error(`Telegram API error: ${res.status} ${bodyText}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx vitest run src/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Pass silent:true at the arm/disarm and webhook call sites**

In `functions/src/onArmStateChange.ts`, the `sendTelegram` call near line 61 becomes:

```ts
    await sendTelegram(
      project.telegramBotToken,
      project.telegramChatId,
      formatArmState(armed, "Device", profileName),
      true // arm/disarm is a notice, not a demand for attention
    );
```

In `functions/src/onServerArmChange.ts`, near line 55:

```ts
    await sendTelegram(
      after.telegramBotToken,
      after.telegramChatId,
      formatArmState(armed, "Server", profileName),
      true // see onArmStateChange
    );
```

In `functions/src/telegramWebhook.ts`, add `true` as the fourth argument to all five `sendTelegram` calls (lines ~54, 60, 66, 71, 75) — the user just typed the command, so the reply need not buzz.

Do **not** touch the calls in `onAlarm.ts`, `deadSensorCheck.ts`, or `onSensorEvent.ts`. Those stay loud.

- [ ] **Step 6: Run the full functions suite and typecheck**

Run: `cd functions && npm test && npm run lint`
Expected: all tests pass, no typecheck output.

- [ ] **Step 7: Commit**

```bash
git add functions/src/telegram.ts functions/src/telegram.test.ts \
  functions/src/onArmStateChange.ts functions/src/onServerArmChange.ts \
  functions/src/telegramWebhook.ts
git commit -m "Telegram: arm/disarm and command replies are silent notices"
```

---

### Task 3: nextOccurrence — pure timezone arithmetic

**Files:**
- Create: `functions/src/nextOccurrence.ts`
- Test: `functions/src/nextOccurrence.test.ts`

**Interfaces:**
- Consumes: `Schedule` from Task 1.
- Produces:
  - `zonedTimeToUtc(dateStr: string, timeStr: string, tz: string): Date`
  - `nextArmInstant(schedule: Schedule, tz: string, after: Date): Date | null`
  - `nextDisarmInstant(schedule: Schedule, tz: string, armAt: Date | null, after: Date): Date | null`

This is the highest-value task to get right. All functions are pure — no Firestore, no ambient clock.

- [ ] **Step 1: Write the failing tests**

Create `functions/src/nextOccurrence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  zonedTimeToUtc,
  nextArmInstant,
  nextDisarmInstant,
} from "./nextOccurrence";
import { Schedule } from "./types";

const TZ = "Asia/Jerusalem"; // observes DST
const UTC = "UTC";

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Night",
    enabled: true,
    side: "device",
    profileId: "away",
    armTime: "23:00",
    disarmTime: "07:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    date: null,
    nextArmAt: null,
    nextDisarmAt: null,
    lastFiredAt: null,
    createdAt: Timestamp.fromMillis(0),
    ...over,
  };
}

describe("zonedTimeToUtc", () => {
  it("resolves a winter time in Jerusalem (UTC+2)", () => {
    // 2026-01-15 23:00 IST = 21:00 UTC
    expect(zonedTimeToUtc("2026-01-15", "23:00", TZ).toISOString())
      .toBe("2026-01-15T21:00:00.000Z");
  });

  it("resolves a summer time in Jerusalem (UTC+3)", () => {
    // 2026-07-15 23:00 IDT = 20:00 UTC
    expect(zonedTimeToUtc("2026-07-15", "23:00", TZ).toISOString())
      .toBe("2026-07-15T20:00:00.000Z");
  });

  it("resolves UTC unchanged", () => {
    expect(zonedTimeToUtc("2026-01-15", "23:00", UTC).toISOString())
      .toBe("2026-01-15T23:00:00.000Z");
  });
});

describe("nextArmInstant — recurring", () => {
  it("returns today's arm time when it is still ahead", () => {
    const after = new Date("2026-01-15T10:00:00.000Z"); // 12:00 local
    const got = nextArmInstant(schedule(), TZ, after);
    expect(got?.toISOString()).toBe("2026-01-15T21:00:00.000Z");
  });

  it("rolls to tomorrow when today's time has passed", () => {
    const after = new Date("2026-01-15T22:00:00.000Z"); // 00:00 local, 16th
    const got = nextArmInstant(schedule(), TZ, after);
    expect(got?.toISOString()).toBe("2026-01-16T21:00:00.000Z");
  });

  it("honours a weekday subset (Mon-Fri) by skipping the weekend", () => {
    // 2026-01-17 is a Saturday. Next Mon-Fri arm is Monday the 19th.
    const after = new Date("2026-01-17T10:00:00.000Z");
    const got = nextArmInstant(schedule({ days: [1, 2, 3, 4, 5] }), TZ, after);
    expect(got?.toISOString()).toBe("2026-01-19T21:00:00.000Z");
  });

  it("returns null for an arm-less window", () => {
    expect(nextArmInstant(schedule({ armTime: null }), TZ, new Date())).toBeNull();
  });
});

describe("nextArmInstant — one-time", () => {
  it("returns the dated instant when it is ahead", () => {
    const s = schedule({ days: [], date: "2026-03-01" });
    const after = new Date("2026-02-28T10:00:00.000Z");
    expect(nextArmInstant(s, TZ, after)?.toISOString())
      .toBe("2026-03-01T21:00:00.000Z");
  });

  it("returns null once the dated instant has passed", () => {
    const s = schedule({ days: [], date: "2026-03-01" });
    const after = new Date("2026-03-02T10:00:00.000Z");
    expect(nextArmInstant(s, TZ, after)).toBeNull();
  });
});

describe("nextDisarmInstant", () => {
  it("computes forward from the arm instant, crossing midnight", () => {
    const armAt = new Date("2026-01-16T21:00:00.000Z"); // Fri 23:00 local
    const got = nextDisarmInstant(schedule(), TZ, armAt, armAt);
    // Saturday 07:00 local = 05:00 UTC
    expect(got?.toISOString()).toBe("2026-01-17T05:00:00.000Z");
  });

  it("uses the same day when disarm is after arm without wrapping", () => {
    const s = schedule({ armTime: "08:00", disarmTime: "17:00" });
    const armAt = new Date("2026-01-16T06:00:00.000Z"); // 08:00 local
    expect(nextDisarmInstant(s, TZ, armAt, armAt)?.toISOString())
      .toBe("2026-01-16T15:00:00.000Z");
  });

  it("resolves against days directly for an arm-less window", () => {
    const s = schedule({ armTime: null, disarmTime: "05:00" });
    const after = new Date("2026-01-15T10:00:00.000Z"); // 12:00 local
    // Today's 05:00 has passed, so tomorrow.
    expect(nextDisarmInstant(s, TZ, null, after)?.toISOString())
      .toBe("2026-01-16T03:00:00.000Z");
  });
});

describe("DST transitions", () => {
  // Israel 2026: forward 2026-03-27 02:00->03:00, back 2026-10-25 02:00->01:00.
  it("fires at the jump when the wall-clock time does not exist", () => {
    const s = schedule({ armTime: "02:30", days: [], date: "2026-03-27" });
    const after = new Date("2026-03-26T00:00:00.000Z");
    const got = nextArmInstant(s, TZ, after);
    // 02:30 is skipped; fire at the instant the clock jumps (03:00 IDT = 00:00Z)
    expect(got?.toISOString()).toBe("2026-03-27T00:00:00.000Z");
  });

  it("fires once, on the first occurrence, when the time repeats", () => {
    const s = schedule({ armTime: "01:30", days: [], date: "2026-10-25" });
    const after = new Date("2026-10-24T00:00:00.000Z");
    const got = nextArmInstant(s, TZ, after);
    // First 01:30 is IDT (UTC+3) = 22:30Z on the 24th, not the IST repeat.
    expect(got?.toISOString()).toBe("2026-10-24T22:30:00.000Z");
  });

  it("is stable in a zone without DST", () => {
    const after = new Date("2026-03-27T00:00:00.000Z");
    const got = nextArmInstant(schedule(), UTC, after);
    expect(got?.toISOString()).toBe("2026-03-27T23:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd functions && npx vitest run src/nextOccurrence.test.ts`
Expected: FAIL — `Cannot find module './nextOccurrence'`.

- [ ] **Step 3: Implement the module**

Create `functions/src/nextOccurrence.ts`:

```ts
// Pure wall-clock -> instant conversion for schedules. The ONLY place a
// "23:00" becomes a Date. No Firestore, no ambient clock: `after` is always
// injected so tests can pin time exactly.
//
// Node 20 on Cloud Functions ships full ICU, so Intl resolves zone offsets
// without a date library — deliberately, to keep functions/ at two runtime
// dependencies.

import { Schedule } from "./types";

/** Offset of `instant` in `tz`, in minutes east of UTC. */
function offsetMinutes(instant: Date, tz: string): number {
  // 'en-US' with an explicit part list gives a stable, parseable breakdown.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Hour 24 appears at midnight in some ICU versions; normalise to 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second")
  );
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * The instant at which local wall-clock `timeStr` occurs on local `dateStr`
 * in `tz`.
 *
 * DST rules, decided in the design doc rather than left to accident:
 * - Skipped time (spring forward): the naive guess lands in the gap. Both
 *   candidate offsets disagree with it, and the later offset wins, which
 *   yields the instant the clock jumps to. The edge fires rather than
 *   vanishing.
 * - Repeated time (autumn): the FIRST occurrence is returned, so an edge
 *   never fires twice. The pre-transition offset produces the earlier
 *   instant, which is what the first guess resolves to.
 */
export function zonedTimeToUtc(
  dateStr: string,
  timeStr: string,
  tz: string
): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);

  // Guess with the offset in effect at the naive instant, then correct once
  // using the offset actually in effect at the guessed instant. Two passes
  // are sufficient for every real zone (offsets change by at most a couple
  // of hours, never enough to skip a whole transition).
  const guess = new Date(naive - offsetMinutes(new Date(naive), tz) * 60000);
  const corrected = new Date(naive - offsetMinutes(guess, tz) * 60000);

  // In a gap the two passes disagree; take the later, i.e. the jump instant.
  return corrected.getTime() >= guess.getTime() ? corrected : guess;
}

/** Local calendar date in `tz` for an instant, as "YYYY-MM-DD". */
function localDateStr(instant: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(instant); // en-CA formats as YYYY-MM-DD
}

/** Day of week (0=Sun) for a "YYYY-MM-DD" local date string. */
function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Add `n` days to a "YYYY-MM-DD" string, returning the same format. */
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + n));
  return next.toISOString().slice(0, 10);
}

/**
 * First instant strictly after `after` at which `timeStr` occurs on a day
 * permitted by the schedule. Returns null for a one-time schedule whose
 * date has passed.
 */
function nextInstantFor(
  schedule: Schedule,
  timeStr: string,
  tz: string,
  after: Date
): Date | null {
  if (schedule.date) {
    const instant = zonedTimeToUtc(schedule.date, timeStr, tz);
    return instant.getTime() > after.getTime() ? instant : null;
  }
  if (schedule.days.length === 0) return null;

  // Start from the local date of `after` and walk forward. 8 days covers a
  // full week plus the case where today's time has already passed.
  let dateStr = localDateStr(after, tz);
  for (let i = 0; i < 8; i++) {
    if (schedule.days.includes(dayOfWeek(dateStr))) {
      const instant = zonedTimeToUtc(dateStr, timeStr, tz);
      if (instant.getTime() > after.getTime()) return instant;
    }
    dateStr = addDays(dateStr, 1);
  }
  return null;
}

/** Next arm instant, or null for an arm-less or expired one-time window. */
export function nextArmInstant(
  schedule: Schedule,
  tz: string,
  after: Date
): Date | null {
  if (!schedule.armTime) return null;
  return nextInstantFor(schedule, schedule.armTime, tz, after);
}

/**
 * Next disarm instant.
 *
 * When the window has an arm edge, the disarm is derived FORWARD from it, so
 * a Fri 23:00 -> 07:00 window disarms on Saturday with no wraparound flag.
 * When it does not, `disarmTime` resolves against `days`/`date` directly.
 */
export function nextDisarmInstant(
  schedule: Schedule,
  tz: string,
  armAt: Date | null,
  after: Date
): Date | null {
  if (!armAt) return nextInstantFor(schedule, schedule.disarmTime, tz, after);

  const armDate = localDateStr(armAt, tz);
  const sameDay = zonedTimeToUtc(armDate, schedule.disarmTime, tz);
  if (sameDay.getTime() > armAt.getTime()) return sameDay;
  return zonedTimeToUtc(addDays(armDate, 1), schedule.disarmTime, tz);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd functions && npx vitest run src/nextOccurrence.test.ts`
Expected: all PASS. If a DST test fails, print the actual value and check it against Israel's 2026 transition dates before changing the implementation — the test's expectation may be the thing that is wrong.

- [ ] **Step 5: Commit**

```bash
git add functions/src/nextOccurrence.ts functions/src/nextOccurrence.test.ts
git commit -m "Pure next-occurrence module with DST handling"
```

---

### Task 4: scheduleDecision — pure fire/skip logic

**Files:**
- Create: `functions/src/scheduleDecision.ts`
- Test: `functions/src/scheduleDecision.test.ts`

**Interfaces:**
- Consumes: nothing (takes plain values, not `Schedule`).
- Produces: `decideEdge(dueAt, now, profileEnabled, edge): EdgeDecision` where `EdgeDecision = "fire" | "skip_stale" | "skip_disabled_profile" | "not_due"`, and `STALE_CUTOFF_MS`.

Extracting the decision keeps Task 5's Firestore code thin and lets the rules be tested without an emulator.

- [ ] **Step 1: Write the failing tests**

Create `functions/src/scheduleDecision.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideEdge, STALE_CUTOFF_MS } from "./scheduleDecision";

const now = new Date("2026-01-15T23:00:00.000Z");

describe("decideEdge", () => {
  it("fires an edge due right now", () => {
    expect(decideEdge(now, now, true, "arm")).toBe("fire");
  });

  it("fires an edge a few minutes late", () => {
    const due = new Date(now.getTime() - 5 * 60_000);
    expect(decideEdge(due, now, true, "arm")).toBe("fire");
  });

  it("skips an edge later than the stale cutoff", () => {
    const due = new Date(now.getTime() - STALE_CUTOFF_MS - 1000);
    expect(decideEdge(due, now, true, "arm")).toBe("skip_stale");
  });

  it("reports not_due for a future edge", () => {
    const due = new Date(now.getTime() + 60_000);
    expect(decideEdge(due, now, true, "arm")).toBe("not_due");
  });

  it("skips an arm edge whose profile is disabled", () => {
    expect(decideEdge(now, now, false, "arm")).toBe("skip_disabled_profile");
  });

  it("still fires a disarm edge when the profile is disabled", () => {
    // Releasing is always safe, so a disabled profile must not strand the
    // system armed.
    expect(decideEdge(now, now, false, "disarm")).toBe("fire");
  });

  it("prefers staleness over the disabled-profile reason", () => {
    const due = new Date(now.getTime() - STALE_CUTOFF_MS - 1000);
    expect(decideEdge(due, now, false, "arm")).toBe("skip_stale");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd functions && npx vitest run src/scheduleDecision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `functions/src/scheduleDecision.ts`:

```ts
// Pure decision for a single schedule edge. Kept separate from scheduleTick
// so the rules are testable without emulating Firestore.

export type EdgeKind = "arm" | "disarm";
export type EdgeDecision =
  | "fire"
  | "skip_stale"
  | "skip_disabled_profile"
  | "not_due";

/**
 * How late an edge may be and still fire. Downtime from a deploy or outage
 * must not arm the house at 08:00 because a 23:00 edge was still pending —
 * the same reasoning as onAlarm's 60s cutoff on alarm_cause: a stale trigger
 * is worse than a missed one.
 */
export const STALE_CUTOFF_MS = 15 * 60 * 1000;

export function decideEdge(
  dueAt: Date,
  now: Date,
  profileEnabled: boolean,
  edge: EdgeKind
): EdgeDecision {
  const lateBy = now.getTime() - dueAt.getTime();
  if (lateBy < 0) return "not_due";
  if (lateBy > STALE_CUTOFF_MS) return "skip_stale";
  // Arming a profile Operations hides would be invisible and unpredictable.
  // Disarming is always safe, so it fires regardless.
  if (edge === "arm" && !profileEnabled) return "skip_disabled_profile";
  return "fire";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd functions && npx vitest run src/scheduleDecision.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/scheduleDecision.ts functions/src/scheduleDecision.test.ts
git commit -m "Pure schedule edge decision: stale cutoff, disabled profile"
```

---

### Task 5: onScheduleChange — keep derived timestamps fresh

**Files:**
- Create: `functions/src/onScheduleChange.ts`
- Modify: `functions/src/index.ts`

**Interfaces:**
- Consumes: `nextArmInstant`, `nextDisarmInstant` (Task 3); `Schedule` (Task 1).
- Produces: the export `onScheduleChange`; maintains `nextArmAt`/`nextDisarmAt` that Task 6 queries.

- [ ] **Step 1: Write the trigger**

Create `functions/src/onScheduleChange.ts`:

```ts
// Cloud Function: onScheduleChange
// Trigger: Firestore writes to projects/{projectId}/schedules/{scheduleId}.
// Recomputes the derived nextArmAt / nextDisarmAt fields.
//
// This is the SINGLE writer of those fields on edit, which is what makes
// scheduleTick's cheap indexed query trustworthy. If they go stale, a
// schedule silently stops firing.

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { Schedule } from "./types";
import { nextArmInstant, nextDisarmInstant } from "./nextOccurrence";

export const onScheduleChange = onDocumentWritten(
  {
    document: "projects/{projectId}/schedules/{scheduleId}",
    region: "europe-west1",
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return; // deleted — nothing to recompute

    const projectId = event.params.projectId;
    const schedule = { id: after.id, ...after.data() } as Schedule;

    // A disabled schedule has no next fire time. Clearing rather than
    // recomputing means re-enabling recomputes from NOW, so a schedule
    // paused for three weeks does not wake believing it owes a past fire.
    let armAt: Date | null = null;
    let disarmAt: Date | null = null;

    if (schedule.enabled) {
      const projectSnap = await db.doc(`projects/${projectId}`).get();
      const tz = (projectSnap.data()?.timezone as string) || "UTC";
      const now = new Date();
      armAt = nextArmInstant(schedule, tz, now);
      disarmAt = nextDisarmInstant(schedule, tz, armAt, now);
    }

    const nextArmAt = armAt ? Timestamp.fromDate(armAt) : null;
    const nextDisarmAt = disarmAt ? Timestamp.fromDate(disarmAt) : null;

    // Recursion guard: this function writes the very fields it triggers on,
    // so bail when they already hold the computed values.
    const currentArm = schedule.nextArmAt?.toMillis() ?? null;
    const currentDisarm = schedule.nextDisarmAt?.toMillis() ?? null;
    if (
      currentArm === (nextArmAt?.toMillis() ?? null) &&
      currentDisarm === (nextDisarmAt?.toMillis() ?? null)
    ) {
      return;
    }

    await after.ref.update({ nextArmAt, nextDisarmAt });
  }
);
```

- [ ] **Step 2: Export it**

In `functions/src/index.ts`, add after the `onProfileChange` export line:

```ts
export { onScheduleChange } from "./onScheduleChange";
```

- [ ] **Step 3: Typecheck**

Run: `cd functions && npm run lint`
Expected: no output.

- [ ] **Step 4: Run the full suite (nothing should regress)**

Run: `cd functions && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/onScheduleChange.ts functions/src/index.ts
git commit -m "onScheduleChange: recompute derived next-fire timestamps"
```

---

### Task 6: scheduleTick — the every-minute function

**Files:**
- Create: `functions/src/scheduleTick.ts`
- Modify: `functions/src/index.ts`

**Interfaces:**
- Consumes: `decideEdge`, `STALE_CUTOFF_MS` (Task 4); `nextArmInstant`, `nextDisarmInstant` (Task 3); `Schedule` (Task 1).
- Produces: the export `scheduleTick`.

- [ ] **Step 1: Write the function**

Create `functions/src/scheduleTick.ts`:

```ts
// Cloud Function: scheduleTick
// Trigger: every minute.
//
// Fires due schedule edges by writing exactly the fields a human pressing a
// button in Operations writes — the scheduler gets no private path to the
// device, so every downstream trigger (config rebuild, timeline, Telegram)
// is reused unmodified.
//
// Cost: an idle minute is two collection-group queries matching zero
// documents, which is what the precomputed nextArmAt/nextDisarmAt fields
// exist to buy. Do not replace them with a full scan.
//
// This is the 2nd of Cloud Scheduler's 3 free jobs per BILLING ACCOUNT
// (deadSensorCheck is the other).

import { onSchedule } from "firebase-functions/v2/scheduler";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { Schedule, Profile } from "./types";
import { decideEdge, EdgeKind } from "./scheduleDecision";
import { nextArmInstant, nextDisarmInstant } from "./nextOccurrence";

export const scheduleTick = onSchedule(
  { schedule: "every 1 minutes", region: "europe-west1" },
  async (_event) => {
    const now = new Date();
    const nowTs = Timestamp.fromDate(now);

    for (const edge of ["arm", "disarm"] as EdgeKind[]) {
      const field = edge === "arm" ? "nextArmAt" : "nextDisarmAt";
      const dueSnap = await db
        .collectionGroup("schedules")
        .where("enabled", "==", true)
        .where(field, "<=", nowTs)
        .get();

      for (const doc of dueSnap.docs) {
        const schedule = { id: doc.id, ...doc.data() } as Schedule;
        // .../projects/{projectId}/schedules/{id} — parent of the collection.
        const projectId = doc.ref.parent.parent?.id;
        if (!projectId) continue;

        const dueTs = edge === "arm" ? schedule.nextArmAt : schedule.nextDisarmAt;
        if (!dueTs) continue;

        const profileSnap = await db
          .doc(`projects/${projectId}/profiles/${schedule.profileId}`)
          .get();
        const profileEnabled =
          profileSnap.exists && (profileSnap.data() as Profile).enabled !== false;

        const decision = decideEdge(dueTs.toDate(), now, profileEnabled, edge);

        if (decision === "not_due") continue;
        if (decision !== "fire") {
          console.warn(
            `schedule ${projectId}/${schedule.id} ${edge}: ${decision}`
          );
        } else {
          await fireEdge(projectId, schedule, edge);
        }

        await advance(projectId, doc.ref, schedule, decision === "fire", now);
      }
    }
  }
);

/**
 * Apply an edge. Writes the same fields OperationsPage.armSide writes:
 * device -> profile.isActiveOnDevice + RTDB commands/armed;
 * server -> profile.isActiveOnServer + project.serverArmed.
 */
async function fireEdge(
  projectId: string,
  schedule: Schedule,
  edge: EdgeKind
): Promise<void> {
  const arming = edge === "arm";
  const field =
    schedule.side === "device" ? "isActiveOnDevice" : "isActiveOnServer";

  // Exactly one profile may be active per side, so clear the others.
  const profilesSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .get();
  const batch = db.batch();
  for (const p of profilesSnap.docs) {
    const shouldBeActive = arming && p.id === schedule.profileId;
    if (Boolean(p.data()[field]) !== shouldBeActive) {
      batch.update(p.ref, { [field]: shouldBeActive });
    }
  }
  await batch.commit();

  if (schedule.side === "device") {
    await rtdb.ref(`${projectId}/commands/armed`).set(arming);
    // Disarming must always silence. commands/armed only reaches the device
    // on a VALUE CHANGE, so disarming an already-disarmed device delivers
    // nothing and a sounding siren would run to its timer.
    if (!arming) {
      await rtdb.ref(`${projectId}/commands/siren`).set(false);
    }
  } else {
    await db.doc(`projects/${projectId}`).update({ serverArmed: arming });
  }
}

/** Recompute this schedule's next fire times after an edge is handled. */
async function advance(
  projectId: string,
  ref: FirebaseFirestore.DocumentReference,
  schedule: Schedule,
  fired: boolean,
  now: Date
): Promise<void> {
  const projectSnap = await db.doc(`projects/${projectId}`).get();
  const tz = (projectSnap.data()?.timezone as string) || "UTC";

  const armAt = nextArmInstant(schedule, tz, now);
  const disarmAt = nextDisarmInstant(schedule, tz, armAt, now);

  const update: Record<string, unknown> = {
    nextArmAt: armAt ? Timestamp.fromDate(armAt) : null,
    nextDisarmAt: disarmAt ? Timestamp.fromDate(disarmAt) : null,
  };
  if (fired) update.lastFiredAt = Timestamp.fromDate(now);

  // A one-time schedule with nothing left ahead disables itself, so it stops
  // matching the tick's query instead of lingering as a dead row.
  if (!armAt && !disarmAt) update.enabled = false;

  await ref.update(update);
}
```

- [ ] **Step 2: Export it**

In `functions/src/index.ts`, add:

```ts
export { scheduleTick } from "./scheduleTick";
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `cd functions && npm run lint && npm test`
Expected: no typecheck output; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add functions/src/scheduleTick.ts functions/src/index.ts
git commit -m "scheduleTick: fire due schedule edges every minute"
```

---

### Task 7: Security rules and Firestore indexes

**Files:**
- Modify: `firestore.rules`
- Create: `firestore.indexes.json`
- Modify: `firebase.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `schedules` write rules the UI in Tasks 9–11 must respect.

- [ ] **Step 1: Add the schedules rules block**

In `firestore.rules`, inside `match /projects/{projectId}`, after the closing brace of the `match /profiles/{profileId}` block, add:

```
      match /schedules/{scheduleId} {
        allow read: if isMember(projectId);
        allow create, delete: if isAdmin(projectId);
        // Admin may edit everything. A plain member may only pause/resume a
        // DEVICE schedule — the same boundary as the profiles rule above: a
        // member may arm and disarm the device but not the server, because
        // server-side arming changes what the cloud evaluates for the whole
        // project. Pausing a device schedule is the same class of act as
        // arming the device; pausing a server schedule is not.
        allow update: if isAdmin(projectId)
          || (isMember(projectId)
              && resource.data.side == 'device'
              && request.resource.data.diff(resource.data).affectedKeys()
                   .hasOnly(['enabled']));
      }
```

The derived fields are written by `onScheduleChange` and `scheduleTick` under the admin SDK, which bypasses rules, so they need no client allowance.

- [ ] **Step 2: Create the indexes file**

Create `firestore.indexes.json`:

```json
{
  "indexes": [
    {
      "collectionGroup": "schedules",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "enabled", "order": "ASCENDING" },
        { "fieldPath": "nextArmAt", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "schedules",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "enabled", "order": "ASCENDING" },
        { "fieldPath": "nextDisarmAt", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

- [ ] **Step 3: Reference it from firebase.json**

In `firebase.json`, the `firestore` block currently reads `{ "rules": "firestore.rules" }`. Change it to:

```json
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
```

- [ ] **Step 4: Verify the config parses**

Run: `npx firebase deploy --only firestore:indexes --dry-run 2>&1 | tail -20`
Expected: no JSON or schema error. (If the CLI is not authenticated, `python3 -m json.tool firestore.indexes.json > /dev/null && python3 -m json.tool firebase.json > /dev/null` is an acceptable substitute — it confirms both files are valid JSON.)

- [ ] **Step 5: Commit**

```bash
git add firestore.rules firestore.indexes.json firebase.json
git commit -m "Schedules: security rules and collection-group indexes"
```

---

### Task 8: Web Firestore helpers and i18n strings

**Files:**
- Modify: `web/src/lib/firestore.ts`
- Modify: `web/src/i18n/en.ts`
- Modify: `web/src/i18n/he.ts`

**Interfaces:**
- Consumes: `Schedule` (Task 1).
- Produces: `schedulesCol(projectId)`, `scheduleDoc(projectId, scheduleId)`, and the `sched.*` translation keys used by Tasks 9–11.

- [ ] **Step 1: Add the typed collection helpers**

In `web/src/lib/firestore.ts`, add `Schedule` to the type import list from `@/types`, then add alongside the other converters:

```ts
const scheduleConverter = converter<Schedule>();
```

and near the other collection helpers:

```ts
export const schedulesCol = (projectId: string) =>
  collection(db, "projects", projectId, "schedules").withConverter(
    scheduleConverter
  ) as CollectionReference<Schedule>;

export const scheduleDoc = (projectId: string, scheduleId: string) =>
  doc(db, "projects", projectId, "schedules", scheduleId).withConverter(
    scheduleConverter
  ) as DocumentReference<Schedule>;
```

Match the exact style of the existing `profilesCol` / `profileDoc` pair in this file.

- [ ] **Step 2: Add English strings**

In `web/src/i18n/en.ts`, before the closing `} as const;`, add:

```ts
  // ---- Schedules ----
  "sched.title": "Schedules",
  "sched.none": "No schedules yet.",
  "sched.add": "Add schedule",
  "sched.edit": "Edit schedule",
  "sched.name": "Name",
  "sched.side": "Side",
  "sched.side.device": "device",
  "sched.side.server": "server",
  "sched.profile": "Profile",
  "sched.armTime": "Arm at",
  "sched.disarmTime": "Disarm at",
  "sched.armOptional": "Leave empty to arm manually",
  "sched.disarmOnly": "disarm only",
  "sched.repeat": "Repeat",
  "sched.repeat.weekly": "Weekly",
  "sched.repeat.once": "Once",
  "sched.date": "Date",
  "sched.everyDay": "every day",
  "sched.weekdays": "Mon–Fri",
  "sched.weekends": "Sat–Sun",
  "sched.next": "Next: {what}",
  "sched.nextArm": "{side} arms {when}",
  "sched.nextDisarm": "{side} disarms {when}",
  "sched.nextNone": "nothing scheduled",
  "sched.overlapWarning":
    "This overlaps another schedule on the same side. Both will run; the later edge wins.",
  "sched.disabledProfile": "This profile is disabled — the arm step will be skipped.",
  "sched.enable": "Enable schedule",
  "sched.disable": "Disable schedule",
  "sched.day.0": "Sun",
  "sched.day.1": "Mon",
  "sched.day.2": "Tue",
  "sched.day.3": "Wed",
  "sched.day.4": "Thu",
  "sched.day.5": "Fri",
  "sched.day.6": "Sat",
```

- [ ] **Step 3: Add Hebrew strings**

In `web/src/i18n/he.ts`, before the closing brace, add the same keys with Hebrew values. Weekday abbreviations use the real Hebrew forms, not transliterated English:

```ts
  // ---- Schedules ----
  "sched.title": "תזמונים",
  "sched.none": "אין תזמונים עדיין.",
  "sched.add": "הוספת תזמון",
  "sched.edit": "עריכת תזמון",
  "sched.name": "שם",
  "sched.side": "צד",
  "sched.side.device": "התקן",
  "sched.side.server": "שרת",
  "sched.profile": "פרופיל",
  "sched.armTime": "דריכה בשעה",
  "sched.disarmTime": "נטרול בשעה",
  "sched.armOptional": "השאירו ריק לדריכה ידנית",
  "sched.disarmOnly": "נטרול בלבד",
  "sched.repeat": "חזרה",
  "sched.repeat.weekly": "שבועי",
  "sched.repeat.once": "חד־פעמי",
  "sched.date": "תאריך",
  "sched.everyDay": "כל יום",
  "sched.weekdays": "א׳–ה׳",
  "sched.weekends": "ו׳–ש׳",
  "sched.next": "הבא: {what}",
  "sched.nextArm": "{side} נדרך {when}",
  "sched.nextDisarm": "{side} מנוטרל {when}",
  "sched.nextNone": "אין תזמון קרוב",
  "sched.overlapWarning":
    "יש חפיפה עם תזמון אחר באותו צד. שניהם יפעלו; הפעולה המאוחרת קובעת.",
  "sched.disabledProfile": "הפרופיל מושבת — שלב הדריכה ידולג.",
  "sched.enable": "הפעלת תזמון",
  "sched.disable": "השבתת תזמון",
  "sched.day.0": "א׳",
  "sched.day.1": "ב׳",
  "sched.day.2": "ג׳",
  "sched.day.3": "ד׳",
  "sched.day.4": "ה׳",
  "sched.day.5": "ו׳",
  "sched.day.6": "ש׳",
```

Note: in Hebrew the working week runs Sunday–Thursday, so `sched.weekdays` renders as א׳–ה׳ (Sun–Thu) rather than a literal translation of "Mon–Fri". The preset it applies is still `[1,2,3,4,5]`; only the label differs.

- [ ] **Step 4: Typecheck**

Run: `cd web && npm run lint`
Expected: no output. A missing Hebrew key fails here, which is the point of `he.ts` being typed.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/firestore.ts web/src/i18n/en.ts web/src/i18n/he.ts
git commit -m "Web: schedule collection helpers and i18n strings"
```

---

### Task 9: Pure formatters and overlap detection

**Files:**
- Create: `web/src/features/operations/scheduleFormat.ts`
- Create: `web/src/features/operations/scheduleFormat.test.ts`
- Create: `web/src/features/operations/scheduleOverlap.ts`
- Create: `web/src/features/operations/scheduleOverlap.test.ts`

**Interfaces:**
- Consumes: `Schedule` (Task 1).
- Produces:
  - `formatTimeRange(armTime: string | null, disarmTime: string): string`
  - `formatRecurrence(days: number[], date: string | null, dayNames: string[], everyDayLabel: string): string`
  - `minutesOf(time: string): number`
  - `overlaps(a: Schedule, b: Schedule): boolean`
  - `findOverlaps(candidate: Schedule, existing: Schedule[]): Schedule[]`

- [ ] **Step 1: Write the failing formatter tests**

Create `web/src/features/operations/scheduleFormat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatTimeRange, formatRecurrence, minutesOf } from "./scheduleFormat";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

describe("minutesOf", () => {
  it("converts HH:MM to minutes since midnight", () => {
    expect(minutesOf("00:00")).toBe(0);
    expect(minutesOf("07:30")).toBe(450);
    expect(minutesOf("23:00")).toBe(1380);
  });
});

describe("formatTimeRange", () => {
  it("renders a full window with an arrow", () => {
    expect(formatTimeRange("23:00", "07:00")).toBe("23:00 → 07:00");
  });

  it("renders a disarm-only window as a leading arrow", () => {
    expect(formatTimeRange(null, "05:00")).toBe("→ 05:00");
  });
});

describe("formatRecurrence", () => {
  it("collapses all seven days", () => {
    expect(formatRecurrence([0, 1, 2, 3, 4, 5, 6], null, DAYS, "every day"))
      .toBe("every day");
  });

  it("lists a weekday subset in week order", () => {
    expect(formatRecurrence([5, 1, 3], null, DAYS, "every day"))
      .toBe("Mon, Wed, Fri");
  });

  it("renders a one-time date", () => {
    expect(formatRecurrence([], "2026-09-01", DAYS, "every day"))
      .toBe("2026-09-01");
  });

  it("returns an empty string when neither is set", () => {
    expect(formatRecurrence([], null, DAYS, "every day")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/features/operations/scheduleFormat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the formatters**

Create `web/src/features/operations/scheduleFormat.ts`:

```ts
// Pure label helpers for the schedule rows. Kept out of the component so the
// string shapes are testable without rendering.

/** "HH:MM" -> minutes since local midnight. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * The row's headline. A disarm-only window shows a single time behind an
 * arrow, which makes its shape obvious at a glance.
 */
export function formatTimeRange(
  armTime: string | null,
  disarmTime: string
): string {
  return armTime ? `${armTime} → ${disarmTime}` : `→ ${disarmTime}`;
}

/** "every day" / "Mon, Wed, Fri" / "2026-09-01". */
export function formatRecurrence(
  days: number[],
  date: string | null,
  dayNames: string[],
  everyDayLabel: string
): string {
  if (date) return date;
  if (days.length === 0) return "";
  if (days.length === 7) return everyDayLabel;
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => dayNames[d])
    .join(", ");
}
```

- [ ] **Step 4: Run to verify the formatter tests pass**

Run: `cd web && npx vitest run src/features/operations/scheduleFormat.test.ts`
Expected: all PASS.

- [ ] **Step 5: Write the failing overlap tests**

Create `web/src/features/operations/scheduleOverlap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { overlaps, findOverlaps } from "./scheduleOverlap";
import type { Schedule } from "@/types";

function s(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "a",
    name: "n",
    enabled: true,
    side: "device",
    profileId: "away",
    armTime: "23:00",
    disarmTime: "07:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    date: null,
    nextArmAt: null,
    nextDisarmAt: null,
    lastFiredAt: null,
    createdAt: Timestamp.fromMillis(0),
    ...over,
  };
}

describe("overlaps", () => {
  it("detects two windows sharing a day and side", () => {
    expect(overlaps(s({ id: "a" }), s({ id: "b", armTime: "22:00", disarmTime: "06:00" })))
      .toBe(true);
  });

  it("ignores schedules on different sides", () => {
    expect(overlaps(s({ id: "a" }), s({ id: "b", side: "server" }))).toBe(false);
  });

  it("ignores schedules with no day in common", () => {
    const a = s({ id: "a", days: [1, 2] });
    const b = s({ id: "b", days: [5, 6] });
    expect(overlaps(a, b)).toBe(false);
  });

  it("treats a midnight-crossing window as covering the early hours", () => {
    // 23:00->07:00 overlaps a 06:00->08:00 window on the same day.
    const night = s({ id: "a" });
    const morning = s({ id: "b", armTime: "06:00", disarmTime: "08:00" });
    expect(overlaps(night, morning)).toBe(true);
  });

  it("finds no overlap between disjoint same-day windows", () => {
    const a = s({ id: "a", armTime: "08:00", disarmTime: "12:00" });
    const b = s({ id: "b", armTime: "13:00", disarmTime: "17:00" });
    expect(overlaps(a, b)).toBe(false);
  });

  it("never reports a schedule as overlapping itself", () => {
    const a = s({ id: "a" });
    expect(findOverlaps(a, [a])).toEqual([]);
  });

  it("ignores disabled schedules", () => {
    const a = s({ id: "a" });
    const b = s({ id: "b", enabled: false });
    expect(findOverlaps(a, [b])).toEqual([]);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd web && npx vitest run src/features/operations/scheduleOverlap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement overlap detection**

Create `web/src/features/operations/scheduleOverlap.ts`:

```ts
// Same-side overlap detection, used to WARN on save — never to block.
// Overlapping edges are last-write-wins by design (see the design doc): each
// edge is independent, so no window owns a side. The warning exists to catch
// the genuine mistake, not to enforce a policy.

import { minutesOf } from "./scheduleFormat";
import type { Schedule } from "@/types";

const DAY_MINUTES = 24 * 60;

/** Intervals a window covers, split at midnight when it wraps. */
function intervals(s: Schedule): Array<[number, number]> {
  const start = s.armTime ? minutesOf(s.armTime) : 0;
  const end = minutesOf(s.disarmTime);
  if (end > start) return [[start, end]];
  // Wraps midnight: the tail of the day plus the head of the next.
  return [
    [start, DAY_MINUTES],
    [0, end],
  ];
}

function intervalsIntersect(
  a: Array<[number, number]>,
  b: Array<[number, number]>
): boolean {
  return a.some(([as, ae]) => b.some(([bs, be]) => as < be && bs < ae));
}

function sharesADay(a: Schedule, b: Schedule): boolean {
  if (a.date || b.date) return a.date === b.date;
  return a.days.some((d) => b.days.includes(d));
}

export function overlaps(a: Schedule, b: Schedule): boolean {
  if (a.id === b.id) return false;
  if (a.side !== b.side) return false;
  if (!sharesADay(a, b)) return false;
  return intervalsIntersect(intervals(a), intervals(b));
}

export function findOverlaps(
  candidate: Schedule,
  existing: Schedule[]
): Schedule[] {
  return existing.filter((e) => e.enabled && overlaps(candidate, e));
}
```

- [ ] **Step 8: Run both test files**

Run: `cd web && npx vitest run src/features/operations/scheduleFormat.test.ts src/features/operations/scheduleOverlap.test.ts`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/features/operations/scheduleFormat.ts \
  web/src/features/operations/scheduleFormat.test.ts \
  web/src/features/operations/scheduleOverlap.ts \
  web/src/features/operations/scheduleOverlap.test.ts
git commit -m "Pure schedule formatters and overlap detection"
```

---

### Task 10: ScheduleEditor modal

**Files:**
- Create: `web/src/features/operations/ScheduleEditor.tsx`

**Interfaces:**
- Consumes: `Schedule` (Task 1), `findOverlaps` (Task 9), `sched.*` strings (Task 8).
- Produces: `<ScheduleEditor schedule onSave onCancel onDelete profiles existing />` — `onSave(draft: Schedule)` hands a complete `Schedule` back to Task 11, which owns persistence.

- [ ] **Step 1: Create the component**

Create `web/src/features/operations/ScheduleEditor.tsx`:

```tsx
// Modal editor for one schedule. Presentational: it owns draft state and
// validation only — the parent persists, so this stays testable and the
// Firestore calls live in one place.
//
// A <dialog> opened with showModal() is what gives the top layer, backdrop,
// focus trap and Esc handling; rendering with `open` does none of that. Same
// pattern as ProfilesTab's rule dialogs.
import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/I18nProvider";
import { findOverlaps } from "./scheduleOverlap";
import type { TranslationKey } from "@/i18n/en";
import type { Schedule, Profile } from "@/types";

interface Props {
  schedule: Schedule; // a fully-formed draft, new or existing
  profiles: Profile[];
  existing: Schedule[]; // for the overlap warning
  isNew: boolean;
  onSave: (draft: Schedule) => void;
  onCancel: () => void;
  onDelete: () => void;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export default function ScheduleEditor({
  schedule,
  profiles,
  existing,
  isNew,
  onSave,
  onCancel,
  onDelete,
}: Props) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Schedule>(schedule);

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, []);

  const set = <K extends keyof Schedule>(key: K, value: Schedule[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const toggleDay = (day: number) =>
    setDraft((d) => ({
      ...d,
      days: d.days.includes(day)
        ? d.days.filter((x) => x !== day)
        : [...d.days, day],
    }));

  const isOnce = draft.date !== null;
  const conflicts = findOverlaps(draft, existing);
  const targetProfile = profiles.find((p) => p.id === draft.profileId);
  const profileDisabled = targetProfile ? targetProfile.enabled === false : false;

  // A window must close, and a recurring one must say when.
  const valid =
    draft.disarmTime !== "" &&
    draft.profileId !== "" &&
    (isOnce ? draft.date !== "" : draft.days.length > 0);

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onCancel={onCancel}
      onClose={onCancel}
    >
      <div className="modal__body">
        <h3 className="card__title">
          {isNew ? t("sched.add") : t("sched.edit")}
        </h3>

        <div className="field">
          <label className="field__label" htmlFor="sched-name">
            {t("sched.name")}
          </label>
          <input
            id="sched-name"
            className="input"
            type="text"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-side">
            {t("sched.side")}
          </label>
          <select
            id="sched-side"
            className="input"
            value={draft.side}
            onChange={(e) => set("side", e.target.value as Schedule["side"])}
          >
            <option value="device">{t("sched.side.device")}</option>
            <option value="server">{t("sched.side.server")}</option>
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-profile">
            {t("sched.profile")}
          </label>
          <select
            id="sched-profile"
            className="input"
            value={draft.profileId}
            onChange={(e) => set("profileId", e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          {profileDisabled && (
            <p className="muted">{t("sched.disabledProfile")}</p>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-arm">
            {t("sched.armTime")}
          </label>
          <input
            id="sched-arm"
            className="input"
            type="time"
            value={draft.armTime ?? ""}
            onChange={(e) => set("armTime", e.target.value || null)}
          />
          <p className="muted">{t("sched.armOptional")}</p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-disarm">
            {t("sched.disarmTime")}
          </label>
          <input
            id="sched-disarm"
            className="input"
            type="time"
            required
            value={draft.disarmTime}
            onChange={(e) => set("disarmTime", e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-repeat">
            {t("sched.repeat")}
          </label>
          <select
            id="sched-repeat"
            className="input"
            value={isOnce ? "once" : "weekly"}
            onChange={(e) =>
              setDraft((d) =>
                e.target.value === "once"
                  ? {
                      ...d,
                      days: [],
                      date: d.date ?? new Date().toISOString().slice(0, 10),
                    }
                  : { ...d, date: null, days: d.days.length ? d.days : ALL_DAYS }
              )
            }
          >
            <option value="weekly">{t("sched.repeat.weekly")}</option>
            <option value="once">{t("sched.repeat.once")}</option>
          </select>
        </div>

        {isOnce ? (
          <div className="field">
            <label className="field__label" htmlFor="sched-date">
              {t("sched.date")}
            </label>
            <input
              id="sched-date"
              className="input"
              type="date"
              value={draft.date ?? ""}
              onChange={(e) => set("date", e.target.value)}
            />
          </div>
        ) : (
          <div className="field">
            <span className="field__label">{t("sched.repeat.weekly")}</span>
            <div className="day-toggles">
              {ALL_DAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`day-toggle${draft.days.includes(d) ? " is-active" : ""}`}
                  aria-pressed={draft.days.includes(d)}
                  onClick={() => toggleDay(d)}
                >
                  {t(`sched.day.${d}` as TranslationKey)}
                </button>
              ))}
            </div>
          </div>
        )}

        {conflicts.length > 0 && (
          <p className="muted">{t("sched.overlapWarning")}</p>
        )}

        <div className="row">
          <button
            className="btn btn--primary"
            disabled={!valid}
            onClick={() => onSave(draft)}
          >
            {t("common.save")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          {!isNew && (
            <button className="btn btn--danger" onClick={onDelete}>
              {t("common.delete")}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npm run lint`
Expected: no output. If `field__hint`, `seg`, `seg__btn`, `btn--danger` or `row` are not existing class names in `web/src/styles/components.css`, that is fine — Task 11 adds the new ones; reuse whatever the file already defines for the rest and adjust these names to match.

- [ ] **Step 3: Commit**

```bash
git add web/src/features/operations/ScheduleEditor.tsx
git commit -m "Schedule editor modal"
```

---

### Task 11: SchedulesPanel and Operations integration

**Files:**
- Create: `web/src/features/operations/SchedulesPanel.tsx`
- Modify: `web/src/features/operations/OperationsPage.tsx`
- Modify: `web/src/styles/components.css`

**Interfaces:**
- Consumes: `schedulesCol`, `scheduleDoc` (Task 8); `formatTimeRange`, `formatRecurrence` (Task 9); `ScheduleEditor` (Task 10).
- Produces: the mounted UI. Nothing depends on it.

- [ ] **Step 1: Create the panel**

Create `web/src/features/operations/SchedulesPanel.tsx`:

```tsx
// Schedules list, phone-alarm shaped: one compact row each, big time and a
// toggle, so the list stays scannable. The `+` opens the editor modal.
//
// This lives on Operations rather than Configure because "when does it
// disarm" is an operational question — the same kind of fact as "is it
// armed" — and you should not have to navigate away to answer it.
import { useEffect, useState } from "react";
import {
  addDoc,
  deleteDoc,
  onSnapshot,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import { schedulesCol, scheduleDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import { formatTimeRange, formatRecurrence } from "./scheduleFormat";
import ScheduleEditor from "./ScheduleEditor";
import type { TranslationKey } from "@/i18n/en";
import type { Schedule, Profile, Role } from "@/types";

interface Props {
  projectId: string;
  profiles: Profile[];
  role: Role | null;
}

export default function SchedulesPanel({ projectId, profiles, role }: Props) {
  const t = useT();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [isNew, setIsNew] = useState(false);

  const isAdmin = role === "admin";

  useEffect(() => {
    const unsub = onSnapshot(schedulesCol(projectId), (snap) => {
      setSchedules(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, [projectId]);

  // Operations hides the Server card from non-admins, so a server schedule is
  // hidden from them too — same boundary, stated in one place.
  const visible = schedules.filter((s) => isAdmin || s.side === "device");

  // The header carries the single next edge in plain language. Read straight
  // off the precomputed timestamps, which is the second thing they buy.
  const nextLine = (): string => {
    let best: { at: Timestamp; text: string } | null = null;
    for (const s of visible) {
      if (!s.enabled) continue;
      const sideLabel = t(`sched.side.${s.side}` as TranslationKey);
      const candidates: Array<[Timestamp | null, string]> = [
        [s.nextArmAt, t("sched.nextArm", { side: sideLabel, when: s.armTime ?? "" })],
        [s.nextDisarmAt, t("sched.nextDisarm", { side: sideLabel, when: s.disarmTime })],
      ];
      for (const [at, text] of candidates) {
        if (!at) continue;
        if (!best || at.toMillis() < best.at.toMillis()) best = { at, text };
      }
    }
    return best ? best.text : t("sched.nextNone");
  };

  const blankSchedule = (): Schedule => ({
    id: "",
    name: "",
    enabled: true,
    side: "device",
    profileId: profiles[0]?.id ?? "",
    armTime: "23:00",
    disarmTime: "07:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    date: null,
    nextArmAt: null,
    nextDisarmAt: null,
    lastFiredAt: null,
    createdAt: Timestamp.now(),
  });

  const handleSave = async (draft: Schedule) => {
    if (isNew) {
      // Strip id — the converter drops it on write, and addDoc assigns one.
      await addDoc(schedulesCol(projectId), draft);
    } else {
      await setDoc(scheduleDoc(projectId, draft.id), draft);
    }
    setEditing(null);
  };

  const handleDelete = async () => {
    if (editing && !isNew) {
      await deleteDoc(scheduleDoc(projectId, editing.id));
    }
    setEditing(null);
  };

  // The toggle is the control most often reached for ("skip tonight"), so it
  // must never open the editor. It is a SIBLING of the row button rather than
  // nested inside it — nesting would make every toggle tap also a row tap.
  const handleToggle = async (s: Schedule, next: boolean) => {
    await setDoc(scheduleDoc(projectId, s.id), { ...s, enabled: next });
  };

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">{t("sched.title")}</h2>
        <span className="muted">{t("sched.next", { what: nextLine() })}</span>
      </div>

      {visible.length === 0 && <p className="muted">{t("sched.none")}</p>}

      <ul className="sched-list">
        {visible.map((s) => {
          const profile = profiles.find((p) => p.id === s.profileId);
          const canToggle = isAdmin || s.side === "device";
          return (
            <li key={s.id}>
              <button
                className="sched-row"
                onClick={() => {
                  if (!isAdmin) return;
                  setIsNew(false);
                  setEditing(s);
                }}
                disabled={!isAdmin}
              >
                <span className="sched-row__time">
                  {formatTimeRange(s.armTime, s.disarmTime)}
                </span>
                <span className="sched-row__meta">
                  {[
                    s.armTime ? profile?.displayName : t("sched.disarmOnly"),
                    t(`sched.side.${s.side}` as TranslationKey),
                    formatRecurrence(
                      s.days,
                      s.date,
                      [0, 1, 2, 3, 4, 5, 6].map((d) =>
                        t(`sched.day.${d}` as TranslationKey)
                      ),
                      t("sched.everyDay")
                    ),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={!canToggle}
                  aria-label={s.enabled ? t("sched.disable") : t("sched.enable")}
                  onChange={(e) => void handleToggle(s, e.target.checked)}
                />
              </label>
            </li>
          );
        })}
      </ul>

      {isAdmin && (
        <button
          className="btn"
          onClick={() => {
            setIsNew(true);
            setEditing(blankSchedule());
          }}
        >
          + {t("sched.add")}
        </button>
      )}

      {editing && (
        <ScheduleEditor
          schedule={editing}
          profiles={profiles}
          existing={schedules}
          isNew={isNew}
          onSave={(d) => void handleSave(d)}
          onCancel={() => setEditing(null)}
          onDelete={() => void handleDelete()}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 2: Mount it on the Operations page**

In `web/src/features/operations/OperationsPage.tsx`, add the import:

```tsx
import SchedulesPanel from "./SchedulesPanel";
```

Then place it **below the arm grid and SOS, above the siren panel** — the arm grid is what you came to press; schedules are what you check on the way past. Insert:

```tsx
      {projectId && (
        <SchedulesPanel projectId={projectId} profiles={profiles} role={role} />
      )}
```

Locate the siren `<section>` (the block gated on `role === "admin"` around line 320 that renders the siren status and Force Silence button) and insert immediately before it.

- [ ] **Step 3: Add the row styles**

Append to `web/src/styles/components.css`:

```css
/* Schedule rows — phone-alarm shaped: large time, small subtitle, toggle at
   the inline end. Logical properties throughout so the RTL layout mirrors
   correctly in Hebrew (the 23:00 → 07:00 arrow reads right-to-left). */
.sched-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sched-list li {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding-block: var(--sp-2);
  border-block-end: 1px solid var(--border);
}

.sched-list li:last-child {
  border-block-end: none;
}

.sched-row {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
  background: none;
  border: none;
  padding: 0;
  text-align: start;
  color: inherit;
  cursor: pointer;
}

.sched-row:disabled {
  cursor: default;
}

.sched-row__time {
  font-size: 1.5rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.sched-row__meta {
  font-size: 0.8rem;
  opacity: 0.7;
}

.day-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.day-toggle {
  min-inline-size: 2.5rem;
  min-block-size: var(--tap);
  padding-inline: var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: none;
  color: inherit;
  cursor: pointer;
}

.day-toggle.is-active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast);
}
```

Only `.sched-list`, `.sched-row`, `.sched-row__time`, `.sched-row__meta`, `.day-toggles` and `.day-toggle` are new. Everything else the components use — `.card`, `.card__header`, `.card__title`, `.field`, `.field__label`, `.input`, `.check`, `.btn`, `.btn--primary`, `.btn--danger`, `.row`, `.muted`, `.modal`, `.modal__body` — already exists in this file. Confirm with:

```bash
grep -n "^\.card\b\|card__header\|card__title\|^\.field\b\|field__label\|^\.input\b\|^\.check\b\|^\.btn\b\|btn--primary\|btn--danger\|^\.row\b\|^\.muted\b\|^\.modal\b" web/src/styles/components.css
```

The rules below use the design tokens from `web/src/styles/tokens.css`: `--border`, `--border-strong`, `--accent`, `--accent-contrast`, `--sp-2`, `--sp-3`, `--tap`. All are already defined there.

- [ ] **Step 4: Typecheck and run the full web suite**

Run: `cd web && npm run lint && npm test`
Expected: no typecheck output; all tests pass.

- [ ] **Step 5: Build to confirm the bundle compiles**

Run: `cd web && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/operations/SchedulesPanel.tsx \
  web/src/features/operations/OperationsPage.tsx \
  web/src/styles/components.css
git commit -m "Schedules panel on Operations"
```

---

### Task 12: Project timezone on setup

**Files:**
- Modify: `web/src/features/setup/CreateProjectPage.tsx:48-64`

**Interfaces:**
- Consumes: `Project.timezone` (Task 1).
- Produces: new projects carry a `timezone`; existing ones fall back to `"UTC"` in `onScheduleChange` and `scheduleTick`.

- [ ] **Step 1: Set the timezone at creation**

In `web/src/features/setup/CreateProjectPage.tsx`, the `const project: Omit<Project, "id"> = { ... }` literal (around line 48) sets the defaults. Add after `sirenDurationSec: 120,`:

```ts
        // The browser's zone is right in almost every case — the alarm is in
        // the house the user is standing in. Readers fall back to UTC.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
```

Match the file's existing 8-space indentation inside that literal.

- [ ] **Step 2: Typecheck and build**

Run: `cd web && npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add web/src/features/setup/CreateProjectPage.tsx
git commit -m "Set project timezone from the browser at creation"
```

---

### Task 13: Deploy and verify on hardware

**Files:** none — verification only.

- [ ] **Step 1: Deploy rules, indexes and functions**

```bash
npx firebase deploy --only firestore:rules,firestore:indexes
npx firebase deploy --only functions:onScheduleChange,functions:scheduleTick,functions:onArmStateChange,functions:onServerArmChange,functions:telegramWebhook
```

Indexes can take a few minutes to build. Confirm they are `Enabled` in the Firebase console before testing the tick.

- [ ] **Step 2: Deploy hosting**

```bash
cd web && npm run build && cd .. && npx firebase deploy --only hosting
```

- [ ] **Step 3: Set an existing project's timezone**

Projects created before Task 12 have no `timezone` and fall back to UTC. Set it in the Firebase console on the project doc (e.g. `Asia/Jerusalem`), or the schedule will fire at the wrong local time.

- [ ] **Step 4: Verify a real fire**

Create a schedule on Operations arming the device in ~2 minutes, with a disarm a minute later. Then confirm, in order:

1. The row shows the correct time range and recurrence.
2. Within a minute of saving, the doc has non-null `nextArmAt`/`nextDisarmAt` (Firebase console) — this proves `onScheduleChange` ran.
3. At the arm instant the Operations arm grid highlights the scheduled profile.
4. The device arms — check `http://alarm.local/status`, or watch the serial log.
5. A Telegram message arrives **silently** (no sound/vibration, message present).
6. The Firestore timeline shows the arm event.
7. At the disarm instant the system disarms and `nextArmAt` has advanced to the next occurrence.

- [ ] **Step 5: Verify the stale-edge guard**

In the console, set a schedule's `nextArmAt` to 30 minutes in the past with `enabled: true`. Within a minute, confirm the system does **not** arm and the function log shows `skip_stale`, and that `nextArmAt` has advanced.

- [ ] **Step 6: Update project documentation**

In `CLAUDE.md`, add `scheduleTick` and `onScheduleChange` to the Cloud Functions list in the Architecture section, and note that Cloud Scheduler now uses 2 of 3 free jobs. Remove the `- scheduling` line from `todo.txt`.

While in `CLAUDE.md`, fix the stale claim that the device "polls commands/config every 15s" — `cloud_client.h:163` sets `kPollIntervalMs = 5000`.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md todo.txt
git commit -m "Document scheduled arming; correct the documented poll cadence"
```

---

## Self-Review Notes

**Spec coverage.** Every section of the design maps to a task: the data model to Task 1; the silent-Telegram table to Task 2; `nextOccurrence` and the DST rules to Task 3; the stale cutoff and disabled-profile rule to Task 4; the single-writer derived state to Task 5; the tick, its query shape and edge firing to Task 6; rules and indexes to Task 7; i18n and helpers to Task 8; pure formatters and overlap warning to Task 9; the editor to Task 10; the phone-alarm rows, placement and next-edge header to Task 11; the project timezone to Task 12; hardware verification to Task 13.

**Known deviations from the spec, deliberate:**
- Task 6 disables a one-time schedule once nothing remains ahead. The spec did not say what becomes of a spent one-time window; leaving it enabled with null timestamps would be harmless but would linger as a dead row.
- `Project.timezone` is optional with a `"UTC"` fallback, because existing project docs predate the field. The spec presented it as required.
