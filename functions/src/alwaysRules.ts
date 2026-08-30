// Which rules apply to a sensor event, given arm state.
//
// Pure and separate from onSensorEvent so the armed/disarmed matrix is
// testable without emulating Firestore.

import { Rule } from "./types";

/**
 * Armed: the active profile's rules, plus always-rules from every profile.
 * Disarmed: always-rules only — that is the whole feature.
 *
 * De-duplicated by id, because an always-rule living in the active profile
 * arrives through both arguments.
 */
export function applicableRules(
  armed: boolean,
  activeProfileRules: Rule[],
  alwaysRules: Rule[]
): Rule[] {
  if (!armed) return alwaysRules;

  const seen = new Set(activeProfileRules.map((r) => r.id));
  const out = [...activeProfileRules];
  for (const r of alwaysRules) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}
