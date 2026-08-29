// Project settings (admin-only): edit name, Telegram bot token + chat id,
// siren duration, and server alarm actions. Writes to the project doc
// (rules allow admin updates).
import { useEffect, useState } from "react";
import { updateDoc } from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { projectDoc } from "@/lib/firestore";

// Inline help marker: a "?" button that toggles a visible instruction panel on
// click (native title tooltips are unreliable, so we render our own).
function Help({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        aria-label="Help"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          marginLeft: 6,
          width: 18,
          height: 18,
          lineHeight: "16px",
          textAlign: "center",
          borderRadius: "50%",
          border: "1px solid currentColor",
          background: "transparent",
          color: "inherit",
          fontSize: 12,
          cursor: "pointer",
          padding: 0,
        }}
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            top: "120%",
            left: 0,
            zIndex: 10,
            width: 280,
            padding: "8px 10px",
            background: "#1e1e1e",
            color: "#fff",
            border: "1px solid #444",
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1.4,
            fontWeight: "normal",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

export default function SettingsPage() {
  const { project, role, reloadProject } = useProject();

  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [sirenDurationSec, setSirenDurationSec] = useState(120);
  const [sendTelegram, setSendTelegram] = useState(true);
  const [triggerSiren, setTriggerSiren] = useState(false);
  const [notifyEverySensorTrigger, setNotifyEverySensorTrigger] = useState(true);

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Toggles write immediately rather than waiting for Save: a switch that
  // silently reverts when you navigate away reads as a broken setting, not as
  // an unsaved edit. Text fields still batch behind the Save button, so a
  // half-typed bot token never reaches Firestore.
  const saveToggle = async (
    field: string,
    value: unknown,
    apply: () => void,
    revert: () => void
  ) => {
    if (!project) return;
    apply();
    setNotice(null);
    setError(null);
    try {
      await updateDoc(projectDoc(project.id), { [field]: value });
      await reloadProject();
      setNotice("Saved.");
    } catch (err) {
      revert();
      setError(err instanceof Error ? err.message : "Failed to save setting.");
    }
  };

  // Populate the form from the loaded project.
  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setBotToken(project.telegramBotToken);
    setChatId(project.telegramChatId);
    setSirenDurationSec(project.sirenDurationSec);
    setSendTelegram(project.serverActions.sendTelegram);
    setTriggerSiren(project.serverActions.triggerSiren);
    setNotifyEverySensorTrigger(project.notifyEverySensorTrigger !== false);
  }, [project]);

  if (!project) return <div>Loading…</div>;
  if (role !== "admin") return <div>Admin access required.</div>;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      // Toggles are not included: they save on change via saveToggle(), and
      // re-writing them here would clobber a concurrent change with whatever
      // this form last rendered.
      await updateDoc(projectDoc(project.id), {
        name: name.trim(),
        telegramBotToken: botToken.trim(),
        telegramChatId: chatId.trim(),
        sirenDurationSec,
      });
      await reloadProject();
      setNotice("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page">
      <h1>Project Settings</h1>
      <form onSubmit={handleSave}>
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

        <h2>Telegram</h2>
        <div>
          <label htmlFor="bot-token">
            Bot Token
            <Help text="In Telegram, message @BotFather, send /newbot, follow the prompts, and copy the token it gives you (looks like 123456789:ABCdef...). Leave blank to disable Telegram alerts." />
          </label>
          <input
            id="bot-token"
            type="text"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456:ABC-DEF..."
          />
        </div>
        <div>
          <label htmlFor="chat-id">
            Chat ID
            <Help text="The chat that receives alerts. For a direct message to you: open @userinfobot and it replies with your numeric ID (a positive number) — use that. For a group: add your bot to the group, send a message there, then open https://api.telegram.org/bot<TOKEN>/getUpdates and read chat.id (group IDs are negative, e.g. -1001234567890)." />
          </label>
          <input
            id="chat-id"
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="-1001234567890"
          />
        </div>

        <div>
          <label>
            <input
              type="checkbox"
              checked={notifyEverySensorTrigger}
              onChange={(e) => {
                const next = e.target.checked;
                void saveToggle(
                  "notifyEverySensorTrigger",
                  next,
                  () => setNotifyEverySensorTrigger(next),
                  () => setNotifyEverySensorTrigger(!next)
                );
              }}
            />
            Send Telegram on every sensor trigger (battery-low and tamper always notify)
          </label>
        </div>

        <h2>Siren &amp; Server Alarm</h2>
        <div>
          <label htmlFor="siren-duration">Siren Duration (seconds)</label>
          <input
            id="siren-duration"
            type="number"
            min={0}
            value={sirenDurationSec}
            onChange={(e) => setSirenDurationSec(Number(e.target.value))}
          />
        </div>
        <div>
          <label>
            <input
              type="checkbox"
              checked={sendTelegram}
              onChange={(e) => {
                const next = e.target.checked;
                void saveToggle(
                  "serverActions",
                  { sendTelegram: next, triggerSiren },
                  () => setSendTelegram(next),
                  () => setSendTelegram(!next)
                );
              }}
            />
            Server sends Telegram alerts on alarm
          </label>
        </div>
        <div>
          <label>
            <input
              type="checkbox"
              checked={triggerSiren}
              onChange={(e) => {
                const next = e.target.checked;
                void saveToggle(
                  "serverActions",
                  { sendTelegram, triggerSiren: next },
                  () => setTriggerSiren(next),
                  () => setTriggerSiren(!next)
                );
              }}
            />
            Server triggers siren on alarm
          </label>
        </div>

        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save Settings"}
        </button>
      </form>
    </div>
  );
}
