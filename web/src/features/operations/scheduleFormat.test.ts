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
