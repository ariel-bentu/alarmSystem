// Pure decision logic for onDeviceArmStateChange, kept in its own module so
// tests can import it without pulling in ./admin, which needs a live
// Firebase Database URL at module scope. Same split as apiKey.ts /
// mintDeviceToken.ts and alarmLogic.ts / onAlarm.ts.

/**
 * A cloud-initiated arm/disarm writes commands/armed first; the device then
 * echoes the SAME value to state/armed, which would double-notify. When the
 * two already agree the change was cloud-initiated and onArmStateChange has
 * reported it. Only a device-originated change leaves them differing.
 *
 * commandsArmed === null means the node is absent (a project that has never
 * been armed from the app), which cannot be a cloud echo — so notify.
 */
export function shouldSuppressDeviceArmNotification(
  commandsArmed: boolean | null,
  stateArmed: boolean
): boolean {
  if (commandsArmed === null) return false;
  return commandsArmed === stateArmed;
}

/**
 * Timeline label for the event row. The remote is called out by name
 * because "who disarmed my house" is the security-relevant question.
 */
export function armEventSourceLabel(source: string | null): string {
  return source === "remote" ? "Remote" : "Device";
}
