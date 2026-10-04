# Per-Sensor Breach Certainty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each sensor declare whether its trigger is a definite breach, so a definite alarm sends an emergency (repeating) push while a non-definite one sends a loud single-shot push that the AI judge can escalate to emergency.

**Architecture:** Certainty is decided entirely cloud-side. `onAlarm` fires on
`state/siren_active` — written by both the device and the server — so it is
the single chokepoint for alarm notifications. It resolves the causing sensor
(or rule), computes a tier via a new pure `breachCertainty.ts`, and picks
`severity: "alarm"` vs `"loud"`. `onSnapshotUploaded` then escalates a
non-definite alarm to `"alarm"` on a breach verdict, and sends a silent
all-clear on a safe verdict.

**Tech Stack:** TypeScript, Firebase Functions gen-2, firebase-admin, Vitest,
React + Vite (web).

**Spec:** `docs/superpowers/specs/2026-10-04-per-sensor-breach-certainty-design.md`

## Global Constraints

- **No firmware change. No EEPROM magic bump.** The device never learns about
  certainty. Touching `EepromStore::kMagic` risks the physical siren pairing
  (see `docs/history/siren-hub-free.md`).
- **`definiteBreach` must stay OUT of `sensorConfigChanged`'s guard**, exactly
  as `cameraNames` already is. It is not a device-visible field; including it
  would churn the derived RTDB config on every edit for data the device never
  receives.
- **Absent `definiteBreach` means DEFINITE.** Encoded once, in
  `isDefiniteBreach`. Never re-derive the default at a call site.
- **A rule is definite iff EVERY member sensor is definite.** All, not any: a
  `multi_sensor` condition is an AND, so the weakest member governs.
- **Every genuine unknown fails loud (definite):** unresolvable `rfId`, tamper
  cause (bare label, no rule), no covering rule, empty member list.
- **Severity vocabulary is fixed** by `functions/src/pushover.ts`:
  `"alarm"` → priority 2 (repeats), `"loud"` → priority 1 (Critical Alert,
  single shot), `"notice"` → priority -1 (silent).
- **Telegram wording does not change** in any tier. Telegram has no tiering,
  and divergent text would make the two channels disagree about one event.
- **i18n:** every new string goes in BOTH `web/src/i18n/en.ts` and `he.ts`,
  as FLAT DOTTED KEYS (`"cfg.sensors.definiteBreach"`). A locale-parity test
  in `src/i18n/translate.test.ts` fails on a mismatch.
- **Verification:** `cd functions && npx tsc --noEmit && npx vitest run` and
  `cd web && npm run lint && npm test && npm run build`.

## Testing reality in this codebase

`onAlarm` and `onSensorEvent` are thin trigger wrappers with **no unit
tests**, by deliberate convention: decision logic lives in pure helpers that
are tested separately, and the wrappers are covered by emulator smoke tests.
`onSnapshotUploaded` is the exception — it takes an injectable
`SnapshotUploadDeps` and has a real suite.

Therefore:
- Tasks 1 and 2 put ALL new decision logic in pure, fully-tested modules.
- Task 3 (`onAlarm`) and Task 4 (`onSensorEvent`) are wiring verified by
  `tsc` plus exact `grep` assertions. Do not invent new wrapper harnesses.
- Task 5 (`onSnapshotUploaded`) extends the existing injectable-deps suite.

## File Structure

| File | Responsibility |
|---|---|
| `functions/src/breachCertainty.ts` | All certainty logic, pure: the absent-means-definite default, the all-members rule, severity mapping. |
| `functions/src/onAlarm.ts` | Resolve the causing sensor/rule; pick the tier. |
| `functions/src/onSensorEvent.ts` | Write `rfId` into both `alarm_cause` writes. |
| `functions/src/onSnapshotUploaded.ts` | Escalate on breach; all-clear on safe. |
| `web/src/features/configure/SensorsTab.tsx` | The per-sensor checkbox. |

---

### Task 1: `breachCertainty.ts` — the certainty rules

**Files:**
- Create: `functions/src/breachCertainty.ts`
- Create: `functions/src/breachCertainty.test.ts`
- Modify: `functions/src/types.ts` (add `Sensor.definiteBreach?`)

**Interfaces:**
- Consumes: `Sensor` from `./types`.
- Produces:
  - `Sensor.definiteBreach?: boolean`
  - `function isDefiniteBreach(sensor: Pick<Sensor, "definiteBreach"> | null | undefined): boolean`
  - `function isRuleDefinite(members: (Pick<Sensor, "definiteBreach"> | null)[]): boolean`
  - `function alarmSeverity(definite: boolean): "alarm" | "loud"`
  - `function breachVerdictSeverity(definite: boolean): "alarm" | "loud"`

- [ ] **Step 1: Add the type field**

In `functions/src/types.ts`, inside `interface Sensor`, after
`batteryChangedAt?: Timestamp | null;`:

```typescript
  // Is a trigger from this sensor a confirmed break-in on its own?
  //
  // ABSENT MEANS TRUE. A door opening is definite; motion is not. The tier of
  // the alarm notification follows from it: definite -> Pushover priority 2
  // (repeats until acknowledged), non-definite -> priority 1 (audible through
  // a muted ringer, single shot) which the AI judge can escalate to priority
  // 2 on a breach verdict.
  //
  // Absent defaults to definite so a newly paired sensor wakes the owner,
  // matching the fail-loud stance elsewhere (a missing judge key yields a
  // NullJudge that fails to "breach").
  //
  // NOT a device-visible field: the device never learns about certainty, and
  // it is deliberately excluded from sensorConfigChanged's guard.
  definiteBreach?: boolean;
```

- [ ] **Step 2: Write the failing test**

Create `functions/src/breachCertainty.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  isDefiniteBreach,
  isRuleDefinite,
  alarmSeverity,
  breachVerdictSeverity,
} from "./breachCertainty";

const definite = { definiteBreach: true };
const nonDefinite = { definiteBreach: false };
const unset = {};

describe("isDefiniteBreach", () => {
  // The fail-loud default: an unconfigured sensor wakes the owner.
  it("treats an absent flag as definite", () => {
    expect(isDefiniteBreach(unset)).toBe(true);
  });

  it("honours an explicit true", () => {
    expect(isDefiniteBreach(definite)).toBe(true);
  });

  // The ONLY route to the quieter tier.
  it("honours an explicit false", () => {
    expect(isDefiniteBreach(nonDefinite)).toBe(false);
  });

  // A cause that resolved to no sensor at all (deleted, never paired) is an
  // unknown, and unknowns fail loud.
  it("treats null as definite", () => {
    expect(isDefiniteBreach(null)).toBe(true);
  });

  it("treats undefined as definite", () => {
    expect(isDefiniteBreach(undefined)).toBe(true);
  });
});

describe("isRuleDefinite", () => {
  it("is definite when every member is definite", () => {
    expect(isRuleDefinite([definite, definite])).toBe(true);
  });

  // THE assertion that pins the corrected decision. An earlier design
  // defaulted multi-sensor rules to definite on "several conditions at once
  // is stronger evidence" grounds. That is backwards: such a rule exists
  // precisely BECAUSE its members are individually inconclusive, and the
  // condition is an AND, so the weakest member governs.
  it("is NOT definite when any single member is non-definite", () => {
    expect(isRuleDefinite([definite, definite, nonDefinite])).toBe(false);
  });

  it("is not definite when every member is non-definite", () => {
    expect(isRuleDefinite([nonDefinite, nonDefinite])).toBe(false);
  });

  it("takes a single member's certainty verbatim", () => {
    expect(isRuleDefinite([definite])).toBe(true);
    expect(isRuleDefinite([nonDefinite])).toBe(false);
  });

  // An unset member still counts as definite, so a rule mixing one unset
  // sensor with definite ones stays definite.
  it("treats an unset member as definite", () => {
    expect(isRuleDefinite([definite, unset])).toBe(true);
  });

  // No resolvable members is an unknown, not a quiet case.
  it("is definite for an empty member list", () => {
    expect(isRuleDefinite([])).toBe(true);
  });

  it("treats a null member as definite", () => {
    expect(isRuleDefinite([nonDefinite, null])).toBe(false);
    expect(isRuleDefinite([null])).toBe(true);
  });
});

describe("alarmSeverity", () => {
  it("sends emergency for a definite breach", () => {
    expect(alarmSeverity(true)).toBe("alarm");
  });

  it("sends loud-but-not-emergency for a non-definite breach", () => {
    expect(alarmSeverity(false)).toBe("loud");
  });
});

describe("breachVerdictSeverity", () => {
  // The escalation: the priority-1 alarm already went out, and the breach
  // verdict is what raises it to a repeating emergency.
  it("escalates a non-definite sensor to emergency", () => {
    expect(breachVerdictSeverity(false)).toBe("alarm");
  });

  // A definite sensor ALREADY sent priority 2 from onAlarm. A second
  // emergency would mean two repeating alerts for one event.
  it("does not re-escalate a definite sensor", () => {
    expect(breachVerdictSeverity(true)).toBe("loud");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd functions && npx vitest run src/breachCertainty.test.ts`
Expected: FAIL — cannot resolve `./breachCertainty`.

- [ ] **Step 4: Write the implementation**

Create `functions/src/breachCertainty.ts`:

```typescript
// Per-sensor breach certainty: does a trigger from this sensor mean a
// confirmed break-in, or does it need camera confirmation?
//
// Pure and separate from onAlarm.ts so the whole matrix is testable without
// the Functions emulator — the same split as alarmLogic.ts / onAlarm.ts and
// deviceArmNotify.ts / onDeviceArmStateChange.ts.
//
// The tiers map onto pushover.ts's severities:
//   "alarm"  -> priority  2  Critical Alert, repeats until acknowledged
//   "loud"   -> priority  1  Critical Alert, single shot
//   "notice" -> priority -1  silent

import { Sensor } from "./types";

/** Just the field these helpers read, so callers may pass a partial sensor. */
type Certainty = Pick<Sensor, "definiteBreach">;

/**
 * Is this sensor's trigger a definite breach?
 *
 * ABSENT/NULL MEANS TRUE, and this is the single place that default lives.
 * Two distinct cases both land here and both fail loud:
 *   - a sensor nobody has configured yet
 *   - a cause that resolved to no sensor at all (deleted, never paired)
 */
export function isDefiniteBreach(
  sensor: Certainty | null | undefined
): boolean {
  return sensor?.definiteBreach !== false;
}

/**
 * Certainty for a whole rule, from its member sensors.
 *
 * EVERY member must be definite. All, not any: a multi_sensor condition is an
 * AND — it fires only when every member tripped — so the WEAKEST member
 * governs what the combination proves. A door sensor plus a motion sensor
 * firing together is still gated on the motion sensor being right.
 *
 * This is derived rather than defaulted on purpose. A multi-sensor rule
 * exists precisely BECAUSE its members are individually inconclusive: a
 * sensor that were a definite breach on its own would already fire via its
 * own `immediate` rule. Defaulting such a rule to definite (an earlier draft
 * of the design did) gets it exactly backwards.
 *
 * An EMPTY list means no member resolved, which is an unknown — so definite.
 */
export function isRuleDefinite(members: (Certainty | null)[]): boolean {
  if (members.length === 0) return true;
  return members.every((s) => isDefiniteBreach(s));
}

/** Tier for the notification sent when the siren fires. */
export function alarmSeverity(definite: boolean): "alarm" | "loud" {
  return definite ? "alarm" : "loud";
}

/**
 * Tier for the notification sent when the judge returns "breach".
 *
 * Non-definite: the alarm went out as priority 1, so THIS is the escalation
 * and the first emergency push for the event.
 *
 * Definite: onAlarm already sent priority 2, which is still repeating. A
 * second emergency would mean two repeating alerts for one event, so the
 * confirmation is downgraded to a single loud push.
 */
export function breachVerdictSeverity(definite: boolean): "alarm" | "loud" {
  return definite ? "loud" : "alarm";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd functions && npx vitest run src/breachCertainty.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Typecheck**

Run: `cd functions && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add functions/src/breachCertainty.ts functions/src/breachCertainty.test.ts \
        functions/src/types.ts
git commit -m "feat(functions): per-sensor breach certainty rules

Absent definiteBreach means DEFINITE, encoded in one place so the fail-loud
default cannot drift between readers.

A rule is definite iff EVERY member is definite -- all, not any, because a
multi_sensor condition is an AND and the weakest member governs what the
combination proves."
```

---

### Task 2: Resolve the causing sensor's certainty

A separate task from Task 1 because this is the lookup — mapping an
`alarm_cause` onto the sensor or rule members whose certainty decides the
tier. A reviewer could accept Task 1's rules while rejecting this resolution.

**Files:**
- Modify: `functions/src/breachCertainty.ts`
- Modify: `functions/src/breachCertainty.test.ts`

**Interfaces:**
- Consumes: `isDefiniteBreach`, `isRuleDefinite` (Task 1); `AlarmCause` from
  `./alarmCause`; `Rule`, `Sensor` from `./types`.
- Produces:
  - `function resolveCauseCertainty(cause: AlarmCause | null, rules: Rule[], sensorsById: Record<string, Certainty>, sensorIdsByRfId: Record<string, string>): boolean`

- [ ] **Step 1: Write the failing test**

Append to `functions/src/breachCertainty.test.ts`:

```typescript
import { resolveCauseCertainty } from "./breachCertainty";
import type { Rule } from "./types";

describe("resolveCauseCertainty", () => {
  // Mirrors onAlarm's two lookup maps.
  const sensorsById = {
    doorId: { definiteBreach: true },
    motionId: { definiteBreach: false },
    unsetId: {},
  };
  const sensorIdsByRfId = {
    "0x2E5B7": "doorId",
    "0x0061D": "motionId",
    "0xAAAAA": "unsetId",
  };
  const rule = (id: string, sensors: string[]): Rule =>
    ({ id, name: id, sensors, condition: { type: "immediate" } }) as Rule;

  it("is definite for a definite single sensor", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x2E5B7", at: 1 },
        [rule("r1", ["doorId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  it("is non-definite for a non-definite single sensor", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x0061D", at: 1 },
        [rule("r1", ["motionId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });

  // The corrected multi-sensor decision, end to end through the lookup.
  it("is non-definite when the covering rule has one non-definite member", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x2E5B7", at: 1 },
        [rule("r1", ["doorId", "motionId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });

  it("is definite when every member of the covering rule is definite", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x2E5B7", at: 1 },
        [rule("r1", ["doorId", "unsetId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  // No rule covers it, so fall back to the sensor's own certainty rather
  // than failing loud: the sensor IS resolvable, so this is not an unknown.
  it("falls back to the sensor's own flag when no rule covers it", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x0061D", at: 1 },
        [],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });

  // --- unknowns, all fail loud ---

  it("is definite for a null cause", () => {
    expect(resolveCauseCertainty(null, [], sensorsById, sensorIdsByRfId)).toBe(true);
  });

  // A tamper cause, and every pre-fix server write: label only, no rfId.
  it("is definite for a cause carrying only a label", () => {
    expect(
      resolveCauseCertainty(
        { label: "Front door tampered", at: 1 },
        [],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  it("is definite for an rfId matching no sensor", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0xDEAD0", at: 1 },
        [],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  // A label AND an rfId is what the server writes after this change. The
  // rfId must win for certainty, even though resolveCauseLabel prefers the
  // label for DISPLAY.
  it("uses the rfId for certainty even when a label is also present", () => {
    expect(
      resolveCauseCertainty(
        { label: "Night motion", rfId: "0x0061D", at: 1 },
        [rule("r1", ["motionId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd functions && npx vitest run src/breachCertainty.test.ts`
Expected: FAIL — `resolveCauseCertainty` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `functions/src/breachCertainty.ts`:

```typescript
import { AlarmCause } from "./alarmCause";
import { Rule } from "./types";

/**
 * Which tier an alarm_cause deserves.
 *
 * Deliberately keyed on the cause's rfId, NOT its label — even though
 * resolveCauseLabel prefers the label for display. A label is free text
 * naming a rule; only the rfId identifies a sensor whose certainty can be
 * read. (This is why onSensorEvent now writes both.)
 *
 * When the sensor resolves AND a rule covers it, the RULE's members decide:
 * a multi_sensor rule is an AND, so one non-definite member makes the whole
 * combination non-definite. With no covering rule, the sensor's own flag is
 * used — it resolved, so this is not an unknown.
 *
 * Every genuine unknown returns true (definite, fail loud): no cause, a
 * label-only cause (tamper, or any pre-fix server write), or an rfId that
 * matches no sensor.
 */
export function resolveCauseCertainty(
  cause: AlarmCause | null,
  rules: Rule[],
  sensorsById: Record<string, Certainty>,
  sensorIdsByRfId: Record<string, string>
): boolean {
  const rfId = cause?.rfId?.trim();
  if (!rfId) return true;

  const sensorId = sensorIdsByRfId[rfId];
  if (!sensorId) return true;

  const rule = rules.find((r) => r.sensors.includes(sensorId));
  if (rule) {
    return isRuleDefinite(rule.sensors.map((id) => sensorsById[id] ?? null));
  }

  return isDefiniteBreach(sensorsById[sensorId] ?? null);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx vitest run src/breachCertainty.test.ts`
Expected: PASS, 27 tests.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; every suite passes.

- [ ] **Step 6: Commit**

```bash
git add functions/src/breachCertainty.ts functions/src/breachCertainty.test.ts
git commit -m "feat(functions): resolve an alarm cause to a certainty tier

Keyed on the cause's rfId, not its label: a label is free text naming a
rule, and only the rfId identifies a sensor whose flag can be read.

A covering rule's members decide when one exists, so a multi_sensor rule
with any non-definite member is non-definite. Unknowns -- no cause,
label-only (tamper), or an unmatched rfId -- all fail loud."
```

---

### Task 3: `onSensorEvent` records the rfId on server-written causes

**This is load-bearing for the whole feature and has a side effect.** A
server-written `alarm_cause` carries only a label today, so `onAlarm` cannot
identify the sensor, and `onSnapshotUploaded`'s armed gate
(`causeFamily === family`) can never match — meaning **the judge currently
never runs on a server-evaluated alarm at all.** Adding `rfId` fixes the
certainty lookup AND enables judging on that path.

**Files:**
- Modify: `functions/src/onSensorEvent.ts` (the two `alarm_cause` writes)
- Modify: `functions/src/alarmCause.ts` (comment only)

**Interfaces:**
- Consumes: nothing new.
- Produces: a server-written cause of shape `{ label, rfId, at }`.

- [ ] **Step 1: Add rfId to the tamper cause**

In `functions/src/onSensorEvent.ts`, find the tamper write (near line 183):

```typescript
      await rtdb
        .ref(`${projectId}/state/alarm_cause`)
        .set({ label: `${sensor.name} tampered`, at: Date.now() });
```

Replace with:

```typescript
      await rtdb.ref(`${projectId}/state/alarm_cause`).set({
        label: `${sensor.name} tampered`,
        // rfId alongside the label so onAlarm can resolve the sensor's breach
        // certainty, and so onSnapshotUploaded's armed gate (which compares
        // the cause's family to the snapshot's) can match at all. The label
        // still wins for DISPLAY — see resolveCauseLabel.
        rfId: sensor.rfId,
        at: Date.now(),
      });
```

- [ ] **Step 2: Add rfId to the rule-triggered cause**

Find the rule write (near line 272):

```typescript
      await rtdb
        .ref(`${projectId}/state/alarm_cause`)
        .set({ label, at: Date.now() });
```

Replace with:

```typescript
      await rtdb
        .ref(`${projectId}/state/alarm_cause`)
        .set({ label, rfId: sensor.rfId, at: Date.now() });
```

- [ ] **Step 3: Record the shape change in `alarmCause.ts`**

The module doc comment currently says the server writes a label and the
device writes an rfId. Update that header:

```typescript
/**
 * Pure helpers for the alarm "cause" written to /{projectId}/state/alarm_cause
 * just before state/siren_active flips true.
 *
 * Two writers, deliberately different shapes:
 *  - the server (onSensorEvent) knows the rule, so it writes a ready `label`
 *    AND the `rfId` that fired. The rfId was added for per-sensor breach
 *    certainty (onAlarm reads the sensor's definiteBreach from it) and it
 *    also unblocked onSnapshotUploaded's armed gate, which compares the
 *    cause's family to the snapshot's and could never match a label-only
 *    cause — so the judge never ran on server-evaluated alarms before.
 *  - the device knows only the rfId that fired (it has no rule or sensor
 *    *names*), so it writes `rfId` and leaves the naming to onAlarm
 *
 * `label` still wins for DISPLAY when both are present; the rfId is for
 * identifying the sensor, not naming it.
 *
 * onAlarm is the single alarm notifier and normalises both into one message.
 */
```

No code change in this file: `AlarmCause` already declares both fields
optional and `parseCause` keeps whichever are present.

- [ ] **Step 4: Pin the both-fields behaviour**

Append to `functions/src/alarmCause.test.ts` (keep the file's import style):

```typescript
describe("a server cause carrying both label and rfId", () => {
  // onSensorEvent now writes both. Pinned so a future narrowing of
  // parseCause cannot silently drop the rfId and take the certainty lookup
  // with it.
  it("parseCause keeps both fields", () => {
    expect(parseCause({ label: "Night motion", rfId: "0x0061D", at: 5 })).toEqual({
      label: "Night motion",
      rfId: "0x0061D",
      at: 5,
    });
  });

  // DISPLAY still prefers the label; only certainty uses the rfId.
  it("resolveCauseLabel still prefers the label", () => {
    expect(
      resolveCauseLabel(
        { label: "Night motion", rfId: "0x0061D", at: 5 },
        [],
        { "0x0061D": "Garden PIR" },
        { "0x0061D": "s1" }
      )
    ).toBe("Night motion");
  });
});
```

- [ ] **Step 5: Verify**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all suites pass including `alarmCause.test.ts`.

Run: `cd functions && grep -n "alarm_cause" src/onSensorEvent.ts`
Expected: two write sites, both now including `rfId`.

- [ ] **Step 6: Commit**

```bash
git add functions/src/onSensorEvent.ts functions/src/alarmCause.ts \
        functions/src/alarmCause.test.ts
git commit -m "feat(functions): record the rfId on server-written alarm causes

A server cause carried only a label, so onAlarm could not identify the
sensor whose breach certainty decides the notification tier.

Side effect, deliberate and worth knowing: onSnapshotUploaded's armed gate
compares the cause's FAMILY to the snapshot's, and a label-only cause has
none -- so the AI judge never ran on a server-evaluated alarm at all. It
now does, which is also what makes judge escalation reachable for a
non-definite sensor alarming via a server rule.

No type or parser change needed: AlarmCause already declares both fields
optional and parseCause keeps whichever are present."
```

---

### Task 4: `onAlarm` picks the tier

**Files:**
- Modify: `functions/src/onAlarm.ts`

**Interfaces:**
- Consumes: `resolveCauseCertainty`, `alarmSeverity` (Tasks 1-2).
- Produces: nothing new.

- [ ] **Step 1: Restructure `resolveLabel` to also return the certainty**

`resolveLabel` already loads every sensor and every rule, then throws the
objects away. It must now return both the label and the tier. Rename it and
widen the return.

Replace the whole `resolveLabel` function with:

```typescript
/**
 * Read the recorded cause and resolve BOTH what to call it and how loudly to
 * notify.
 *
 * One function because the two need the same two lookups (every sensor, and
 * the rules of the device-active profile), and doing them twice would double
 * the Firestore reads on the alarm path.
 *
 * `label` is null when the cause names nothing — the caller then sends its
 * generic message. `definite` defaults to TRUE on every unknown, so a cause
 * we cannot resolve still wakes the owner.
 */
async function resolveCause(
  projectId: string
): Promise<{ label: string | null; definite: boolean }> {
  const causeSnap = await rtdb.ref(`${projectId}/state/alarm_cause`).get();
  const cause = parseCause(causeSnap.val());
  if (!cause || !isCauseFresh(cause, Date.now())) {
    // No usable cause: generic message, and fail loud.
    return { label: null, definite: true };
  }

  // Indexed under BOTH the full rfId and the 20-bit family, because the
  // device's TriggerCause carries whatever identity its config used: a
  // pre-family firmware sends the full 24-bit rfId, the new one sends the
  // family. Keying on only one of them would leave every device-side alarm
  // unnamed for the other — during the rollout, and permanently if a device
  // is ever rolled back. Both keys point at the same sensor, so a cause is
  // resolvable either way.
  const sensorsSnap = await db.collection(`projects/${projectId}/sensors`).get();
  const sensorNamesByRfId: Record<string, string> = {};
  const sensorIdsByRfId: Record<string, string> = {};
  const sensorsById: Record<string, Pick<Sensor, "definiteBreach">> = {};
  for (const doc of sensorsSnap.docs) {
    const sensor = { id: doc.id, ...doc.data() } as Sensor;
    sensorsById[sensor.id] = sensor;
    for (const key of [sensor.rfId, sensorFamilyId(sensor)]) {
      if (!key) continue;
      sensorNamesByRfId[key] = sensor.name;
      sensorIdsByRfId[key] = sensor.id;
    }
  }

  // Rules come from the profile the DEVICE is running, which is the one that
  // evaluated this alarm — not the server's active profile.
  let rules: Rule[] = [];
  const profileSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .where("isActiveOnDevice", "==", true)
    .limit(1)
    .get();
  if (!profileSnap.empty) {
    const rulesSnap = await db
      .collection(`projects/${projectId}/profiles/${profileSnap.docs[0].id}/rules`)
      .get();
    rules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Rule));
  }

  return {
    label: resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId),
    definite: resolveCauseCertainty(cause, rules, sensorsById, sensorIdsByRfId),
  };
}
```

- [ ] **Step 2: Update the call site and the notify call**

Find:

```typescript
    const label = await resolveLabel(projectId);
```

Replace with:

```typescript
    const { label, definite } = await resolveCause(projectId);
```

Then find the notify call and replace it with:

```typescript
    await notify(projectId, project, {
      text: label ? formatAlarm(label) : "🚨 Alarm triggered!",
      // A definite sensor sends priority 2, which repeats until acknowledged.
      // A non-definite one sends priority 1 — audible through a muted ringer
      // but single-shot — which the AI judge escalates to priority 2 if it
      // confirms a breach. The Telegram text is identical either way: that
      // channel has no tiering, and divergent wording would make the two
      // channels disagree about one event.
      severity: alarmSeverity(definite),
      title: definite ? "Alarm" : "Alarm (unconfirmed)",
      link: true, // tapping opens the PWA on the events page
    });
```

- [ ] **Step 3: Fix the imports**

The file imports `Sensor` and `Rule` already; add the new helpers:

```typescript
import { alarmSeverity, resolveCauseCertainty } from "./breachCertainty";
```

Confirm `Sensor` and `Rule` are both in the existing `./types` import. If
either is missing, add it.

- [ ] **Step 4: Verify**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all suites pass.

Run: `cd functions && grep -n "resolveLabel\|severity:" src/onAlarm.ts`
Expected: NO `resolveLabel` (renamed), and `severity: alarmSeverity(definite)`.

- [ ] **Step 5: Commit**

```bash
git add functions/src/onAlarm.ts
git commit -m "feat(functions): onAlarm picks the tier from the sensor's certainty

resolveLabel becomes resolveCause and returns both the display label and
the certainty: the two need the same sensor and rule lookups, and doing
them twice would double the Firestore reads on the alarm path.

Definite -> priority 2 (repeats). Non-definite -> priority 1, audible
through mute but single-shot, which the judge can escalate."
```

---

### Task 5: `onSnapshotUploaded` escalates and all-clears

**Files:**
- Modify: `functions/src/onSnapshotUploaded.ts`
- Modify: `functions/src/onSnapshotUploaded.test.ts`

**Interfaces:**
- Consumes: `isDefiniteBreach`, `breachVerdictSeverity` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("handleSnapshotUpload", ...)` block in
`functions/src/onSnapshotUploaded.test.ts`:

```typescript
  // --- breach escalation by sensor certainty ---

  it("escalates a NON-definite sensor's breach to emergency", async () => {
    const stubJudge = {
      judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "person" })),
    };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", telegramBotToken: "tok", telegramChatId: "c" },
      sensors: {
        s1: {
          rfId: RF_ID,
          familyId: "0x0061D",
          name: "Garden PIR",
          definiteBreach: false,
        },
      },
      rtdbSeed: { [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS } },
    });

    await handleSnapshotUpload(deps, objectName(2));

    const [, , msg] = vi.mocked(deps.notify).mock.calls[0];
    // The alarm went out as priority 1; THIS is the first emergency push.
    expect(msg.severity).toBe("alarm");
  });

  it("does not re-escalate a DEFINITE sensor's breach", async () => {
    const stubJudge = {
      judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "person" })),
    };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", telegramBotToken: "tok", telegramChatId: "c" },
      sensors: {
        s1: {
          rfId: RF_ID,
          familyId: "0x0061D",
          name: "Front door",
          definiteBreach: true,
        },
      },
      rtdbSeed: { [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS } },
    });

    await handleSnapshotUpload(deps, objectName(2));

    const [, , msg] = vi.mocked(deps.notify).mock.calls[0];
    // onAlarm already sent priority 2 and it is still repeating. A second
    // emergency would be two repeating alerts for one event.
    expect(msg.severity).toBe("loud");
    // The photo still goes out either way.
    expect(sendTelegramPhoto).toHaveBeenCalledTimes(1);
  });

  // --- safe verdict: quiet all-clear ---

  it("sends a silent all-clear on a safe verdict", async () => {
    const stubJudge = {
      judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty frame" })),
    };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps, rtdb } = makeDeps({
      project: { nvrMode: "capture+judge" },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Garden PIR" } },
      rtdbSeed: { [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS } },
    });

    await handleSnapshotUpload(deps, objectName(2));

    const [, , msg] = vi.mocked(deps.notify).mock.calls[0];
    expect(msg.severity).toBe("notice"); // priority -1: explains, never wakes
    expect(msg.text).toContain("Cleared");
    // The existing advisory behaviour is unchanged.
    expect(rtdb._store.get(`${PROJECT_ID}/commands/fp`)).toBeDefined();
  });

  // An all-clear must never contradict a standing alarm.
  //
  // The sibling breach is seeded by RUNNING THE HANDLER TWICE with different
  // judges — the pattern the existing "all-channels coordination" describe
  // block uses (see the test at ~line 465). Writing the snapshotJudging doc
  // directly would couple this test to the fake's internals and would not
  // exercise the real coordination write.
  it("sends NO all-clear when a sibling channel already saw a breach", async () => {
    const breachJudge = {
      judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "intruder" })),
    };
    const safeJudge = {
      judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty" })),
    };

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", telegramBotToken: "tok", telegramChatId: "c" },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Garden PIR" } },
      rtdbSeed: { [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS } },
    });

    vi.mocked(judgeFor).mockReturnValueOnce(breachJudge);
    await handleSnapshotUpload(deps, objectName(1));
    const callsAfterBreach = vi.mocked(deps.notify).mock.calls.length;

    vi.mocked(judgeFor).mockReturnValueOnce(safeJudge);
    await handleSnapshotUpload(deps, objectName(2));

    // The breach notified; the later safe channel must add nothing, because
    // an "all clear" would contradict the alarm still standing.
    expect(vi.mocked(deps.notify).mock.calls.length).toBe(callsAfterBreach);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd functions && npx vitest run src/onSnapshotUploaded.test.ts`
Expected: FAIL — severities are still hardcoded; no all-clear is sent.

- [ ] **Step 3: Make the breach severity conditional**

In `functions/src/onSnapshotUploaded.ts`, the breach branch currently sends
`severity: "alarm"` unconditionally. Replace the `deps.notify` call inside
`if (verdict === "breach") { ... }` with:

```typescript
    // A definite sensor's alarm ALREADY went out as priority 2 and is still
    // repeating; a second emergency would be two repeating alerts for one
    // event. A non-definite sensor's alarm went out as priority 1, so this
    // verdict is the escalation and the first emergency push.
    await deps.notify(projectId, project, {
      text: caption,
      severity: breachVerdictSeverity(isDefiniteBreach(sensor)),
      title: "Confirmed breach",
      link: true, // the snapshots this breach was judged on are on that page
    });
```

- [ ] **Step 4: Add the all-clear to the safe branch**

At the very end of the function — after the `commands/fp` write and the
`false positive (AI)` timeline update, which must both stay first so a
notification failure cannot cost the advisory — add:

```typescript
  // A quiet all-clear, so a glance at the phone explains the earlier alert.
  // severity "notice" is Pushover priority -1: delivered silently, never
  // waking anyone. Sent regardless of the sensor's certainty — a cleared
  // trigger is worth explaining either way.
  //
  // Deliberately NOT on the alreadyHasBreach path above, which returns
  // early: that branch withholds the advisory precisely because a sibling
  // channel saw a breach, and an "all clear" would contradict a standing
  // alarm.
  await deps.notify(projectId, project, {
    text: `✓ Cleared — ${sensorName}, ${cameraName ?? `camera ${channel}`} — ${reason}`,
    severity: "notice",
  });
```

- [ ] **Step 5: Add the imports**

```typescript
import { breachVerdictSeverity, isDefiniteBreach } from "./breachCertainty";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd functions && npx vitest run src/onSnapshotUploaded.test.ts`
Expected: PASS. The suite has **19 tests before this task** (verified by
running it); these 4 bring it to **23**. If the count differs, reconcile
before continuing rather than assuming the delta is benign.

- [ ] **Step 7: Full verification**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; every suite passes.

- [ ] **Step 8: Commit**

```bash
git add functions/src/onSnapshotUploaded.ts functions/src/onSnapshotUploaded.test.ts
git commit -m "feat(functions): judge escalates a non-definite breach, all-clears a safe one

A breach verdict on a non-definite sensor is now the escalation to
priority 2 -- the first emergency push for that event. On a DEFINITE
sensor it stays priority 1, because onAlarm already sent a repeating
emergency and two would be worse than one.

A safe verdict adds a silent priority -1 all-clear, so a glance at the
phone explains the earlier alert. Not sent on the alreadyHasBreach path,
where it would contradict a standing alarm."
```

---

### Task 6: The per-sensor checkbox in the web UI

**Files:**
- Modify: `web/src/types/index.ts`
- Modify: `web/src/features/configure/SensorsTab.tsx`
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/he.ts`

**Interfaces:**
- Consumes: the `Sensor` shape (mirrored, not imported — the web app keeps
  its own copy).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Mirror the type field**

In `web/src/types/index.ts`, inside `interface Sensor`:

```typescript
  // Is a trigger from this sensor a confirmed break-in on its own?
  // ABSENT MEANS TRUE — see functions/src/breachCertainty.ts, which owns
  // this default. Definite sends a repeating emergency push; non-definite
  // sends a loud single-shot push the AI judge can escalate.
  definiteBreach?: boolean;
```

- [ ] **Step 2: Add the i18n strings to BOTH locales**

These files use FLAT DOTTED KEYS. In `web/src/i18n/en.ts`, beside the other
`cfg.sensors.*` keys:

```typescript
  "cfg.sensors.definiteBreach": "Definite breach",
  "cfg.sensors.definiteBreachHelp":
    "An alarm from this sensor is a confirmed break-in: sends an emergency notification that repeats until acknowledged. Leave unticked for sensors that need camera confirmation, such as motion — those send a loud single alert, which the AI judge upgrades to an emergency if it sees a person.",
```

In `web/src/i18n/he.ts`, the identical keys:

```typescript
  "cfg.sensors.definiteBreach": "פריצה ודאית",
  "cfg.sensors.definiteBreachHelp":
    "אזעקה מהחיישן הזה היא פריצה מאומתת: נשלחת התראת חירום שחוזרת עד לאישור. אין לסמן עבור חיישנים שדורשים אימות במצלמה, כמו גלאי תנועה — אלה שולחים התראה רועשת אחת, שהשופט האוטומטי משדרג לחירום אם מזוהה אדם.",
```

Verify parity: `cd web && grep -c '"cfg.sensors\.' src/i18n/en.ts src/i18n/he.ts`
(the two counts must match).

- [ ] **Step 3: Add the update handler**

In `SensorsTab.tsx`, beside `handleCamerasChange` (near line 350), add:

```typescript
  /** Persist a sensor's breach certainty. Written explicitly as a boolean —
   *  never omitted — because ABSENT means definite, so clearing the box has
   *  to store `false` rather than delete the field. */
  const handleDefiniteBreachChange = async (sensor: Sensor, definite: boolean) => {
    if (!projectId) return;
    await updateDoc(sensorDoc(projectId, sensor.id), { definiteBreach: definite });
    setSensors((prev) =>
      prev.map((s) => (s.id === sensor.id ? { ...s, definiteBreach: definite } : s))
    );
  };
```

- [ ] **Step 4: Add the checkbox to the expanded row**

In the `<td>` that holds the camera `MultiSelect` (near line 633), after the
`<p className="muted">{t("cfg.sensors.camerasHelp")}</p>` line, add:

```tsx
                        <label className="check">
                          <input
                            type="checkbox"
                            // Absent means definite, so an unconfigured
                            // sensor shows as ticked — matching what it
                            // actually does.
                            checked={s.definiteBreach !== false}
                            onChange={(e) =>
                              void handleDefiniteBreachChange(s, e.target.checked)
                            }
                          />
                          <span>{t("cfg.sensors.definiteBreach")}</span>
                        </label>
                        <p className="muted">
                          {t("cfg.sensors.definiteBreachHelp")}
                        </p>
```

Follow the surrounding markup conventions; if this file renders help text
differently from `<p className="muted">`, match what it already does.

- [ ] **Step 5: Verify**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: lint clean, all tests pass (including the i18n parity test), build
succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/index.ts web/src/features/configure/SensorsTab.tsx \
        web/src/i18n/en.ts web/src/i18n/he.ts
git commit -m "feat(web): per-sensor Definite breach checkbox

Ticked (and the default for an unconfigured sensor, since absent means
definite) sends a repeating emergency push on alarm. Unticked sends a loud
single alert the AI judge can escalate.

Writes an explicit boolean rather than omitting the field: absent means
definite, so clearing the box must store false."
```

---

### Task 7: Documentation and deployment

**Files:**
- Modify: `CLAUDE.md`
- Modify: `functions/src/sensorConfigChanged.ts` (comment only)

**Interfaces:**
- Consumes: everything above.
- Produces: a deployed, documented feature.

- [ ] **Step 1: Record why `definiteBreach` is excluded from the guard**

A future reader will reasonably wonder why a sensor field does not rebuild
the device config. In `functions/src/sensorConfigChanged.ts`, extend the
`SensorConfigFields` doc comment:

```typescript
/** The only sensor fields that reach the device, via buildRtdbConfig.
 *
 *  Deliberately absent: `name`, the various *AlertSentAt markers,
 *  `batteryChangedAt`, and `definiteBreach`. The last is a NOTIFICATION
 *  concern resolved entirely cloud-side in onAlarm — the device never learns
 *  about breach certainty — so including it here would rebuild the derived
 *  RTDB config on every edit for data no device reads. Same reasoning as
 *  cameraNames. */
```

- [ ] **Step 2: Document the feature in `CLAUDE.md`**

Add a status section in the established style, and update the Pushover
section's severity table to note that `alarm` is no longer unconditional:

```markdown
**Per-sensor breach certainty (2026-10-04) — built, NOT hardware-tested.**
`Sensor.definiteBreach?: boolean` picks the alarm notification tier.
**Absent means DEFINITE** — a newly paired sensor wakes you, matching the
fail-loud stance elsewhere. The default lives in exactly one place,
`functions/src/breachCertainty.ts`.

| Sensor | Alarm fires | Judge: breach | Judge: safe | No verdict |
|---|---|---|---|---|
| Definite | **P2** repeats | P1 + photo | P-1 all-clear + `fp` | — |
| Non-definite | **P1** single | **P2** repeats (escalation) | P-1 all-clear + `fp` | stays P1 |

A definite sensor's breach confirmation is deliberately P1, not P2: `onAlarm`
already sent a repeating emergency, and two for one event is worse than one.

**A rule is definite iff EVERY member sensor is definite.** All, not any: a
`multi_sensor` condition is an AND, so the weakest member governs what the
combination proves. Derived, not defaulted — such a rule exists precisely
BECAUSE its members are individually inconclusive (a definite sensor would
already fire via its own `immediate` rule). Every genuine unknown
(unresolvable `rfId`, tamper's bare label, no covering rule) fails loud.

⚠️ **NVR health is now load-bearing for night alerting.** A non-definite
alarm with no judge verdict — NVR down, `nvrMode` not `capture+judge`, or no
cameras ticked for that sensor — **stays at P1 forever**. There is no
timeout escalation, by choice, to avoid crying wolf. The siren is the only
backstop, and a sensor deliberately marked non-definite is therefore less
likely to wake you than one nobody configured.

Server-written `alarm_cause` now carries `rfId` alongside `label` (the label
still wins for display). That was required for the certainty lookup and had
a **side effect worth knowing: the AI judge never ran on server-evaluated
alarms before**, because `onSnapshotUploaded`'s armed gate compares the
cause's family to the snapshot's and a label-only cause has none. It now
runs there — which is also what makes escalation reachable for a
non-definite sensor alarming via a server rule.

`definiteBreach` is **not** a device-visible field and is deliberately
excluded from `sensorConfigChanged`'s guard, like `cameraNames`. No firmware
change, no EEPROM magic bump.
```

- [ ] **Step 3: Full verification before deploying**

Run: `cd functions && npx tsc --noEmit && npx vitest run && npm run build`
Run: `cd web && npm run lint && npm test && npm run build`
Expected: everything clean. **Do not deploy if anything fails** — report the
output instead.

- [ ] **Step 4: Commit the docs**

```bash
git add CLAUDE.md functions/src/sensorConfigChanged.ts
git commit -m "docs: per-sensor breach certainty

Records the NVR blind spot explicitly: a non-definite alarm with no judge
verdict stays at priority 1 forever, by choice, with the siren as the only
backstop."
```

- [ ] **Step 5: Deploy**

No rules change in this feature, so functions and hosting only:

```bash
cd functions && npm run build && cd ..
npx firebase deploy --only functions
cd web && npm run build && cd ..
npx firebase deploy --only hosting
```

- [ ] **Step 6: Configure and verify end to end**

1. In the Sensors tab, **untick "Definite breach" on a motion sensor** and
   leave it ticked on a door sensor.
2. Confirm the motion sensor has cameras ticked, and `nvrMode` is
   `capture+judge` — without both, it can never escalate.
3. With the phone **muted** and the system armed, trigger the **door**
   sensor. Expect a **repeating** emergency push.
4. Trigger the **motion** sensor with nobody in frame. Expect a single loud
   push, then a **silent** all-clear once the judge clears it.
5. Trigger the **motion** sensor with a person in frame. Expect a single loud
   push, then a **repeating** emergency once the judge confirms the breach.

Step 5 is the whole point of the feature; nothing in the unit suite can
establish it.

- [ ] **Step 7: Record the verified result**

Replace "**NOT hardware-tested**" in the `CLAUDE.md` section with what was
actually observed, then commit.

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| Data: `Sensor.definiteBreach` | 1, 6 |
| `isDefiniteBreach` default in one place | 1 |
| Multi-sensor: all members must be definite | 1, 2 |
| Genuinely unresolvable causes fail loud | 2 |
| The `alarm_cause` rfId blocker | 3 |
| Side effect: judge now runs on server alarms | 3 |
| `onAlarm` picks the tier | 4 |
| No extra Firestore reads | 4 (one `resolveCause`, same two lookups) |
| Judge escalates on breach | 5 |
| No double-emergency for a definite sensor | 1 (`breachVerdictSeverity`), 5 |
| `safe` → quiet all-clear | 5 |
| Not on the `alreadyHasBreach` path | 5 |
| Web checkbox + i18n | 6 |
| Excluded from `sensorConfigChanged` | 7 |
| Decision 1's cost (NVR blind spot) | 7 (documented) |
| Resulting matrix | 7 |

**Placeholder scan:** none. Every code step carries real code. One step
(Task 6 step 4) says "match what the file already does" for help-text
markup — paired with the exact line to insert after and a lint/test gate.

**Type consistency:** `Certainty` is defined once in `breachCertainty.ts`
(Task 1) and reused by `resolveCauseCertainty` (Task 2). `definiteBreach` is
spelled identically in `functions/src/types.ts`, `web/src/types/index.ts`,
the Firestore write, and the checkbox. `breachVerdictSeverity` is defined in
Task 1 and consumed in Task 5. `resolveCause` (Task 4) replaces
`resolveLabel` — no caller outside `onAlarm.ts`, verified by grep.

**Known gap, stated:** `onAlarm` and `onSensorEvent` have no unit tests, by
this codebase's convention. Tasks 3 and 4 are verified by `tsc`, grep
assertions, and Task 7's end-to-end check. All their decision logic lives in
`breachCertainty.ts`, which has 27 tests.
