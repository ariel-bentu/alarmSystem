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
