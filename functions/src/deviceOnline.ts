// Pure decision logic for device offline/online alerting.
//
// WHY THIS EXISTS: nothing watched the CONTROLLER. deadSensorCheck watches
// sensors, but the device itself could die — as one did on 2026-09-01,
// staying dark for ~28 hours — with no alert at all. A dead controller while
// armed is an unmonitored house, which is strictly worse than a dead sensor.
//
// Kept pure and separate from the Cloud Function so the thresholds and the
// fire-once latching are unit-testable without Firestore or Telegram.

/** Silence tolerated while ARMED before alerting. */
export const OFFLINE_THRESHOLD_ARMED_MS = 5 * 60 * 1000;

/**
 * Silence tolerated while DISARMED. Much longer on purpose: disarmed usually
 * means someone is home and may be power-cycling, moving, or working on the
 * device, and a 5-minute alert then is noise. It is NOT "never" — a
 * controller that quietly died while disarmed must still be discovered
 * before the next arm, not at the moment it is needed.
 */
export const OFFLINE_THRESHOLD_DISARMED_MS = 2 * 60 * 60 * 1000;

export function offlineThresholdMs(armed: boolean): number {
  return armed ? OFFLINE_THRESHOLD_ARMED_MS : OFFLINE_THRESHOLD_DISARMED_MS;
}

export type OfflineAction = "none" | "alert_offline" | "alert_back_online";

export interface OfflineInput {
  /** Wall-clock ms of the last heartbeat, or null if never seen. */
  lastSeenMs: number | null;
  /** Whether an offline alert has already been sent for this silence. */
  alertSent: boolean;
  /** Device-side armed state, which selects the threshold. */
  armed: boolean;
  nowMs: number;
}

/**
 * Decide what to do about a device's liveness.
 *
 * Latching matters as much as the threshold: without `alertSent` this would
 * re-send every time the scheduler ran, turning one outage into an alert per
 * minute. The same flag drives the recovery message, so "back online" is
 * only sent to someone who was actually told it went down.
 */
export function decideOfflineAction(input: OfflineInput): OfflineAction {
  const { lastSeenMs, alertSent, armed, nowMs } = input;

  // Never seen. A project whose device has not yet reported once is being
  // set up, not failing — alerting here would fire on every new install.
  if (lastSeenMs === null) return "none";

  const silentMs = nowMs - lastSeenMs;

  // Clock skew, or a heartbeat stamped slightly in the future. Treat as
  // alive rather than inventing a negative silence.
  if (silentMs < 0) {
    return alertSent ? "alert_back_online" : "none";
  }

  const isOffline = silentMs > offlineThresholdMs(armed);

  if (isOffline && !alertSent) return "alert_offline";
  if (!isOffline && alertSent) return "alert_back_online";
  return "none";
}

/**
 * Humanised silence duration for the alert text. Minutes below an hour,
 * hours below a day, then days — an outage measured in "1680 minutes" is
 * technically correct and useless at a glance.
 */
export function formatSilence(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}
