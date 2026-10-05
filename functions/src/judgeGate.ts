// Pure decision logic for the AI judge as EVIDENCE rather than a filter.
// See docs/superpowers/specs/2026-10-05-judge-as-evidence-design.md.
//
// Three decisions live here, all kept out of onSnapshotUploaded so they are
// testable without the Functions emulator — the same split as alarmLogic.ts /
// onSensorEvent.ts and breachCertainty.ts / onAlarm.ts:
//
//  1. shouldJudge        — judge every ARMED trigger, not only alarming ones
//  2. reusableVerdict    — inherit a verdict when no fresh images can exist
//  3. breachSatisfiesAny — may a breach fire the alarm for this sensor?

import { Project, Rule } from "./types";
import { Verdict } from "./snapshotJudge";

/**
 * Judge this snapshot?
 *
 * The gate is **armed**, not "did this trigger alarm". The old
 * alarm_cause-matching gate made the judge structurally unreachable for
 * count_in_window rules: trigger 1 captures but has no cause yet (the count is
 * unmet), and trigger 2 alarms but falls inside captureCooldownSec so has no
 * images. Measured on hardware 2026-10-05 — three capture sets, all skipped,
 * and the trigger that did alarm had no snapshot at all.
 *
 * Judging an unalarmed trigger is cheap and now load-bearing: its verdict is
 * what a later trigger in the same episode inherits.
 */
export function shouldJudge(ctx: {
  armed: boolean;
  nvrMode: Project["nvrMode"];
}): boolean {
  return ctx.armed && ctx.nvrMode === "capture+judge";
}

/** One channel's verdict, as recorded on the coordination doc. */
export interface ChannelVerdictRecord {
  /** The TRIGGER ts the verdict was taken for — not when it was written. */
  ts: number;
  verdict: Verdict;
  reason: string;
}

/**
 * The verdict a trigger with no images of its own should inherit, or null.
 *
 * THE REUSE WINDOW IS DERIVED, NOT TUNABLE. A trigger arriving inside
 * `captureCooldownSec` cannot have fresh images — the device will not grab
 * any — so the previous verdict is the only evidence that exists. Reuse is
 * forced, not chosen. Stated as an invariant: *the reuse window is exactly the
 * period during which fresh evidence is unobtainable.*
 *
 * `judgeLatencySec` extends it slightly: a trigger just past the cooldown does
 * get its own images, but the verdict takes a few seconds to land (~4-7s
 * measured on hardware). During that gap the prior verdict is still the best
 * available evidence.
 *
 * Deliberately NOT asymmetric between safe and breach. An earlier draft had
 * safe expiring sooner, reasoning that an empty yard 25s ago says little about
 * now. That holds only for long cooldowns; at ~10s the distinction is worth
 * almost nothing and costs two knobs plus a rule relating them.
 */
export function reusableVerdict(
  priors: ChannelVerdictRecord[],
  triggerTs: number,
  captureCooldownSec: number,
  judgeLatencySec = 0
): ChannelVerdictRecord | null {
  const windowMs = (captureCooldownSec + judgeLatencySec) * 1000;
  let best: ChannelVerdictRecord | null = null;
  for (const p of priors) {
    // Never inherit from the FUTURE: that would be a later episode's evidence
    // bleeding backwards into this one.
    if (p.ts > triggerTs) continue;
    if (triggerTs - p.ts > windowMs) continue;
    if (best === null || p.ts > best.ts) best = p;
  }
  return best;
}

/**
 * May a `breach` verdict raise the alarm for this sensor on its own?
 *
 * OR across EVERY condition covering the sensor in the device-active profile:
 * true if any of them sets `breach_satisfies`.
 *
 * Why OR rather than identifying the firing rule: `alarm_cause.ct` is a
 * condition TYPE index, not a rule id, so the rule that fired cannot be
 * recovered from the cause — the same limitation that forced rule-derived
 * certainty to be reverted on 2026-10-04. It does not need to be. OR matches
 * how AlarmState already combines a sensor's conditions, and it is
 * order-independent: Firestore document order is precisely what made the old
 * `rules.find(...)` non-deterministic, where the same sensor could behave
 * differently on each trigger.
 *
 * Consequence worth knowing: per-condition opt-in controls *whether vision may
 * fire for this sensor at all*, not which rule gets the credit. Flagging a
 * sensor's count_in_window but not its multi_sensor still fires on a breach.
 * Not expressible, and deliberately so — "fires" is the only outcome either
 * way.
 */
export function breachSatisfiesAny(rules: Rule[], sensorId: string): boolean {
  return rules.some(
    (r) => r.sensors.includes(sensorId) && r.condition.breach_satisfies === true
  );
}
