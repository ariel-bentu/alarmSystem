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
import type { Project } from "@/types";

const grantTenantAccess = httpsCallable<
  { projectId: string; email: string; role: "admin" | "user" },
  { status: string }
>(functions, "grantTenantAccess");

export default function CreateProjectPage() {
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
      setError(err instanceof Error ? err.message : "Failed to create project.");
    } finally {
      setSubmitting(false);
    }
  };

  if (rawApiKey) {
    return (
      <div className="create-project-page">
        <h1>Project Created</h1>
        <p>
          <strong>Save this API key now.</strong> It will not be shown again.
        </p>
        <code data-testid="api-key-display">{rawApiKey}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(rawApiKey);
            setCopied(true);
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <p>Use this key in your edge device firmware configuration.</p>
        <button type="button" onClick={() => void refresh()}>
          I've saved it — continue
        </button>
      </div>
    );
  }

  return (
    <div className="create-project-page">
      <h1>Create Project</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="project-name">Project Name</label>
          <input
            id="project-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="telegram-bot-token">Telegram Bot Token (optional)</label>
          <input
            id="telegram-bot-token"
            type="text"
            value={telegramBotToken}
            onChange={(e) => setTelegramBotToken(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="telegram-chat-id">Telegram Chat ID (optional)</label>
          <input
            id="telegram-chat-id"
            type="text"
            value={telegramChatId}
            onChange={(e) => setTelegramChatId(e.target.value)}
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Creating..." : "Create Project"}
        </button>
      </form>
    </div>
  );
}
