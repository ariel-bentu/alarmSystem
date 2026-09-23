// Best-effort disarm straight to the device over the LAN, fired alongside the
// cloud command rather than instead of it.
//
// Why bother: when the siren is sounding by mistake, the wait is the device's
// command poll (5s, 1s while alarming). Hitting the firmware's own /disarm
// endpoint skips Firebase entirely. That endpoint already exists and already
// silences — LocalWebServer::handleDisarm queues applyArmedCommand(false),
// which calls siren.turnOff(). No firmware change backs this file.
//
// IMPORTANT — this path is inert on the deployed site. Browsers block
// plain-HTTP requests from an HTTPS page as mixed content, and that check
// happens before the request reaches the network, so no fetch option can opt
// out of it. `alarm.local` is an mDNS name, not localhost, so it gets no
// secure-origin exemption. It therefore only actually fires when the app is
// served over plain HTTP on the LAN. It is kept because it costs nothing when
// blocked and the cloud write below it always does the real work.
//
// Everything here is shaped so the caller cannot be harmed: void return,
// no throw, no unhandled rejection, no hanging socket.
export const LOCAL_DEVICE_ORIGIN = "http://alarm.local";

// Long enough for a device on the same LAN to answer, short enough that an
// unresolvable name does not leave the request pending. Nothing waits on this,
// so the timeout only bounds resource use, never the UI.
//
// 5s, not 2s: measured on a real LAN, the ESP32 sometimes needs more than 2s to
// answer and then succeeds — 2s was aborting requests that would have worked.
// The device is single-threaded and its loop() does RF decode, cloud polling and
// EEPROM work between handleClient() calls, so a slow answer is normal rather
// than a sign of trouble. mDNS resolution of alarm.local adds to it.
export const TIMEOUT_MS = 5000;

/**
 * Whether an arm-grid press should also try the LAN.
 *
 * Only a device-side disarm. Arming is excluded deliberately: the device's
 * local endpoints are unauthenticated by design (LAN-only, see CLAUDE.md), and
 * an arm is not something to issue silently over an unauthenticated channel —
 * whereas a disarm that the cloud is about to send anyway grants nothing new.
 * Server-side presses change what the cloud evaluates and have no LAN meaning.
 *
 * Extracted so the rule is testable without mounting OperationsPage, which
 * needs Firestore, RTDB and auth context.
 */
export function shouldTryLocalDisarm({
  side,
  profileId,
}: {
  side: "device" | "server";
  profileId: string | null;
}): boolean {
  return side === "device" && profileId === null;
}

export function postLocalDisarm(fetchImpl: typeof fetch = fetch): void {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    void fetchImpl(`${LOCAL_DEVICE_ORIGIN}/disarm`, {
      method: "POST",
      // Opaque by design: we cannot read the response cross-origin and do not
      // need to, which is also what keeps CORS headers out of the firmware and
      // a preflight off the single-threaded ESP32 web server.
      mode: "no-cors",
      // Disarm is often the last tap before the phone is pocketed.
      keepalive: true,
      signal: controller.signal,
    })
      .catch(() => {
        // Unreachable device, aborted timeout, blocked request — all expected,
        // all indistinguishable, none actionable. The cloud write is the path
        // that reports success or failure to the user.
      })
      .finally(() => clearTimeout(timer));
  } catch {
    // A blocked call can throw synchronously rather than reject. Caught for
    // the same reason as above: this function must never affect its caller.
  }
}
