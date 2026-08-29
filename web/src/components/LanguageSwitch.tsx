// Flag toggle between the two supported languages.
// Two languages means a toggle, not a dropdown: the button shows the language
// you would switch TO, so one tap is the whole interaction.
import { useI18n } from "@/i18n/I18nProvider";

const NEXT = { en: "he", he: "en" } as const;
const FLAG = { en: "🇬🇧", he: "🇮🇱" } as const;
const NAME = { en: "English", he: "עברית" } as const;

export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  const next = NEXT[lang];

  return (
    <button
      type="button"
      className="lang-switch"
      onClick={() => setLang(next)}
      title={`${t("app.language")}: ${NAME[next]}`}
      aria-label={`${t("app.language")}: ${NAME[next]}`}
    >
      <span aria-hidden="true">{FLAG[next]}</span>
      <span>{NAME[next]}</span>
    </button>
  );
}
