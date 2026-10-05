// Should an alarm's notification WAIT for the AI judge's verdict?
//
// Context (2026-10-05): a non-definite sensor alarmed at 05:52:55, the P0
// alert went out at 05:53:05, and the judge declared both camera channels
// empty at 05:53:06 — one second later. The owner was woken and then
// reassured. Deferring the notification until the verdict exists turns that
// into "never woken at all" for a false positive.
//
// Pure and separate from onAlarm.ts for the same reason breachCertainty.ts is:
// the whole decision matrix is testable without the Functions emulator.
//
// THE FAIL-LOUD DIRECTION IS "DO NOT DEFER". Every unknown returns false, so
// the worst case of a misjudgement here is today's behaviour (an immediate
// alert), never a silent alarm.

import { Project, Sensor } from "./types";
import { isDefiniteBreach } from "./breachCertainty";

/** Just the fields this reads, so callers may pass a partial sensor. */
type DeferSensor = Pick<Sensor, "definiteBreach" | "cameras">;

/**
 * True when onAlarm should skip its notification and let the judge send it.
 *
 * Requires ALL of:
 *  - the project opted in (`judgeWaitSec` > 0);
 *  - the sensor is explicitly NON-definite — an absent flag means definite
 *    (breachCertainty.isDefiniteBreach owns that default), and a definite
 *    sensor must wake the owner immediately;
 *  - a verdict is actually PLAUSIBLE: the project is in `capture+judge` and
 *    the sensor has at least one camera ticked.
 *
 * That last condition is what keeps the common no-judge cases at zero delay.
 * Without it, a sensor with no cameras — of which this project has several —
 * would defer every alarm to a sweeper that runs only once a minute, turning
 * an instant alert into a silent 60-second gap for no benefit.
 */
export function shouldDeferToJudge(
  project: Pick<Project, "judgeWaitSec" | "nvrMode">,
  sensor: DeferSensor | null | undefined
): boolean {
  const wait = project.judgeWaitSec;
  if (typeof wait !== "number" || !Number.isFinite(wait) || wait <= 0) {
    return false;
  }
  // No sensor resolved => no certainty to read => fail loud, alert now.
  if (!sensor) return false;
  if (isDefiniteBreach(sensor)) return false;
  if (project.nvrMode !== "capture+judge") return false;
  return (sensor.cameras?.length ?? 0) > 0;
}
