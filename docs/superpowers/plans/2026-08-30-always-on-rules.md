# Always-On Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rule fire the alarm even when the system is disarmed, so a smoke detector works at 14:00 on a Tuesday with the house occupied.

**Architecture:** One optional boolean on `Rule` (`always`), mirrored to the RTDB wire format as `x: 1` and to the device's `Condition` struct as `bool always`. Evaluation changes in exactly two places — the device's single arm gate becomes a per-condition skip, and the server's `if (serverArmed)` block becomes a rule-gathering step. Because always-rules are collected from *every* profile (not just the active one), a smoke rule reaches the device whichever profile is armed.

**Tech Stack:** TypeScript (Cloud Functions gen-2, `europe-west1`), C++17 (ESP32-S3 / PlatformIO), React 18 + Vite, vitest, Unity (PlatformIO native).

**Spec:** `docs/superpowers/specs/2026-08-30-always-on-rules-design.md`

## Global Constraints

- **`always` implies a single-sensor `immediate` condition.** The editor coerces; the data model does not encode the restriction and the server does not re-validate it.
- **Absent means false.** Every existing rule doc lacks `always` and must keep its current behaviour. `undefined` reads as `false`, never tri-state.
- **`x` is omitted when false**, so the wire payload is byte-identical to today for projects with no always-rules. The device polls `/config` every 5s (`cloud_client.h:163`).
- **`sizeof(Config)` must stay 2416.** `Config` is persisted to EEPROM by `EepromStore`; a size change misreads stored config after upgrade. Measured before/after: `Condition` 34→34, `SensorConfig` 150→150, `Config` 2416→2416.
- **Always-rules respect `sirenEnabled` and `serverActions.triggerSiren`**, and Force Silence works on them. Only the *sounding* is gated — the alarm report is never suppressed.
- **No new dependencies.** `functions/` has two runtime deps; `web/` has four.
- **Types are mirrored by hand** between `functions/src/types.ts` and `web/src/types/index.ts`.
- **Every user-facing string goes through i18n** — both `web/src/i18n/en.ts` and `he.ts`. `he.ts` is typed `Record<TranslationKey, string>`, so a missing key fails the typecheck.
- Test commands: `cd functions && npm test`, `cd web && npm test`, `cd firmware/edge/device && pio test -e native`. Typecheck: `npm run lint`.
- **`functions/tsconfig.json` sets `noUnusedLocals`/`noUnusedParameters`** — unused imports fail the build.

## File Structure

**Modify:**
- `functions/src/types.ts` — `Rule.always?`, `RtdbCondition.x?`
- `functions/src/buildConfig.ts` — accept always-rules from all profiles, emit `x`
- `functions/src/buildConfig.test.ts` — new cases
- `functions/src/onProfileChange.ts:44-91` — gather always-rules across profiles
- `functions/src/scheduleRules.ts` — **new**, pure rule-gathering helper (name chosen to avoid colliding with the scheduling feature's `scheduleTick`; see Task 4)
- `functions/src/onSensorEvent.ts:91-157` — use the helper, evaluate when disarmed
- `firmware/edge/device/src/alarm_state.h` — `Condition::always`, `static_assert`
- `firmware/edge/device/src/alarm_state.cpp:96-116` — per-condition skip
- `firmware/edge/device/src/config_parser.cpp:41-45` — parse `x`
- `firmware/edge/device/test/test_alarm_state/test_alarm_state.cpp` — rename the disarmed test, add always cases
- `firmware/edge/device/test/test_config_parser/test_config_parser.cpp` — parse cases
- `web/src/types/index.ts` — mirror `Rule.always?`
- `web/src/features/configure/RuleEditor.tsx` — the checkbox and coercion
- `web/src/features/configure/ProfilesTab.tsx:539,602` — pass the new props, mark always-rules in the list
- `web/src/features/operations/OperationsPage.tsx` — note always-rules beside Disarmed
- `web/src/i18n/en.ts`, `he.ts` — new strings

**Task order:** types → server config path → server evaluation → firmware → web. Tasks 1–5 are independently testable without hardware; Task 6 needs `pio test -e native` (no board required); Tasks 7–8 are UI.

**Note on ordering with the scheduling feature:** scheduling is deployed but not yet verified end-to-end (the device was offline). Both features touch `onSensorEvent.ts` and `alarm_state.cpp`. Do not deploy this feature until scheduling's hardware verification passes, or a failure will be ambiguous between the two.

---

### Task 1: Add the `always` field to both type mirrors

**Files:**
- Modify: `functions/src/types.ts:29-34` (`Rule`), `:148-161` (`RtdbCondition`)
- Modify: `web/src/types/index.ts:113` (`Rule`)

**Interfaces:**
- Consumes: nothing
- Produces: `Rule.always?: boolean` and `RtdbCondition.x?: 1`, used by every later task.

- [ ] **Step 1: Add `always` to the functions `Rule`**

In `functions/src/types.ts`, the `Rule` interface becomes:

```ts
export interface Rule {
  id: string;
  name: string;
  sensors: string[];
  condition: Condition;
  // Fires even when disarmed (smoke, gas). Absent = false: every rule
  // predating this field must keep its armed-only behaviour.
  // The editor restricts this to single-sensor `immediate` rules; the
  // data model deliberately does not encode that restriction.
  always?: boolean;
}
```

- [ ] **Step 2: Add `x` to `RtdbCondition`**

In the same file, add to `RtdbCondition` (after `k`), and extend the field-key comment block above it:

```ts
  // x: always-on — 1 when the rule fires regardless of arm state. Omitted
  //    when false so the common payload is unchanged (polled every 5s).
  x?: 1;
```

- [ ] **Step 3: Mirror `always` into the web `Rule`**

In `web/src/types/index.ts`, add the identical `always?: boolean;` field with the same comment to the `Rule` interface. `RtdbCondition` is not mirrored on the web side — check with `grep -n "RtdbCondition" web/src/types/index.ts`; if it *is* present, add `x?: 1;` there too.

- [ ] **Step 4: Typecheck both packages**

Run: `cd functions && npm run lint && cd ../web && npm run lint`
Expected: both pass with no output.

- [ ] **Step 5: Commit**

```bash
git add functions/src/types.ts web/src/types/index.ts
git commit -m "Rule.always and the RtdbCondition x flag"
```

---

### Task 2: `buildConfig` emits `x` and accepts always-rules

**Files:**
- Modify: `functions/src/buildConfig.ts`
- Test: `functions/src/buildConfig.test.ts`

**Interfaces:**
- Consumes: `Rule.always`, `RtdbCondition.x` (Task 1).
- Produces: `buildRtdbConfig(rules, sensors, armed, sirenDurationSec, sirenEnabled?, alwaysRules?)` — Task 3 calls it with the sixth argument.

The new parameter is last and optional, so the existing four call sites in `buildConfig.test.ts` and the one in `onProfileChange.ts` keep compiling unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `functions/src/buildConfig.test.ts`:

```ts
describe("buildRtdbConfig — always-on rules", () => {
  it("omits x for an ordinary rule", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);
    expect(config.c).toEqual([[{ t: 0 }]]);
  });

  it("sets x:1 for an always rule", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        name: "Smoke",
        sensors: ["s1"],
        condition: { type: "immediate" },
        always: true,
      },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);
    expect(config.c).toEqual([[{ t: 0, x: 1 }]]);
  });

  it("includes an always rule from a non-active profile", () => {
    // The active profile covers s1; the always rule lives elsewhere and
    // covers s2. Without the second pass, s2 never reaches the device.
    const active: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const alwaysRules: Rule[] = [
      {
        id: "r9",
        name: "Smoke",
        sensors: ["s2"],
        condition: { type: "immediate" },
        always: true,
      },
    ];
    const config = buildRtdbConfig(active, sensors, true, 120, true, alwaysRules);
    expect(config.r).toEqual(["0xA1B2C3", "0xD4E5F6"]);
    expect(config.c).toEqual([[{ t: 0 }], [{ t: 0, x: 1 }]]);
  });

  it("does not duplicate an always rule that is also in the active profile", () => {
    const rule: Rule = {
      id: "r1",
      name: "Smoke",
      sensors: ["s1"],
      condition: { type: "immediate" },
      always: true,
    };
    // Same rule id arriving through both paths must appear once.
    const config = buildRtdbConfig([rule], sensors, true, 120, true, [rule]);
    expect(config.r).toEqual(["0xA1B2C3"]);
    expect(config.c).toEqual([[{ t: 0, x: 1 }]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd functions && npx vitest run src/buildConfig.test.ts`
Expected: FAIL — the `x:1` cases get `[{ t: 0 }]`, and the non-active-profile case gets only `0xA1B2C3`.

- [ ] **Step 3: Emit `x` from `toRtdbCondition`**

In `functions/src/buildConfig.ts`, `toRtdbCondition` currently takes `(condition, ruleSensorIds, rfIdOf, indexOfRfId)`. Add an `always` parameter and apply it to every return path:

```ts
function toRtdbCondition(
  condition: Condition,
  ruleSensorIds: string[],
  rfIdOf: (sensorId: string) => string | undefined,
  indexOfRfId: (rfId: string) => number,
  always = false
): RtdbCondition {
  const t = CONDITION_TYPE_CODE[condition.type];
  // Spread rather than assigning undefined: an explicit `x: undefined`
  // would survive JSON.stringify as a missing key but shows up in
  // toEqual comparisons, and RTDB rejects undefined values outright.
  const x = always ? ({ x: 1 } as const) : {};

  if (condition.type === "count_in_window") {
    return { t, n: condition.count, w: condition.window_sec, ...x };
  }
  if (condition.type === "entry_delay") {
    return { t, y: condition.delay_sec, ...x };
  }
  if (condition.type === "multi_sensor") {
    const k: Record<string, number> = {};
    for (const sensorId of ruleSensorIds) {
      const rfId = rfIdOf(sensorId);
      if (!rfId) continue;
      const idx = indexOfRfId(rfId);
      if (idx === -1) continue;
      k[String(idx)] = condition.counts?.[sensorId] ?? 1;
    }
    return { t, w: condition.window_sec, k, ...x };
  }
  // immediate
  return { t, ...x };
}
```

- [ ] **Step 4: Merge always-rules into both passes**

Still in `buildConfig.ts`, change the signature and build a merged list used by both passes:

```ts
export function buildRtdbConfig(
  rules: Rule[],
  sensors: Sensor[],
  armed: boolean,
  sirenDurationSec: number,
  sirenEnabled = true,
  alwaysRules: Rule[] = []
): RtdbConfig {
```

Immediately after the `sensorMap` / `rfIdOf` setup, insert:

```ts
  // Always-rules come from EVERY profile, not just the active one: a smoke
  // rule sitting in an inactive profile must still reach the device, or the
  // UI would show it enabled while nothing happens on hardware.
  // De-duplicated by id, because a rule in the active profile arrives twice.
  const seenRuleIds = new Set(rules.map((r) => r.id));
  const allRules = [...rules];
  for (const r of alwaysRules) {
    if (!seenRuleIds.has(r.id)) {
      seenRuleIds.add(r.id);
      allRules.push(r);
    }
  }
```

Then replace `rules` with `allRules` in **both** loops — the pass-1 loop that builds `r`, and the pass-2 loop that translates conditions. In pass 2, forward the flag:

```ts
  for (const rule of allRules) {
    const translated = toRtdbCondition(
      rule.condition,
      rule.sensors,
      rfIdOf,
      indexOfRfId,
      rule.always === true
    );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd functions && npx vitest run src/buildConfig.test.ts`
Expected: all PASS, including the 8 pre-existing cases — the payload for non-always rules must be unchanged.

- [ ] **Step 6: Commit**

```bash
git add functions/src/buildConfig.ts functions/src/buildConfig.test.ts
git commit -m "buildConfig: emit x for always rules, merge them from all profiles"
```

---

### Task 3: `onProfileChange` gathers always-rules from every profile

**Files:**
- Modify: `functions/src/onProfileChange.ts:44-91`

**Interfaces:**
- Consumes: `buildRtdbConfig(..., alwaysRules)` (Task 2).
- Produces: nothing new; the RTDB config now carries always-rules.

- [ ] **Step 1: Collect always-rules before building the config**

In `rebuildConfig`, the current code fetches the active profile's rules then calls `buildRtdbConfig`. Two changes.

First, the empty-profile early return must no longer bail unconditionally — a project with no active profile can still have always-rules. Replace the `if (profileSnap.empty) { ... return; }` block with a flag:

```ts
  const activeProfile = profileSnap.empty ? null : profileSnap.docs[0];
```

Then delete the old early return entirely and derive `rules` from `activeProfile`:

```ts
  let rules: Rule[] = [];
  if (activeProfile) {
    const rulesSnap = await db
      .collection(`projects/${projectId}/profiles/${activeProfile.id}/rules`)
      .get();
    rules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Rule));
  }
```

- [ ] **Step 2: Query always-rules across all profiles**

Immediately after, add:

```ts
  // Always-rules are collected from EVERY profile — see buildConfig. A
  // collection-group query would also match other projects' schedules, so
  // this walks the project's own profiles instead.
  const allProfilesSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .get();
  const alwaysRules: Rule[] = [];
  for (const prof of allProfilesSnap.docs) {
    const rs = await db
      .collection(`projects/${projectId}/profiles/${prof.id}/rules`)
      .where("always", "==", true)
      .get();
    for (const d of rs.docs) {
      alwaysRules.push({ id: d.id, ...d.data() } as Rule);
    }
  }
```

- [ ] **Step 3: Pass them to the builder and keep the empty case correct**

Replace the final `buildRtdbConfig` call and guard the no-config case:

```ts
  // Nothing to evaluate at all — write the thin shape. RTDB drops empty
  // arrays on .set(), so r/c are omitted deliberately; parseConfigJson
  // treats missing r/c as "zero sensors", not a parse failure.
  if (!activeProfile && alwaysRules.length === 0) {
    await rtdb.ref(`${projectId}/config`).set({ a: false, d: 120, e: true });
    return;
  }

  const config = buildRtdbConfig(
    rules,
    sensors,
    armed,
    sirenDurationSec,
    sirenEnabled,
    alwaysRules
  );
  await rtdb.ref(`${projectId}/config`).set(config);
```

Note the `sensors`, `armed`, `sirenDurationSec` and `sirenEnabled` lookups already exist below the old early return — make sure they now run before this block, moving them up if needed.

- [ ] **Step 4: Typecheck and run the suite**

Run: `cd functions && npm run lint && npm test`
Expected: no typecheck output; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add functions/src/onProfileChange.ts
git commit -m "onProfileChange: ship always rules from every profile"
```

---

### Task 4: Pure rule-gathering helper

**Files:**
- Create: `functions/src/alwaysRules.ts`
- Test: `functions/src/alwaysRules.test.ts`

**Interfaces:**
- Consumes: `Rule` (Task 1).
- Produces: `applicableRules(armed: boolean, activeProfileRules: Rule[], alwaysRules: Rule[]): Rule[]` — Task 5 calls it.

Extracting the decision keeps Task 5's Firestore code thin and makes the armed/disarmed matrix testable without an emulator.

- [ ] **Step 1: Write the failing tests**

Create `functions/src/alwaysRules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applicableRules } from "./alwaysRules";
import { Rule } from "./types";

const ordinary: Rule = {
  id: "r1",
  name: "Door",
  sensors: ["s1"],
  condition: { type: "immediate" },
};
const smoke: Rule = {
  id: "r9",
  name: "Smoke",
  sensors: ["s2"],
  condition: { type: "immediate" },
  always: true,
};

describe("applicableRules", () => {
  it("returns the active profile's rules plus always rules when armed", () => {
    expect(applicableRules(true, [ordinary], [smoke])).toEqual([ordinary, smoke]);
  });

  it("returns only always rules when disarmed", () => {
    expect(applicableRules(false, [ordinary], [smoke])).toEqual([smoke]);
  });

  it("returns nothing when disarmed with no always rules", () => {
    expect(applicableRules(false, [ordinary], [])).toEqual([]);
  });

  it("does not duplicate an always rule that is in the active profile", () => {
    expect(applicableRules(true, [ordinary, smoke], [smoke])).toEqual([
      ordinary,
      smoke,
    ]);
  });

  it("returns the active rules unchanged when there are no always rules", () => {
    expect(applicableRules(true, [ordinary], [])).toEqual([ordinary]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && npx vitest run src/alwaysRules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `functions/src/alwaysRules.ts`:

```ts
// Which rules apply to a sensor event, given arm state.
//
// Pure and separate from onSensorEvent so the armed/disarmed matrix is
// testable without emulating Firestore.

import { Rule } from "./types";

/**
 * Armed: the active profile's rules, plus always-rules from every profile.
 * Disarmed: always-rules only — that is the whole feature.
 *
 * De-duplicated by id, because an always-rule living in the active profile
 * arrives through both arguments.
 */
export function applicableRules(
  armed: boolean,
  activeProfileRules: Rule[],
  alwaysRules: Rule[]
): Rule[] {
  if (!armed) return alwaysRules;

  const seen = new Set(activeProfileRules.map((r) => r.id));
  const out = [...activeProfileRules];
  for (const r of alwaysRules) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd functions && npx vitest run src/alwaysRules.test.ts`
Expected: all 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/alwaysRules.ts functions/src/alwaysRules.test.ts
git commit -m "Pure applicableRules helper for the armed/disarmed matrix"
```

---

### Task 5: `onSensorEvent` evaluates always-rules when disarmed

**Files:**
- Modify: `functions/src/onSensorEvent.ts:91-157`

**Interfaces:**
- Consumes: `applicableRules` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Replace the arm gate with rule gathering**

The block currently opens `if (project.serverArmed) {` and nests the profile lookup, rule fetch, event fetch and evaluation inside. Restructure so the arm state selects rules rather than gating everything.

Replace from `// (e) Server-side alarm evaluation` down to the line fetching `rules` with:

```ts
    // (e) Server-side alarm evaluation.
    //
    // Disarmed no longer means "evaluate nothing": always-rules (smoke, gas)
    // fire regardless. Arm state now selects WHICH rules apply, and the
    // evaluation below is shared.
    const serverArmed = project.serverArmed === true;

    let activeProfileRules: Rule[] = [];
    if (serverArmed) {
      const profileSnap = await db
        .collection(`projects/${projectId}/profiles`)
        .where("isActiveOnServer", "==", true)
        .limit(1)
        .get();
      if (!profileSnap.empty) {
        const rulesSnap = await db
          .collection(`projects/${projectId}/profiles/${profileSnap.docs[0].id}/rules`)
          .get();
        activeProfileRules = rulesSnap.docs.map(
          (d) => ({ id: d.id, ...d.data() } as Rule)
        );
      }
    }

    // Always-rules come from every profile — when disarmed there is no
    // active profile to read them from.
    const allProfilesSnap = await db
      .collection(`projects/${projectId}/profiles`)
      .get();
    const alwaysRules: Rule[] = [];
    for (const prof of allProfilesSnap.docs) {
      const rs = await db
        .collection(`projects/${projectId}/profiles/${prof.id}/rules`)
        .where("always", "==", true)
        .get();
      for (const d of rs.docs) {
        alwaysRules.push({ id: d.id, ...d.data() } as Rule);
      }
    }

    const rules = applicableRules(serverArmed, activeProfileRules, alwaysRules);

    // Nothing applies — skip the event query entirely, preserving today's
    // cost for projects with no always-rules and a disarmed server.
    if (rules.length === 0) return;
```

- [ ] **Step 2: Unindent the evaluation body**

Everything from `// Get recent events for evaluation (last 5 minutes)` to the end of the old `if (project.serverArmed)` block was nested two levels (inside `if (serverArmed)` and `if (!profileSnap.empty)`). It now runs unconditionally after the guard above, so remove those two enclosing blocks and their closing braces, and unindent the body by four spaces.

The body itself is unchanged: the recent-events query, `evaluateRules(rules, fullEvent, recentEvents, timestamp)`, the `alarm_cause` write, and the siren/Telegram branch all stay exactly as they are.

- [ ] **Step 3: Add the import**

At the top of `functions/src/onSensorEvent.ts`, add:

```ts
import { applicableRules } from "./alwaysRules";
```

`Rule` is already imported — verify with `grep -n "^import" functions/src/onSensorEvent.ts` and add it to the existing `./types` import only if absent.

- [ ] **Step 4: Typecheck and run the full suite**

Run: `cd functions && npm run lint && npm test`
Expected: no typecheck output; all tests pass (the 27 `alarmLogic` tests must be untouched — `evaluateRules` did not change).

- [ ] **Step 5: Commit**

```bash
git add functions/src/onSensorEvent.ts
git commit -m "onSensorEvent: evaluate always rules while disarmed"
```

---

### Task 6: Firmware — parse and evaluate `always`

**Files:**
- Modify: `firmware/edge/device/src/alarm_state.h:6-14` (`Condition`), `:27-37` (`Config`)
- Modify: `firmware/edge/device/src/alarm_state.cpp:96-116` (`onSensorEvent`)
- Modify: `firmware/edge/device/src/config_parser.cpp:41-45`
- Test: `firmware/edge/device/test/test_alarm_state/test_alarm_state.cpp`
- Test: `firmware/edge/device/test/test_config_parser/test_config_parser.cpp`

**Interfaces:**
- Consumes: the `x` wire field (Task 2).
- Produces: `Condition::always`.

- [ ] **Step 1: Write the failing tests**

In `firmware/edge/device/test/test_alarm_state/test_alarm_state.cpp`, the existing `test_disarmed_never_fires` is now wrong in name and premise. **Rename it** and add three cases. Replace that whole function with:

```cpp
void test_disarmed_ordinary_condition_never_fires() {
  Config config;
  config.armed = false;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000));
}

void test_disarmed_always_condition_fires() {
  Config config;
  config.armed = false;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;
  config.sensors[0].conditions[0].always = true;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000));
}

void test_armed_always_condition_still_fires() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;
  config.sensors[0].conditions[0].always = true;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000));
}

// An always condition on one sensor must not make an ordinary condition on
// a DIFFERENT sensor fire while disarmed.
void test_disarmed_always_does_not_leak_to_other_sensors() {
  Config config;
  config.armed = false;
  config.sensorCount = 2;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;
  config.sensors[0].conditions[0].always = true;
  strcpy(config.sensors[1].rfId, "D4E5F6");
  config.sensors[1].conditionCount = 1;
  config.sensors[1].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000));
  TEST_ASSERT_FALSE(state.onSensorEvent("D4E5F6", 1000));
}

// Disarmed, an ordinary count_in_window must accumulate NO history, so
// arming later does not inherit a backlog of stale triggers.
void test_disarmed_ordinary_accumulates_no_history() {
  Config config;
  config.armed = false;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1; // count_in_window
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 60;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000));
  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 2000));

  // Arm now: the two disarmed events must not count toward the threshold,
  // so the next single event is the FIRST, not the third.
  config.armed = true;
  state.setConfig(config);
  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 3000));
}
```

Then update the `RUN_TEST` list in `main()`: replace `RUN_TEST(test_disarmed_never_fires);` with

```cpp
  RUN_TEST(test_disarmed_ordinary_condition_never_fires);
  RUN_TEST(test_disarmed_always_condition_fires);
  RUN_TEST(test_armed_always_condition_still_fires);
  RUN_TEST(test_disarmed_always_does_not_leak_to_other_sensors);
  RUN_TEST(test_disarmed_ordinary_accumulates_no_history);
```

In `firmware/edge/device/test/test_config_parser/test_config_parser.cpp`, add:

```cpp
void test_parses_always_flag() {
  Config config;
  const char* json =
      "{\"a\":true,\"d\":120,\"r\":[\"0xA1B2C3\"],\"c\":[[{\"t\":0,\"x\":1}]]}";
  bool ok = ConfigParser::parseConfigJson(json, &config);
  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_TRUE(config.sensors[0].conditions[0].always);
}

void test_absent_x_means_not_always() {
  Config config;
  const char* json =
      "{\"a\":true,\"d\":120,\"r\":[\"0xA1B2C3\"],\"c\":[[{\"t\":0}]]}";
  bool ok = ConfigParser::parseConfigJson(json, &config);
  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_FALSE(config.sensors[0].conditions[0].always);
}
```

and add both to its `RUN_TEST` list. Note the namespace and the `Config*`
pointer — the signature is
`ConfigParser::parseConfigJson(const char* json, Config* out)`
(`config_parser.h:21`), matching the existing tests in that file.

- [ ] **Step 2: Run to verify failure**

Run: `cd firmware/edge/device && pio test -e native`
Expected: FAIL — `Condition` has no member `always`.

- [ ] **Step 3: Add the field and the size guard**

In `firmware/edge/device/src/alarm_state.h`, add to `Condition` after `kLen`:

```cpp
  // Fires regardless of arm state (smoke, gas). Always implies a
  // single-sensor immediate condition, so it carries no runtime state.
  bool always = false;
```

Then after the `Config` struct's closing brace, add:

```cpp
// Config is persisted verbatim to EEPROM by EepromStore, so its size is part
// of the on-flash format. `always` was added into existing padding after
// Condition::kLen — measured 2416 before and after. If this ever fails, bump
// EepromStore::kMagic so stale config is discarded rather than misread.
static_assert(sizeof(Config) == 2416, "EEPROM layout changed - bump kMagic");
```

- [ ] **Step 4: Change the arm gate to a per-condition skip**

In `firmware/edge/device/src/alarm_state.cpp`, `onSensorEvent` currently begins with `if (!config_.armed) return false;`. Delete that line and add the skip inside the condition loop:

```cpp
bool AlarmState::onSensorEvent(const char* rfId, unsigned long nowMs,
                               TriggerCause* cause) {
  int sensorIndex = findSensorIndex(rfId);
  if (sensorIndex < 0) return false;

  const SensorConfig& sensor = config_.sensors[sensorIndex];
  for (uint8_t c = 0; c < sensor.conditionCount; c++) {
    // Disarmed no longer means "evaluate nothing": always-conditions (smoke,
    // gas) fire regardless. `continue` rather than an early return is what
    // keeps ordinary conditions from accumulating trigger history while
    // disarmed — evaluateCondition records history as a side effect of being
    // called, so skipping the call is what preserves today's behaviour.
    if (!config_.armed && !sensor.conditions[c].always) continue;

    if (evaluateCondition((uint8_t)sensorIndex, c, nowMs)) {
```

The rest of the loop body and the trailing `return false;` are unchanged.

- [ ] **Step 5: Parse `x`**

In `firmware/edge/device/src/config_parser.cpp`, after the `cond.y` line (~line 44), add:

```cpp
      cond.always = (condJson["x"] | 0) == 1;
```

- [ ] **Step 6: Run the native tests**

Run: `cd firmware/edge/device && pio test -e native`
Expected: all suites PASS — 38 pre-existing plus the 6 added (5 alarm_state, 2 config_parser, minus the renamed one).

- [ ] **Step 7: Verify the firmware still builds for hardware**

Run: `cd firmware/edge/device && pio run -e esp32s3`
Expected: build succeeds. This catches a `static_assert` failure under the xtensa compiler, whose padding rules the host measurement did not prove.

- [ ] **Step 8: Commit**

```bash
git add firmware/edge/device/src/alarm_state.h \
  firmware/edge/device/src/alarm_state.cpp \
  firmware/edge/device/src/config_parser.cpp \
  firmware/edge/device/test/test_alarm_state/test_alarm_state.cpp \
  firmware/edge/device/test/test_config_parser/test_config_parser.cpp
git commit -m "Firmware: always conditions fire while disarmed"
```

---

### Task 7: Rule editor checkbox and coercion

**Files:**
- Modify: `web/src/features/configure/RuleEditor.tsx`
- Modify: `web/src/features/configure/ProfilesTab.tsx:539-548,602-608`
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/he.ts`

**Interfaces:**
- Consumes: `Rule.always` (Task 1).
- Produces: `RuleEditor` props `always?: boolean` and `onAlwaysChange?: (v: boolean) => void`.

- [ ] **Step 1: Add the i18n strings**

In `web/src/i18n/en.ts`, before the closing `} as const;`:

```ts
  "cfg.rule.always": "Always active — fires even when disarmed",
  "cfg.rule.alwaysHelp":
    "For smoke or gas detectors. Ignores arm state, but still respects the siren setting. Applies to one sensor with an immediate trigger.",
  "cfg.rule.alwaysMultiHint":
    "Always active applies to a single sensor. Remove the extra sensors to enable it.",
  "cfg.rule.alwaysBadge": "always",
  "ops.alwaysRules": "{count} always-on rule(s) active while disarmed",
```

In `web/src/i18n/he.ts`, before the closing brace:

```ts
  "cfg.rule.always": "פעיל תמיד — מופעל גם כשהמערכת מנוטרלת",
  "cfg.rule.alwaysHelp":
    "לגלאי עשן או גז. מתעלם ממצב הדריכה, אך עדיין כפוף להגדרת הצופר. חל על חיישן אחד עם הפעלה מיידית.",
  "cfg.rule.alwaysMultiHint":
    "פעיל תמיד חל על חיישן אחד. הסירו את החיישנים הנוספים כדי לאפשר זאת.",
  "cfg.rule.alwaysBadge": "תמיד",
  "ops.alwaysRules": "{count} כללים פעילים תמיד גם בנטרול",
```

- [ ] **Step 2: Add the props and coercion to RuleEditor**

In `web/src/features/configure/RuleEditor.tsx`, extend the props interface:

```ts
interface RuleEditorProps {
  condition: Condition;
  onChange: (condition: Condition) => void;
  /** Sensors selected for this rule — used to render per-sensor counts. */
  selectedSensors?: { id: string; name: string }[];
  /** Rule-level always-on flag. Lives on the rule, not the condition. */
  always?: boolean;
  onAlwaysChange?: (always: boolean) => void;
}
```

and the destructuring:

```ts
export default function RuleEditor({
  condition,
  onChange,
  selectedSensors = [],
  always = false,
  onAlwaysChange,
}: RuleEditorProps) {
```

- [ ] **Step 3: Render the checkbox with coercion**

Immediately after the existing `{isMulti && <p className="muted">{t("cfg.rule.multiHint")}</p>}` line, insert:

```tsx
      {/* Ticking `always` coerces the rule to a single-sensor immediate
          condition and hides the type selector — the same coercion style as
          the sensor-count effect above, so an invalid combination is
          unrepresentable rather than rejected on save.

          The two coercions must not fight: with 2+ sensors selected, sensor
          count wins and `always` is disabled. */}
      {onAlwaysChange && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={always}
              disabled={isMulti}
              onChange={(e) => {
                const next = e.target.checked;
                if (next && localCondition.type !== "immediate") {
                  const c = defaultsFor("immediate");
                  setLocalCondition(c);
                  onChange(c);
                }
                onAlwaysChange(next);
              }}
            />
            <span>{t("cfg.rule.always")}</span>
          </label>
          <p className="muted">
            {isMulti ? t("cfg.rule.alwaysMultiHint") : t("cfg.rule.alwaysHelp")}
          </p>
        </>
      )}
```

Then hide the type selector while always is ticked: change the opening of the condition-type `<div className="field">` block to

```tsx
      {!always && (
      <div className="field">
```

and close it with `)}` after that div's closing tag. The `disabled={isMulti}` on the `<select>` stays as it is.

- [ ] **Step 4: Wire both ProfilesTab call sites**

At `ProfilesTab.tsx:539`, the edit-rule `<RuleEditor>` gains:

```tsx
            always={editingRule.rule.always === true}
            onAlwaysChange={(always) =>
              setEditingRule({
                ...editingRule,
                rule: { ...editingRule.rule, always },
              })
            }
```

At `:602`, the add-rule editor needs a state field. Find the `newRuleCondition` / `newRuleName` state declarations and add alongside them:

```tsx
  const [newRuleAlways, setNewRuleAlways] = useState(false);
```

Pass it:

```tsx
            always={newRuleAlways}
            onAlwaysChange={setNewRuleAlways}
```

Include it when the rule is created. In `handleAddRule` (~line 228) the rule
object is built as `const newRule: Omit<Rule, "id"> = { name, sensors, condition }`.
Spread the flag in only when true, so ordinary rules do not each gain a
`always: false` field:

```tsx
    const newRule: Omit<Rule, "id"> = {
      name: newRuleName.trim(),
      sensors: newRuleSensors,
      condition: newRuleCondition,
      ...(newRuleAlways ? { always: true } : {}),
    };
```

Note `handleAddRule` also validates with `sensorCountValidForType`, which
already rejects a multi-sensor `immediate` rule — so the coercion in the editor
and this validation agree, and no extra check is needed.

Reset it in `closeAddRule` alongside the other fields:

```tsx
    setNewRuleAlways(false);
```

- [ ] **Step 5: Mark always-rules in the rule list**

In `ProfilesTab.tsx`, the rule list renders each rule as one line (see the `cfg.rule.type.*` label near line 467). Append a badge after the existing label so a profile's rules are not silently different from each other:

```tsx
                    {rule.always === true && (
                      <span className="muted"> · {t("cfg.rule.alwaysBadge")}</span>
                    )}
```

`.muted` is used rather than a new badge class: `components.css` has no `.pill`
or equivalent, and inventing one for a single label is not worth a new style.

- [ ] **Step 6: Typecheck, test and build**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/features/configure/RuleEditor.tsx \
  web/src/features/configure/ProfilesTab.tsx \
  web/src/i18n/en.ts web/src/i18n/he.ts
git commit -m "Rule editor: always-on checkbox with immediate coercion"
```

---

### Task 8: Operations shows that disarmed is not fully off

**Files:**
- Modify: `web/src/features/operations/OperationsPage.tsx`

**Interfaces:**
- Consumes: `Rule.always` (Task 1), the `ops.alwaysRules` string (Task 7).
- Produces: nothing.

Once any always-rule exists, "Disarmed" no longer describes the system. A smoke trigger at 3am on a disarmed system must not be inexplicable.

- [ ] **Step 1: Count always-rules across all profiles**

`OperationsPage` already subscribes to `profilesCol`. Rules live in a subcollection, so add a `collectionGroup` count. Near the existing profile subscription, add:

```tsx
  const [alwaysRuleCount, setAlwaysRuleCount] = useState(0);

  // Always-rules span every profile, so this is a project-level fact, not a
  // property of the armed profile.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      const snaps = await Promise.all(
        profiles.map((p) =>
          getDocs(query(rulesCol(projectId, p.id), where("always", "==", true)))
        )
      );
      if (!cancelled) {
        setAlwaysRuleCount(snaps.reduce((n, s) => n + s.size, 0));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, profiles]);
```

Add `getDocs`, `query` and `where` to the existing `firebase/firestore` import, and `rulesCol` to the `@/lib/firestore` import.

- [ ] **Step 2: Show it beside the arm grid**

Inside the device `<section className="card">`, after `<ArmGrid side="device" activeId={activeDeviceId} />`, add:

```tsx
            {alwaysRuleCount > 0 && (
              <p className="muted">
                {t("ops.alwaysRules", { count: String(alwaysRuleCount) })}
              </p>
            )}
```

- [ ] **Step 3: Typecheck, test and build**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/features/operations/OperationsPage.tsx
git commit -m "Operations: note always-on rules beside the arm state"
```

---

### Task 9: Deploy and verify

**Files:** none — verification only.

**Do not start this task until the scheduling feature's hardware verification has passed.** Both features touch `onSensorEvent.ts` and `alarm_state.cpp`; deploying them together makes a failure ambiguous.

- [ ] **Step 1: Deploy the functions**

```bash
npx firebase deploy --only functions:onSensorEvent,functions:onProfileChange,functions:onRuleChange,functions:onProjectConfigChange
```

- [ ] **Step 2: Deploy hosting**

```bash
cd web && npm run build && cd .. && npx firebase deploy --only hosting
```

- [ ] **Step 3: Flash the device**

```bash
cd firmware/edge/device && pio run -e esp32s3 -t upload --upload-port /dev/cu.usbmodem101
```

Check `ls /dev/cu.*` first — macOS reassigns the `usbmodem` suffix per port/session.

- [ ] **Step 4: Verify the config reaches the device**

Create a rule in the UI on a paired sensor, tick "Always active", and confirm:

```bash
curl -s http://alarm.local/status
```

The device should be reachable and its config should list the sensor. Watch the serial log to confirm a config poll picked it up:

```bash
python3 firmware/edge/read_serial.py 40 --port /dev/cu.usbmodem101
```

- [ ] **Step 5: Verify it fires while disarmed**

With the system **disarmed** on both sides, trigger the sensor:

```bash
curl -s -X POST "http://alarm.local/trigger?rfId=0xYOURSENSOR"
```

Confirm: the siren sounds, a Telegram alarm arrives (loud, not silent), and the timeline shows an alarm entry.

- [ ] **Step 6: Verify an ordinary rule still does not fire while disarmed**

Trigger a sensor covered only by an ordinary rule, still disarmed. Confirm nothing happens — no siren, no alarm Telegram. This is the regression that matters most: always-on must not turn the whole system into always-armed.

- [ ] **Step 7: Verify the always-rule reaches the device from an inactive profile**

Arm a *different* profile than the one holding the smoke rule, then trigger the smoke sensor. It must still fire — this is what the all-profiles collection buys, and it is the failure mode most likely to slip through.

- [ ] **Step 8: Update project documentation**

In `CLAUDE.md`, add `always` to the "Sensor Trigger Conditions" section, noting it is a rule-level flag restricted to single-sensor `immediate` and collected from every profile. Remove `- always sensors` from `todo.txt`.

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md todo.txt
git commit -m "Document always-on rules"
```

---

## Self-Review Notes

**Spec coverage.** Data model → Task 1. `buildConfig` all-profiles merge and `x` emission → Task 2. Config rebuild → Task 3. Rule gathering → Tasks 4–5. `evaluateRules` unchanged → verified in Task 5's test run. Device evaluation, parsing, `static_assert` → Task 6. Editor coercion → Task 7. Disarmed disclosure → Task 8. Testing section → distributed across Tasks 2, 4, 6. Risks → Task 9 steps 6–7 target them directly.

**Known deviations from the spec, deliberate:**
- The spec named the helper module ambiguously; it is `alwaysRules.ts` exporting `applicableRules`, to avoid confusion with the scheduling feature's files.
- Task 3 restructures `onProfileChange`'s empty-profile early return, which the spec did not mention. Without it, a project whose active profile is cleared would drop its always-rules from the device config — the exact bug the feature exists to prevent.
- The spec put the disarmed note "next to the Disarmed state"; Task 8 places it under the device arm grid, since the count is project-level and the server card is admin-only.

**Cost note.** Tasks 3 and 5 each issue one query per profile. With a handful of profiles this is negligible, but it runs on every sensor event. If profile counts ever grow, a single `collectionGroup("rules").where("always","==",true)` filtered by path prefix would replace it — deliberately not done now, since a collection-group query spans projects and would need careful tenant filtering.
