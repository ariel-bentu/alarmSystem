// Language context: exposes t(), the current language, and a setter.
// Also owns the <html lang>/<html dir> attributes, which is what makes the
// whole app mirror for Hebrew (every stylesheet uses logical properties).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import { en, type TranslationKey } from "./en";
import { he } from "./he";
import { directionOf, resolveInitialLanguage, type Language } from "./language";
import { translate, type Dict, type Vars } from "./translate";

const DICTS: Record<Language, Dict> = { en, he };
const STORAGE_KEY = "alarm.lang";

interface I18nContextValue {
  t: (key: TranslationKey, vars?: Vars) => string;
  lang: Language;
  setLang: (lang: Language) => void;
  dir: "ltr" | "rtl";
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function readStoredLang(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private mode / storage disabled
  }
}

function storeLang(lang: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Non-fatal: the choice just won't survive a reload.
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() =>
    resolveInitialLanguage(
      readStoredLang(),
      typeof navigator === "undefined" ? [] : navigator.languages ?? []
    )
  );

  const dir = directionOf(lang);

  // The document attributes drive both CSS mirroring and screen-reader
  // pronunciation, so they follow the language rather than being set once.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((next: Language) => {
    storeLang(next);
    setLangState(next);
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Vars) => translate(DICTS[lang], key, vars),
    [lang]
  );

  const value = useMemo(
    () => ({ t, lang, setLang, dir }),
    [t, lang, setLang, dir]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

/** Convenience for the common case of only needing t(). */
export function useT(): (key: TranslationKey, vars?: Vars) => string {
  return useI18n().t;
}
