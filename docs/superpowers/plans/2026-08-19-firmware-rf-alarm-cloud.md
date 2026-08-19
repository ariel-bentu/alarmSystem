# Firmware RF Decode, Alarm Logic, and Cloud Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the D1 Mini firmware with CC1101 RF receive, Kerui decode,
local alarm-condition evaluation, relay-driven siren, EEPROM-persisted
arm/config state, and two-way Firebase RTDB sync (SSE for commands/config,
direct write for events) — plus the backend changes (thin index-based config
format, device custom-token minting, RTDB rules) it depends on.

**Architecture:** Backend changes land first (config format + auth), since
firmware code depends on the wire shape they define and they're testable
today via existing Vitest suites with no hardware. Firmware then builds
bottom-up: pure/testable pieces first (EEPROM store, alarm-condition
evaluation — both verified via a new PlatformIO `native` test env, no board
required), then hardware/network-bound pieces (CC1101 receive, cloud client,
relay siren) which get manual verification steps since they need real
hardware. `main.cpp` wiring is the final integration task.

**Tech Stack:** TypeScript/Vitest (functions), C++/PlatformIO/ArduinoJson 7.1
(firmware), `mobizt/FirebaseClient` (RTDB SSE + CustomToken auth), Unity (via
PlatformIO native test env) for firmware unit tests.

**Spec:** `docs/superpowers/specs/2026-08-19-firmware-rf-alarm-cloud-design.md`

## Global Constraints

- Config wire format (RTDB `/{projectId}/config`) and EEPROM-persisted format
  are byte-identical in shape: `{ a: bool, d: number, r: string[], c: Condition[][] }`.
- Condition object short keys: `t` (0=immediate,1=count_in_window,
  2=entry_delay,3=multi_sensor), `n`=count, `w`=window_sec, `y`=delay_sec,
  `k`=counts (map of **index-as-string** → required count).
- `deviceIngest` is NOT removed or modified — it stays as the entry point for
  `smoke/` simulated-event tests.
- Device RTDB auth uses Firebase custom tokens with claims
  `{ projectId, role: "device" }`, minted by a new `mintDeviceToken` function
  using the same `hashApiKey`/`deviceKeys` lookup pattern as `deviceIngest`.
- Alarm evaluation and siren firing must never block on network/WiFi state.
- Firmware library: `bblanchon/ArduinoJson@^7.1.0` (already in
  `platformio.ini`) plus `mobizt/FirebaseClient` (to be added).

---

## File Structure

**Backend (`functions/src/`):**
- Modify `types.ts` — replace `RtdbConfig`/`RtdbConfigSensor`/`RtdbCondition`
  with the short-key, index-based shape.
- Modify `buildConfig.ts` — rewrite `buildRtdbConfig` to emit `{a, d, r, c}`.
- Modify `buildConfig.test.ts` — update all assertions to the new shape.
- Create `mintDeviceToken.ts` — new HTTPS function, mirrors `deviceIngest.ts`
  auth pattern, returns a custom token.
- Create `mintDeviceToken.test.ts`.
- Modify `index.ts` — export `mintDeviceToken`.
- Modify `../../web/src/types/index.ts` — mirror the same type change (web
  doesn't consume `/config` today per prior research, so this is a
  type-only, zero-behavior-change edit).
- Modify `../../database.rules.json` — scope `events` write and
  `commands`/`config` read to device custom-token claims, alongside existing
  user rules.

**Firmware (`firmware/edge/device/`):**
- Create `test/native/test_alarm_state.cpp` — Unity tests for condition
  evaluation, run in a new `[env:native]` PlatformIO environment.
- Create `src/alarm_state.h` / `src/alarm_state.cpp` — `Config` struct +
  `AlarmState` evaluator class.
- Create `src/eeprom_store.h` / `src/eeprom_store.cpp` — persists
  `{armed, Config}` to EEPROM.
- Create `src/relay_siren.h` / `src/relay_siren.cpp` — GPIO relay + auto-off
  timer.
- Create `src/cc1101_receiver.h` / `src/cc1101_receiver.cpp` — SPI CC1101 RX
  feeding the existing `../../kerui_decoder.h` bit-timing decode.
- Create `src/cloud_client.h` / `src/cloud_client.cpp` — `FirebaseClient`
  wrapper: token mint/refresh, SSE streams, event reporting.
- Modify `src/main.cpp` — wire everything into `onNormalOperation()` /
  `loop()`.
- Modify `platformio.ini` — add `mobizt/FirebaseClient` dependency and the
  `[env:native]` test environment.

---

## Task 1: Backend — thin index-based config type

**Files:**
- Modify: `functions/src/types.ts:118-135` (the `RtdbCondition`,
  `RtdbConfigSensor`, `RtdbConfig` interfaces)

**Interfaces:**
- Produces: `RtdbCondition { t: 0|1|2|3; n?: number; w?: number; y?: number; k?: Record<string, number> }`,
  `RtdbConfig { a: boolean; d: number; r: string[]; c: RtdbCondition[][] }`.
  Later tasks (`buildConfig.ts`, firmware) consume these exact field names.

- [ ] **Step 1: Replace the type definitions**

Replace lines 118-135 of `functions/src/types.ts`:

```typescript
// Condition as written into the RTDB config. Short keys and index-based
// references keep the payload small — the device only needs to evaluate
// conditions, not display names, and rfIds are referenced by their position
// in RtdbConfig.r instead of repeating the string.
//
// t: 0=immediate, 1=count_in_window, 2=entry_delay, 3=multi_sensor
// n: count (count_in_window)
// w: window_sec (count_in_window, multi_sensor)
// y: delay_sec (entry_delay)
// k: counts, keyed by index-into-r (as string) — required trigger count per
//    participant, always explicit for every participant including self
export interface RtdbCondition {
  t: 0 | 1 | 2 | 3;
  n?: number;
  w?: number;
  y?: number;
  k?: Record<string, number>;
}

// Device-facing config written to RTDB /{projectId}/config.
// r[i] is a sensor's rfId; c[i] is that same sensor's condition list
// (OR semantics — any one condition firing is enough). r and c are always
// the same length and index-aligned. A sensor whose rfId never appears in r
// is unknown to the device and is not evaluated for alarm logic.
export interface RtdbConfig {
  a: boolean; // armed
  d: number; // siren_duration_sec
  r: string[]; // rfIds, by index
  c: RtdbCondition[][]; // conditions per sensor, index-aligned with r
}
```

- [ ] **Step 2: Confirm the functions package typechecks**

Run: `cd functions && npm run build`
Expected: FAILS — `buildConfig.ts` still references the old shape. This
confirms the type change took effect; Task 2 fixes the build.

- [ ] **Step 3: Commit**

```bash
git add functions/src/types.ts
git commit -m "Replace RtdbConfig with thin index-based device config shape"
```

---

## Task 2: Backend — rewrite buildRtdbConfig to emit the new shape

**Files:**
- Modify: `functions/src/buildConfig.ts`
- Modify: `functions/src/buildConfig.test.ts`

**Interfaces:**
- Consumes: `RtdbCondition`, `RtdbConfig` from Task 1 (`functions/src/types.ts`).
- Consumes existing `Rule`, `Sensor`, `Condition` from `functions/src/types.ts`
  (unchanged Firestore-side types).
- Produces: `buildRtdbConfig(rules: Rule[], sensors: Sensor[], armed: boolean, sirenDurationSec: number): RtdbConfig`
  — same signature as before, new return shape. `onProfileChange.ts` (which
  calls this) needs no changes since it only threads the return value
  through to `rtdb.ref(...).set(config)`.

- [ ] **Step 1: Write the failing tests (replace buildConfig.test.ts entirely)**

```typescript
import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { buildRtdbConfig } from "./buildConfig";
import { Rule, Sensor } from "./types";

const sensors: Sensor[] = [
  { id: "s1", rfId: "0xA1B2C3", name: "Front door", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "ok", lastSeen: Timestamp.fromMillis(2000) },
  { id: "s2", rfId: "0xD4E5F6", name: "Back window", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "low", lastSeen: Timestamp.fromMillis(3000) },
  { id: "s3", rfId: "0x112233", name: "Garage PIR", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "ok", lastSeen: null },
];

describe("buildRtdbConfig", () => {
  it("builds config with an immediate rule", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door rule", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);

    expect(config.a).toBe(true);
    expect(config.d).toBe(120);
    expect(config.r).toEqual(["0xA1B2C3"]);
    expect(config.c).toEqual([[{ t: 0 }]]);
  });

  it("builds config with multiple sensors and conditions, index-aligned", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1", "s2"], condition: { type: "immediate" } },
      { id: "r2", name: "Garage", sensors: ["s3"], condition: { type: "count_in_window", count: 3, window_sec: 60 } },
    ];
    const config = buildRtdbConfig(rules, sensors, false, 90);

    expect(config.a).toBe(false);
    expect(config.d).toBe(90);
    expect(config.r).toEqual(["0xA1B2C3", "0xD4E5F6", "0x112233"]);
    expect(config.c).toEqual([
      [{ t: 0 }],
      [{ t: 0 }],
      [{ t: 1, n: 3, w: 60 }],
    ]);
  });

  it("merges conditions when a sensor appears in multiple rules", () => {
    const rules: Rule[] = [
      { id: "r1", name: "A", sensors: ["s1"], condition: { type: "immediate" } },
      { id: "r2", name: "B", sensors: ["s1"], condition: { type: "entry_delay", delay_sec: 30 } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 60);

    expect(config.r).toEqual(["0xA1B2C3"]);
    expect(config.c).toEqual([[{ t: 0 }, { t: 2, y: 30 }]]);
  });

  it("skips sensors not found in the sensors array", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Unknown", sensors: ["nonexistent"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, false, 120);

    expect(config.r).toEqual([]);
    expect(config.c).toEqual([]);
  });

  describe("multi_sensor translation", () => {
    it("re-keys per-sensor counts by index into r", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Break-in",
          sensors: ["s1", "s2"],
          condition: { type: "multi_sensor", window_sec: 60, counts: { s1: 1, s2: 2 } },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C3", "0xD4E5F6"]);
      // index 0 = s1/0xA1B2C3, index 1 = s2/0xD4E5F6
      expect(config.c).toEqual([
        [{ t: 3, w: 60, k: { "0": 1, "1": 2 } }],
        [{ t: 3, w: 60, k: { "0": 1, "1": 2 } }],
      ]);
    });

    it("defaults a missing count to 1 and makes every participant explicit", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "s3"],
          condition: { type: "multi_sensor", window_sec: 30, counts: { s1: 3 } }, // s3 omitted
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C3", "0x112233"]);
      expect(config.c[0][0]).toEqual({ t: 3, w: 30, k: { "0": 3, "1": 1 } });
    });

    it("fills in counts when the condition has none at all", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "s2"],
          condition: { type: "multi_sensor", window_sec: 45 },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c[0][0]).toEqual({ t: 3, w: 45, k: { "0": 1, "1": 1 } });
    });

    it("drops participants that cannot be resolved to an rfId", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "ghost"],
          condition: { type: "multi_sensor", window_sec: 60, counts: { s1: 2, ghost: 5 } },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C3"]);
      expect(config.c).toEqual([[{ t: 3, w: 60, k: { "0": 2 } }]]);
    });

    it("leaves single-sensor conditions untouched", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Door",
          sensors: ["s1"],
          condition: { type: "count_in_window", count: 3, window_sec: 60 },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c).toEqual([[{ t: 1, n: 3, w: 60 }]]);
    });
  });

  it("returns empty r/c for empty rules", () => {
    const config = buildRtdbConfig([], sensors, false, 120);

    expect(config.a).toBe(false);
    expect(config.d).toBe(120);
    expect(config.r).toEqual([]);
    expect(config.c).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd functions && npx vitest run buildConfig.test.ts`
Expected: FAIL — `buildRtdbConfig` still returns the old `{armed, siren_duration_sec, sensors}` shape.

- [ ] **Step 3: Rewrite buildConfig.ts**

```typescript
// Pure builder: converts Firestore profile+rules+sensors into the RtdbConfig
// object that gets written to RTDB /{projectId}/config for the device.

import {
  Rule,
  Sensor,
  Condition,
  RtdbCondition,
  RtdbConfig,
} from "./types";

const CONDITION_TYPE_CODE: Record<Condition["type"], 0 | 1 | 2 | 3> = {
  immediate: 0,
  count_in_window: 1,
  entry_delay: 2,
  multi_sensor: 3,
};

/**
 * Translate a Firestore condition into the device-facing short-key form.
 * multi_sensor `counts` — keyed by Firestore sensorId in Firestore, by rfId
 * in the old RTDB shape — are now keyed by **index into `r`**, resolved via
 * `indexOfRfId`. Sensors that cannot be resolved are dropped, and every
 * remaining participant is given an explicit count (defaulting to 1) so the
 * device never has to infer participants.
 */
function toRtdbCondition(
  condition: Condition,
  ruleSensorIds: string[],
  rfIdOf: (sensorId: string) => string | undefined,
  indexOfRfId: (rfId: string) => number
): RtdbCondition {
  const t = CONDITION_TYPE_CODE[condition.type];

  if (condition.type === "count_in_window") {
    return { t, n: condition.count, w: condition.window_sec };
  }
  if (condition.type === "entry_delay") {
    return { t, y: condition.delay_sec };
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
    return { t, w: condition.window_sec, k };
  }
  // immediate
  return { t };
}

/**
 * Build the RTDB config object from the active-on-device profile's data.
 * @param rules - All rules belonging to the active profile
 * @param sensors - All sensors in the project (need rfId lookup)
 * @param armed - Current armed state
 * @param sirenDurationSec - Project-level siren duration
 */
export function buildRtdbConfig(
  rules: Rule[],
  sensors: Sensor[],
  armed: boolean,
  sirenDurationSec: number
): RtdbConfig {
  const sensorMap = new Map<string, Sensor>();
  for (const s of sensors) {
    sensorMap.set(s.id, s);
  }
  const rfIdOf = (sensorId: string) => sensorMap.get(sensorId)?.rfId;

  // Pass 1: determine r (stable order = first-seen order across rules) and
  // collect each rfId's raw Firestore conditions in the same pass.
  const r: string[] = [];
  const rIndex = new Map<string, number>(); // rfId -> index into r
  const rawConditionsByRfId = new Map<string, Condition[]>();

  for (const rule of rules) {
    for (const sensorId of rule.sensors) {
      const sensor = sensorMap.get(sensorId);
      if (!sensor) continue;
      const rfId = sensor.rfId;

      if (!rIndex.has(rfId)) {
        rIndex.set(rfId, r.length);
        r.push(rfId);
        rawConditionsByRfId.set(rfId, []);
      }
    }
  }

  const indexOfRfId = (rfId: string) => rIndex.get(rfId) ?? -1;

  // Pass 2: translate each rule's condition once, append to every
  // participating sensor's condition list.
  for (const rule of rules) {
    const translated = toRtdbCondition(rule.condition, rule.sensors, rfIdOf, indexOfRfId);
    for (const sensorId of rule.sensors) {
      const rfId = rfIdOf(sensorId);
      if (!rfId) continue;
      rawConditionsByRfId.get(rfId)!.push(translated);
    }
  }

  const c: RtdbCondition[][] = r.map((rfId) => rawConditionsByRfId.get(rfId)!);

  return { a: armed, d: sirenDurationSec, r, c };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd functions && npx vitest run buildConfig.test.ts`
Expected: PASS — all assertions in Step 1's test file succeed.

- [ ] **Step 5: Run the full functions build and test suite**

Run: `cd functions && npm run build && npx vitest run`
Expected: PASS — `onProfileChange.ts` (the only other caller of
`buildRtdbConfig`) doesn't inspect the return shape's fields directly, so it
should typecheck and pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add functions/src/buildConfig.ts functions/src/buildConfig.test.ts
git commit -m "Rewrite buildRtdbConfig to emit thin index-based device config"
```

---

## Task 3: Backend — mirror the type change in the web app

**Files:**
- Modify: `web/src/types/index.ts:160-172` (the `RtdbConfigSensor`,
  `RtdbConfig` interfaces — note this file has no separate `RtdbCondition`
  interface per the earlier research; check current line numbers before
  editing since Task 1/2 didn't touch this file)

**Interfaces:**
- Produces: same shape as `functions/src/types.ts`'s `RtdbConfig`/
  `RtdbCondition` from Task 1, kept as a manually-synced mirror (matching the
  existing pattern noted in both files' header comments).

- [ ] **Step 1: Read the current web types file to confirm exact line numbers**

Run: `grep -n "RtdbCondition\|RtdbConfigSensor\|RtdbConfig " web/src/types/index.ts`

- [ ] **Step 2: Replace the RtdbConfig-related interfaces**

Using the line numbers from Step 1, replace the block with:

```typescript
// Condition as written into the RTDB config. Mirrors functions/src/types.ts
// — keep in sync by hand.
// t: 0=immediate, 1=count_in_window, 2=entry_delay, 3=multi_sensor
export interface RtdbCondition {
  t: 0 | 1 | 2 | 3;
  n?: number;
  w?: number;
  y?: number;
  k?: Record<string, number>; // keyed by index into RtdbConfig.r
}

// Device-facing config at RTDB /{projectId}/config. r[i]/c[i] are
// index-aligned: r[i] is a sensor's rfId, c[i] is its condition list.
export interface RtdbConfig {
  a: boolean; // armed
  d: number; // siren_duration_sec
  r: string[];
  c: RtdbCondition[][];
}
```

- [ ] **Step 3: Confirm no other web code references the old field names**

Run: `grep -rn "\.armed\b\|\.siren_duration_sec\b\|RtdbConfigSensor" web/src`
Expected: no matches referencing `RtdbConfig`'s old fields (the earlier
research confirmed no UI code reads `/config` directly — this step verifies
that's still true before proceeding).

- [ ] **Step 4: Typecheck the web app**

Run: `cd web && npm run build` (or `npx tsc --noEmit` if a faster typecheck
script exists — check `web/package.json` first)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/types/index.ts
git commit -m "Mirror thin index-based RtdbConfig type in web app"
```

---

## Task 4: Backend — mintDeviceToken Cloud Function

**Files:**
- Create: `functions/src/mintDeviceToken.ts`
- Create: `functions/src/mintDeviceToken.test.ts`
- Modify: `functions/src/index.ts` — add export

**Interfaces:**
- Consumes: `hashApiKey`, `apiKeyMatches` from `functions/src/apiKey.ts`
  (unchanged), `db` from `functions/src/admin.ts` (unchanged), `Project`
  type from `functions/src/types.ts` (unchanged).
- Produces: HTTPS function `mintDeviceToken`, POST body
  `{ apiKey: string }` → `200 { customToken: string }` on success,
  `400`/`401`/`404` matching `deviceIngest`'s error shape on failure.
  Firmware (`cloud_client.cpp`, Task 8) calls this at boot to obtain the
  token it hands to `FirebaseClient`'s `CustomToken` auth.

- [ ] **Step 1: Write the failing test**

This test uses the Firebase emulator pattern already established by the
project (check `functions/src/deviceIngest.ts` has no existing test file —
if there's an emulator-based test pattern elsewhere in the repo, e.g. under
`smoke/`, prefer matching it; otherwise this is a logic-only test using a
fake Firestore doc reader, matching the style of `apiKey.test.ts`).

```typescript
import { describe, it, expect } from "vitest";
import { hashApiKey } from "./apiKey";

// mintDeviceToken's HTTP handler wraps Firebase Admin calls (Firestore
// lookup, createCustomToken) that require the emulator to exercise
// end-to-end. This test covers the pure, emulator-free logic: that a
// correctly-hashed key produces the same hash the handler will look up.
// Full request/response behavior (400/401/404/200 paths) is covered by
// manual verification in Step 5, matching this project's existing coverage
// level for deviceIngest.ts (which also has no dedicated test file).
describe("mintDeviceToken key hashing", () => {
  it("hashes the same raw key deterministically, matching apiKey.ts", () => {
    const raw = "test-device-key-123";
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
    expect(hashApiKey(raw)).toHaveLength(64); // sha256 hex
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd functions && npx vitest run mintDeviceToken.test.ts`
Expected: FAIL — `mintDeviceToken.test.ts` imports fine (it only imports
existing `apiKey.ts`) but the file doesn't exist as a proper test target
yet if vitest can't find it; more precisely this step just confirms vitest
picks up the new file. If it passes immediately because the import already
works, that's fine — proceed to Step 3 to build the actual function, since
the meaningful verification for this task is Step 5's manual check.

- [ ] **Step 3: Write mintDeviceToken.ts**

```typescript
// Cloud Function: mintDeviceToken (HTTPS)
// Mints a Firebase custom auth token for a device, scoped to its project via
// custom claims. The device presents its raw apiKey (same credential used by
// deviceIngest); we resolve projectId the same way, then mint a token with
// { projectId, role: "device" } claims. Security rules (database.rules.json)
// use these claims to scope the device's RTDB access to its own project.
//
// POST JSON: { apiKey }
// Response: { customToken } | { error }
import { onRequest } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { db } from "./admin";
import { hashApiKey, apiKeyMatches } from "./apiKey";
import type { Project } from "./types";

export const mintDeviceToken = onRequest(
  { region: "europe-west1", cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }
    const { apiKey } = (req.body ?? {}) as { apiKey?: string };

    if (!apiKey) {
      res.status(400).json({ error: "apiKey required" });
      return;
    }

    const keyHash = hashApiKey(apiKey);
    const idxSnap = await db.doc(`deviceKeys/${keyHash}`).get();
    if (!idxSnap.exists) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }
    const projectId = (idxSnap.data() as { projectId: string }).projectId;

    const projectSnap = await db.doc(`projects/${projectId}`).get();
    if (!projectSnap.exists) {
      res.status(404).json({ error: "project missing" });
      return;
    }
    const project = projectSnap.data() as Project;
    if (!apiKeyMatches(apiKey, project.device.apiKeyHash)) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }

    const customToken = await getAuth().createCustomToken(`device:${projectId}`, {
      projectId,
      role: "device",
    });

    res.status(200).json({ customToken });
  }
);
```

- [ ] **Step 4: Export it from index.ts**

Add to `functions/src/index.ts`:

```typescript
export { mintDeviceToken } from "./mintDeviceToken";
```

- [ ] **Step 5: Manual verification against the emulator**

Run: `cd functions && npm run build` then start the emulator per the
project's existing emulator workflow (check `firebase.json` /
`smoke/README` for the exact command — likely `firebase emulators:start`).
With the emulator running, POST a known-good device API key (seed one via
the same path `smoke/` scripts use) to the local `mintDeviceToken` URL and
confirm a `200 { customToken: "..." }` response; POST a bogus key and
confirm `401`.

- [ ] **Step 6: Commit**

```bash
git add functions/src/mintDeviceToken.ts functions/src/mintDeviceToken.test.ts functions/src/index.ts
git commit -m "Add mintDeviceToken function for device RTDB custom-token auth"
```

---

## Task 5: Backend — RTDB security rules for device custom-token access

**Files:**
- Modify: `database.rules.json`

**Interfaces:**
- Consumes: the `{projectId, role: "device"}` claims minted in Task 4.
- Produces: rules enforced by RTDB itself on every device read/write; no
  code-level interface, but firmware (Task 8, `cloud_client.cpp`) depends on
  these rules actually granting the access it needs.

- [ ] **Step 1: Update database.rules.json**

Replace the full file:

```json
{
  "rules": {
    "$projectId": {
      ".read": "auth != null",
      "state": {
        ".read": "auth != null",
        ".write": false
      },
      "commands": {
        ".read": "auth != null",
        ".write": "auth != null"
      },
      "config": {
        ".read": "auth != null",
        ".write": false
      },
      "events": {
        ".read": "auth != null",
        ".write": "auth != null && auth.token.role === 'device' && auth.token.projectId === $projectId"
      }
    }
  }
}
```

Note: `commands`/`config`/top-level `.read` already grant `auth != null`,
which covers both device tokens and web-user tokens (the device's custom
token satisfies `auth != null` too, so no change needed there — only
`events.write` needs the new device-scoped check, since it was previously
`false` entirely and is now how the firmware writes events directly).

- [ ] **Step 2: Verify against the emulator's rules test, if one exists**

Run: `grep -rn "database.rules\|rulesUnitTesting" /Users/i022021/dev/alarmSystem/functions /Users/i022021/dev/alarmSystem/smoke`
If a rules-testing harness exists, run it. If not, manually verify via the
emulator: authenticate as a device custom token (mintable via Task 4's
emulator flow) and confirm a write to `/{projectId}/events/testRf/123`
succeeds for the matching `projectId` and fails (permission denied) for a
different `projectId`.

- [ ] **Step 3: Commit**

```bash
git add database.rules.json
git commit -m "Scope RTDB events write to device custom-token project claims"
```

---

## Task 6: Firmware — native test environment + alarm_state condition evaluation

**Files:**
- Modify: `firmware/edge/device/platformio.ini` — add `[env:native]`
- Create: `firmware/edge/device/test/native/test_alarm_state.cpp`
- Create: `firmware/edge/device/src/alarm_state.h`
- Create: `firmware/edge/device/src/alarm_state.cpp`

**Interfaces:**
- Consumes: nothing from other tasks (pure logic, no hardware, no network).
- Produces:
  ```cpp
  struct Condition {
    uint8_t t;              // 0=immediate,1=count_in_window,2=entry_delay,3=multi_sensor
    uint16_t n = 0;         // count
    uint16_t w = 0;         // window_sec
    uint16_t y = 0;         // delay_sec
    // k: counts map, small enough to store as parallel arrays (index, count)
    uint8_t kIndex[8];
    uint16_t kCount[8];
    uint8_t kLen = 0;
  };
  struct SensorConfig {
    char rfId[9];               // up to 8 hex chars + null
    Condition conditions[4];    // small fixed cap; OR semantics
    uint8_t conditionCount = 0;
  };
  struct Config {
    bool armed = false;
    uint16_t sirenDurationSec = 0;
    SensorConfig sensors[16];   // fixed cap on sensor count
    uint8_t sensorCount = 0;
  };
  class AlarmState {
   public:
    void setConfig(const Config& config);
    // Call once per decoded RF packet. Returns true if this event should
    // fire the siren right now (immediate/count_in_window/multi_sensor
    // conditions met). entry_delay conditions instead arm a pending-fire
    // timer; call tickEntryDelay(nowMs) each loop to check for expiry.
    bool onSensorEvent(const char* rfId, unsigned long nowMs);
    // Returns true exactly once when a pending entry_delay condition
    // expires without being disarmed.
    bool tickEntryDelay(unsigned long nowMs);
    void disarm(); // cancels any pending entry_delay fire
   private:
    Config config_;
    // ... internal per-condition trigger-history state
  };
  ```
  Task 9 (`main.cpp`) instantiates `AlarmState`, calls `setConfig` after
  EEPROM load / config stream update, `onSensorEvent` per decoded packet,
  `tickEntryDelay` each `loop()` iteration.

- [ ] **Step 1: Add the native test environment to platformio.ini**

```ini
[env:d1_mini]
platform = espressif8266
board = d1_mini
framework = arduino
monitor_speed = 9600
lib_deps =
    bblanchon/ArduinoJson@^7.1.0
    mobizt/FirebaseClient@^2.0.0
build_flags =
    -DPIO_FRAMEWORK_ARDUINO_MMU_CACHE16_IRAM48

[env:native]
platform = native
test_framework = unity
build_flags =
    -std=gnu++17
    -Isrc
```

(FirebaseClient version pin: confirm the current stable version tag on
`https://github.com/mobizt/FirebaseClient` releases before finalizing — use
`^2.0.0` as a starting constraint and adjust if the latest major differs.)

- [ ] **Step 2: Write the failing test**

Create `firmware/edge/device/test/native/test_alarm_state.cpp`:

```cpp
#include <unity.h>
#include "alarm_state.h"

void test_immediate_condition_fires_on_first_event() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0; // immediate

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000));
}

void test_unknown_sensor_never_fires() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("FFFFFF", 1000));
}

void test_disarmed_never_fires() {
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

void test_count_in_window_requires_n_triggers_within_w() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1; // count_in_window
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 30;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000));       // 1st, not enough
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 5000));        // 2nd, within 30s window -> fires
}

void test_count_in_window_resets_outside_window() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1;
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 30;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000));
  // 2nd trigger arrives 40s later -> outside the 30s window, window resets
  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 41000));
}

void test_entry_delay_does_not_fire_immediately_but_ticks_true_after_delay() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 2; // entry_delay
  config.sensors[0].conditions[0].y = 30;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000)); // starts countdown, no immediate fire
  TEST_ASSERT_FALSE(state.tickEntryDelay(20000));          // still within delay
  TEST_ASSERT_TRUE(state.tickEntryDelay(31001));           // delay expired -> fires once
  TEST_ASSERT_FALSE(state.tickEntryDelay(40000));          // already fired, no repeat
}

void test_entry_delay_disarm_cancels_pending_fire() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 2;
  config.sensors[0].conditions[0].y = 30;

  AlarmState state;
  state.setConfig(config);

  state.onSensorEvent("A1B2C3", 1000);
  state.disarm();
  TEST_ASSERT_FALSE(state.tickEntryDelay(31001)); // cancelled, never fires
}

void test_multi_sensor_requires_all_participants_within_window() {
  Config config;
  config.armed = true;
  config.sensorCount = 2;
  strcpy(config.sensors[0].rfId, "AA11BB");
  strcpy(config.sensors[1].rfId, "CC22DD");

  Condition cond;
  cond.t = 3; // multi_sensor
  cond.w = 60;
  cond.kLen = 2;
  cond.kIndex[0] = 0; cond.kCount[0] = 2; // AA11BB needs 2 triggers
  cond.kIndex[1] = 1; cond.kCount[1] = 1; // CC22DD needs 1 trigger

  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0] = cond;
  config.sensors[1].conditionCount = 1;
  config.sensors[1].conditions[0] = cond;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("AA11BB", 1000)); // AA11BB: 1/2
  TEST_ASSERT_FALSE(state.onSensorEvent("CC22DD", 2000)); // CC22DD: 1/1, but AA11BB still 1/2
  TEST_ASSERT_TRUE(state.onSensorEvent("AA11BB", 3000));  // AA11BB: 2/2, CC22DD: 1/1 -> fires
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_immediate_condition_fires_on_first_event);
  RUN_TEST(test_unknown_sensor_never_fires);
  RUN_TEST(test_disarmed_never_fires);
  RUN_TEST(test_count_in_window_requires_n_triggers_within_w);
  RUN_TEST(test_count_in_window_resets_outside_window);
  RUN_TEST(test_entry_delay_does_not_fire_immediately_but_ticks_true_after_delay);
  RUN_TEST(test_entry_delay_disarm_cancels_pending_fire);
  RUN_TEST(test_multi_sensor_requires_all_participants_within_window);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
```

- [ ] **Step 3: Run the tests to verify they fail (no implementation yet)**

Run: `cd firmware/edge/device && pio test -e native`
Expected: FAIL to compile — `alarm_state.h` doesn't exist yet.

- [ ] **Step 4: Write alarm_state.h**

```cpp
#pragma once

#include <cstdint>
#include <cstring>

struct Condition {
  uint8_t t = 0;
  uint16_t n = 0;
  uint16_t w = 0;
  uint16_t y = 0;
  uint8_t kIndex[8] = {};
  uint16_t kCount[8] = {};
  uint8_t kLen = 0;
};

struct SensorConfig {
  char rfId[9] = {};
  Condition conditions[4];
  uint8_t conditionCount = 0;
};

struct Config {
  bool armed = false;
  uint16_t sirenDurationSec = 0;
  SensorConfig sensors[16];
  uint8_t sensorCount = 0;
};

class AlarmState {
 public:
  void setConfig(const Config& config);
  bool onSensorEvent(const char* rfId, unsigned long nowMs);
  bool tickEntryDelay(unsigned long nowMs);
  void disarm();

 private:
  static constexpr uint8_t kMaxSensors = 16;
  static constexpr uint8_t kMaxConditionsPerSensor = 4;
  static constexpr uint8_t kMaxTriggerHistory = 8;

  struct ConditionRuntime {
    unsigned long triggerTimesMs[kMaxTriggerHistory];
    uint8_t triggerCount = 0;
    bool entryDelayPending = false;
    bool entryDelayFired = false;
    unsigned long entryDelayDeadlineMs = 0;
  };

  Config config_;
  // runtime_[sensorIndex][conditionIndex]
  ConditionRuntime runtime_[kMaxSensors][kMaxConditionsPerSensor];

  int findSensorIndex(const char* rfId) const;
  bool evaluateCondition(uint8_t sensorIndex, uint8_t conditionIndex, unsigned long nowMs);
  bool multiSensorSatisfied(const Condition& cond, unsigned long nowMs);
};
```

- [ ] **Step 5: Write alarm_state.cpp**

```cpp
#include "alarm_state.h"

void AlarmState::setConfig(const Config& config) {
  config_ = config;
  memset(runtime_, 0, sizeof(runtime_));
}

int AlarmState::findSensorIndex(const char* rfId) const {
  for (uint8_t i = 0; i < config_.sensorCount; i++) {
    if (strcmp(config_.sensors[i].rfId, rfId) == 0) return i;
  }
  return -1;
}

bool AlarmState::multiSensorSatisfied(const Condition& cond, unsigned long nowMs) {
  for (uint8_t p = 0; p < cond.kLen; p++) {
    uint8_t participantIndex = cond.kIndex[p];
    uint16_t required = cond.kCount[p];

    // Find this participant's own runtime state for the matching
    // multi_sensor condition (same t/w/kLen — participants carry identical
    // condition copies per the config format).
    uint8_t matchedConditionIdx = 255;
    for (uint8_t ci = 0; ci < config_.sensors[participantIndex].conditionCount; ci++) {
      const Condition& c = config_.sensors[participantIndex].conditions[ci];
      if (c.t == 3 && c.w == cond.w && c.kLen == cond.kLen) {
        matchedConditionIdx = ci;
        break;
      }
    }
    if (matchedConditionIdx == 255) return false;

    ConditionRuntime& rt = runtime_[participantIndex][matchedConditionIdx];
    uint8_t countInWindow = 0;
    for (uint8_t h = 0; h < rt.triggerCount; h++) {
      if (nowMs - rt.triggerTimesMs[h] <= (unsigned long)cond.w * 1000UL) {
        countInWindow++;
      }
    }
    if (countInWindow < required) return false;
  }
  return true;
}

bool AlarmState::evaluateCondition(uint8_t sensorIndex, uint8_t conditionIndex, unsigned long nowMs) {
  const Condition& cond = config_.sensors[sensorIndex].conditions[conditionIndex];
  ConditionRuntime& rt = runtime_[sensorIndex][conditionIndex];

  switch (cond.t) {
    case 0: // immediate
      return true;

    case 1: { // count_in_window
      // Drop history outside the window, then record this trigger.
      unsigned long windowMs = (unsigned long)cond.w * 1000UL;
      uint8_t kept = 0;
      for (uint8_t h = 0; h < rt.triggerCount; h++) {
        if (nowMs - rt.triggerTimesMs[h] <= windowMs) {
          rt.triggerTimesMs[kept++] = rt.triggerTimesMs[h];
        }
      }
      rt.triggerCount = kept;
      if (rt.triggerCount < kMaxTriggerHistory) {
        rt.triggerTimesMs[rt.triggerCount++] = nowMs;
      }
      return rt.triggerCount >= cond.n;
    }

    case 2: // entry_delay
      if (!rt.entryDelayPending && !rt.entryDelayFired) {
        rt.entryDelayPending = true;
        rt.entryDelayDeadlineMs = nowMs + (unsigned long)cond.y * 1000UL;
      }
      return false; // never fires immediately; tickEntryDelay handles expiry

    case 3: { // multi_sensor
      unsigned long windowMs = (unsigned long)cond.w * 1000UL;
      uint8_t kept = 0;
      for (uint8_t h = 0; h < rt.triggerCount; h++) {
        if (nowMs - rt.triggerTimesMs[h] <= windowMs) {
          rt.triggerTimesMs[kept++] = rt.triggerTimesMs[h];
        }
      }
      rt.triggerCount = kept;
      if (rt.triggerCount < kMaxTriggerHistory) {
        rt.triggerTimesMs[rt.triggerCount++] = nowMs;
      }
      return multiSensorSatisfied(cond, nowMs);
    }

    default:
      return false;
  }
}

bool AlarmState::onSensorEvent(const char* rfId, unsigned long nowMs) {
  if (!config_.armed) return false;

  int sensorIndex = findSensorIndex(rfId);
  if (sensorIndex < 0) return false;

  const SensorConfig& sensor = config_.sensors[sensorIndex];
  for (uint8_t c = 0; c < sensor.conditionCount; c++) {
    if (evaluateCondition((uint8_t)sensorIndex, c, nowMs)) {
      return true;
    }
  }
  return false;
}

bool AlarmState::tickEntryDelay(unsigned long nowMs) {
  for (uint8_t s = 0; s < config_.sensorCount; s++) {
    for (uint8_t c = 0; c < config_.sensors[s].conditionCount; c++) {
      if (config_.sensors[s].conditions[c].t != 2) continue;
      ConditionRuntime& rt = runtime_[s][c];
      if (rt.entryDelayPending && !rt.entryDelayFired && nowMs >= rt.entryDelayDeadlineMs) {
        rt.entryDelayFired = true;
        rt.entryDelayPending = false;
        return true;
      }
    }
  }
  return false;
}

void AlarmState::disarm() {
  config_.armed = false;
  for (uint8_t s = 0; s < config_.sensorCount; s++) {
    for (uint8_t c = 0; c < config_.sensors[s].conditionCount; c++) {
      runtime_[s][c].entryDelayPending = false;
    }
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS — all 8 tests green.

- [ ] **Step 7: Commit**

```bash
git add firmware/edge/device/platformio.ini firmware/edge/device/test/native/test_alarm_state.cpp firmware/edge/device/src/alarm_state.h firmware/edge/device/src/alarm_state.cpp
git commit -m "Add AlarmState condition evaluator with native unit tests"
```

---

## Task 7: Firmware — EEPROM-backed config/arm-state store

**Files:**
- Create: `firmware/edge/device/src/eeprom_store.h`
- Create: `firmware/edge/device/src/eeprom_store.cpp`
- Create: `firmware/edge/device/test/native/test_eeprom_store.cpp` (uses a
  fake in-memory EEPROM backend so it runs under `[env:native]`)

**Interfaces:**
- Consumes: `Config` struct from Task 6 (`alarm_state.h`).
- Produces:
  ```cpp
  class EepromStore {
   public:
    bool begin();                          // EEPROM.begin(kReservedBytes)
    bool load(bool* armed, Config* config); // false if no valid data yet
    bool save(bool armed, const Config& config);
  };
  ```
  Task 9 (`main.cpp`) calls `begin()` once at boot, `load()` to restore
  state before starting RF/cloud loops, `save()` whenever armed state or
  config changes.

- [ ] **Step 1: Write the failing test**

Because `EEPROM.h` is an Arduino/ESP8266-only header, the native test
exercises the serialize/deserialize logic through a small seam: extract the
pure encode/decode functions (`encodeConfig`/`decodeConfig`, operating on a
byte buffer) so they're testable without real EEPROM I/O, and have
`EepromStore::load`/`save` call `EEPROM.get`/`put` around them in the
non-native build.

Create `firmware/edge/device/test/native/test_eeprom_store.cpp`:

```cpp
#include <unity.h>
#include "eeprom_store.h"

void test_encode_decode_round_trips_armed_and_config() {
  Config config;
  config.armed = true; // note: EepromStore tracks armed separately; this
                        // field on Config itself is unused by the store,
                        // included here only for struct completeness
  config.sirenDurationSec = 90;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1;
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 30;

  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(true, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = false;
  Config configOut;
  bool ok = EepromStore::decode(buffer, written, &armedOut, &configOut);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_TRUE(armedOut);
  TEST_ASSERT_EQUAL(90, configOut.sirenDurationSec);
  TEST_ASSERT_EQUAL(1, configOut.sensorCount);
  TEST_ASSERT_EQUAL_STRING("A1B2C3", configOut.sensors[0].rfId);
  TEST_ASSERT_EQUAL(1, configOut.sensors[0].conditions[0].t);
  TEST_ASSERT_EQUAL(2, configOut.sensors[0].conditions[0].n);
  TEST_ASSERT_EQUAL(30, configOut.sensors[0].conditions[0].w);
}

void test_decode_rejects_garbage_buffer() {
  uint8_t buffer[EepromStore::kReservedBytes];
  memset(buffer, 0xFF, sizeof(buffer)); // erased-flash pattern, no valid magic/header

  bool armedOut = false;
  Config configOut;
  bool ok = EepromStore::decode(buffer, sizeof(buffer), &armedOut, &configOut);

  TEST_ASSERT_FALSE(ok);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_encode_decode_round_trips_armed_and_config);
  RUN_TEST(test_decode_rejects_garbage_buffer);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd firmware/edge/device && pio test -e native -f test_eeprom_store`
Expected: FAIL to compile — `eeprom_store.h` doesn't exist yet.

- [ ] **Step 3: Write eeprom_store.h**

```cpp
#pragma once

#include <cstddef>
#include <cstdint>

#include "alarm_state.h"

class EepromStore {
 public:
  static constexpr size_t kReservedBytes = 4096;
  static constexpr uint32_t kMagic = 0xA1A2B3B4;

  bool begin();
  bool load(bool* armed, Config* config);
  bool save(bool armed, const Config& config);

  // Pure encode/decode, exposed for native unit testing. Layout: magic
  // (4 bytes) | armed (1 byte) | Config (raw struct bytes, fixed size).
  static size_t encode(bool armed, const Config& config, uint8_t* buffer, size_t bufferLen);
  static bool decode(const uint8_t* buffer, size_t bufferLen, bool* armed, Config* config);
};
```

- [ ] **Step 4: Write eeprom_store.cpp**

```cpp
#include "eeprom_store.h"

#include <cstring>

#if defined(ARDUINO)
#include <EEPROM.h>
#endif

size_t EepromStore::encode(bool armed, const Config& config, uint8_t* buffer, size_t bufferLen) {
  size_t needed = sizeof(kMagic) + sizeof(uint8_t) + sizeof(Config);
  if (bufferLen < needed) return 0;

  size_t offset = 0;
  memcpy(buffer + offset, &kMagic, sizeof(kMagic));
  offset += sizeof(kMagic);

  uint8_t armedByte = armed ? 1 : 0;
  memcpy(buffer + offset, &armedByte, sizeof(armedByte));
  offset += sizeof(armedByte);

  memcpy(buffer + offset, &config, sizeof(Config));
  offset += sizeof(Config);

  return offset;
}

bool EepromStore::decode(const uint8_t* buffer, size_t bufferLen, bool* armed, Config* config) {
  size_t needed = sizeof(kMagic) + sizeof(uint8_t) + sizeof(Config);
  if (bufferLen < needed) return false;

  uint32_t magic = 0;
  size_t offset = 0;
  memcpy(&magic, buffer + offset, sizeof(magic));
  offset += sizeof(magic);
  if (magic != kMagic) return false;

  uint8_t armedByte = 0;
  memcpy(&armedByte, buffer + offset, sizeof(armedByte));
  offset += sizeof(armedByte);
  *armed = armedByte != 0;

  memcpy(config, buffer + offset, sizeof(Config));
  offset += sizeof(Config);

  return true;
}

#if defined(ARDUINO)

bool EepromStore::begin() {
  EEPROM.begin(kReservedBytes);
  return true;
}

bool EepromStore::load(bool* armed, Config* config) {
  uint8_t buffer[kReservedBytes];
  for (size_t i = 0; i < kReservedBytes; i++) {
    buffer[i] = EEPROM.read(i);
  }
  return decode(buffer, kReservedBytes, armed, config);
}

bool EepromStore::save(bool armed, const Config& config) {
  uint8_t buffer[kReservedBytes];
  size_t written = encode(armed, config, buffer, kReservedBytes);
  if (written == 0) return false;

  for (size_t i = 0; i < written; i++) {
    EEPROM.write(i, buffer[i]);
  }
  return EEPROM.commit();
}

#endif  // defined(ARDUINO)
```

Note: `sizeof(Config)` must fit within `kReservedBytes` (4096) minus 5
header bytes. With `sensors[16]` each holding `conditions[4]` each holding
two `uint8_t[8]`+`uint16_t[8]` arrays, this comfortably fits (well under
4KB) — Step 5 confirms this at compile/test time via the successful
`encode` call in the test (which asserts `written > 0`, and `encode`
returns 0 if it wouldn't fit).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS — both `test_alarm_state` and `test_eeprom_store` suites
green (Task 6's tests must still pass too).

- [ ] **Step 6: Commit**

```bash
git add firmware/edge/device/src/eeprom_store.h firmware/edge/device/src/eeprom_store.cpp firmware/edge/device/test/native/test_eeprom_store.cpp
git commit -m "Add EepromStore for persisting armed state and config"
```

---

## Task 8: Firmware — CC1101 receiver (SPI, feeds existing Kerui decoder)

**Files:**
- Create: `firmware/edge/device/src/cc1101_receiver.h`
- Create: `firmware/edge/device/src/cc1101_receiver.cpp`

**Interfaces:**
- Consumes: `keruiReadRow`, `keruiParse`, `KeruiPacket`, `KERUI_BITS`,
  `KERUI_RESULT_SUCCESS` from `../../kerui_decoder.h` (existing, unmodified
  — note the relative include path since `kerui_decoder.h` lives at
  `firmware/edge/kerui_decoder.h`, one level above `device/`).
- Produces:
  ```cpp
  class Cc1101Receiver {
   public:
    bool begin(uint8_t csPin, uint8_t gdo0Pin); // SPI init + CC1101 config for 433.92MHz OOK
    // Non-blocking poll: returns true if a full valid packet was decoded
    // this call. Call every loop() iteration.
    bool poll(KeruiPacket* outPacket, int* outRssi);
  };
  ```
  Task 9 (`main.cpp`) calls `poll()` each `loop()` iteration; a `true`
  return feeds `AlarmState::onSensorEvent` and `CloudClient::reportEvent`.

This task is hardware-bound (SPI + real CC1101 module + real RF signal) and
cannot be meaningfully unit-tested without the part in hand. Per the spec's
Testing section and the project's existing "Next" steps, this is manual
hardware verification once the CC1101 arrives.

- [ ] **Step 1: Write cc1101_receiver.h**

```cpp
#pragma once

#include <cstdint>

#include "../../kerui_decoder.h"

class Cc1101Receiver {
 public:
  bool begin(uint8_t csPin, uint8_t gdo0Pin);
  bool poll(KeruiPacket* outPacket, int* outRssi);

 private:
  uint8_t csPin_ = 0;
  uint8_t gdo0Pin_ = 0;

  void writeReg(uint8_t addr, uint8_t value);
  uint8_t readReg(uint8_t addr);
  void strobe(uint8_t cmd);
  void configureFor433MhzOok();
};
```

- [ ] **Step 2: Write cc1101_receiver.cpp**

```cpp
#include "cc1101_receiver.h"

#include <Arduino.h>
#include <SPI.h>

namespace {
// CC1101 register addresses and strobe commands (subset needed for
// ASK/OOK receive at 433.92MHz). Values from the TI CC1101 datasheet
// register tables.
constexpr uint8_t REG_IOCFG0 = 0x02;
constexpr uint8_t REG_FIFOTHR = 0x03;
constexpr uint8_t REG_PKTCTRL0 = 0x08;
constexpr uint8_t REG_FREQ2 = 0x0D;
constexpr uint8_t REG_FREQ1 = 0x0E;
constexpr uint8_t REG_FREQ0 = 0x0F;
constexpr uint8_t REG_MDMCFG2 = 0x12;
constexpr uint8_t REG_MDMCFG4 = 0x10;
constexpr uint8_t REG_MDMCFG3 = 0x11;
constexpr uint8_t REG_RSSI = 0x34;
constexpr uint8_t STROBE_SRES = 0x30;
constexpr uint8_t STROBE_SRX = 0x34;
constexpr uint8_t CC1101_WRITE = 0x00;
constexpr uint8_t CC1101_READ = 0x80;
}  // namespace

bool Cc1101Receiver::begin(uint8_t csPin, uint8_t gdo0Pin) {
  csPin_ = csPin;
  gdo0Pin_ = gdo0Pin;

  pinMode(csPin_, OUTPUT);
  digitalWrite(csPin_, HIGH);
  pinMode(gdo0Pin_, INPUT);

  SPI.begin();

  strobe(STROBE_SRES);
  delay(10);

  configureFor433MhzOok();
  strobe(STROBE_SRX);

  return true;
}

void Cc1101Receiver::writeReg(uint8_t addr, uint8_t value) {
  digitalWrite(csPin_, LOW);
  SPI.transfer(addr | CC1101_WRITE);
  SPI.transfer(value);
  digitalWrite(csPin_, HIGH);
}

uint8_t Cc1101Receiver::readReg(uint8_t addr) {
  digitalWrite(csPin_, LOW);
  SPI.transfer(addr | CC1101_READ);
  uint8_t value = SPI.transfer(0x00);
  digitalWrite(csPin_, HIGH);
  return value;
}

void Cc1101Receiver::strobe(uint8_t cmd) {
  digitalWrite(csPin_, LOW);
  SPI.transfer(cmd);
  digitalWrite(csPin_, HIGH);
}

void Cc1101Receiver::configureFor433MhzOok() {
  // 433.92MHz, ASK/OOK modulation, GDO0 asserts on sync-free async serial
  // data so the existing timing-based decoder can read GDO0 as a digital
  // signal line, matching the analog spike's approach but via SPI-configured
  // hardware instead of a raw RX module on an analog pin.
  writeReg(REG_IOCFG0, 0x0D);     // GDO0: serial data output, async
  writeReg(REG_PKTCTRL0, 0x32);   // async serial mode, no packet handling
  writeReg(REG_FREQ2, 0x10);
  writeReg(REG_FREQ1, 0xB0);
  writeReg(REG_FREQ0, 0x71);      // ~433.92MHz
  writeReg(REG_MDMCFG2, 0x30);    // ASK/OOK, no sync word
  writeReg(REG_MDMCFG4, 0xF6);
  writeReg(REG_MDMCFG3, 0x83);
  writeReg(REG_FIFOTHR, 0x07);
}

bool Cc1101Receiver::poll(KeruiPacket* outPacket, int* outRssi) {
  // GDO0 in async serial mode outputs the demodulated bitstream directly —
  // feed it into the existing bit-timing decoder exactly as the analog
  // spike fed analogRead(). keruiReadRow blocks until it gets `passes`
  // consecutive identical reads or times out, so this poll() call is
  // effectively synchronous per invocation (matching the spike's model);
  // main.cpp's loop() calling this every iteration keeps other work
  // (SSE stream servicing, etc.) interleaved between calls.
  byte bits[KERUI_BITS];
  int result = keruiReadRow(gdo0Pin_, 2, bits, nullptr);

  if (result != KERUI_RESULT_SUCCESS) {
    return false;
  }

  *outPacket = keruiParse(bits);
  *outRssi = (int)readReg(REG_RSSI) - 128; // raw RSSI byte to dBm-ish offset, per CC1101 datasheet convention
  return true;
}
```

Note for the implementer: `keruiReadRow` in `kerui_decoder.h` is written
around `analogRead(pin)` returning a signal level compared against
`KERUI_UPPER_THRESHOLD`/`KERUI_LOWER_THRESHOLD`. GDO0 in async serial mode
is a **digital** pin, not analog — `analogRead` won't work on it as-is. This
is a genuine integration gap between the existing decoder and CC1101's
digital output that the spec deferred ("bit-timing decode logic is reused
as-is"). Two options, to resolve with real hardware in hand:
(a) add a `digitalRead`-based overload of `keruiReadRow` to
`kerui_decoder.h` since the timing logic itself doesn't care about the
read mechanism, or (b) route GDO0 through one of the D1 Mini's analog-capable
paths. Prefer (a) — it's a small, additive change to `kerui_decoder.h`
(new overload, no change to existing `analogRead`-based signature used by
`spike_decode.ino`) and keeps the timing/threshold logic in one place.
Flag this explicitly during manual hardware bring-up rather than guessing
the fix blind.

- [ ] **Step 3: Manual verification (requires CC1101 hardware)**

Once the CC1101 module is available: wire CS/GDO0/SPI per the D1 Mini pin
plan (document exact pins in code comments once chosen), flash a temporary
test build that calls `Cc1101Receiver::begin()` + loops on `poll()` printing
any decoded packet's `sensorId` over Serial, trigger a real Kerui sensor,
and confirm a stable, repeatable `sensorId` prints (cross-check against
`spike_decode.ino`'s analog-based output for the same sensor, if the analog
RX module is still available, to validate the CC1101 path decodes
identically).

- [ ] **Step 4: Commit**

```bash
git add firmware/edge/device/src/cc1101_receiver.h firmware/edge/device/src/cc1101_receiver.cpp
git commit -m "Add CC1101 SPI receiver feeding existing Kerui decoder"
```

---

## Task 9: Firmware — relay-driven siren with auto-off timer

**Files:**
- Create: `firmware/edge/device/src/relay_siren.h`
- Create: `firmware/edge/device/src/relay_siren.cpp`

**Interfaces:**
- Consumes: nothing from other tasks (standalone GPIO + timer logic).
- Produces:
  ```cpp
  class RelaySiren {
   public:
    void begin(uint8_t relayPin);
    void turnOn(uint16_t durationSec, unsigned long nowMs); // durationSec == 0 means "siren disabled, no-op"
    void turnOff();
    void tick(unsigned long nowMs); // call every loop(); auto-turns-off when duration elapses
    bool isActive() const;
  };
  ```
  Task 10 (`main.cpp`) calls `turnOn` when `AlarmState`/commands indicate
  siren-on, `turnOff` on remote siren-off command or disarm, `tick` every
  loop iteration.

- [ ] **Step 1: Write relay_siren.h**

```cpp
#pragma once

#include <cstdint>

class RelaySiren {
 public:
  void begin(uint8_t relayPin);
  void turnOn(uint16_t durationSec, unsigned long nowMs);
  void turnOff();
  void tick(unsigned long nowMs);
  bool isActive() const { return active_; }

 private:
  uint8_t relayPin_ = 0;
  bool active_ = false;
  unsigned long offAtMs_ = 0;
  bool autoOff_ = false;
};
```

- [ ] **Step 2: Write relay_siren.cpp**

```cpp
#include "relay_siren.h"

#include <Arduino.h>

void RelaySiren::begin(uint8_t relayPin) {
  relayPin_ = relayPin;
  pinMode(relayPin_, OUTPUT);
  digitalWrite(relayPin_, LOW);
}

void RelaySiren::turnOn(uint16_t durationSec, unsigned long nowMs) {
  if (durationSec == 0) return; // siren disabled

  digitalWrite(relayPin_, HIGH);
  active_ = true;
  autoOff_ = true;
  offAtMs_ = nowMs + (unsigned long)durationSec * 1000UL;
}

void RelaySiren::turnOff() {
  digitalWrite(relayPin_, LOW);
  active_ = false;
  autoOff_ = false;
}

void RelaySiren::tick(unsigned long nowMs) {
  if (active_ && autoOff_ && nowMs >= offAtMs_) {
    turnOff();
  }
}
```

- [ ] **Step 3: Manual verification (requires relay + siren hardware)**

Wire a relay module to a chosen GPIO pin (document the pin once chosen —
matches the "physical siren wired via relay to D1 Mini GPIO" note in
CLAUDE.md), flash a temporary test build calling `turnOn(5, millis())` at
boot, confirm the relay clicks on and auto-releases after 5 seconds via
`tick()` called from `loop()`.

- [ ] **Step 4: Commit**

```bash
git add firmware/edge/device/src/relay_siren.h firmware/edge/device/src/relay_siren.cpp
git commit -m "Add RelaySiren GPIO control with auto-off timer"
```

---

## Task 10: Firmware — CloudClient (FirebaseClient wrapper: token, SSE, event report)

**Files:**
- Create: `firmware/edge/device/src/cloud_client.h`
- Create: `firmware/edge/device/src/cloud_client.cpp`

**Interfaces:**
- Consumes: `ProvisionStore` (existing, `provision_store.h`) for
  `endpoint()`/`apiKey()`; the new `mintDeviceToken` endpoint from Task 4
  (a plain HTTPS POST, not part of `FirebaseClient` — use `WiFiClientSecure`
  + `HTTPClient` matching the pattern already available via
  ESP8266WiFi/ESP8266HTTPClient, both already linked per
  `provisioning_portal.cpp`'s use of `ESP8266WebServer`).
- Produces:
  ```cpp
  class CloudClient {
   public:
    // projectApiBase: the mintDeviceToken function's base URL; databaseUrl:
    // the project's RTDB URL; firebaseWebApiKey: public Web API key
    // (compile-time constant, safe to embed — see Task 11 note).
    bool begin(const String& mintTokenUrl, const String& databaseUrl,
               const String& firebaseWebApiKey, const String& deviceApiKey);

    // Non-blocking; call every loop() iteration to service FirebaseClient's
    // async tasks (auth refresh, stream reconnects).
    void loop();

    bool isReady() const; // true once authenticated and streams attached

    // Fire-and-forget event write to /{projectId}/events/{rfId}/{ts}.
    // No-op (silently skipped) if not yet authenticated — matches the
    // "no event buffering v1" decision.
    void reportEvent(const char* rfId, const char* event, bool batteryLow, int rssi);

    // Registered once in begin(); main.cpp polls these via getters rather
    // than a callback, to keep main.cpp's control flow linear.
    bool consumeArmedCommand(bool* armed);   // true if a new value arrived since last call
    bool consumeSirenCommand(bool* sirenOn); // true if a new value arrived since last call
    bool consumeConfigUpdate(Config* config); // true if a new config arrived since last call
  };
  ```
  Task 11 (`main.cpp`) owns one `CloudClient` instance, calls `begin()` once
  after WiFi connects, `loop()` every iteration, `reportEvent()` per decoded
  RF packet, and polls the three `consume*` methods each iteration to react
  to remote commands/config pushes.

This task is network/hardware-bound (real WiFi + real Firebase project) and
its actual runtime behavior can't be verified without the D1 Mini flashed
and connected. Code is written per the spec and the FirebaseClient examples
already reviewed during brainstorming; verification is manual, per Step 4.

- [ ] **Step 1: Write cloud_client.h**

```cpp
#pragma once

#include <Arduino.h>

#define ENABLE_CUSTOM_TOKEN
#define ENABLE_DATABASE
#include <FirebaseClient.h>

#include "alarm_state.h"

class CloudClient {
 public:
  bool begin(const String& mintTokenUrl, const String& databaseUrl,
             const String& firebaseWebApiKey, const String& deviceApiKey);
  void loop();
  bool isReady() const;

  void reportEvent(const char* rfId, const char* event, bool batteryLow, int rssi);

  bool consumeArmedCommand(bool* armed);
  bool consumeSirenCommand(bool* sirenOn);
  bool consumeConfigUpdate(Config* config);

 private:
  String mintTokenUrl_;
  String databaseUrl_;
  String deviceApiKey_;
  bool tokenMinted_ = false;
  String customTokenJwt_;

  SSL_CLIENT authSslClient_;
  SSL_CLIENT writeSslClient_;
  SSL_CLIENT commandsStreamSslClient_;
  SSL_CLIENT configStreamSslClient_;

  using AsyncClient = AsyncClientClass;
  AsyncClient authClient_{authSslClient_};
  AsyncClient writeClient_{writeSslClient_};
  AsyncClient commandsStreamClient_{commandsStreamSslClient_};
  AsyncClient configStreamClient_{configStreamSslClient_};

  FirebaseApp app_;
  RealtimeDatabase database_;

  AsyncResult commandsResult_;
  AsyncResult configResult_;

  bool pendingArmed_ = false;
  bool hasPendingArmed_ = false;
  bool pendingSiren_ = false;
  bool hasPendingSiren_ = false;
  bool hasPendingConfig_ = false;
  Config pendingConfig_;

  bool mintCustomToken();
  void onCommandsStream(AsyncResult& result);
  void onConfigStream(AsyncResult& result);
  bool parseConfigJson(const String& json, Config* out);
};
```

- [ ] **Step 2: Write cloud_client.cpp**

```cpp
#include "cloud_client.h"

#include <ArduinoJson.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>

bool CloudClient::mintCustomToken() {
  WiFiClientSecure client;
  client.setInsecure(); // TODO(hardware bring-up): pin the mintDeviceToken
                         // host's cert instead of setInsecure() before
                         // shipping past the bring-up phase.
  HTTPClient http;

  if (!http.begin(client, mintTokenUrl_)) return false;
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<128> reqDoc;
  reqDoc["apiKey"] = deviceApiKey_;
  String reqBody;
  serializeJson(reqDoc, reqBody);

  int status = http.POST(reqBody);
  if (status != 200) {
    http.end();
    return false;
  }

  String respBody = http.getString();
  http.end();

  StaticJsonDocument<2048> respDoc; // custom tokens are long signed JWTs
  DeserializationError err = deserializeJson(respDoc, respBody);
  if (err) return false;

  customTokenJwt_ = respDoc["customToken"].as<String>();
  return customTokenJwt_.length() > 0;
}

bool CloudClient::begin(const String& mintTokenUrl, const String& databaseUrl,
                         const String& firebaseWebApiKey, const String& deviceApiKey) {
  mintTokenUrl_ = mintTokenUrl;
  databaseUrl_ = databaseUrl;
  deviceApiKey_ = deviceApiKey;

  if (!mintCustomToken()) return false;
  tokenMinted_ = true;

  CustomToken customToken(firebaseWebApiKey, customTokenJwt_.c_str(), 3000);
  initializeApp(authClient_, app_, getAuth(customToken));

  app_.getApp<RealtimeDatabase>(database_);
  database_.url(databaseUrl_);

  commandsStreamSslClient_.setInsecure();
  configStreamSslClient_.setInsecure();
  writeSslClient_.setInsecure();
  authSslClient_.setInsecure();

  database_.get(
      commandsStreamClient_, "/commands", commandsResult_, true /* SSE */);
  database_.get(
      configStreamClient_, "/config", configResult_, true /* SSE */);

  return true;
}

void CloudClient::loop() {
  app_.loop();

  if (commandsResult_.isResult() && commandsResult_.available()) {
    onCommandsStream(commandsResult_);
  }
  if (configResult_.isResult() && configResult_.available()) {
    onConfigStream(configResult_);
  }
}

bool CloudClient::isReady() const {
  return tokenMinted_ && app_.ready();
}

void CloudClient::onCommandsStream(AsyncResult& result) {
  RealtimeDatabaseResult& stream = result.to<RealtimeDatabaseResult>();
  if (!stream.isStream()) return;

  String path = stream.dataPath();
  if (path.indexOf("armed") >= 0) {
    pendingArmed_ = stream.to<bool>();
    hasPendingArmed_ = true;
  } else if (path.indexOf("siren") >= 0) {
    pendingSiren_ = stream.to<bool>();
    hasPendingSiren_ = true;
  }
}

bool CloudClient::parseConfigJson(const String& json, Config* out) {
  StaticJsonDocument<4096> doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) return false;

  out->armed = doc["a"] | false;
  out->sirenDurationSec = doc["d"] | 0;

  JsonArray r = doc["r"];
  JsonArray c = doc["c"];
  if (r.isNull() || c.isNull() || r.size() != c.size()) return false;

  out->sensorCount = 0;
  for (size_t i = 0; i < r.size() && i < 16; i++) {
    SensorConfig& sensor = out->sensors[out->sensorCount];
    strncpy(sensor.rfId, r[i].as<const char*>(), sizeof(sensor.rfId) - 1);
    sensor.rfId[sizeof(sensor.rfId) - 1] = '\0';

    JsonArray conditions = c[i];
    sensor.conditionCount = 0;
    for (JsonVariant condJson : conditions) {
      if (sensor.conditionCount >= 4) break;
      Condition& cond = sensor.conditions[sensor.conditionCount];
      cond.t = condJson["t"] | 0;
      cond.n = condJson["n"] | 0;
      cond.w = condJson["w"] | 0;
      cond.y = condJson["y"] | 0;
      cond.kLen = 0;
      JsonObject k = condJson["k"];
      if (!k.isNull()) {
        for (JsonPair kv : k) {
          if (cond.kLen >= 8) break;
          cond.kIndex[cond.kLen] = (uint8_t)atoi(kv.key().c_str());
          cond.kCount[cond.kLen] = kv.value().as<uint16_t>();
          cond.kLen++;
        }
      }
      sensor.conditionCount++;
    }
    out->sensorCount++;
  }
  return true;
}

void CloudClient::onConfigStream(AsyncResult& result) {
  RealtimeDatabaseResult& stream = result.to<RealtimeDatabaseResult>();
  if (!stream.isStream()) return;

  String json = stream.to<String>();
  Config parsed;
  if (parseConfigJson(json, &parsed)) {
    pendingConfig_ = parsed;
    hasPendingConfig_ = true;
  }
}

bool CloudClient::consumeArmedCommand(bool* armed) {
  if (!hasPendingArmed_) return false;
  *armed = pendingArmed_;
  hasPendingArmed_ = false;
  return true;
}

bool CloudClient::consumeSirenCommand(bool* sirenOn) {
  if (!hasPendingSiren_) return false;
  *sirenOn = pendingSiren_;
  hasPendingSiren_ = false;
  return true;
}

bool CloudClient::consumeConfigUpdate(Config* config) {
  if (!hasPendingConfig_) return false;
  *config = pendingConfig_;
  hasPendingConfig_ = false;
  return true;
}

void CloudClient::reportEvent(const char* rfId, const char* event, bool batteryLow, int rssi) {
  if (!isReady()) return; // no buffering v1 — drop if not connected/authed

  StaticJsonDocument<128> doc;
  doc["event"] = event;
  doc["battery_low"] = batteryLow;
  doc["rssi"] = rssi;
  String json;
  serializeJson(doc, json);

  String path = String("/events/") + rfId + "/" + String(millis());
  object_t payload(json.c_str());
  database_.set<object_t>(writeClient_, path, payload);
}
```

Notes for the implementer, to resolve during hardware bring-up rather than
guessed here:
- `database_.url(databaseUrl_)` — confirm the exact RTDB base URL format
  `FirebaseClient` expects (with or without trailing slash, project-scoped
  vs full DB) against the library's `Set`/`Get` examples once building for
  real.
- `client.setInsecure()` appears three times as a bring-up shortcut (skips
  TLS cert validation) — flagged inline with a TODO; replace with proper
  cert pinning (`FirebaseClient` supports `setCACert` per its SSL client
  examples) before this leaves a bring-up/testing phase, since these
  connections carry the device's auth token.
- `mintCustomToken()` is called once in `begin()`. `FirebaseApp` handles
  session refresh internally after that (per the CustomToken example
  reviewed during brainstorming) — a full re-mint only happens on device
  reboot, which naturally re-runs `begin()`.

- [ ] **Step 3: Add FirebaseClient dependency (already staged in Task 6's platformio.ini edit)**

Confirm `mobizt/FirebaseClient@^2.0.0` is present in
`firmware/edge/device/platformio.ini`'s `lib_deps` (added in Task 6, Step
1). If the version constraint needs adjusting based on the latest release,
update it here.

Run: `cd firmware/edge/device && pio run -e d1_mini`
Expected: PASS (compiles) — this is the first task that actually compiles
`cloud_client.cpp` against the real ESP8266 toolchain, since `[env:native]`
doesn't build ESP8266-only files. This step is a compile check, not a
functional test (no real network/Firebase project involved).

- [ ] **Step 4: Manual verification (requires WiFi + a real/emulator Firebase project)**

Flash a temporary test build that calls `CloudClient::begin()` with a real
provisioned device's `mintTokenUrl`/`databaseUrl`/API key, then loops
`loop()` printing `isReady()` and any `consumeConfigUpdate`/
`consumeArmedCommand` results over Serial. Confirm: token mint succeeds,
streams attach, changing `/commands/armed` or `/config` in the Firebase
console (or via the web app) is reflected within a few seconds, and
`reportEvent()` calls show up under `/{projectId}/events` in the console.

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/cloud_client.h firmware/edge/device/src/cloud_client.cpp firmware/edge/device/platformio.ini
git commit -m "Add CloudClient: FirebaseClient-backed RTDB streams and event reporting"
```

---

## Task 11: Firmware — wire everything into main.cpp

**Files:**
- Modify: `firmware/edge/device/src/main.cpp`

**Interfaces:**
- Consumes: `AlarmState`/`Config` (Task 6), `EepromStore` (Task 7),
  `Cc1101Receiver` (Task 8), `RelaySiren` (Task 9), `CloudClient` (Task 10),
  and existing `ProvisionStore`/`ProvisioningPortal` (unmodified).
- Produces: the complete `onNormalOperation()` flow described in the spec's
  Data Flow section — this is the integration point; no later task consumes
  anything from this one.

This task's correctness depends on all of Tasks 6–10 being flashed together
on real hardware — it's the final integration step and is verified
end-to-end manually, not via automated tests (the pieces it wires together
already have their own unit/manual verification).

- [ ] **Step 1: Add GPIO pin constants and member instances**

In `firmware/edge/device/src/main.cpp`, inside the existing anonymous
namespace (after the current `kForcePortalPin`/`kWifiConnectTimeoutMs`
constants):

```cpp
#include "alarm_state.h"
#include "cc1101_receiver.h"
#include "cloud_client.h"
#include "eeprom_store.h"
#include "relay_siren.h"

namespace {
// ... existing kForcePortalPin, kWifiConnectTimeoutMs, provisionStore, portal, portalActive ...

const uint8_t kCc1101CsPin = 15;    // D8 — confirm against final wiring during hardware bring-up
const uint8_t kCc1101Gdo0Pin = 4;   // D2 — confirm against final wiring during hardware bring-up
const uint8_t kRelayPin = 5;        // D1 — confirm against final wiring during hardware bring-up

EepromStore eepromStore;
AlarmState alarmState;
Cc1101Receiver cc1101;
RelaySiren siren;
CloudClient cloudClient;

bool armed = false;
Config config;
}  // namespace
```

- [ ] **Step 2: Replace the onNormalOperation() stub**

Replace the existing stub:

```cpp
void onNormalOperation() {
  Serial.println("Entering normal operation");

  eepromStore.begin();
  if (!eepromStore.load(&armed, &config)) {
    Serial.println("No valid EEPROM state found — starting disarmed with empty config");
    armed = false;
    config = Config();
  }
  config.armed = armed;
  alarmState.setConfig(config);

  cc1101.begin(kCc1101CsPin, kCc1101Gdo0Pin);
  siren.begin(kRelayPin);

  String mintTokenUrl = provisionStore.endpoint() + "/mintDeviceToken";
  String databaseUrl = provisionStore.endpoint(); // TODO(hardware bring-up):
      // confirm whether provisionStore.endpoint() should hold the RTDB URL,
      // the Cloud Functions base URL, or both need to be provisioned
      // separately — the current provisioning portal (setup_page.h) only
      // captures one "endpoint" field; this may need a second field added
      // to ProvisionStore/ProvisioningPortal to hold the RTDB URL
      // distinctly from the mintDeviceToken function's base URL.
  cloudClient.begin(mintTokenUrl, databaseUrl, FIREBASE_WEB_API_KEY, provisionStore.apiKey());
}
```

Flag inline (as written above) the genuine open question about
`ProvisionStore` needing a second URL field — `endpoint()` currently holds
one value per `provision_store.h`, but this design needs both the
`mintDeviceToken` Cloud Function base URL and the RTDB database URL, which
are different hosts. Resolve by extending `ProvisionStore`/
`ProvisioningPortal`/`setup_page.h` with a second field (e.g. `databaseUrl`)
during this task's implementation, not deferred further — this is a small,
contained change to existing files, not a new open question for later.

Also add a compile-time constant near the top of `main.cpp` (or a new
`firmware_secrets.h`, gitignored, matching how `WIFI_SSID`-style secrets are
handled in the FirebaseClient examples reviewed earlier):

```cpp
#ifndef FIREBASE_WEB_API_KEY
#define FIREBASE_WEB_API_KEY "REPLACE_WITH_PROJECT_WEB_API_KEY"
#endif
```

- [ ] **Step 3: Extend loop() with the RF/alarm/cloud cycle**

Replace the existing `loop()`:

```cpp
void loop() {
  if (portalActive) {
    portal.handle();
    if (portal.hasPendingSave()) {
      String ssid, password, endpoint, apiKey;
      portal.takePendingSave(&ssid, &password, &endpoint, &apiKey);
      provisionStore.save(ssid, password, endpoint, apiKey);

      if (connectToWifi(ssid, password, kWifiConnectTimeoutMs)) {
        portal.stop();
        portalActive = false;
        onNormalOperation();
      } else {
        portal.showError();
      }
    }
    return;
  }

  unsigned long now = millis();

  KeruiPacket packet;
  int rssi;
  if (cc1101.poll(&packet, &rssi)) {
    char rfIdHex[9];
    snprintf(rfIdHex, sizeof(rfIdHex), "%06X", packet.sensorId);

    bool shouldFire = alarmState.onSensorEvent(rfIdHex, now);
    if (shouldFire) {
      siren.turnOn(config.sirenDurationSec, now);
    }
    cloudClient.reportEvent(rfIdHex, "trigger", packet.batteryLow, rssi);
  }

  if (alarmState.tickEntryDelay(now)) {
    siren.turnOn(config.sirenDurationSec, now);
  }
  siren.tick(now);

  cloudClient.loop();

  bool newArmed;
  if (cloudClient.consumeArmedCommand(&newArmed)) {
    armed = newArmed;
    config.armed = armed;
    alarmState.setConfig(config);
    if (!armed) {
      alarmState.disarm();
      siren.turnOff();
    }
    eepromStore.save(armed, config);
  }

  bool sirenCommandOn;
  if (cloudClient.consumeSirenCommand(&sirenCommandOn)) {
    if (sirenCommandOn) {
      siren.turnOn(config.sirenDurationSec, now);
    } else {
      siren.turnOff();
    }
  }

  Config newConfig;
  if (cloudClient.consumeConfigUpdate(&newConfig)) {
    newConfig.armed = armed; // armed is tracked separately from config pushes
    config = newConfig;
    alarmState.setConfig(config);
    eepromStore.save(armed, config);
  }
}
```

- [ ] **Step 4: Build for the real target**

Run: `cd firmware/edge/device && pio run -e d1_mini`
Expected: PASS (compiles cleanly).

- [ ] **Step 5: Manual end-to-end verification (requires full hardware: D1 Mini, CC1101, relay, siren, WiFi, provisioned project)**

Flash the complete firmware to a D1 Mini already provisioned via the
existing WiFi portal flow. Confirm, in order: (a) boots into normal
operation using EEPROM state after a previous run, even with WiFi
disconnected; (b) triggering a real Kerui sensor while armed and matching a
configured condition fires the relay/siren; (c) the same trigger appears
under `/{projectId}/events` in the Firebase console within a few seconds
once WiFi is up; (d) toggling armed/siren via the web app or Telegram bot
is reflected on the device (siren stops, arm state changes) within a few
seconds; (e) power-cycling the device without WiFi available still restores
the last-known armed state and config from EEPROM.

- [ ] **Step 6: Commit**

```bash
git add firmware/edge/device/src/main.cpp
git commit -m "Wire RF decode, alarm evaluation, siren, and cloud sync into main loop"
```

---

## Self-Review Notes

- **Spec coverage:** CC1101 receive (Task 8), Kerui decode reuse (Task 8),
  alarm condition evaluation for all four types (Task 6), EEPROM
  arm+config persistence surviving reboot offline (Task 7, wired in Task
  11), relay siren with auto-off and disable-via-zero-duration (Task 9),
  FirebaseClient CustomToken auth + SSE commands/config + direct event
  write (Task 10), `deviceIngest` untouched (verified — no task modifies
  it), thin index-based config format on both wire and EEPROM (Tasks 1–3
  backend, Task 6 firmware struct, Task 10 parse/encode symmetry), backend
  `mintDeviceToken` + RTDB rules (Tasks 4–5) — all covered.
- **Known gap surfaced during planning, not deferred silently:** the
  `ProvisionStore` single-`endpoint()` field doesn't cleanly cover both the
  `mintDeviceToken` HTTPS base URL and the RTDB database URL — Task 11
  explicitly calls this out as something to resolve by extending
  `ProvisionStore` during that task, not left as a TODO comment in shipped
  code.
- **Type consistency:** `Config`/`SensorConfig`/`Condition` struct shapes
  introduced in Task 6 are reused verbatim (same field names) by Task 7
  (EEPROM encode/decode), Task 10 (`parseConfigJson`), and Task 11
  (`main.cpp`) — no renaming drift.
- **Hardware-bound tasks (8, 9, 10, 11)** cannot carry automated tests per
  this project's constraints (no CC1101/relay/real Firebase project in CI);
  each has an explicit manual verification step instead, consistent with
  the spec's Testing section.
