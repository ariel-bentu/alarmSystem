// Create project page: form for project name + optional Telegram config.
// Only system admins reach this screen. Creates the project doc, then calls
// grantTenantAccess to wire the owner's member doc + users.tenants entry
// (that write is server-owned). Displays the raw API key once.
import { useState } from "react";
import { setDoc, Timestamp, doc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/app/AuthProvider";
import { useProject } from "@/app/ProjectProvider";
import { generateApiKey, hashApiKey } from "./apiKey";
import { useT } from "@/i18n/I18nProvider";
import type { Project } from "@/types";

const grantTenantAccess = httpsCallable<
  { projectId: string; email: string; role: "admin" | "user" },
  { status: string }
>(functions, "grantTenantAccess");

export default function CreateProjectPage() {
  const t = useT();
  const { user } = useAuth();
  const { refresh } = useProject();

  const [name, setName] = useState("");
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rawApiKey, setRawApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSubmitting(true);
    setError(null);

    try {
      const apiKey = generateApiKey();
      const apiKeyHash = await hashApiKey(apiKey);
      const memberEmail = (user.email ?? "").toLowerCase();

      // Generate a project doc ID
      const projectRef = doc(db, "projects", crypto.randomUUID());
      const projectId = projectRef.id;

      const project: Omit<Project, "id"> = {
        name: name.trim(),
        createdAt: Timestamp.now(),
        ownerId: memberEmail,
        telegramBotToken: telegramBotToken.trim(),
        telegramChatId: telegramChatId.trim(),
        serverArmed: false,
        serverActions: { sendTelegram: true, triggerSiren: false },
        sirenDurationSec: 120,
        sirenEnabled: true,
        notifyEverySensorTrigger: true,
        device: {
          name: "edge-1",
          apiKeyHash,
          lastSeen: null,
        },
      };

      await setDoc(projectRef, project);

      // Index the device key hash -> projectId so the device can authenticate
      // with just its API key (no projectId needed). The hash is not secret.
      await setDoc(doc(db, "deviceKeys", apiKeyHash), { projectId });

      // Server-owned: writes members/{email} + users/{email}.tenants[projectId].
      await grantTenantAccess({
        projectId,
        email: memberEmail,
        role: "admin",
      });

      // Show the API key. Do NOT refresh() here — that repopulates memberships
      // and the app gate would navigate away before the key is seen. The user
      // dismisses the key screen via "Continue", which then refreshes.
      setRawApiKey(apiKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("create.failed"));
    } finally {
      setSubmitting(false);
    }
  };

  if (rawApiKey) {
    return (
      <div className="app-main">
        <div className="card">
          <h1>{t("create.projectCreated")}</h1>
          <p className="banner banner--warn">
            <strong>{t("create.saveKeyNow")}</strong>{" "}
            {t("create.notShownAgain")}
          </p>
          <p>
            <code data-testid="api-key-display" className="ltr">
              {rawApiKey}
            </code>
          </p>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(rawApiKey);
                setCopied(true);
              }}
            >
              {copied ? t("create.copied") : t("create.copy")}
            </button>
          </div>
          <p className="muted">{t("create.useKeyIn")}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void refresh()}
          >
            {t("create.savedContinue")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-main">
      <div className="card">
        <h1>{t("create.title")}</h1>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="project-name">
              {t("create.projectName")}
            </label>
            <input
              id="project-name"
              className="input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="telegram-bot-token">
              {t("create.botTokenOptional")}
            </label>
            <input
              id="telegram-bot-token"
              className="input ltr"
              type="text"
              value={telegramBotToken}
              onChange={(e) => setTelegramBotToken(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="telegram-chat-id">
              {t("create.chatIdOptional")}
            </label>
            <input
              id="telegram-chat-id"
              className="input ltr"
              type="text"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
            />
          </div>
          {error && (
            <p className="badge badge--danger" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn btn--primary"
            disabled={submitting}
          >
            {submitting ? t("create.creating") : t("create.create")}
          </button>
        </form>
      </div>
    </div>
  );
}
