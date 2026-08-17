import { describe, it, expect } from "vitest";
import { decideProvision } from "./provisionLogic";

describe("decideProvision", () => {
  it("bootstraps the very first user when the collection is empty", () => {
    expect(
      decideProvision({ usersCollectionEmpty: true, userDocExists: false })
    ).toEqual({ action: "bootstrap" });
  });

  it("bootstraps even if a doc somehow exists but collection is 'empty' guard wins", () => {
    // Emptiness takes precedence — the first successful writer wins the race.
    expect(
      decideProvision({ usersCollectionEmpty: true, userDocExists: true })
    ).toEqual({ action: "bootstrap" });
  });

  it("allows a known user", () => {
    expect(
      decideProvision({ usersCollectionEmpty: false, userDocExists: true })
    ).toEqual({ action: "allow" });
  });

  it("denies an unknown user when the collection is non-empty", () => {
    expect(
      decideProvision({ usersCollectionEmpty: false, userDocExists: false })
    ).toEqual({ action: "deny" });
  });
});
