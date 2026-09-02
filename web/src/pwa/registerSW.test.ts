// Tests for the service-worker update prompt.
//
// This is the one piece of PWA plumbing with real user consequences: the app
// ships with registerType "prompt" precisely so a new bundle never swaps in
// underneath someone mid-arm, which means the banner IS the update mechanism.
// If it silently stops rendering, users sit on a stale build indefinitely and
// nothing else in the app would notice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The virtual module only exists in a real Vite build, so it is mocked here.
// registerSW() returns the updateSW function the banner's button calls.
interface RegisterOptions {
  onNeedRefresh?: () => void;
}

const updateSW = vi.fn();
const registerSW = vi.fn((_opts?: RegisterOptions) => updateSW);
vi.mock("virtual:pwa-register", () => ({
  registerSW: (opts?: RegisterOptions) => registerSW(opts),
}));

import { registerServiceWorker } from "./registerSW";

// Pull the onNeedRefresh callback the module handed to registerSW, then fire
// it — this is what workbox does when a new SW is waiting.
function triggerNeedRefresh(): void {
  const opts = registerSW.mock.calls.at(-1)?.[0];
  opts?.onNeedRefresh?.();
}

const banner = () => document.getElementById("sw-update-banner");

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  // The module short-circuits in dev; these tests exercise the built path.
  vi.stubEnv("DEV", false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("registerServiceWorker", () => {
  it("registers the service worker in a production build", () => {
    registerServiceWorker();
    expect(registerSW).toHaveBeenCalledOnce();
  });

  it("does not register in dev", () => {
    vi.stubEnv("DEV", true);
    registerServiceWorker();
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("shows no banner until a new version is waiting", () => {
    registerServiceWorker();
    expect(banner()).toBeNull();
  });

  it("shows a banner with a reload button when an update is waiting", () => {
    registerServiceWorker();
    triggerNeedRefresh();

    const el = banner();
    expect(el).not.toBeNull();
    // role=status so a screen reader announces it without stealing focus.
    expect(el).toHaveAttribute("role", "status");
    expect(el?.textContent).toContain("A new version is available.");
    expect(
      el?.querySelector("button")?.textContent
    ).toBe("Reload");
  });

  it("applies the update when the reload button is clicked", () => {
    registerServiceWorker();
    triggerNeedRefresh();

    banner()?.querySelector("button")?.click();

    // true = reload the page once the new SW takes control. Passing false (or
    // nothing) would activate the worker but leave the stale bundle running.
    expect(updateSW).toHaveBeenCalledOnce();
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it("does not stack duplicate banners if onNeedRefresh fires twice", () => {
    registerServiceWorker();
    triggerNeedRefresh();
    triggerNeedRefresh();

    expect(document.querySelectorAll("#sw-update-banner")).toHaveLength(1);
  });

  it("uses Hebrew copy when the document is in Hebrew", () => {
    document.documentElement.lang = "he";
    registerServiceWorker();
    triggerNeedRefresh();

    const el = banner();
    expect(el?.textContent).toContain("קיימת גרסה חדשה.");
    expect(el?.querySelector("button")?.textContent).toBe("רענון");
  });
});
