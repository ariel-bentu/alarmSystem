/**
 * Pure helpers for profile rules: building initial rules, validating
 * condition params, and reconciling rules when a sensor is unpaired.
 */
import type { Rule, Condition, ConditionType } from "@/types";

/**
 * Given an array of sensorIds, build an initial set of Rule-like objects
 * with condition { type: "immediate" }, one rule per sensor.
 * Rule ids are generated as `rule-{index}`.
 */
export function buildInitialRules(
  sensorIds: string[]
): Omit<Rule, "id">[] {
  return sensorIds.map((sensorId) => ({
    name: "",
    sensors: [sensorId],
    condition: { type: "immediate" as ConditionType },
  }));
}

/**
 * Only `multi_sensor` rules may span several sensors. The other condition types
 * describe a single sensor's behaviour, so pairing them with multiple sensors
 * has no well-defined meaning.
 */
export function sensorCountValidForType(
  type: ConditionType,
  sensorCount: number
): boolean {
  if (sensorCount === 0) return false;
  if (type === "multi_sensor") return sensorCount >= 2;
  return sensorCount === 1;
}

/**
 * A rule covering more than one sensor must carry a name — the alarm message
 * falls back to the sensor name, which is ambiguous when several are involved.
 */
export function ruleNameRequired(sensors: string[]): boolean {
  return sensors.length > 1;
}

/**
 * True when the rule's name satisfies the naming requirement.
 */
export function ruleNameValid(sensors: string[], name: string): boolean {
  if (!ruleNameRequired(sensors)) return true;
  return name.trim().length > 0;
}

/**
 * Validate that a condition object has the required params for its type.
 * Returns true if valid.
 */
export function conditionParamsValid(condition: Condition): boolean {
  switch (condition.type) {
    case "immediate":
      return true;

    case "count_in_window":
      return (
        typeof condition.count === "number" &&
        condition.count > 0 &&
        typeof condition.window_sec === "number" &&
        condition.window_sec > 0
      );

    case "entry_delay":
      return (
        typeof condition.delay_sec === "number" && condition.delay_sec > 0
      );

    case "multi_sensor":
      return (
        typeof condition.window_sec === "number" && condition.window_sec > 0
      );

    default:
      return false;
  }
}

export interface RuleReconciliation {
  /** Rules that must be deleted (no sensors left). */
  toDelete: Rule[];
  /** Rules that must be updated, already rewritten. */
  toUpdate: Rule[];
}

/**
 * Work out how a profile's rules must change when a sensor is unpaired.
 * The sensor is stripped from every rule; rules left with no sensors are
 * deleted, and a multi_sensor rule left with a single sensor is downgraded to
 * an immediate condition (multi_sensor needs at least two).
 */
export function reconcileRulesForRemovedSensor(
  rules: Rule[],
  sensorId: string
): RuleReconciliation {
  const toDelete: Rule[] = [];
  const toUpdate: Rule[] = [];

  for (const rule of rules) {
    if (!rule.sensors.includes(sensorId)) continue;

    const sensors = rule.sensors.filter((id) => id !== sensorId);
    if (sensors.length === 0) {
      toDelete.push(rule);
      continue;
    }

    let condition: Condition = rule.condition;
    if (condition.type === "multi_sensor") {
      if (sensors.length < 2) {
        // No longer a multi-sensor condition. Replaced wholesale, so any
        // quorum and per-sensor counts go with it.
        condition = { type: "immediate" };
      } else {
        if (condition.counts) {
          const counts = { ...condition.counts };
          delete counts[sensorId];
          condition = { ...condition, counts };
        }
        // A quorum left above the surviving sensor count would make the rule
        // permanently unfireable — "3 of 3" over 2 sensors can never be met,
        // and nothing in the UI would show why the alarm stopped working.
        if (
          typeof condition.quorum === "number" &&
          condition.quorum > sensors.length
        ) {
          condition = { ...condition, quorum: sensors.length };
        }
      }
    }

    toUpdate.push({ ...rule, sensors, condition });
  }

  return { toDelete, toUpdate };
}

/**
 * What to call a rule in a list.
 *
 * Most rules are unnamed by construction — `buildInitialRules` creates one
 * `{ name: "" }` rule per sensor — so showing a literal "(unnamed)" made the
 * common case unreadable: a list of identical placeholders where the sensor
 * name was the only thing that distinguished the rows. The sensor a rule
 * covers is the natural name for it, so fall back to that.
 *
 * Returns null only when there is nothing at all to name it with (no name and
 * no sensors); the caller supplies its own translated placeholder, since this
 * module is deliberately free of i18n.
 */
export function ruleDisplayName(
  rule: { name?: string; sensors: string[] },
  sensorNameById: (id: string) => string | undefined
): string | null {
  const own = rule.name?.trim();
  if (own) return own;
  if (rule.sensors.length === 0) return null;
  // An unpaired sensor still referenced by a rule has no name; the raw id is
  // ugly but identifies the row, which a blank cell would not.
  return rule.sensors.map((id) => sensorNameById(id) ?? id).join(" + ");
}

/**
 * Whether a rule covering `sensorCount` sensors may be marked always-on.
 *
 * Always-on means a single sensor with an immediate trigger — a smoke
 * detector firing on its own. Adding a second sensor makes the rule
 * `multi_sensor`, which cannot be always-on, so the flag must be CLEARED
 * rather than merely disabled: leaving it set would save an always-on
 * multi-sensor rule the user can no longer see or undo.
 */
export function alwaysAllowedForSensorCount(sensorCount: number): boolean {
  // 0 sensors is mid-edit, not a violation — such a rule cannot be saved.
  return sensorCount <= 1;
}
