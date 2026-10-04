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
  // A built-in Pushover sound name. Absent/empty plays the user's own default
  // tone, so it is omitted rather than guessed.
  //
  // Matters more than it looks: most built-in sounds are SHORT one-shots, and
  // priority 2's repeat re-sends the notification rather than sustaining a
  // tone — so a short sound every `retry` seconds does not feel like an
  // alarm. Only five are long/looping: alien, climb, persistent, echo,
  // updown. `siren` and `spacealarm` are the alarm-flavoured short ones.
  sound?: string;
  retrySec?: number;
  expireSec?: number;
}

export function pushoverPriority(severity: Severity): number {
  switch (severity) {
    case "alarm":
      // Critical Alert: plays at full volume through a muted ringer and
      // through Do Not Disturb, and repeats until acknowledged.
      return 2;
    case "loud":
      // Priority 0 (normal), NOT 1 — deliberately, and this is the one place
      // the choice is made.
      //
      // Pushover applies Apple's Critical Alerts entitlement to priority 1 as
      // well as 2, so a "loud" alert at priority 1 ALSO broke through mute.
      // That left the two tiers near-indistinguishable: both sounded at full
      // volume, differing only in whether they repeated — and with a looping
      // sound like `updown` even that difference was inaudible.
      //
      // A non-definite sensor is one whose trigger might be a cat. It should
      // notify, and sound when the phone is not silenced, but it must not
      // override silence. Breaking through mute is reserved for a confirmed
      // breach — either a definite sensor, or the AI judge escalating a
      // non-definite one to "alarm".
      //
      // COST, accepted: when no judge verdict ever arrives (NVR down,
      // nvrMode not capture+judge, or no cameras on the sensor), a
      // non-definite alarm is now SILENT on a muted phone and nothing will
      // escalate it. The siren is the only backstop for those sensors.
      return 0;
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
  if (args.sound) body.set("sound", args.sound);
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
