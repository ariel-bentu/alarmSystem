// The siren-duration half of the old settingsForm.test.ts. "Server triggers
// siren" was a checkbox there and is one here too, but it saves on change
// now, so it is no longer form state and has no isDirty case.
import { describe, it, expect } from "vitest";
import { type SirenForm, formFromProject, isDirty } from "./sirenSettings";

const base: SirenForm = { sirenDurationSec: 120 };

describe("isDirty", () => {
  it("is false when nothing has changed", () => {
    expect(isDirty(base, { ...base })).toBe(false);
  });

  it("detects a changed duration", () => {
    expect(isDirty(base, { sirenDurationSec: 60 })).toBe(true);
  });

  it("is false again once the duration is changed back", () => {
    expect(isDirty(base, { sirenDurationSec: 60 })).toBe(true);
    expect(isDirty(base, { sirenDurationSec: 120 })).toBe(false);
  });

  // 0 is a meaningful value (sound until told to stop), not an empty field,
  // so it must register as a real change rather than be treated as absent.
  it("detects a change to zero", () => {
    expect(isDirty(base, { sirenDurationSec: 0 })).toBe(true);
  });
});

describe("formFromProject", () => {
  it("reads the project's duration", () => {
    expect(formFromProject({ sirenDurationSec: 90 })).toEqual({
      sirenDurationSec: 90,
    });
  });
});
