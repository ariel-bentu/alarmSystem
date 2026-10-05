/** Pure form state for the Configure → General tab.
 *
 *  Only the DEFERRED fields live here. The timezone <select> saves on change,
 *  so it is not form state — see the save-model note in notifySettings.ts.
 *  That leaves the project name, which is free text: there is no moment at
 *  which a half-typed name is known to be finished, so it needs a Save button
 *  and therefore needs isDirty() to drive it. */

export interface GeneralForm {
  name: string;
}

/** The subset of Project this form edits. */
export interface GeneralSource {
  name: string;
}

export function formFromProject(project: GeneralSource): GeneralForm {
  return { name: project.name };
}

/**
 * True when `current` differs from `saved` in any way a save would persist.
 *
 * Compared TRIMMED, because save trims: without that, typing a trailing space
 * would enable Save and then write a value identical to the stored one.
 */
export function isDirty(saved: GeneralForm, current: GeneralForm): boolean {
  return saved.name.trim() !== current.name.trim();
}
