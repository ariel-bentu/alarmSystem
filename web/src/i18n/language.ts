/** Supported UI languages and the rules for picking one. Pure — no storage
 *  or DOM access, so the choice logic is testable on its own. */

export const LANGUAGES = ["en", "he"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Languages that read right-to-left. */
const RTL: ReadonlySet<Language> = new Set<Language>(["he"]);

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function directionOf(lang: Language): "ltr" | "rtl" {
  return RTL.has(lang) ? "rtl" : "ltr";
}

/**
 * Pick the starting language: an explicit stored choice wins, otherwise the
 * first browser preference we support, otherwise English.
 *
 * `stored` is whatever came out of localStorage and is therefore untrusted —
 * a value we no longer support must not wedge the UI.
 */
export function resolveInitialLanguage(
  stored: string | null,
  navigatorLanguages: readonly string[]
): Language {
  if (isLanguage(stored)) return stored;

  for (const tag of navigatorLanguages) {
    // Browser tags are region-qualified ("he-IL") and inconsistently cased.
    const base = tag.toLowerCase().split("-")[0];
    if (isLanguage(base)) return base;
  }

  return "en";
}
