// The project-name half of the old settingsForm.test.ts. The timezone cases
// moved out with the control: it saves on change now, so it is not form state
// and has no isDirty behaviour to pin. GeneralTab still applies the
// browser's-zone fallback it used to test, at the point it seeds the select.
import { describe, it, expect } from "vitest";
import { type GeneralForm, formFromProject, isDirty } from "./generalSettings";

const base: GeneralForm = { name: "Home" };

describe("isDirty", () => {
  it("is false when nothing has changed", () => {
    expect(isDirty(base, { ...base })).toBe(false);
  });

  it("detects a changed name", () => {
    expect(isDirty(base, { name: "Office" })).toBe(true);
  });

  it("is false again once the name is changed back", () => {
    expect(isDirty(base, { name: "Office" })).toBe(true);
    expect(isDirty(base, { name: "Home" })).toBe(false);
  });

  // Trailing whitespace is stripped on save, so "  Home  " would otherwise
  // enable Save and then write a value identical to what was already stored.
  it("ignores leading/trailing whitespace", () => {
    expect(isDirty(base, { name: "  Home  " })).toBe(false);
  });

  it("treats a whitespace-only change to an empty name as clean", () => {
    expect(isDirty({ name: "" }, { name: "   " })).toBe(false);
  });
});

describe("formFromProject", () => {
  it("reads the project's name", () => {
    expect(formFromProject({ name: "Home" })).toEqual({ name: "Home" });
  });
});
