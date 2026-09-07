// Operations dashboard. Arm the device or server by selecting an enabled
// profile, or Disarm. Shows the live alarm state and siren configuration.
//
// The sensor list deliberately lives in Configure, not here: this page is for
// acting on the system, not inspecting it.
import { useEffect, useState } from "react";
import {
  getDocs,
  onSnapshot,
  query,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { set } from "firebase/database";
import { dbSync } from "@/lib/firebase";
import { useProject } from "@/app/ProjectProvider";
import {
  sensorsCol,
  profilesCol,
  projectDoc,
  profileDoc,
  rulesCol,
} from "@/lib/firestore";
import {
  commandsArmedRef,
  commandsArmedViaRef,
  commandsSirenRef,
} from "@/lib/rtdb";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { useT } from "@/i18n/I18nProvider";
import { useDeviceState } from "./useDeviceState";
import { useAlarmState } from "./useAlarmState";
import SchedulesPanel from "./SchedulesPanel";
import { causeLabel } from "./alarmState";
import { bootSeverity, bootReasonKey, isRecentBoot } from "./bootReason";
import {
  armedBadgeState,
  isArmButtonEnabled,
  isDisarmButtonEnabled,
  isProfileActive,
} from "./armGridReadiness";
import type { Sensor, Profile } from "@/types";

type Side = "device" | "server";

// How long an unexpected restart stays worth reporting. The boot node
// persists until the next boot overwrites it, so without a window the notice
// would be permanent. A day is long enough that an overnight crash is still
// waiting in the morning.
const BOOT_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export default function OperationsPage() {
  const t = useT();
  const { project, role, loading: projectLoading } = useProject();
  const projectId = project?.id;
  const {
    armed: deviceArmed,
    sirenActive,
    boot,
    loading: rtdbLoading,
  } = useDeviceState(projectId);
  const alarm = useAlarmState(projectId);
  const online = useOnlineStatus();

  // An unexpected restart is worth surfacing exactly once. Dismissal is keyed
  // by the boot timestamp and persisted, so it survives a reload but a NEW
  // crash still shows — the same shape as the alarm acknowledgement above.
  const [bootDismissedAt, setBootDismissedAt] = useState<number | null>(() => {
    if (!projectId) return null;
    const raw = localStorage.getItem(`bootAck:${projectId}`);
    return raw ? Number(raw) : null;
  });
  const showBootNotice =
    bootSeverity(boot?.reason) === "unexpected" &&
    isRecentBoot(boot, Date.now(), BOOT_NOTICE_WINDOW_MS) &&
    boot?.at !== bootDismissedAt;
  const dismissBootNotice = () => {
    if (!projectId || !boot) return;
    localStorage.setItem(`bootAck:${projectId}`, String(boot.at));
    setBootDismissedAt(boot.at);
  };

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // Distinct from `profiles.length > 0`: a project with no profiles yet is
  // loaded-and-empty, not still-loading, and must not leave the server card
  // stuck showing an unknown state forever.
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [alwaysRuleCount, setAlwaysRuleCount] = useState(0);
  // Which control has a write in flight, not merely THAT one does: the write
  // takes a visible round-trip, so the pressed button has to say so itself.
  // A bare boolean could only disable everything, which reads as a dead UI.
  // Shape: `${side}:${profileId ?? "off"}` for the grid, "sos" for the panic
  // button; null when idle.
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  // SOS is armed by a first press and only fires on a second. It sits near the
  // Disarm button that gets tapped at bedtime, and an accidental siren at
  // 2am is a genuinely costly mistake, so a single stray tap must not sound it.
  const [sosArmed, setSosArmed] = useState(false);

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
    setProfilesLoaded(false);
    const unsub = onSnapshot(profilesCol(projectId), (snap) => {
      setProfiles(snap.docs.map((d) => d.data()));
      setProfilesLoaded(true);
    });
    return unsub;
  }, [projectId]);

  // Always-rules span every profile, so this is a project-level fact rather
  // than a property of the armed profile. Once any exists, "Disarmed" stops
  // being a complete description of the system and the page must say so.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      const snaps = await Promise.all(
        profiles.map((p) =>
          getDocs(query(rulesCol(projectId, p.id), where("always", "==", true)))
        )
      );
      if (!cancelled) {
        setAlwaysRuleCount(snaps.reduce((n, s) => n + s.size, 0));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, profiles]);

  // Disarm the SOS confirmation if the second press never comes. Without this
  // the button stays primed indefinitely, so a tap now and an unrelated tap
  // tomorrow would sound the siren — the opposite of a safety.
  useEffect(() => {
    if (!sosArmed) return;
    const id = setTimeout(() => setSosArmed(false), 5000);
    return () => clearTimeout(id);
  }, [sosArmed]);

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
    setPending(`${side}:${profileId ?? "off"}`);
    try {
      const field = side === "device" ? "isActiveOnDevice" : "isActiveOnServer";
      const batch = writeBatch(dbSync());
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
        // Stamped BEFORE commands/armed so onArmStateChange, which triggers on
        // that write, can attribute the row to the app rather than guessing.
        await set(commandsArmedViaRef(projectId), "app");
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
      setPending(null);
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
    if (!projectId || !canArm || busy || sirenEnabled === false) return;
    // First press only primes the button; nothing is written until the second.
    if (!sosArmed) {
      setSosArmed(true);
      return;
    }
    setSosArmed(false);
    setPending("sos");
    try {
      // Write false first so the device always sees a false->true edge: it acts
      // on commands/siren only when the value CHANGES, so a bare `true` after a
      // previous SOS (or after the siren's own timer expired, which does not
      // reset the command) would be a silent no-op.
      await set(commandsSirenRef(projectId), false);
      await set(commandsSirenRef(projectId), true);
    } finally {
      setPending(null);
    }
  };

  // "No project selected" is a real, actionable state — but only once we know
  // there is genuinely no project. While the doc is still being fetched it is
  // simply unknown, and saying so would flash a wrong answer on every load.
  if (!project) {
    return projectLoading ? null : <p>{t("ops.noProject")}</p>;
  }

  // `stateKnown` false means the grid is painted before the device's arm state
  // has arrived. The buttons still render — the user came here to press one,
  // and showing the layout immediately lets them find it while the rest loads.
  // What is withheld is any CLAIM about current state: no button is marked
  // active, because highlighting Disarmed on an armed house is a lie the user
  // would act on.
  //
  // Disarm stays live regardless. It is the one control whose value is highest
  // exactly when you have just walked in and the page is still loading, and it
  // is safe to press blind: armSide() writes commands/armed=false AND an
  // explicit commands/siren=false, so disarming an already-disarmed system is
  // idempotent and still silences a sounding siren. Waiting would be the
  // dangerous choice, not the cautious one.
  const ArmGrid = ({
    side,
    activeId,
    stateKnown,
  }: {
    side: Side;
    activeId: string | null;
    stateKnown: boolean;
  }) => (
    <div className="arm-grid">
      <button
        className={`arm-btn${
          isProfileActive({ stateKnown, activeId, id: null }) ? " is-active" : ""
        }`}
        onClick={() => void armSide(side, null)}
        disabled={!isDisarmButtonEnabled({ canArm, busy, stateKnown })}
        aria-pressed={stateKnown ? activeId === null : undefined}
      >
        {pending === `${side}:off` ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">🔓</span>
        )}{" "}
        {t("ops.disarmed")}
      </button>
      {availableProfiles.map((p) => {
        const isActive = isProfileActive({ stateKnown, activeId, id: p.id });
        const isAlarming = alarm.active && alarm.side === side && isActive;
        const isPending = pending === `${side}:${p.id}`;
        return (
          <button
            key={p.id}
            className={
              "arm-btn" +
              (isActive ? " is-active" : "") +
              (isAlarming ? " is-alarming" : "")
            }
            onClick={() => void armSide(side, p.id)}
            disabled={!isArmButtonEnabled({ canArm, busy, stateKnown })}
            aria-pressed={stateKnown ? activeId === p.id : undefined}
          >
            {isPending ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <span aria-hidden="true">{isAlarming ? "🚨" : "🛡"}</span>
            )}{" "}
            {p.displayName}
          </button>
        );
      })}
    </div>
  );

  // Deliberately NOT part of ArmGrid. The grid is a state selector — a filled
  // button there means "this is the current arm state" — whereas SOS performs
  // an action and has no selected/unselected state at all. Rendering it inside
  // the grid made one visual language carry two unrelated meanings, so a red
  // button read as either "armed to something" or "tap to sound", depending on
  // which neighbour you compared it against.
  // Small and right-aligned, not full-width: it sits just below the Disarm
  // button that gets tapped on the way to bed, so it is deliberately the least
  // prominent control here and offset away from the grid's tap targets.
  // Prominence would be wrong even though the action is urgent — the two-press
  // confirm is what makes it reachable in a hurry without being reachable by
  // accident.
  const SosButton = () => (
    <div className="action-row">
      {sosArmed && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setSosArmed(false)}
        >
          {t("ops.sosCancel")}
        </button>
      )}
      <button
        type="button"
        className={`btn btn--sm sos-btn${sosArmed ? " is-armed" : ""}`}
        onClick={() => void handleSos()}
        disabled={!canArm || busy || !sirenEnabled}
        title={sirenEnabled ? t("ops.sosTitle") : t("ops.sosDisabled")}
      >
        {pending === "sos" ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">🆘</span>
        )}{" "}
        {sosArmed ? t("ops.sosConfirm") : t("ops.sos")}
      </button>
    </div>
  );

  // `armed: null` means "not known yet" — the RTDB subscription has not
  // delivered its first value. That is deliberately NOT rendered as Disarmed:
  // claiming disarmed while the house may be armed is the one wrong answer
  // here, so the badge says nothing until it knows.
  const StateBadge = ({
    armed,
    loading = false,
  }: {
    armed: boolean | null;
    loading?: boolean;
  }) => {
    const state = armedBadgeState({ loading, armed });
    return (
      <span className={`badge ${state === "armed" ? "badge--ok" : ""}`}>
        {state === "unknown"
          ? "—"
          : state === "armed"
            ? t("ops.armed")
            : t("ops.disarmed")}
      </span>
    );
  };

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

      {showBootNotice && boot && (
        <div className="banner banner--warn" role="status">
          <span className="banner__title">
            <span aria-hidden="true">⚠️</span> {t("ops.deviceRestarted")}
          </span>
          <span>
            {t(bootReasonKey(boot.reason))}
            {` ${t("ops.bootAt", {
              time: new Date(boot.at).toLocaleString(),
            })}`}
          </span>
          <button
            type="button"
            className="btn btn--sm spacer"
            onClick={dismissBootNotice}
          >
            {t("common.dismiss")}
          </button>
        </div>
      )}

      {/* No loading gate around the page body. The arm grid and SOS are what
          the user came for, so they paint immediately and fill in state as it
          arrives, rather than making someone watch a spinner while standing at
          the door. Only the parts that genuinely depend on device state hold
          back — see StateBadge and ArmGrid's stateKnown. */}
      <>
          <section className="card">
            <div className="card__header">
              {/* The "Device" title only earns its place next to a "Server"
                  card. A non-admin sees just this one, so naming it says
                  nothing — but the armed badge still matters, and stays. */}
              {role === "admin" && (
                <h2 className="card__title">{t("ops.device")}</h2>
              )}
              <StateBadge armed={deviceArmed} loading={rtdbLoading} />
            </div>
            <ArmGrid
              side="device"
              activeId={activeDeviceId}
              stateKnown={!rtdbLoading}
            />
            {alwaysRuleCount > 0 && (
              <p className="muted">
                {t("ops.alwaysRules", { count: String(alwaysRuleCount) })}
              </p>
            )}
            <SosButton />
          </section>

          {/* Server-side arming is an admin concern: it changes what the
              cloud evaluates for everyone, and a regular user arms the
              device, which is the thing in their house. Hidden rather than
              disabled — a greyed-out card they can never use is just noise. */}
          {role === "admin" && (
            <section className="card">
              <div className="card__header">
                <h2 className="card__title">{t("ops.server")}</h2>
                {/* Server state comes from the profile subscription, not RTDB,
                    so it is known as soon as profiles load — a different
                    condition from the device card's. */}
                <StateBadge
                  armed={serverArmedEffective}
                  loading={!profilesLoaded}
                />
              </div>
              <ArmGrid
                side="server"
                activeId={activeServerId}
                stateKnown={profilesLoaded}
              />
            </section>
          )}

          {/* Below the arm grid and SOS, above the siren panel: the arm grid
              is what you came to press; schedules are what you check on the
              way past. */}
          {projectId && (
            <SchedulesPanel
              projectId={projectId}
              profiles={profiles}
              role={role}
            />
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
                  {/* "Quiet" is a claim about the siren, so it waits for the
                      subscription rather than defaulting to reassuring. */}
                  {rtdbLoading
                    ? "—"
                    : sirenActive
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
    </div>
  );
}
