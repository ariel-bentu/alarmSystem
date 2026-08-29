// Hook: live alarm indicator, driven by RTDB state/alarm_cause.
//
// The cause node persists after the alarm ends, so an alarm counts as active
// only while its timestamp is newer than the last acknowledgement. Disarming
// acknowledges; the acknowledgement is persisted per project so a page reload
// does not resurrect an alarm the user already dealt with.
import { useCallback, useEffect, useState } from "react";
import { onValue } from "firebase/database";
import { stateAlarmCauseRef } from "@/lib/rtdb";
import {
  AlarmCause,
  AlarmSide,
  alarmSide,
  isAlarmActive,
  parseAlarmCause,
} from "./alarmState";

interface AlarmState {
  cause: AlarmCause | null;
  side: AlarmSide | null;
  active: boolean;
  acknowledge: () => void;
}

const ackKey = (projectId: string) => `alarm.ack.${projectId}`;

function readAck(projectId: string): number | null {
  try {
    const raw = localStorage.getItem(ackKey(projectId));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

function writeAck(projectId: string, at: number): void {
  try {
    localStorage.setItem(ackKey(projectId), String(at));
  } catch {
    // Non-fatal: the dismissal just won't survive a reload.
  }
}

export function useAlarmState(projectId: string | undefined): AlarmState {
  const [cause, setCause] = useState<AlarmCause | null>(null);
  const [acknowledgedAt, setAcknowledgedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) {
      setCause(null);
      setAcknowledgedAt(null);
      return;
    }
    setAcknowledgedAt(readAck(projectId));
    const unsub = onValue(stateAlarmCauseRef(projectId), (snap) => {
      setCause(parseAlarmCause(snap.val()));
    });
    return unsub;
  }, [projectId]);

  const acknowledge = useCallback(() => {
    if (!projectId || typeof cause?.at !== "number") return;
    writeAck(projectId, cause.at);
    setAcknowledgedAt(cause.at);
  }, [projectId, cause]);

  return {
    cause,
    side: alarmSide(cause),
    active: isAlarmActive(cause, acknowledgedAt),
    acknowledge,
  };
}
