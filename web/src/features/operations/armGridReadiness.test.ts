// Rules for what the Operations page may claim, and what it may let you press,
// while device state is still loading.
//
// The page paints its controls immediately rather than behind a spinner, so
// these predicates are what stop "renders early" from becoming "lies early".
// They are pure so the rules can be pinned down without mounting the page,
// which needs Firestore, RTDB and auth context.
import { describe, it, expect } from "vitest";
import {
  armedBadgeState,
  isArmButtonEnabled,
  isDisarmButtonEnabled,
  isProfileActive,
} from "./armGridReadiness";

describe("armedBadgeState", () => {
  it("reports unknown while device state is loading", () => {
    // Never "disarmed": that is a claim about the house, and getting it wrong
    // tells someone their alarm is off when it may be on.
    expect(armedBadgeState({ loading: true, armed: null })).toBe("unknown");
    expect(armedBadgeState({ loading: true, armed: false })).toBe("unknown");
    expect(armedBadgeState({ loading: true, armed: true })).toBe("unknown");
  });

  it("reports the real state once loaded", () => {
    expect(armedBadgeState({ loading: false, armed: true })).toBe("armed");
    expect(armedBadgeState({ loading: false, armed: false })).toBe("disarmed");
  });

  it("treats a missing value as unknown, not disarmed", () => {
    expect(armedBadgeState({ loading: false, armed: null })).toBe("unknown");
  });
});

describe("isDisarmButtonEnabled", () => {
  // The whole point of the early paint: someone walking in the door can hit
  // disarm before the page has finished loading. Safe because the write is
  // idempotent (commands/armed=false plus an explicit commands/siren=false).
  it("is enabled while device state is still loading", () => {
    expect(
      isDisarmButtonEnabled({ canArm: true, busy: false, stateKnown: false })
    ).toBe(true);
  });

  it("is enabled once state is known", () => {
    expect(
      isDisarmButtonEnabled({ canArm: true, busy: false, stateKnown: true })
    ).toBe(true);
  });

  it("is disabled while a write is in flight", () => {
    expect(
      isDisarmButtonEnabled({ canArm: true, busy: true, stateKnown: true })
    ).toBe(false);
  });

  it("is disabled when the user cannot arm (offline or read-only)", () => {
    expect(
      isDisarmButtonEnabled({ canArm: false, busy: false, stateKnown: false })
    ).toBe(false);
  });
});

describe("isArmButtonEnabled", () => {
  // Arming is not idempotent: arming a house already armed to another profile
  // silently swaps which rules are live, so it waits for known state.
  it("is disabled while device state is still loading", () => {
    expect(
      isArmButtonEnabled({ canArm: true, busy: false, stateKnown: false })
    ).toBe(false);
  });

  it("is enabled once state is known", () => {
    expect(
      isArmButtonEnabled({ canArm: true, busy: false, stateKnown: true })
    ).toBe(true);
  });

  it("is disabled while a write is in flight", () => {
    expect(
      isArmButtonEnabled({ canArm: true, busy: true, stateKnown: true })
    ).toBe(false);
  });
});

describe("isProfileActive", () => {
  it("marks nothing active while state is unknown", () => {
    // A highlighted button means "this is the current state". With the state
    // unknown there is no honest highlight, so the grid shows none.
    expect(
      isProfileActive({ stateKnown: false, activeId: "night", id: "night" })
    ).toBe(false);
  });

  it("marks the active profile once state is known", () => {
    expect(
      isProfileActive({ stateKnown: true, activeId: "night", id: "night" })
    ).toBe(true);
    expect(
      isProfileActive({ stateKnown: true, activeId: "night", id: "home" })
    ).toBe(false);
  });

  it("marks disarmed active only when state is known", () => {
    expect(
      isProfileActive({ stateKnown: false, activeId: null, id: null })
    ).toBe(false);
    expect(isProfileActive({ stateKnown: true, activeId: null, id: null })).toBe(
      true
    );
  });
});
