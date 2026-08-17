import { describe, it, expect } from "vitest";
import { parseCommand } from "./parseCommand";

describe("parseCommand", () => {
  it("parses /arm", () => {
    expect(parseCommand("/arm")).toEqual({ cmd: "arm" });
  });

  it("parses /disarm", () => {
    expect(parseCommand("/disarm")).toEqual({ cmd: "disarm" });
  });

  it("parses /status", () => {
    expect(parseCommand("/status")).toEqual({ cmd: "status" });
  });

  it("parses /siren off", () => {
    expect(parseCommand("/siren off")).toEqual({ cmd: "siren_off" });
  });

  it("returns unknown for unrecognised commands", () => {
    expect(parseCommand("/foo")).toEqual({ cmd: "unknown" });
    expect(parseCommand("hello")).toEqual({ cmd: "unknown" });
    expect(parseCommand("")).toEqual({ cmd: "unknown" });
  });

  it("handles leading/trailing whitespace", () => {
    expect(parseCommand("  /arm  ")).toEqual({ cmd: "arm" });
    expect(parseCommand(" /siren off ")).toEqual({ cmd: "siren_off" });
  });

  it("is case-insensitive", () => {
    expect(parseCommand("/ARM")).toEqual({ cmd: "arm" });
    expect(parseCommand("/Disarm")).toEqual({ cmd: "disarm" });
    expect(parseCommand("/SIREN OFF")).toEqual({ cmd: "siren_off" });
  });
});
