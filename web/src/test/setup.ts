import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

// Tests assert on English copy. Without pinning this, the language resolves
// from navigator.languages and localStorage, so the suite would pass or fail
// depending on the machine's locale and on leftover state from an earlier
// test. Pin both before every test.
//
// Guarded because pure-logic suites run without a DOM, where neither global
// exists.
beforeEach(() => {
  if (typeof localStorage !== "undefined" && localStorage?.clear) {
    localStorage.clear();
  }
  if (typeof navigator !== "undefined") {
    Object.defineProperty(navigator, "languages", {
      value: ["en-US"],
      configurable: true,
    });
  }
});
