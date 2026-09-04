// Turns the stored `sensorName` of an event into display text.
//
// The field is deliberately language-neutral in Firestore — it holds a sensor
// name, a profile name, a raw reset reason ("power_on"), or the generic
// "Remote"/"Device" label. Translation and decoration belong here, in the UI,
// so the database never carries English or Hebrew and existing rows pick up
// improvements retroactively.

import { bootReasonKey } from "@/features/operations/bootReason";
import type { TranslationKey } from "@/i18n/en";

type Translate = (
  key: TranslationKey,
  vars?: Record<string, string | number>
) => string;

/** The literal fallbacks written by armEventSourceLabel() in the functions. */
const GENERIC_REMOTE = "Remote";
const GENERIC_DEVICE = "Device";

/**
 * Display text for the "what this event is about" column.
 *
 * - arm/disarm by a named remote  -> "שלט <name>" / "Remote <name>"
 * - arm/disarm, generic fallbacks -> translated "Remote" / left as "Device"
 * - device_restart                -> the reset reason, translated
 * - everything else               -> unchanged
 */
export function eventSubject(
  eventType: string,
  subject: string,
  t: Translate
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

  if (!subject) return "";

  if (eventType === "armed" || eventType === "disarmed") {
    // Generic fallback for an identity that matched no paired remote: just
    // translate it. Prefixing would read "Remote Remote".
    if (subject === GENERIC_REMOTE) return t("explore.eventSource.remote");
    // A local/cloud arm is not a remote at all.
    if (subject === GENERIC_DEVICE) return subject;
    // Anything else here is a paired remote's user-given name, which is the
    // only way this column carries a name for an arm/disarm event.
    return t("explore.remoteSubject", { name: subject });
  }

  return subject;
}
