// What the Operations page may claim, and what it may let you press, before
// device state has arrived.
//
// The page renders its controls immediately instead of behind a spinner — the
// arm grid is what someone came to press, and making them watch a loader at the
// front door is the wrong trade. The cost is a window where the controls exist
// but the current state does not yet, and these predicates define exactly what
// is honest in that window.
//
// Extracted from OperationsPage so the rules are testable without mounting the
// page (which needs Firestore, RTDB and auth context).

/** Whether the armed badge can make a claim yet. */
export type ArmedBadge = "armed" | "disarmed" | "unknown";

export function armedBadgeState({
  loading,
  armed,
}: {
  loading: boolean;
  armed: boolean | null;
}): ArmedBadge {
  // Unknown is NOT folded into "disarmed". Telling someone their alarm is off
  // when it may be on is the one error that gets acted on.
  if (loading || armed === null) return "unknown";
  return armed ? "armed" : "disarmed";
}

interface ButtonState {
  canArm: boolean;
  busy: boolean;
  stateKnown: boolean;
}

/**
 * Disarm stays pressable even before state is known.
 *
 * Safe because armSide() writes commands/armed=false AND an explicit
 * commands/siren=false, so disarming an already-disarmed system is idempotent
 * and still silences a sounding siren. Waiting would be the dangerous choice:
 * this is the control whose value peaks exactly while the page is still
 * loading.
 */
export function isDisarmButtonEnabled({
  canArm,
  busy,
}: ButtonState): boolean {
  return canArm && !busy;
}

/**
 * Arming waits for known state — unlike disarm it is not idempotent, and
 * arming a house already armed to a different profile silently changes which
 * rules are live.
 */
export function isArmButtonEnabled({
  canArm,
  busy,
  stateKnown,
}: ButtonState): boolean {
  return canArm && !busy && stateKnown;
}

/**
 * Whether a grid button should render as the current state. A highlight is a
 * claim, so nothing is highlighted until the state is known.
 */
export function isProfileActive({
  stateKnown,
  activeId,
  id,
}: {
  stateKnown: boolean;
  activeId: string | null;
  id: string | null;
}): boolean {
  return stateKnown && activeId === id;
}
