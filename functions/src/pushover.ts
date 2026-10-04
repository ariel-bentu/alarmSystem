// Pushover sender. Same shape as telegram.ts: one fetch sender plus pure,
// unit-tested helpers.
//
// WHY PUSHOVER AT ALL: a muted iPhone (the ringer switch, not Do Not Disturb)
// silences every Telegram notification, and no chat or Focus setting changes
// that — iOS only lets an app play sound through mute if it holds Apple's
// Critical Alerts entitlement, which Telegram does not have. Pushover does,
// and applies it to BOTH priority 1 and priority 2.
//
// Critical Alerts must also be opted into inside the Pushover iOS app; Apple
// requires that consent separately from normal push. Without it, priority 1
// and 2 are ordinary notifications and stay silent on mute — which looks
// exactly like a broken integration.

export type Severity = "alarm" | "loud" | "notice";

export const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

// Emergency-priority defaults. Pushover caps total retries at 50 regardless
// of expire, so 60s over an hour is well inside the cap.
export const DEFAULT_RETRY_SEC = 60;
export const DEFAULT_EXPIRE_SEC = 3600;

// API-enforced bounds for priority 2.
const MIN_RETRY_SEC = 30;
const MAX_EXPIRE_SEC = 10800;

export interface PushoverArgs {
  token: string;
  user: string;
  message: string;
  severity: Severity;
  title?: string;
  // A supplementary URL, rendered by Pushover as a tappable action on the
  // notification. Used for the PWA deep link — the web app's manifest has
  // scope "/" and display "standalone", so an in-scope https link opens the
  // INSTALLED app rather than a browser tab.
  url?: string;
  urlTitle?: string;
  retrySec?: number;
  expireSec?: number;
}

export function pushoverPriority(severity: Severity): number {
  switch (severity) {
    case "alarm":
      return 2; // Critical Alert, repeats until acknowledged.
    case "loud":
      return 1; // Critical Alert, single shot.
    case "notice":
      return -1; // Delivered with no sound or vibration.
  }
}

/**
 * Builds the form body. Pure, so the priority-2 invariant below is testable
 * without a network call.
 *
 * Priority 2 REQUIRES retry and expire — Pushover rejects the message
 * otherwise, which would mean an alarm that silently fails to send. They are
 * therefore added unconditionally whenever priority is 2, clamped to the
 * API's own bounds.
 */
export function pushoverBody(args: PushoverArgs): URLSearchParams {
  const priority = pushoverPriority(args.severity);
  const body = new URLSearchParams({
    token: args.token,
    user: args.user,
    message: args.message,
    priority: String(priority),
    // The shared formatters emit <b>, which is inside Pushover's HTML subset.
    html: "1",
  });
  if (args.title) body.set("title", args.title);
  // url_title without url is meaningless to Pushover, so it is gated on url.
  if (args.url) {
    body.set("url", args.url);
    if (args.urlTitle) body.set("url_title", args.urlTitle);
  }
  if (priority === 2) {
    const retry = Math.max(MIN_RETRY_SEC, args.retrySec ?? DEFAULT_RETRY_SEC);
    const expire = Math.min(MAX_EXPIRE_SEC, args.expireSec ?? DEFAULT_EXPIRE_SEC);
    body.set("retry", String(retry));
    body.set("expire", String(expire));
  }
  return body;
}

/**
 * Sends one Pushover message. Mirrors sendTelegram's contract exactly: logs
 * on failure and NEVER throws, so a Pushover outage cannot take down the
 * caller or prevent the Telegram channel from firing.
 */
export async function sendPushover(args: PushoverArgs): Promise<void> {
  try {
    const res = await fetch(PUSHOVER_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: pushoverBody(args),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Pushover API error: ${res.status} ${text}`);
    }
  } catch (e) {
    console.error("Pushover send failed", e);
  }
}
