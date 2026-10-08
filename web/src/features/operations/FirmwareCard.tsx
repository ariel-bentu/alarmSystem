// Firmware card (admins only): what the device runs, whether a newer release
// is published, and the Install button that sends /commands/ota.
//
// The flow after Install is entirely the device's — see
// firmware/edge/device/src/ota_updater.h. This card only reflects what the
// device reports on state/ota.
import { useEffect, useState } from "react";
import { onSnapshot } from "firebase/firestore";
import { set } from "firebase/database";
import { firmwareLatestDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import type { FirmwareManifest, RtdbBoot, RtdbOtaState } from "@/types";
import {
  buildOtaCommand,
  firmwareOffer,
  isOtaInProgress,
  newOtaNonce,
  otaStatusKey,
  refusalKey,
} from "./firmware";

interface Props {
  projectId: string;
  boot: RtdbBoot | null;
  online: boolean;
  sirenActive: boolean;
}

// How long the first press stays primed before the button disarms itself.
const CONFIRM_WINDOW_MS = 5000;
// A device that never answers (went offline after the click) must not leave
// the card stuck on "waiting" — it polls every 5s, so a minute is plenty.
const REQUEST_ANSWER_MS = 60_000;

export default function FirmwareCard({ projectId, boot, online, sirenActive }: Props) {
  const t = useT();
  const [latest, setLatest] = useState<FirmwareManifest | null>(null);
  const [ota, setOta] = useState<RtdbOtaState | null>(null);
  const [primed, setPrimed] = useState(false);
  // Set on Install, cleared by the device's next state/ota write — bridges
  // the up-to-5s poll gap so the button does not look like it did nothing.
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(
    () =>
      onSnapshot(
        firmwareLatestDoc(),
        (snap) => setLatest(snap.exists() ? (snap.data() as FirmwareManifest) : null),
        () => setLatest(null)
      ),
    []
  );

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    void (async () => {
      const { onValue } = await import("firebase/database");
      const { stateOtaRef } = await import("@/lib/rtdb");
      if (cancelled) return;
      unsub = onValue(stateOtaRef(projectId), (snap) => {
        const val = snap.val();
        setOta(val && typeof val.status === "string" ? (val as RtdbOtaState) : null);
        setRequestedAt(null);
      });
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [projectId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!primed) return;
    const id = setTimeout(() => setPrimed(false), CONFIRM_WINDOW_MS);
    return () => clearTimeout(id);
  }, [primed]);

  const offer = firmwareOffer(boot, latest);
  const awaitingDevice = requestedAt !== null && now - requestedAt < REQUEST_ANSWER_MS;
  const inProgress = isOtaInProgress(ota, now) || awaitingDevice;
  const canInstall = offer.kind === "available" && online && !sirenActive && !inProgress;

  const handleInstall = async () => {
    if (offer.kind !== "available" || !canInstall) return;
    if (!primed) {
      setPrimed(true);
      return;
    }
    setPrimed(false);
    setRequestedAt(Date.now());
    try {
      const { commandsOtaRef } = await import("@/lib/rtdb");
      await set(commandsOtaRef(projectId), buildOtaCommand(offer.latest, Date.now(), newOtaNonce()));
    } catch {
      setRequestedAt(null);
    }
  };

  const statusLine = (() => {
    if (awaitingDevice) return t("fw.requested");
    if (!ota) return null;
    const text = t(otaStatusKey(ota.status), {
      version: ota.version,
      progress: String(ota.progress ?? 0),
    });
    if (ota.status === "refused") {
      const why = refusalKey(ota.detail);
      return why ? `${text}: ${t(why)}` : text;
    }
    if (ota.status === "failed" && ota.detail) return `${text}: ${ota.detail}`;
    return text;
  })();

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">{t("fw.title")}</h2>
      </div>

      <p className="muted">
        {boot?.fw ? t("fw.running", { version: boot.fw }) : t("fw.runningUnknown")}
      </p>

      {offer.kind === "unsupported" && <p className="muted">{t("fw.unsupported")}</p>}
      {offer.kind === "none" && <p className="muted">{t("fw.nonePublished")}</p>}
      {offer.kind === "current" && <p>✅ {t("fw.upToDate")}</p>}

      {offer.kind === "available" && (
        <div className="row">
          <span>
            {t("fw.available", { version: offer.latest.version })}
            <br />
            <span className="muted">
              {t("fw.publishedAt", {
                time: new Date(offer.latest.publishedAt).toLocaleString(),
              })}
              {offer.latest.notes ? ` — ${offer.latest.notes}` : ""}
            </span>
          </span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void handleInstall()}
            disabled={!canInstall}
            title={
              !online
                ? t("fw.offline")
                : sirenActive
                  ? t("fw.sirenBusy")
                  : t("fw.installTitle")
            }
          >
            {primed ? t("fw.installConfirm") : t("fw.install")}
          </button>
        </div>
      )}

      {statusLine && (
        <p className="muted" role="status">
          {statusLine}
        </p>
      )}
    </section>
  );
}
