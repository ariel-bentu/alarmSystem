// The LAN disarm path exists to be fast and to be ignorable. Every test here
// is really one assertion: nothing this module does can affect the caller.
// The cloud write is what actually disarms; this is a best-effort shortcut
// alongside it, so a failure of any shape must be indistinguishable from
// success from the outside.
import { describe, it, expect, vi } from "vitest";
import {
  postLocalDisarm,
  shouldTryLocalDisarm,
  LOCAL_DEVICE_ORIGIN,
  TIMEOUT_MS,
} from "./localDevice";

describe("TIMEOUT_MS", () => {
  it("allows at least 5s, because 2s aborted requests that would have worked", () => {
    // Measured on a real LAN: the ESP32 sometimes answers later than 2s and
    // then succeeds. Its loop() interleaves RF decode, cloud polling and EEPROM
    // writes with handleClient(), and mDNS resolution adds more, so a slow
    // answer is normal. Pinned because nothing waits on this timeout — shrinking
    // it buys nothing and silently costs working disarms.
    expect(TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });
});

describe("shouldTryLocalDisarm", () => {
  it("fires on a device-side disarm", () => {
    expect(shouldTryLocalDisarm({ side: "device", profileId: null })).toBe(true);
  });

  it("does not fire when arming the device", () => {
    // The device's LAN endpoints are unauthenticated; a disarm the cloud is
    // about to send anyway grants nothing, an arm would.
    expect(shouldTryLocalDisarm({ side: "device", profileId: "home" })).toBe(
      false
    );
  });

  it("does not fire for either server-side press", () => {
    // Server arming changes what the cloud evaluates. There is no LAN
    // equivalent, so the device endpoint would be answering a question it was
    // never asked.
    expect(shouldTryLocalDisarm({ side: "server", profileId: null })).toBe(
      false
    );
    expect(shouldTryLocalDisarm({ side: "server", profileId: "home" })).toBe(
      false
    );
  });
});

describe("postLocalDisarm", () => {
  // Typed as fetch itself so mock.calls carries fetch's real parameter tuple,
  // which is what lets the assertions below read url/init without casting.
  const mockFetch = (impl: typeof fetch) => vi.fn<typeof fetch>(impl);
  const ok: typeof fetch = () => Promise.resolve(new Response());

  it("posts to the device's existing /disarm endpoint", () => {
    const fetchImpl = mockFetch(ok);
    postLocalDisarm(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${LOCAL_DEVICE_ORIGIN}/disarm`);
    expect(init?.method).toBe("POST");
  });

  it("sends opaquely, because the reply is neither readable nor needed", () => {
    // no-cors keeps the device free of CORS headers: the firmware answers a
    // bare "ok" and we never look at it. It also avoids a preflight, which a
    // single-threaded ESP32 web server would have to answer before the POST.
    const fetchImpl = mockFetch(ok);
    postLocalDisarm(fetchImpl);

    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.mode).toBe("no-cors");
    // The disarm press can be the last thing before the tab is backgrounded
    // or closed; keepalive keeps the request alive past that.
    expect(init?.keepalive).toBe(true);
    // An unresolvable alarm.local must not leave a socket pending forever.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns void, so no caller can await it", () => {
    // A promise return would invite `await postLocalDisarm()`, which would put
    // the LAN round-trip back in front of the cloud write this runs alongside.
    expect(postLocalDisarm(mockFetch(ok))).toBeUndefined();
  });

  it("swallows a rejected request", async () => {
    // The normal offline case: alarm.local does not resolve.
    const fetchImpl = mockFetch(() =>
      Promise.reject(new TypeError("Failed to fetch"))
    );
    expect(() => postLocalDisarm(fetchImpl)).not.toThrow();
    // Flush the microtask queue: an unhandled rejection would surface here.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("swallows a synchronous throw", () => {
    // Mixed-content blocking (an HTTPS page calling http://alarm.local) can
    // throw rather than return a pending promise, and a blocked call must be
    // exactly as harmless as an unreachable one.
    const fetchImpl = mockFetch(() => {
      throw new TypeError("Mixed Content: blocked");
    });
    expect(() => postLocalDisarm(fetchImpl)).not.toThrow();
  });
});
