// Does a sensor-doc write change anything the DEVICE config carries?
//
// RTDB /{projectId}/config is DERIVED state. It is rebuilt by the profile,
// rule, remote and project-config triggers — and, since per-sensor camera
// selection, by a sensor trigger too, which is what this guard serves.
//
// Why the guard rather than rebuilding on every sensor write: a sensor doc is
// also where names, battery-change dates and the various *AlertSentAt markers
// live, and those markers are written by the alert paths themselves, several
// times a day, for data the device never sees. Rebuilding on each would mean a
// pointless RTDB write (and a device-visible config churn) per sensor alert.
//
// Kept pure and separate from onProfileChange.ts so the decision is testable
// without the Functions emulator — same split as buildConfig vs its triggers.

/** The only sensor fields that reach the device, via buildRtdbConfig.
 *
 *  Deliberately absent: `name`, the various *AlertSentAt markers and
 *  `batteryChangedAt` — same reasoning as cameraNames.
 *
 *  `definiteBreach` WAS in that list, on the grounds that breach certainty
 *  was a notification concern resolved entirely cloud-side. It no longer is:
 *  the device delays the siren for a non-definite sensor (sirenHoldSec), so
 *  it has to know the flag, and leaving it out would mean the hold never
 *  reached the device at all — the derived-state trap that cost the per-sensor
 *  camera selection a release. */
interface SensorConfigFields {
  rfId?: unknown;
  familyId?: unknown;
  cameras?: unknown;
  definiteBreach?: unknown;
}

/** Normalized for comparison: the mask the device actually receives cannot
 *  represent order or duplicates, so neither should count as a change. */
function cameraKey(cameras: unknown): string {
  if (!Array.isArray(cameras)) return "";
  const unique = new Set<number>();
  for (const c of cameras) {
    if (typeof c === "number" && Number.isInteger(c)) unique.add(c);
  }
  return [...unique].sort((a, b) => a - b).join(",");
}

/**
 * true when `before` -> `after` alters a device-visible sensor field, or when
 * the sensor was created or deleted (either changes r[] itself).
 */
export function sensorConfigChanged(
  before: SensorConfigFields | undefined,
  after: SensorConfigFields | undefined
): boolean {
  if (!before || !after) return true;
  return (
    before.rfId !== after.rfId ||
    before.familyId !== after.familyId ||
    cameraKey(before.cameras) !== cameraKey(after.cameras) ||
    // Compared as the BOOLEAN the device receives, not raw: absent means
    // definite, so absent -> true is invisible to the device and must not
    // churn a config it polls every 5s.
    definiteKey(before.definiteBreach) !== definiteKey(after.definiteBreach)
  );
}

/** Absent/null/anything-but-false reads as definite — the same default
 *  breachCertainty.isDefiniteBreach owns, duplicated here only as a
 *  comparison key. */
function definiteKey(value: unknown): boolean {
  return value !== false;
}
