/** The lookup + interpolation step, kept pure and separate from React so it
 *  can be unit-tested without rendering. */

import type { TranslationKey } from "./en";

export type Dict = Record<string, string>;
export type Vars = Record<string, string | number>;

const warned = new Set<string>();

/**
 * Look up `key` and fill any {placeholder} tokens from `vars`.
 *
 * An unknown key returns the key itself and warns once — a visible
 * "cfg.sensors.name" in the UI is a bug you notice, whereas an empty string
 * silently loses a label.
 *
 * A placeholder with no matching var is left as-is for the same reason:
 * "at {time}" reads as unfinished, "at undefined" reads as broken.
 */
export function translate(
  dict: Dict,
  key: TranslationKey,
  vars?: Vars
): string {
  const template = dict[key];
  if (template === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing translation key: ${key}`);
    }
    return key;
  }

  if (!vars) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}
