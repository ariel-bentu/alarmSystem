// Operations dashboard. Arm the device or server by selecting an enabled
// profile, or Disarm. Shows the live alarm state and siren configuration.
//
// The sensor list deliberately lives in Configure, not here: this page is for
// acting on the system, not inspecting it.
import { useEffect, useState } from "react";
import { onSnapshot, updateDoc, writeBatch } from "firebase/firestore";
import { set } from "firebase/database";
import { db } from "@/lib/firebase";
import { useProject } from "@/app/ProjectProvider";
import { sensorsCol, profilesCol, projectDoc, profileDoc } from "@/lib/firestore";
import { commandsArmedRef, commandsSirenRef } from "@/lib/rtdb";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { useT } from "@/i18n/I18nProvider";
import { useDeviceState } from "./useDeviceState";
import { useAlarmState } from "./useAlarmState";
import { causeLabel } from "./alarmState";
import type { Sensor, Profile } from "@/types";

type Side = "device" | "server";

export default function OperationsPage() {
  const t = useT();
  const { project, role } = useProject();
  const projectId = project?.id;
  const { armed: deviceArmed, sirenActive, loading: rtdbLoading } = useDeviceState(projectId);
  const alarm = useAlarmState(projectId);
  const online = useOnlineStatus();

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState(false);

  // Sensors are still loaded — not to list them, but to resolve the alarm
  // cause's rfId to a human name.
  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(sensorsCol(projectId), (snap) => {
      setSensors(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(profilesCol(projectId), (snap) => {
      setProfiles(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, [projectId]);

  const sensorNamesByRfId = Object.fromEntries(
    sensors.map((s) => [s.rfId, s.name])
  );

  // Arming while offline would queue a write the device cannot receive, so the
  // UI would claim armed when nothing is.
  const canArm = (role === "user" || role === "admin") && online;
  const sirenEnabled = project?.sirenEnabled !== false;
  const availableProfiles = profiles.filter((p) => p.enabled !== false);
  const activeDeviceId = profiles.find((p) => p.isActiveOnDevice)?.id ?? null;
  const activeServerId = profiles.find((p) => p.isActiveOnServer)?.id ?? null;
  // The badge and the button grid must never disagree, so both are derived
  // from the live profile subscription rather than the badge reading
  // project.serverArmed (a one-shot getDoc that goes stale) and the grid
  // reading isActiveOnServer. They are written together but can drift — e.g.
  // disabling an armed profile used to clear only the profile flag, leaving
  // "Armed" next to a highlighted Disarmed button.
  //
  // The profile flag wins because it is what the alarm evaluation actually
  // uses: onSensorEvent requires BOTH serverArmed and a profile with
  // isActiveOnServer, so a stale serverArmed:true with no active profile
  // evaluates nothing. That makes it a display inconsistency, not a safety
  // one — which is why this reconciles for display only and does not write
  // back. A repair-on-load write would race other clients and mutate data as
  // a side effect of viewing a page.
  const serverArmedEffective = activeServerId !== null;

  const armSide = async (side: Side, profileId: string | null) => {
    if (!projectId || !canArm || busy) return;
    setBusy(true);
    try {
      const field = side === "device" ? "isActiveOnDevice" : "isActiveOnServer";
      const batch = writeBatch(db);
      for (const p of profiles) {
        const shouldBeActive = p.id === profileId;
        if (Boolean(p[field]) !== shouldBeActive) {
          batch.update(profileDoc(projectId, p.id), { [field]: shouldBeActive });
        }
      }
      await batch.commit();

      // Disarming is how the user acknowledges an alarm — "if it yells I can
      // disarm". Only the side that actually tripped clears the indicator.
      if (profileId === null && alarm.active && alarm.side === side) {
        alarm.acknowledge();
      }

      if (side === "device") {
        await set(commandsArmedRef(projectId), profileId !== null);
        // Disarming must always silence, including after SOS while already
        // disarmed. The firmware's applyArmedCommand() calls siren.turnOff(),
        // but commands/armed only reaches the device when the VALUE CHANGES —
        // so disarming an already-disarmed device delivers nothing and the
        // siren would keep sounding until its timer expired.
        if (profileId === null) {
          await set(commandsSirenRef(projectId), false);
        }
      } else {
        // Still written: onSensorEvent gates server-side evaluation on it.
        // The badge no longer reads it — see serverArmedEffective.
        await updateDoc(projectDoc(projectId), {
          serverArmed: profileId !== null,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSilenceSiren = async () => {
    if (!projectId || role !== "admin") return;
    await set(commandsSirenRef(projectId), false);
  };

  // Panic button: sound the siren now, independently of arm state and alarm
  // rules. No confirmation — a dialog defeats the purpose of a panic button,
  // and the siren auto-stops after sirenDurationSec or can be silenced.
  //
  // The device firmware acts on commands/siren WITHOUT checking sirenEnabled
  // (unlike the alarm path, which does), so the gate has to be here.
  const handleSos = async () => {
    if (!projectId || !canArm || sirenEnabled === false) return;
    // Write false first so the device always sees a false->true edge: it acts
    // on commands/siren only when the value CHANGES, so a bare `true` after a
    // previous SOS (or after the siren's own timer expired, which does not
    // reset the command) would be a silent no-op.
    await set(commandsSirenRef(projectId), false);
    await set(commandsSirenRef(projectId), true);
  };

  if (!project) return <p>{t("ops.noProject")}</p>;

  const ArmGrid = ({
    side,
    activeId,
    withSos = false,
  }: {
    side: Side;
    activeId: string | null;
    withSos?: boolean;
  }) => (
    <div className="arm-grid">
      <button
        className={`arm-btn${activeId === null ? " is-active" : ""}`}
        onClick={() => void armSide(side, null)}
        disabled={!canArm || busy}
      >
        <span aria-hidden="true">🔓</span> {t("ops.disarmed")}
      </button>
      {availableProfiles.map((p) => {
        const isAlarming =
          alarm.active && alarm.side === side && activeId === p.id;
        return (
          <button
            key={p.id}
            className={
              "arm-btn" +
              (activeId === p.id ? " is-active" : "") +
              (isAlarming ? " is-alarming" : "")
            }
            onClick={() => void armSide(side, p.id)}
            disabled={!canArm || busy}
          >
            <span aria-hidden="true">{isAlarming ? "🚨" : "🛡"}</span>{" "}
            {p.displayName}
          </button>
        );
      })}
      {/* Sounds the siren now, regardless of arm state. Styled apart from the
          arm buttons so a mis-tap is less likely despite sharing the grid. */}
      {withSos && (
        <button
          className="arm-btn arm-btn--sos"
          onClick={() => void handleSos()}
          disabled={!canArm || busy || !sirenEnabled}
          title={sirenEnabled ? t("ops.sosTitle") : t("ops.sosDisabled")}
        >
          <span aria-hidden="true">🆘</span> {t("ops.sos")}
        </button>
      )}
    </div>
  );

  const StateBadge = ({ armed }: { armed: boolean }) => (
    <span className={`badge ${armed ? "badge--ok" : ""}`}>
      {armed ? t("ops.armed") : t("ops.disarmed")}
    </span>
  );

  return (
    <div>
      <h1 className="sr-only">{t("ops.title")}</h1>

      {alarm.active && (
        <div className="banner banner--danger" role="alert">
          <span className="banner__title">
            <span aria-hidden="true">🚨</span> {t("ops.alarm")}
          </span>
          <span>
            {causeLabel(alarm.cause, sensorNamesByRfId) ??
              t("ops.alarmCauseUnknown")}
            {alarm.side ? ` — ${t(`ops.${alarm.side}`)}` : ""}
            {typeof alarm.cause?.at === "number"
              ? ` ${t("ops.alarmAt", {
                  time: new Date(alarm.cause.at).toLocaleTimeString(),
                })}`
              : ""}
          </span>
          <button
            type="button"
            className="btn btn--sm spacer"
            onClick={alarm.acknowledge}
          >
            {t("common.dismiss")}
          </button>
        </div>
      )}

      {rtdbLoading ? (
        <p>{t("ops.loadingDeviceState")}</p>
      ) : (
        <>
          <section className="card">
            <div className="card__header">
              {/* The "Device" title only earns its place next to a "Server"
                  card. A non-admin sees just this one, so naming it says
                  nothing — but the armed badge still matters, and stays. */}
              {role === "admin" && (
                <h2 className="card__title">{t("ops.device")}</h2>
              )}
              <StateBadge armed={Boolean(deviceArmed)} />
            </div>
            <ArmGrid side="device" activeId={activeDeviceId} withSos />
          </section>

          {/* Server-side arming is an admin concern: it changes what the
              cloud evaluates for everyone, and a regular user arms the
              device, which is the thing in their house. Hidden rather than
              disabled — a greyed-out card they can never use is just noise. */}
          {role === "admin" && (
            <section className="card">
              <div className="card__header">
                <h2 className="card__title">{t("ops.server")}</h2>
                <StateBadge armed={serverArmedEffective} />
              </div>
              <ArmGrid side="server" activeId={activeServerId} />
            </section>
          )}

          <section className="card">
            <div className="card__header">
              <h2 className="card__title">{t("ops.siren")}</h2>
            </div>
            {/* Reports configuration, not a phantom control: with the siren
                disabled an alarm is deliberately silent, and claiming
                "ACTIVE" with a Force Silence button that silences nothing
                is simply wrong. */}
            {project.sirenEnabled === false ? (
              <p className="muted">
                <span aria-hidden="true">🔕</span> {t("ops.sirenDisabled")}
              </p>
            ) : (
              <p className="row">
                <span>
                  {sirenActive
                    ? `🚨 ${t("ops.sirenSounding")}`
                    : t("ops.sirenEnabledQuiet")}
                </span>
                {role === "admin" && sirenActive && (
                  <button
                    className="btn btn--danger btn--sm"
                    onClick={handleSilenceSiren}
                  >
                    {t("ops.forceSilence")}
                  </button>
                )}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
