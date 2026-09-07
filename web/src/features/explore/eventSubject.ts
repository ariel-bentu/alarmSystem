// Turns the stored `sensorName` of an event into display text.
//
// The field is deliberately language-neutral in Firestore — it holds a sensor
// name, a profile name, a raw reset reason ("power_on"), or the generic
// "Remote"/"Device" label. Translation and decoration belong here, in the UI,
// so the database never carries English or Hebrew and existing rows pick up
// improvements retroactively.

import { bootReasonKey } from "@/features/operations/bootReason";
import type { TranslationKey } from "@/i18n/en";
import type { ArmSource } from "@/types";

type Translate = (
  key: TranslationKey,
  vars?: Record<string, string | number>
) => string;

/** The literal fallbacks written by armEventSourceLabel() in the functions. */
const GENERIC_REMOTE = "Remote";
const GENERIC_DEVICE = "Device";

/** The cloud sources, which carry a PROFILE name rather than a remote name. */
const CLOUD_SOURCE_KEY: Partial<Record<ArmSource, TranslationKey>> = {
  app: "explore.eventSource.app",
  schedule: "explore.eventSource.schedule",
  telegram: "explore.eventSource.telegram",
};

/**
 * Display text for the "what this event is about" column.
 *
 * - arm/disarm from app/schedule/telegram -> "App — <profile>"
 * - arm/disarm by a named remote  -> "שלט <name>" / "Remote <name>"
 * - arm/disarm, generic fallbacks -> translated "Remote" / left as "Device"
 * - device_restart                -> the reset reason, translated
 * - everything else               -> unchanged
 *
 * `armSource` is what makes the arm/disarm cases decidable. Two functions
 * write these rows into the SAME sensorName field with different meanings:
 * onArmStateChange stores the profile name, onDeviceArmStateChange stores the
 * remote's name. Without the discriminator an app-driven arm under profile
 * "Night" rendered as "Remote Night" — inventing a remote that was never
 * used, in the one column where attribution is a security question.
 */
export function eventSubject(
  eventType: string,
  subject: string,
  t: Translate,
  armSource?: ArmSource
): string {
  // Checked BEFORE the empty-subject guard below: a restart with no recorded
  // reason is still a restart, and bootReasonKey maps "" to bootUnknown
  // ("Restarted for an unknown reason"). Falling through to the generic
  // "System" label instead would lose the one fact the row carries.
  if (eventType === "device_restart") {
    // Stored raw so the database stays language-neutral; bootReasonKey is the
    // single mapping, already used by the Operations banner. Reusing it means
    // a new firmware reason only has to be handled in one place.
    return t(bootReasonKey(subject));
  }

  // Checked BEFORE the empty-subject guard: a cloud disarm carries no profile
  // (onArmStateChange stores "" for it), but the source alone is still worth
  // showing — "App" beats a blank cell falling through to "System".
  if (eventType === "armed" || eventType === "disarmed") {
    const sourceKey = armSource ? CLOUD_SOURCE_KEY[armSource] : undefined;
    if (sourceKey) {
      const source = t(sourceKey);
      // No profile recorded (every disarm, and an arm with no active profile):
      // joining would render a dangling "App — ".
      if (!subject) return source;
      return t("explore.armSubject", { source, name: subject });
    }
  }

  if (!subject) return "";

  if (eventType === "armed" || eventType === "disarmed") {
    // Generic fallback for an identity that matched no paired remote: just
    // translate it. Prefixing would read "Remote Remote".
    if (subject === GENERIC_REMOTE) return t("explore.eventSource.remote");
    // A local/cloud arm is not a remote at all.
    if (subject === GENERIC_DEVICE) return subject;
    // Only a row that SAYS it came from a remote gets the remote prefix.
    // Historical rows predate armSource and carry a profile name or a remote
    // name with nothing to tell them apart, so they render plain: showing a
    // bare name is the only option that never claims a remote it cannot prove.
    if (armSource === "remote") {
      return t("explore.remoteSubject", { name: subject });
    }
    return subject;
  }

  return subject;
}
