import { useState, useEffect } from "react";
import { updateDoc } from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { projectDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import { validateNvrSettings, type NvrMode, type JudgeProvider } from "./cameraSettings";

export default function CameraTab() {
  const t = useT();
  const { project, reloadProject } = useProject();
  const projectId = project?.id ?? "";

  const [nvrMode, setNvrMode] = useState<NvrMode>(project?.nvrMode ?? "off");
  const [nvrHost, setNvrHost] = useState(project?.nvrHost ?? "");
  const [nvrPort, setNvrPort] = useState<string>(
    project?.nvrPort != null ? String(project.nvrPort) : ""
  );
  const [nvrUser, setNvrUser] = useState(project?.nvrUser ?? "");
  // Write-only-style: never pre-filled from the project doc, so the current
  // saved password is never echoed back into the DOM.
  const [nvrPassword, setNvrPassword] = useState("");
  const [captureCooldownSec, setCaptureCooldownSec] = useState<string>(
    project?.captureCooldownSec != null ? String(project.captureCooldownSec) : "30"
  );
  const [snapshotRetentionDays, setSnapshotRetentionDays] = useState<string>(
    project?.snapshotRetentionDays != null
      ? String(project.snapshotRetentionDays)
      : "7"
  );
  const [judgeProvider, setJudgeProvider] = useState<JudgeProvider>(
    project?.judgeProvider ?? "null"
  );
  const [judgeModel, setJudgeModel] = useState(project?.judgeModel ?? "");
  const [judgePrompt, setJudgePrompt] = useState(project?.judgePrompt ?? "");

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setNvrMode(project?.nvrMode ?? "off");
    setNvrHost(project?.nvrHost ?? "");
    setNvrPort(project?.nvrPort != null ? String(project.nvrPort) : "");
    setNvrUser(project?.nvrUser ?? "");
    setNvrPassword("");
    setCaptureCooldownSec(
      project?.captureCooldownSec != null ? String(project.captureCooldownSec) : "30"
    );
    setSnapshotRetentionDays(
      project?.snapshotRetentionDays != null
        ? String(project.snapshotRetentionDays)
        : "7"
    );
    setJudgeProvider(project?.judgeProvider ?? "null");
    setJudgeModel(project?.judgeModel ?? "");
    setJudgePrompt(project?.judgePrompt ?? "");
  }, [
    project?.nvrMode,
    project?.nvrHost,
    project?.nvrPort,
    project?.nvrUser,
    project?.captureCooldownSec,
    project?.snapshotRetentionDays,
    project?.judgeProvider,
    project?.judgeModel,
    project?.judgePrompt,
  ]);

  const handleSave = async () => {
    if (!projectId) return;
    setError(null);
    setSaved(false);

    const result = validateNvrSettings({
      nvrMode,
      nvrHost,
      nvrPort: nvrPort === "" ? undefined : Number(nvrPort),
      nvrUser,
      // An empty password field means "leave unchanged" — only sent when
      // the user actually typed one, so re-saving other fields never wipes
      // the stored credential.
      nvrPassword: nvrPassword === "" ? project?.nvrPassword : nvrPassword,
      captureCooldownSec:
        captureCooldownSec === "" ? undefined : Number(captureCooldownSec),
      snapshotRetentionDays:
        snapshotRetentionDays === "" ? undefined : Number(snapshotRetentionDays),
      judgeProvider,
      judgeModel,
      judgePrompt,
    });

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSaving(true);
    try {
      await updateDoc(projectDoc(projectId), { ...result.value });
      await reloadProject();
      setNvrPassword("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <section className="card">
        <div className="stack">
          <div className="field">
            <label className="field__label" htmlFor="camera-nvr-mode">
              {t("cfg.camera.mode")}
            </label>
            <select
              id="camera-nvr-mode"
              className="input"
              value={nvrMode}
              onChange={(e) => setNvrMode(e.target.value as NvrMode)}
            >
              <option value="off">{t("cfg.camera.modeOff")}</option>
              <option value="capture">{t("cfg.camera.modeCapture")}</option>
              <option value="capture+judge">
                {t("cfg.camera.modeCaptureJudge")}
              </option>
            </select>
            <p className="muted">{t("cfg.camera.modeHelp")}</p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-nvr-host">
              {t("cfg.camera.host")}
            </label>
            <input
              id="camera-nvr-host"
              className="input"
              type="text"
              value={nvrHost}
              onChange={(e) => setNvrHost(e.target.value)}
              placeholder={t("cfg.camera.hostPlaceholder")}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-nvr-port">
              {t("cfg.camera.port")}
            </label>
            <input
              id="camera-nvr-port"
              className="input input--narrow"
              type="number"
              min={1}
              max={65535}
              value={nvrPort}
              onChange={(e) => setNvrPort(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-nvr-user">
              {t("cfg.camera.user")}
            </label>
            <input
              id="camera-nvr-user"
              className="input"
              type="text"
              value={nvrUser}
              onChange={(e) => setNvrUser(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-nvr-password">
              {t("cfg.camera.password")}
            </label>
            <input
              id="camera-nvr-password"
              className="input"
              type="password"
              value={nvrPassword}
              onChange={(e) => setNvrPassword(e.target.value)}
              placeholder={
                project?.nvrPassword
                  ? t("cfg.camera.passwordUnchanged")
                  : undefined
              }
              autoComplete="new-password"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-cooldown">
              {t("cfg.camera.cooldown")}
            </label>
            <input
              id="camera-cooldown"
              className="input input--narrow"
              type="number"
              min={5}
              value={captureCooldownSec}
              onChange={(e) => setCaptureCooldownSec(e.target.value)}
            />
            <p className="muted">{t("cfg.camera.cooldownHelp")}</p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-retention">
              {t("cfg.camera.retention")}
            </label>
            <input
              id="camera-retention"
              className="input input--narrow"
              type="number"
              min={1}
              value={snapshotRetentionDays}
              onChange={(e) => setSnapshotRetentionDays(e.target.value)}
            />
            <p className="muted">{t("cfg.camera.retentionHelp")}</p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-judge-provider">
              {t("cfg.camera.judgeProvider")}
            </label>
            <select
              id="camera-judge-provider"
              className="input"
              value={judgeProvider}
              onChange={(e) => setJudgeProvider(e.target.value as JudgeProvider)}
            >
              <option value="null">{t("cfg.camera.judgeProviderOff")}</option>
              <option value="claude">{t("cfg.camera.judgeProviderClaude")}</option>
            </select>
            {nvrMode === "capture+judge" && judgeProvider === "null" && (
              <p className="banner banner--warn">
                {t("cfg.camera.judgeRequiredWarn")}
              </p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-judge-model">
              {t("cfg.camera.judgeModel")}
            </label>
            <input
              id="camera-judge-model"
              className="input"
              type="text"
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              placeholder={t("cfg.camera.judgeModelPlaceholder")}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="camera-judge-prompt">
              {t("cfg.camera.judgePrompt")}
            </label>
            <textarea
              id="camera-judge-prompt"
              className="input"
              rows={4}
              value={judgePrompt}
              onChange={(e) => setJudgePrompt(e.target.value)}
              placeholder={t("cfg.camera.judgePromptPlaceholder")}
            />
          </div>

          {error && <p className="badge badge--danger">{error}</p>}
          {saved && !error && <p className="muted">{t("cfg.camera.saved")}</p>}

          <div>
            <button
              type="button"
              className="btn btn--primary"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
