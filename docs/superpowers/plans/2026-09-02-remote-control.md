# Remote Control Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pair 433MHz 4-button remotes so they arm, disarm, and trigger SOS directly on the device, working fully offline once paired.

**Architecture:** The remote is a fixed-code EV1527-family device already decodable by `kerui_decoder.h`. Its 24-bit code splits into a 20-bit identity (top) and a one-hot button nibble (bottom). `pollCc1101` splits every decoded packet; a packet whose identity matches a paired remote dispatches to arm/disarm/SOS and returns early, never reaching the sensor path. Identities live in EEPROM so the feature survives a WiFi outage.

**Tech Stack:** C++17 (ESP32-S3, PlatformIO, Unity native tests), TypeScript (Firebase Cloud Functions gen-2, Vitest), React + TypeScript (Vite).

**Spec:** `docs/superpowers/specs/2026-09-02-remote-control-design.md`

## Global Constraints

- Firmware builds MUST pass `-e esp32s3` explicitly: a bare `pio run` also builds `[env:native]`, which fails to link.
- Native tests run with `pio test -e native` from `firmware/edge/device`. Baseline is **44 tests across 5 suites**; this plan adds a 6th suite.
- Button nibble mapping is fixed and NOT configurable: `0x1` = S (ignored), `0x2` = disarm, `0x4` = arm, `0x8` = SOS.
- Remote identity is the **top 20 bits**: `identity = sensorId >> 4`. Never store or match the full 24-bit code.
- Max **8** remotes. This is not arbitrary: `EepromStore` has exactly 64 bytes of headroom and 8 remotes cost `8*4 + 1 = 33` bytes. 16 would cost 65 and overflow. Do NOT raise the cap without changing `kReservedBytes`, whose sizing has a documented heap/stack history.
- `kMagic` MUST bump from `0xA1A2B3B6` to `0xA1A2B3B7` when `Config` changes size, or old EEPROM records are misread rather than rejected.
- RTDB config keys are single letters (`a`, `d`, `e`, `r`, `c`); remotes use `m`. Missing `m` MUST parse as zero remotes, never as a parse failure.
- Never validate the Kerui decoder against the EV1527 siren encoder. They are different protocols sharing one chip.
- The W184 hub relays remote presses to the siren during testing. Hub identity `0x3F010` is NOT a remote. Do not bind to codes observed while the hub relays.

---

### Task 1: Notify on device-originated arm/disarm

Fixes a pre-existing gap: `onArmStateChange` triggers on `commands/armed` (the web app's intent channel), but device-originated arm/disarm writes `state/armed`, which nothing watches. Disarming via `alarm.local` is currently silent — no Telegram, no timeline. The remote's security mitigation depends on this working, so it lands first and is independently useful.

**Files:**
- Create: `functions/src/onDeviceArmStateChange.ts`
- Create: `functions/src/onDeviceArmStateChange.test.ts`
- Modify: `functions/src/index.ts` (add export)
- Modify: `functions/src/telegram.ts` (add `formatArmStateBySource`)
- Modify: `functions/src/telegram.test.ts` (tests for the new formatter)

**Interfaces:**
- Consumes: `sendTelegram(token, chatId, text, silent)` and `formatArmState(armed, side?, profileName?)` from `./telegram`; `db` from `./admin`.
- Produces: `shouldSuppressDeviceArmNotification(commandsArmed: boolean | null, stateArmed: boolean): boolean` — exported for testing. `formatArmStateBySource(armed: boolean, source: string | null): string`.

- [ ] **Step 1: Write the failing test for the suppression rule**

Create `functions/src/onDeviceArmStateChange.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { shouldSuppressDeviceArmNotification } from "./onDeviceArmStateChange";

describe("shouldSuppressDeviceArmNotification", () => {
  it("suppresses when commands/armed already matches — cloud-initiated, already reported", () => {
    expect(shouldSuppressDeviceArmNotification(true, true)).toBe(true);
    expect(shouldSuppressDeviceArmNotification(false, false)).toBe(true);
  });

  it("does not suppress when they differ — device-initiated", () => {
    expect(shouldSuppressDeviceArmNotification(true, false)).toBe(false);
    expect(shouldSuppressDeviceArmNotification(false, true)).toBe(false);
  });

  it("does not suppress when commands/armed is absent", () => {
    expect(shouldSuppressDeviceArmNotification(null, true)).toBe(false);
    expect(shouldSuppressDeviceArmNotification(null, false)).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing test for the source-aware formatter**

Append to `functions/src/telegram.test.ts`:

```typescript
import { formatArmStateBySource } from "./telegram";

describe("formatArmStateBySource", () => {
  it("names the remote as the disarm source", () => {
    expect(formatArmStateBySource(false, "remote")).toBe("🔓 Disarmed by remote");
  });

  it("names the local web UI as the disarm source", () => {
    expect(formatArmStateBySource(false, "local")).toBe("🔓 Disarmed from local web UI");
  });

  it("names the remote when arming", () => {
    expect(formatArmStateBySource(true, "remote")).toBe("🔒 Armed by remote");
  });

  it("falls back to a generic message for an unknown source", () => {
    expect(formatArmStateBySource(false, null)).toBe("🔓 Device disarmed");
    expect(formatArmStateBySource(true, "wat")).toBe("🔒 Device armed");
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd functions && npx vitest run onDeviceArmStateChange telegram`
Expected: FAIL — `shouldSuppressDeviceArmNotification` and `formatArmStateBySource` are not exported.

- [ ] **Step 4: Implement the formatter**

Append to `functions/src/telegram.ts`:

```typescript
// Names WHO armed/disarmed when the change originated on the device rather
// than in the web app. "Who disarmed my house" is the security-relevant
// question a fixed-code remote cannot answer any other way — a replayed
// disarm cannot be prevented, so it must at least be attributed.
export function formatArmStateBySource(
  armed: boolean,
  source: string | null
): string {
  const icon = armed ? "🔒" : "🔓";
  const verb = armed ? "Armed" : "Disarmed";
  if (source === "remote") return `${icon} ${verb} by remote`;
  if (source === "local") return `${icon} ${verb} from local web UI`;
  return `${icon} Device ${verb.toLowerCase()}`;
}
```

- [ ] **Step 5: Implement the function**

Create `functions/src/onDeviceArmStateChange.ts`:

```typescript
// Cloud Function: onDeviceArmStateChange
// Trigger: RTDB onValueWritten on /{projectId}/state/armed
//
// state/armed is the ECHO channel: the device writes it after it acts,
// whatever the source. onArmStateChange covers only commands/armed, the
// web app's INTENT channel, so before this function a disarm originating
// on the device (local web UI, remote) produced no Telegram and no
// timeline entry at all.

import { onValueWritten } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { Project, AlarmEvent } from "./types";
import { sendTelegram, formatArmStateBySource } from "./telegram";

/**
 * A cloud-initiated arm/disarm writes commands/armed first; the device then
 * echoes the SAME value to state/armed, which would double-notify. When the
 * two already agree the change was cloud-initiated and onArmStateChange has
 * reported it. Only a device-originated change leaves them differing.
 */
export function shouldSuppressDeviceArmNotification(
  commandsArmed: boolean | null,
  stateArmed: boolean
): boolean {
  if (commandsArmed === null) return false;
  return commandsArmed === stateArmed;
}

export const onDeviceArmStateChange = onValueWritten(
  { ref: "/{projectId}/state/armed", region: "europe-west1" },
  async (event) => {
    const after = event.data.after.val();
    const before = event.data.before.val();
    if (after === before) return;

    const projectId = event.params.projectId;
    const armed = after === true;

    const commandsSnap = await rtdb.ref(`${projectId}/commands/armed`).get();
    const commandsArmed = commandsSnap.exists()
      ? commandsSnap.val() === true
      : null;
    if (shouldSuppressDeviceArmNotification(commandsArmed, armed)) return;

    const sourceSnap = await rtdb.ref(`${projectId}/state/armed_by`).get();
    const source = sourceSnap.exists() ? String(sourceSnap.val()) : null;

    const alarmEvent: Omit<AlarmEvent, "id"> = {
      sensorId: "",
      rfId: "",
      sensorName: source === "remote" ? "Remote" : "Device",
      eventType: armed ? "armed" : "disarmed",
      batteryLow: false,
      rssi: 0,
      timestamp: Timestamp.now(),
    };
    await db.collection(`projects/${projectId}/events`).add(alarmEvent);

    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) return;
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;
    if (!project.telegramBotToken || !project.telegramChatId) return;

    await sendTelegram(
      project.telegramBotToken,
      project.telegramChatId,
      formatArmStateBySource(armed, source),
      true // arm/disarm is a notice, not a demand for attention
    );
  }
);
```

- [ ] **Step 6: Export the function**

In `functions/src/index.ts`, after the `onArmStateChange` export on line 7:

```typescript
export { onDeviceArmStateChange } from "./onDeviceArmStateChange";
```

- [ ] **Step 7: Run tests and typecheck**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: PASS, all suites.

- [ ] **Step 8: Commit**

```bash
git add functions/src/onDeviceArmStateChange.ts functions/src/onDeviceArmStateChange.test.ts functions/src/index.ts functions/src/telegram.ts functions/src/telegram.test.ts
git commit -m "feat: notify on device-originated arm/disarm

state/armed had no trigger, so disarming via alarm.local produced no
Telegram and no timeline entry. Adds onDeviceArmStateChange with
suppression so cloud-initiated changes are not reported twice."
```

---

### Task 2: Remote code decode (identity/nibble split)

Pure logic, no hardware, no I/O. Establishes the vocabulary every later task uses.

**Files:**
- Create: `firmware/edge/device/src/remote_control.h`
- Create: `firmware/edge/device/src/remote_control.cpp`
- Create: `firmware/edge/device/test/test_remote_control/test_remote_control.cpp`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `enum class RemoteAction : uint8_t { None = 0, ArmHome, Disarm, Arm, Sos }`
  - `uint32_t remoteIdentityOf(uint32_t code)` — returns `code >> 4`
  - `uint8_t remoteNibbleOf(uint32_t code)` — returns `code & 0xF`
  - `RemoteAction remoteActionFor(uint8_t nibble)`

- [ ] **Step 1: Write the failing tests**

Create `firmware/edge/device/test/test_remote_control/test_remote_control.cpp`:

```cpp
#include <unity.h>
#include "remote_control.h"

// Measured from real hardware: remote 0xE45CA, buttons observed as
// nibble 0x2 (disarm) and 0x4 (arm). See the design doc.
void test_splits_measured_code_into_identity_and_nibble() {
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA2));
  TEST_ASSERT_EQUAL_HEX8(0x2, remoteNibbleOf(0xE45CA2));

  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA4));
  TEST_ASSERT_EQUAL_HEX8(0x4, remoteNibbleOf(0xE45CA4));
}

void test_all_four_buttons_share_one_identity() {
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA1));
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA2));
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA4));
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA8));
}

void test_maps_each_nibble_to_its_action() {
  TEST_ASSERT_EQUAL(RemoteAction::ArmHome, remoteActionFor(0x1));
  TEST_ASSERT_EQUAL(RemoteAction::Disarm,  remoteActionFor(0x2));
  TEST_ASSERT_EQUAL(RemoteAction::Arm,     remoteActionFor(0x4));
  TEST_ASSERT_EQUAL(RemoteAction::Sos,     remoteActionFor(0x8));
}

// The nibble is one-hot. A multi-bit or zero value is a corrupt decode or a
// device that is not this kind of remote; guessing an action from it could
// disarm the house on noise.
void test_rejects_non_one_hot_nibbles() {
  TEST_ASSERT_EQUAL(RemoteAction::None, remoteActionFor(0x0));
  TEST_ASSERT_EQUAL(RemoteAction::None, remoteActionFor(0x3));
  TEST_ASSERT_EQUAL(RemoteAction::None, remoteActionFor(0x6));
  TEST_ASSERT_EQUAL(RemoteAction::None, remoteActionFor(0xF));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_splits_measured_code_into_identity_and_nibble);
  RUN_TEST(test_all_four_buttons_share_one_identity);
  RUN_TEST(test_maps_each_nibble_to_its_action);
  RUN_TEST(test_rejects_non_one_hot_nibbles);
  return UNITY_END();
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd firmware/edge/device && pio test -e native -f test_remote_control`
Expected: FAIL — `remote_control.h` does not exist.

- [ ] **Step 3: Write the header**

Create `firmware/edge/device/src/remote_control.h`:

```cpp
#pragma once

#include <cstdint>

// A 433MHz 4-button remote in the same fixed-code EV1527 family as the
// Kerui sensors: one 24-bit code per press, where the TOP 20 BITS are the
// remote's identity and the BOTTOM NIBBLE is which button, one-hot.
//
// Measured on real hardware (see docs/superpowers/specs/
// 2026-09-02-remote-control-design.md): remote 0xE45CA emits 0xE45CA2 for
// disarm and 0xE45CA4 for arm.
//
// NOTE: this is the same wire format the Kerui sensor decoder produces, so
// the receive path is shared. It is NOT the EV1527 framing we TRANSMIT to
// the siren — never validate one against the other.

enum class RemoteAction : uint8_t {
  None = 0,   // not a recognised button
  ArmHome,    // "S" — decoded deliberately, but does nothing (see design doc)
  Disarm,
  Arm,        // arms with the CURRENT config; does not select a profile
  Sos,
};

// Top 20 bits: stable per remote, shared by all four buttons.
inline uint32_t remoteIdentityOf(uint32_t code) { return code >> 4; }

// Bottom 4 bits: which button.
inline uint8_t remoteNibbleOf(uint32_t code) {
  return static_cast<uint8_t>(code & 0xF);
}

// Map a button nibble to its action. The nibble is ONE-HOT; anything else
// is a corrupt decode and returns None rather than a guessed action.
RemoteAction remoteActionFor(uint8_t nibble);
```

- [ ] **Step 4: Write the implementation**

Create `firmware/edge/device/src/remote_control.cpp`:

```cpp
#include "remote_control.h"

RemoteAction remoteActionFor(uint8_t nibble) {
  switch (nibble) {
    case 0x1: return RemoteAction::ArmHome;
    case 0x2: return RemoteAction::Disarm;
    case 0x4: return RemoteAction::Arm;
    case 0x8: return RemoteAction::Sos;
    // Deliberately no default guess: a multi-bit nibble means the decode is
    // corrupt, and inferring "probably disarm" from noise would unlock the
    // house.
    default:  return RemoteAction::None;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd firmware/edge/device && pio test -e native -f test_remote_control`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add firmware/edge/device/src/remote_control.h firmware/edge/device/src/remote_control.cpp firmware/edge/device/test/test_remote_control/
git commit -m "feat: decode remote identity and button nibble"
```

---

### Task 3: Store remotes in Config + EEPROM

**Files:**
- Modify: `firmware/edge/device/src/alarm_state.h` (add fields to `Config`, update `static_assert`)
- Modify: `firmware/edge/device/src/eeprom_store.h` (bump `kMagic`)
- Modify: `firmware/edge/device/test/test_eeprom_store/test_eeprom_store.cpp` (round-trip test)

**Interfaces:**
- Consumes: `Config` from Task 2's sibling header (`alarm_state.h`).
- Produces: `Config::remotes[8]` (`uint32_t`, 20-bit identities, 0 = empty) and `Config::remoteCount` (`uint8_t`), persisted verbatim by `EepromStore`.

- [ ] **Step 1: Write the failing round-trip test**

Append to `firmware/edge/device/test/test_eeprom_store/test_eeprom_store.cpp`, and add the `RUN_TEST` line to its `main()`:

```cpp
void test_round_trips_paired_remotes() {
  Config config;
  config.remoteCount = 2;
  config.remotes[0] = 0xE45CA;
  config.remotes[1] = 0x1234A;

  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(false, true, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = true;
  bool localWebOut = false;
  Config configOut;
  TEST_ASSERT_TRUE(
      EepromStore::decode(buffer, written, &armedOut, &localWebOut, &configOut));

  TEST_ASSERT_EQUAL(2, configOut.remoteCount);
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, configOut.remotes[0]);
  TEST_ASSERT_EQUAL_HEX32(0x1234A, configOut.remotes[1]);
}

// The whole record must still fit the reserved region. kReservedBytes is
// sized with only 64 bytes of headroom and its sizing has a documented
// heap/stack history — 8 remotes (33 bytes) fit; raising the cap would not.
void test_record_still_fits_reserved_region() {
  TEST_ASSERT_LESS_OR_EQUAL(EepromStore::kReservedBytes,
                            EepromStore::kRecordBytes);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd firmware/edge/device && pio test -e native -f test_eeprom_store`
Expected: FAIL — `Config` has no member `remotes`.

- [ ] **Step 3: Add the fields to Config**

In `firmware/edge/device/src/alarm_state.h`, inside `struct Config`, after `sensorCount`:

```cpp
  // Paired remote-control identities (TOP 20 BITS of the 24-bit code; the
  // bottom nibble is the button and is never stored). 0 = empty slot.
  //
  // Capped at 8 by the EEPROM budget, not by preference: EepromStore has
  // exactly 64 bytes of headroom and 8 remotes cost 8*4+1 = 33. Sixteen
  // would cost 65 and overflow it — see EepromStore::kReservedBytes, whose
  // size has a documented heap/stack history. Do not raise this cap without
  // reading that comment.
  static constexpr uint8_t kMaxRemotes = 8;
  uint32_t remotes[kMaxRemotes] = {};
  uint8_t remoteCount = 0;
```

- [ ] **Step 4: Update the size assertion**

Still in `alarm_state.h`, replace the existing `static_assert(sizeof(Config) == 2416, ...)` line with:

```cpp
// Config is persisted verbatim to EEPROM by EepromStore, so its size is part
// of the on-flash format. Was 2416 before `remotes`/`remoteCount` were added
// (8 * uint32_t + uint8_t + padding). If this fails, bump EepromStore::kMagic
// so stale config is discarded rather than misread as the new layout.
static_assert(sizeof(Config) == 2452, "EEPROM layout changed - bump kMagic");
```

Note: 2452 is the expected value (2416 + 32 + 1, rounded up to 4-byte alignment). If the compiler reports a different size, use the reported value — the point of the assertion is that the number is pinned, not that this prediction was right.

- [ ] **Step 5: Bump the magic**

In `firmware/edge/device/src/eeprom_store.h`, replace the `kMagic` line and extend its comment:

```cpp
  // Bumped from 0xA1A2B3B6 — adding Config::remotes/remoteCount changed
  // sizeof(Config), so records written by earlier firmware must be rejected
  // rather than misread. A magic mismatch is decode()'s rejection mechanism.
  // Cost: on the first boot after flashing, stored config is discarded and
  // the device starts disarmed with an empty config, then re-pulls from the
  // cloud. Same one-time cost as when sirenBaseAddress was added.
  static constexpr uint32_t kMagic = 0xA1A2B3B7;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS. If the `static_assert` fails, set the asserted size to the compiler-reported value and re-run.

- [ ] **Step 7: Commit**

```bash
git add firmware/edge/device/src/alarm_state.h firmware/edge/device/src/eeprom_store.h firmware/edge/device/test/test_eeprom_store/
git commit -m "feat: persist paired remote identities to EEPROM

Capped at 8 by the existing 64-byte EEPROM headroom. kMagic bumped so
records from older firmware are rejected rather than misread."
```

---

### Task 4: Remote registry — lookup and pairing rules

Pure logic over `Config`, so it is fully unit-testable with no hardware. Keeps the pairing policy (refuse while armed, idempotent, capacity) out of `main.cpp`.

**Files:**
- Modify: `firmware/edge/device/src/remote_control.h`
- Modify: `firmware/edge/device/src/remote_control.cpp`
- Modify: `firmware/edge/device/test/test_remote_control/test_remote_control.cpp`

**Interfaces:**
- Consumes: `Config` from `alarm_state.h`; `remoteIdentityOf` from Task 2.
- Produces:
  - `bool remoteIsPaired(const Config& config, uint32_t identity)`
  - `enum class RemotePairResult : uint8_t { Paired = 0, AlreadyPaired, RefusedArmed, Full }`
  - `RemotePairResult remotePair(Config* config, uint32_t identity, bool armed)`

- [ ] **Step 1: Write the failing tests**

Append to `firmware/edge/device/test/test_remote_control/test_remote_control.cpp`, adding each `RUN_TEST` to `main()`:

```cpp
void test_recognises_a_paired_identity() {
  Config config;
  config.remoteCount = 1;
  config.remotes[0] = 0xE45CA;

  TEST_ASSERT_TRUE(remoteIsPaired(config, 0xE45CA));
  TEST_ASSERT_FALSE(remoteIsPaired(config, 0x3F010));
}

void test_pairs_an_unknown_remote() {
  Config config;
  TEST_ASSERT_EQUAL(RemotePairResult::Paired,
                    remotePair(&config, 0xE45CA, /*armed=*/false));
  TEST_ASSERT_EQUAL(1, config.remoteCount);
  TEST_ASSERT_TRUE(remoteIsPaired(config, 0xE45CA));
}

// Pairing is idempotent so a user mashing the button does not consume slots.
void test_pairing_the_same_remote_twice_is_a_no_op() {
  Config config;
  remotePair(&config, 0xE45CA, false);
  TEST_ASSERT_EQUAL(RemotePairResult::AlreadyPaired,
                    remotePair(&config, 0xE45CA, false));
  TEST_ASSERT_EQUAL(1, config.remoteCount);
}

// Otherwise anyone in RF range could pair their own remote to an armed
// system and then disarm it.
void test_refuses_to_pair_while_armed() {
  Config config;
  TEST_ASSERT_EQUAL(RemotePairResult::RefusedArmed,
                    remotePair(&config, 0xE45CA, /*armed=*/true));
  TEST_ASSERT_EQUAL(0, config.remoteCount);
}

void test_refuses_to_pair_when_full() {
  Config config;
  for (uint8_t i = 0; i < Config::kMaxRemotes; i++) {
    TEST_ASSERT_EQUAL(RemotePairResult::Paired,
                      remotePair(&config, 0x10000 + i, false));
  }
  TEST_ASSERT_EQUAL(RemotePairResult::Full,
                    remotePair(&config, 0xE45CA, false));
  TEST_ASSERT_EQUAL(Config::kMaxRemotes, config.remoteCount);
}

// Any one button pairs the whole remote, because identity is shared.
void test_pairing_from_any_button_covers_all_buttons() {
  Config config;
  remotePair(&config, remoteIdentityOf(0xE45CA8), false); // paired via SOS
  TEST_ASSERT_TRUE(remoteIsPaired(config, remoteIdentityOf(0xE45CA2)));
  TEST_ASSERT_TRUE(remoteIsPaired(config, remoteIdentityOf(0xE45CA4)));
}
```

Add `#include "alarm_state.h"` to the test file's includes.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd firmware/edge/device && pio test -e native -f test_remote_control`
Expected: FAIL — `remoteIsPaired` not declared.

- [ ] **Step 3: Declare the registry API**

Append to `firmware/edge/device/src/remote_control.h` (and add `#include "alarm_state.h"` at the top):

```cpp
// Why pairing was refused. Distinguishable so the UI can say which.
enum class RemotePairResult : uint8_t {
  Paired = 0,
  AlreadyPaired,  // idempotent success
  RefusedArmed,
  Full,
};

// Is this identity one of the paired remotes?
bool remoteIsPaired(const Config& config, uint32_t identity);

// Adopt `identity` as a paired remote.
//
// Refused while armed: an attacker in RF range could otherwise pair their
// own remote against an armed system and immediately disarm it. Idempotent,
// so repeated presses during the pairing window do not consume slots.
// Caller is responsible for persisting `config` afterwards.
RemotePairResult remotePair(Config* config, uint32_t identity, bool armed);
```

- [ ] **Step 4: Implement the registry**

Append to `firmware/edge/device/src/remote_control.cpp`:

```cpp
bool remoteIsPaired(const Config& config, uint32_t identity) {
  // identity 0 is the empty-slot marker, never a real remote.
  if (identity == 0) return false;
  for (uint8_t i = 0; i < config.remoteCount && i < Config::kMaxRemotes; i++) {
    if (config.remotes[i] == identity) return true;
  }
  return false;
}

RemotePairResult remotePair(Config* config, uint32_t identity, bool armed) {
  if (armed) return RemotePairResult::RefusedArmed;
  if (remoteIsPaired(*config, identity)) return RemotePairResult::AlreadyPaired;
  if (config->remoteCount >= Config::kMaxRemotes) return RemotePairResult::Full;
  config->remotes[config->remoteCount++] = identity;
  return RemotePairResult::Paired;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd firmware/edge/device && pio test -e native -f test_remote_control`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add firmware/edge/device/src/remote_control.h firmware/edge/device/src/remote_control.cpp firmware/edge/device/test/test_remote_control/
git commit -m "feat: remote registry with pairing rules

Refuses pairing while armed so an attacker in RF range cannot pair
their own remote to an armed system."
```

---

### Task 5: Dispatch remote presses in the firmware

Wires the pure logic into the live receive path. The critical property: a paired remote's packet returns early and never reaches `handleSensorEvent()`, so a remote can never trigger an alarm rule or be logged as a sensor trigger.

**Files:**
- Modify: `firmware/edge/device/src/main.cpp:250-264` (`pollCc1101`)
- Modify: `firmware/edge/device/src/cloud_client.h` (declare `reportAlarmLabel`)
- Modify: `firmware/edge/device/src/cloud_client.cpp` (implement `reportAlarmLabel`)

**Interfaces:**
- Consumes: `remoteIdentityOf`, `remoteNibbleOf`, `remoteActionFor`, `remoteIsPaired`, `RemoteAction` (Tasks 2, 4); `applyArmedCommand(bool)` at `main.cpp:232`; `siren.turnOn(uint16_t, unsigned long)`.
- Produces: `void CloudClient::reportAlarmLabel(const char* label)`; `bool handleRemotePacket(uint32_t code, unsigned long now)` in `main.cpp` (returns true when the packet was a paired remote's and must not fall through).

- [ ] **Step 1: Declare reportAlarmLabel**

In `firmware/edge/device/src/cloud_client.h`, after the `reportAlarm` declaration (line 68):

```cpp
  // Report an alarm that has no sensor behind it (SOS from a remote).
  // Writes /{projectId}/state/alarm_cause as {label, at} — the shape
  // alarmCause.ts already supports, where a label wins outright over rfId
  // mapping — then sets /state/siren_active true, exactly like
  // reportAlarm(). Do NOT pass a remote's raw code to reportAlarm()
  // instead: it would make the Telegram alert name an unpaired sensor.
  // No-op if not yet authenticated.
  void reportAlarmLabel(const char* label);
```

- [ ] **Step 2: Implement reportAlarmLabel**

In `firmware/edge/device/src/cloud_client.cpp`, immediately after the existing `reportAlarm` definition. Mirror that function's structure exactly — same client-open guard, same ordering of `alarm_cause` before `siren_active` (the ordering matters: `onAlarm` triggers on `siren_active`, so the cause must already be present), substituting a `{label, at}` payload for `{rfId, ct, at}`.

- [ ] **Step 3: Add the dispatch helper**

In `firmware/edge/device/src/main.cpp`, immediately BEFORE `pollCc1101` (line 249), add. Note `__attribute__((noinline))` — it carries a `Config`-touching frame and follows the same cont-stack discipline documented on `handleSensorEvent`:

```cpp
// Route a decoded packet that belongs to a paired remote. Returns true when
// the packet was consumed, so the caller must NOT fall through to the sensor
// path — a remote must never be able to trigger an alarm rule.
__attribute__((noinline))
bool handleRemotePacket(uint32_t code, unsigned long now) {
  uint32_t identity = remoteIdentityOf(code);
  if (!remoteIsPaired(config, identity)) return false;

  RemoteAction action = remoteActionFor(remoteNibbleOf(code));
  Serial.printf("[remote] 0x%05X button=0x%X action=%d\n", identity,
                remoteNibbleOf(code), (int)action);

  switch (action) {
    case RemoteAction::Arm:
      // Arms with whatever config is currently loaded. The remote does NOT
      // select a profile — see the design doc.
      armedBySource = "remote";
      applyArmedCommand(true);
      break;
    case RemoteAction::Disarm:
      armedBySource = "remote";
      applyArmedCommand(false);
      break;
    case RemoteAction::Sos:
      // Fires regardless of arm state — a panic button gated on armed is
      // useless. Still honours sirenEnabled, which is a noise preference.
      if (config.sirenEnabled) {
        siren.turnOn(config.sirenDurationSec, now);
      }
      cloudClient.reportAlarmLabel("SOS (remote)");
      alarmReportedToCloud = true;
      break;
    case RemoteAction::ArmHome:
      // "S" is decoded deliberately and does nothing, so an unmapped button
      // is visibly ignored rather than silently falling through to the
      // sensor path.
      Serial.println("[remote] arm-home (S) ignored");
      break;
    case RemoteAction::None:
      Serial.println("[remote] unrecognised button nibble, ignored");
      break;
  }
  return true;
}
```

- [ ] **Step 4: Call it from pollCc1101**

In `firmware/edge/device/src/main.cpp`, inside `pollCc1101`, insert between the existing `Serial.printf("[cc1101] packet ...")` call and the `snprintf(rfIdHex, ...)` line:

```cpp
  // Before the sensor path: a paired remote is a CONTROL device, not a
  // trigger. Returning here keeps it out of handleSensorEvent entirely, so
  // it cannot satisfy an alarm rule or be written to /events as a trigger.
  if (handleRemotePacket(packet.sensorId, now)) return;
```

- [ ] **Step 5: Add the include and the source variable**

At the top of `main.cpp`, with the other `src/` includes:

```cpp
#include "remote_control.h"
```

Near the `bool armed = false;` declaration (line 64), add:

```cpp
// Which input last changed the arm state, reported to state/armed_by so the
// Telegram alert can name it ("remote" vs "local"). A fixed-code remote is
// replayable, so attribution is the only available mitigation.
const char* armedBySource = "cloud";
```

- [ ] **Step 6: Report the source alongside armed state**

In `applyArmedCommand` (`main.cpp:232`), replace the `cloudClient.reportArmedState(armed);` line with a call that also writes the source. Add to `CloudClient::reportArmedState` an optional second parameter `const char* source = nullptr`; when non-null it writes `/{projectId}/state/armed_by`. Write `armed_by` BEFORE `armed`, so `onDeviceArmStateChange` (Task 1) always finds the source already present when it fires — the same ordering discipline `reportAlarm` uses for `alarm_cause` before `siren_active`.

- [ ] **Step 7: Build for hardware**

Run: `cd firmware/edge/device && pio run -e esp32s3`
Expected: SUCCESS. (`-e esp32s3` is required; a bare `pio run` also builds `[env:native]`, which fails to link.)

- [ ] **Step 8: Run native tests**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS, all suites.

- [ ] **Step 9: Commit**

```bash
git add firmware/edge/device/src/main.cpp firmware/edge/device/src/cloud_client.h firmware/edge/device/src/cloud_client.cpp
git commit -m "feat: dispatch remote presses to arm/disarm/SOS

Paired remotes return early from pollCc1101 so they can never reach the
sensor path or satisfy an alarm rule."
```

---

### Task 6: Pairing window and local endpoint

**Files:**
- Modify: `firmware/edge/device/src/main.cpp`
- Modify: `firmware/edge/device/src/local_web_server.h`
- Modify: `firmware/edge/device/src/local_web_server.cpp`
- Modify: `firmware/edge/device/src/local_web_page.h`

**Interfaces:**
- Consumes: `remotePair`, `RemotePairResult` (Task 4); `handleRemotePacket` (Task 5).
- Produces: `bool LocalWebServer::takePendingRemotePair()`; `void LocalWebServer::setRemotePairStatus(const char* status)`; `unsigned long remotePairUntilMs` in `main.cpp`.

- [ ] **Step 1: Add the pairing window state**

In `main.cpp`, near `armedBySource`:

```cpp
// Non-blocking remote pairing window. Deliberately NOT modelled on
// runSirenPairing(), which blocks the loop for 10s and leaves the alarm deaf
// to sensors — flagged as a real weakness in todo.txt's stability review.
// Remote pairing is receive-only, so it needs no blocking at all: it is a
// deadline checked inside the packet path.
unsigned long remotePairUntilMs = 0;
static constexpr unsigned long kRemotePairWindowMs = 30000;
```

- [ ] **Step 2: Adopt unknown codes during the window**

In `handleRemotePacket` (Task 5), insert at the very top, before the `remoteIsPaired` check:

```cpp
  if (remotePairUntilMs != 0) {
    if ((long)(now - remotePairUntilMs) >= 0) {
      remotePairUntilMs = 0;  // window expired
    } else {
      uint32_t identity = remoteIdentityOf(code);
      RemotePairResult result = remotePair(&config, identity, armed);
      switch (result) {
        case RemotePairResult::Paired:
          eepromStore.save(armed, localWebEnabled, config);
          cloudClient.reportEvent("REMOTE", "paired", false, 0);
          Serial.printf("[remote] paired 0x%05X\n", identity);
          remotePairUntilMs = 0;
          localWebServer.setRemotePairStatus("paired");
          return true;
        case RemotePairResult::AlreadyPaired:
          remotePairUntilMs = 0;
          localWebServer.setRemotePairStatus("already paired");
          break;  // fall through to normal dispatch
        case RemotePairResult::RefusedArmed:
          remotePairUntilMs = 0;
          localWebServer.setRemotePairStatus("refused: system armed");
          Serial.println("[remote] pairing refused — system is armed");
          break;
        case RemotePairResult::Full:
          remotePairUntilMs = 0;
          localWebServer.setRemotePairStatus("refused: no free slots");
          Serial.println("[remote] pairing refused — all 8 slots used");
          break;
      }
    }
  }
```

- [ ] **Step 3: Add the local endpoint**

In `local_web_server.h` add `bool takePendingRemotePair();`, `void setRemotePairStatus(const char* status);`, plus private members `bool pendingRemotePair_ = false;` and `String remotePairStatus_;`.

In `local_web_server.cpp`, register `POST /pair-remote` alongside the existing routes in `begin()`, following the exact shape of the existing `handlePairSiren`. The handler sets `pendingRemotePair_ = true` and responds `200` with the current status. `takePendingRemotePair()` returns the flag and clears it, matching `takePendingArmCommand()`.

Add a "Pair remote" button to `local_web_page.h` next to the existing siren-pair control, POSTing to `/pair-remote`, with helper text: *"Press any button on the remote within 30 seconds."*

- [ ] **Step 4: Open the window from the loop**

In `loop()`, beside the existing `takePendingArmCommand` / `takePendingTrigger` handling (around `main.cpp:822`):

```cpp
      if (localWebServer.takePendingRemotePair()) {
        if (armed) {
          localWebServer.setRemotePairStatus("refused: system armed");
          Serial.println("[remote] pair request refused — system is armed");
        } else {
          remotePairUntilMs = now + kRemotePairWindowMs;
          localWebServer.setRemotePairStatus("waiting for a button press");
          Serial.println("[remote] pairing window open for 30s");
        }
      }
```

- [ ] **Step 5: Build and test**

Run: `cd firmware/edge/device && pio run -e esp32s3 && pio test -e native`
Expected: both SUCCESS/PASS.

- [ ] **Step 6: Commit**

```bash
git add firmware/edge/device/src/main.cpp firmware/edge/device/src/local_web_server.h firmware/edge/device/src/local_web_server.cpp firmware/edge/device/src/local_web_page.h
git commit -m "feat: non-blocking remote pairing window with LAN endpoint

Receive-only, so unlike siren pairing it never blocks the loop. Refused
while armed."
```

---

### Task 7: Push remotes from the cloud

**Files:**
- Modify: `functions/src/types.ts` (`RtdbConfig.m`, `Remote` interface)
- Modify: `functions/src/buildConfig.ts`
- Modify: `functions/src/buildConfig.test.ts`
- Modify: `functions/src/onProfileChange.ts` (`rebuildConfig` loads remotes)
- Modify: `firmware/edge/device/src/config_parser.cpp`
- Modify: `firmware/edge/device/test/test_config_parser/test_config_parser.cpp`

**Interfaces:**
- Consumes: `buildRtdbConfig(rules, sensors, armed, sirenDurationSec, sirenEnabled, alwaysRules)` — gains a 7th parameter `remotes: Remote[] = []`.
- Produces: `RtdbConfig.m?: number[]`; `Config::remotes`/`remoteCount` populated by `ConfigParser::parseConfigJson`.

- [ ] **Step 1: Write the failing functions test**

Append to `functions/src/buildConfig.test.ts`:

```typescript
it("emits paired remote identities as numbers in m", () => {
  const config = buildRtdbConfig([], [], false, 120, true, [], [
    { id: "r1", identity: "0xE45CA", name: "Keyfob", pairedAt: null as never, lastSeen: null },
  ]);
  expect(config.m).toEqual([0xe45ca]);
});

it("omits m entirely when no remotes are paired", () => {
  const config = buildRtdbConfig([], [], false, 120, true, [], []);
  expect(config.m).toBeUndefined();
});
```

- [ ] **Step 2: Write the failing firmware parser test**

Append to `firmware/edge/device/test/test_config_parser/test_config_parser.cpp`, adding the `RUN_TEST` lines to `main()`:

```cpp
void test_parses_remote_identities() {
  const char* json = "{\"a\":false,\"d\":120,\"e\":true,\"m\":[938442,74570]}";
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL(2, out.remoteCount);
  TEST_ASSERT_EQUAL_HEX32(0xE51CA, out.remotes[0]);
  TEST_ASSERT_EQUAL_HEX32(0x1234A, out.remotes[1]);
}

// RTDB drops empty arrays on .set(), so an absent m must mean "no remotes",
// never a parse failure — the same contract r/c already have.
void test_absent_m_means_zero_remotes() {
  const char* json = "{\"a\":false,\"d\":120,\"e\":true}";
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL(0, out.remoteCount);
}

// A malicious or corrupt config must not overflow the fixed array.
void test_clamps_excess_remotes_to_capacity() {
  const char* json =
      "{\"a\":false,\"d\":120,\"e\":true,"
      "\"m\":[1,2,3,4,5,6,7,8,9,10,11,12]}";
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL(Config::kMaxRemotes, out.remoteCount);
}
```

The literal `938442` is `0xE51CA` and `74570` is `0x1234A`; keep them consistent if edited.

- [ ] **Step 3: Run both to verify they fail**

Run: `cd functions && npx vitest run buildConfig`
Run: `cd firmware/edge/device && pio test -e native -f test_config_parser`
Expected: both FAIL.

- [ ] **Step 4: Add the types**

In `functions/src/types.ts`, add `m?: number[]; // paired remote identities (20-bit)` to `RtdbConfig`, and:

```typescript
export interface Remote {
  id: string;
  identity: string; // hex, 20-bit, e.g. "0xE45CA" — no button nibble
  name: string;
  pairedAt: Timestamp;
  lastSeen: Timestamp | null;
}
```

Mirror the `Remote` interface into `web/src/types/index.ts` (the two are kept in sync manually, per that file's header comment).

- [ ] **Step 5: Emit m from buildRtdbConfig**

Add a 7th parameter `remotes: Remote[] = []`. Before the return, parse each `identity` with `parseInt(identity, 16)`, drop any `NaN`, and include `...(ids.length > 0 ? { m: ids } : {})` in the returned object. Spread rather than assigning `undefined` — RTDB rejects `undefined` values outright, and an explicit `m: undefined` shows up in `toEqual` comparisons (the same reason `toRtdbCondition` already spreads `x`).

- [ ] **Step 6: Load remotes in rebuildConfig**

In `onProfileChange.ts`, before the `buildRtdbConfig` call, read `projects/{projectId}/remotes` and pass the docs through. Also add the collection to the early-return branch: a project with no active profile and no always-rules currently writes a thin `{a, d, e}` config — it must still carry `m`, or pairing a remote to an otherwise-empty project would silently fail to reach the device.

- [ ] **Step 7: Parse m in the firmware**

In `config_parser.cpp`, after the `r`/`c` handling:

```cpp
  out->remoteCount = 0;
  JsonArray m = doc["m"];
  if (!m.isNull()) {
    for (JsonVariant v : m) {
      if (out->remoteCount >= Config::kMaxRemotes) break;  // clamp, never overflow
      out->remotes[out->remoteCount++] = v.as<uint32_t>();
    }
  }
```

- [ ] **Step 8: Verify everything passes**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Run: `cd firmware/edge/device && pio test -e native && pio run -e esp32s3`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add functions/src/types.ts functions/src/buildConfig.ts functions/src/buildConfig.test.ts functions/src/onProfileChange.ts firmware/edge/device/src/config_parser.cpp firmware/edge/device/test/test_config_parser/ web/src/types/index.ts
git commit -m "feat: push paired remotes to the device via config.m"
```

---

### Task 8: Remotes UI

**Files:**
- Create: `web/src/features/configure/RemotesTab.tsx`
- Create: `web/src/features/configure/remotes.ts` (pure helpers)
- Create: `web/src/features/configure/remotes.test.ts`
- Modify: the Configure area's tab list (follow `ProfilesTab.tsx`'s registration)

**Interfaces:**
- Consumes: `Remote` from `web/src/types`; existing Firestore helpers in `web/src/lib`.
- Produces: `formatRemoteIdentity(identity: string): string`; `REMOTE_BUTTON_LEGEND` (a readonly array of `{ nibble, label, action }`).

- [ ] **Step 1: Write the failing helper tests**

Create `web/src/features/configure/remotes.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatRemoteIdentity, REMOTE_BUTTON_LEGEND } from "./remotes";

describe("formatRemoteIdentity", () => {
  it("normalises to uppercase 5-digit hex with a 0x prefix", () => {
    expect(formatRemoteIdentity("0xe45ca")).toBe("0xE45CA");
    expect(formatRemoteIdentity("e45ca")).toBe("0xE45CA");
  });
});

describe("REMOTE_BUTTON_LEGEND", () => {
  it("documents all four buttons, with S explicitly unused", () => {
    expect(REMOTE_BUTTON_LEGEND).toHaveLength(4);
    const s = REMOTE_BUTTON_LEGEND.find((b) => b.nibble === 0x1);
    expect(s?.action).toBe("Not used");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run remotes`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `web/src/features/configure/remotes.ts`:

```typescript
// The button mapping is fixed in firmware (remote_control.cpp) and is NOT
// configurable. Shown in the UI because users will ask what each button
// does — especially "S", which is decoded deliberately but does nothing.
export const REMOTE_BUTTON_LEGEND = [
  { nibble: 0x4, label: "Arm", action: "Arms with the active profile" },
  { nibble: 0x2, label: "Disarm", action: "Disarms" },
  { nibble: 0x8, label: "SOS / bell", action: "Sounds the siren immediately" },
  { nibble: 0x1, label: "S", action: "Not used" },
] as const;

/** Normalise a 20-bit identity to the canonical "0xE45CA" display form. */
export function formatRemoteIdentity(identity: string): string {
  const bare = identity.replace(/^0x/i, "");
  return `0x${bare.toUpperCase().padStart(5, "0")}`;
}
```

- [ ] **Step 4: Build the tab**

Create `RemotesTab.tsx` following `ProfilesTab.tsx`'s structure and i18n conventions:
- List paired remotes: name, `formatRemoteIdentity(identity)`, last seen, unpair
- "Pair remote" writes `commands/pair_remote` with a nonce and an `until` ~30s ahead (mirror the siren-pair command shape), then prompts *"Press any button on the remote"* and watches the `remotes` collection for the new document
- Render `REMOTE_BUTTON_LEGEND` as a static table
- Disable the pair button while the system is armed, with a tooltip explaining that pairing is refused while armed — the device enforces this too, but the UI should not offer an action that will be rejected

- [ ] **Step 5: Verify**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/configure/RemotesTab.tsx web/src/features/configure/remotes.ts web/src/features/configure/remotes.test.ts web/src/types/index.ts
git commit -m "feat: remotes pairing UI"
```

---

### Task 9: Hardware verification

RF behaviour has no substitute for hardware. **This task is manual and its result must be reported honestly — a skipped check is a failed check.**

**Files:**
- Create: `docs/testing-remote-control.md`
- Modify: `CLAUDE.md` (Status section)

- [ ] **Step 1: Flash**

```bash
cd firmware/edge/device
ls /dev/cu.*   # macOS reassigns the suffix; confirm before flashing
pio run -e esp32s3 -t upload --upload-port /dev/cu.usbmodem101
```

Expect the `kMagic` bump to discard stored config on this first boot: the device starts disarmed with an empty config and re-pulls from the cloud. This is expected, not a fault.

- [ ] **Step 2: Pair**

With the system **disarmed**, open `http://alarm.local`, click "Pair remote", press any button within 30s. Confirm the serial log shows `[remote] paired 0x…` and the identity matches the top 20 bits of the codes in `/events`.

- [ ] **Step 3: Verify each button**

Monitor with `python3 ../read_serial.py 60 --port /dev/cu.usbmodem101` (`--port` is required) and check:

| Button | Expected |
|---|---|
| arm | device arms; `state/armed` true; Telegram "Armed by remote" |
| disarm | device disarms; siren stops; Telegram "Disarmed by remote" |
| SOS | siren sounds even while disarmed; `alarm_cause` = `SOS (remote)` |
| S | serial logs "arm-home (S) ignored"; nothing else changes |

- [ ] **Step 4: Verify the isolation property**

Confirm a paired remote's presses produce **no** `trigger` events under `/events/{code}`. This is the property that stops a remote satisfying an alarm rule; if it fails, stop and fix before continuing.

- [ ] **Step 5: Verify offline operation**

Power down the router (or disable the AP). Confirm arm, disarm, and SOS still work from EEPROM with no cloud. This is the core requirement.

- [ ] **Step 6: Verify pairing is refused while armed**

Arm the system, attempt to pair. Expect refusal in both the UI and the serial log.

- [ ] **Step 7: Verify the local-disarm notification**

Disarm via `http://alarm.local` (not the remote, not the app). Confirm Telegram says "Disarmed from local web UI" — this is the Task 1 gap fix, verified end to end.

- [ ] **Step 8: Write the testing doc and update status**

Record what was verified, what was not, and any surprises in `docs/testing-remote-control.md`. Update `CLAUDE.md`'s Status section. Add a "Remote control" row to the history table only if the investigation produced findings worth preserving.

- [ ] **Step 9: Commit**

```bash
git add docs/testing-remote-control.md CLAUDE.md
git commit -m "docs: remote control hardware verification"
```

---

## Known interactions

- **The W184 hub still relays remote presses to the siren.** During testing the siren may sound from the hub rather than from our device. Not a defect; do not chase it. It stops when the hub is decommissioned.
- **Device stability is an open risk.** The controller went silent for 31.76h ending 2026-09-02 16:17 (second occurrence; ~28h previously), root cause unresolved. A failure during Task 9 may be that crash rather than this feature — check `state/boot.reason` in RTDB **before** resetting the board, since resetting destroys the evidence.
