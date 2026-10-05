/** Pure form state for the deferred card on the Configure → Siren tab.
 *
 *  The tab has three cards and only this one has a Save button:
 *    1. enable toggle — instant (checkbox)
 *    2. pairing       — no save at all; it is a command/confirm flow
 *    3. this one      — siren duration (a number, so deferred)
 *
 *  "Server triggers siren" is a checkbox and saves instantly, so it is not
 *  form state. See the save-model note in notifySettings.ts. */

export interface SirenForm {
  sirenDurationSec: number;
}

/** The subset of Project this form edits. */
export interface SirenSource {
  sirenDurationSec: number;
}

export function formFromProject(project: SirenSource): SirenForm {
  return { sirenDurationSec: project.sirenDurationSec };
}

export function isDirty(saved: SirenForm, current: SirenForm): boolean {
  return saved.sirenDurationSec !== current.sirenDurationSec;
}
