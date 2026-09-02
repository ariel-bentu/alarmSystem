// Hook: subscribes to RTDB state/armed, state/siren_active, state/last_seen,
// and state/boot.
import { useState, useEffect } from "react";
import { onValue } from "firebase/database";
import {
  stateArmedRef,
  stateSirenRef,
  stateLastSeenRef,
  stateBootRef,
} from "@/lib/rtdb";
import type { RtdbBoot } from "@/types";

interface DeviceState {
  armed: boolean | null;
  sirenActive: boolean | null;
  deviceOnline: boolean; // true if last_seen within 30s
  // Last boot record, or null if the device has not reported one. A device
  // that crashed and recovered is otherwise indistinguishable from one that
  // never went down — see bootReason.ts.
  boot: RtdbBoot | null;
  loading: boolean;
}

// Consider the device online if it has written a heartbeat within this window.
const ONLINE_WINDOW_MS = 30_000;

/**
 * Live RTDB subscription to device arm state, siren state, and online status.
 * Returns null values while loading or if projectId is falsy.
 */
export function useDeviceState(projectId: string | undefined): DeviceState {
  const [armed, setArmed] = useState<boolean | null>(null);
  const [sirenActive, setSirenActive] = useState<boolean | null>(null);
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [boot, setBoot] = useState<RtdbBoot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);

  // Refresh `now` every 5s so the online indicator updates without a trigger.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!projectId) {
      setArmed(null);
      setSirenActive(null);
      setLastSeen(null);
      setBoot(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    let armedResolved = false;
    let sirenResolved = false;

    const checkReady = () => {
      if (armedResolved && sirenResolved) setLoading(false);
    };

    const unsubArmed = onValue(stateArmedRef(projectId), (snap) => {
      setArmed(snap.val() ?? false);
      armedResolved = true;
      checkReady();
    });

    const unsubSiren = onValue(stateSirenRef(projectId), (snap) => {
      setSirenActive(snap.val() ?? false);
      sirenResolved = true;
      checkReady();
    });

    const unsubLastSeen = onValue(stateLastSeenRef(projectId), (snap) => {
      // The value is device uptime (seconds) — not wall-clock. We timestamp
      // the *arrival* of the update so online detection works before NTP sync.
      if (snap.val() !== null) setLastSeen(Date.now());
    });

    const unsubBoot = onValue(stateBootRef(projectId), (snap) => {
      const val = snap.val();
      setBoot(
        val && typeof val === "object" && typeof val.reason === "string"
          ? (val as RtdbBoot)
          : null
      );
    });

    // Deliberately NOT part of checkReady(): a device that has never
    // reported a boot (older firmware, or one that has not reached the cloud
    // yet) would otherwise leave the whole page stuck loading.
    return () => {
      unsubArmed();
      unsubSiren();
      unsubLastSeen();
      unsubBoot();
    };
  }, [projectId]);

  const deviceOnline = lastSeen !== null && now - lastSeen <= ONLINE_WINDOW_MS;

  return { armed, sirenActive, deviceOnline, boot, loading };
}
