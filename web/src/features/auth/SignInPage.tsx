// Sign-in page: shown when user is not authenticated.
import { useAuth } from "@/app/AuthProvider";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useT } from "@/i18n/I18nProvider";

export default function SignInPage() {
  const t = useT();
  const { signIn } = useAuth();

  return (
    <div className="app-main">
      {/* The switch is available before sign-in too — a Hebrew speaker should
          not have to authenticate in English first. */}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <LanguageSwitch />
      </div>
      <div className="card">
        <h1>{t("app.title")}</h1>
        <p className="muted">{t("auth.signInSubtitle")}</p>
        <button className="btn btn--primary" onClick={signIn} type="button">
          {t("auth.signInWithGoogle")}
        </button>
      </div>
    </div>
  );
}
