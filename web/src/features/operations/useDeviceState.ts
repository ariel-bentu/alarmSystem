// Hook: subscribes to RTDB state/armed and state/siren_active for the active project.
import { useState, useEffect } from "react";
import { onValue } from "firebase/database";
import { stateArmedRef, stateSirenRef } from "@/lib/rtdb";

interface DeviceState {
  armed: boolean | null;
  sirenActive: boolean | null;
  loading: boolean;
}

/**
 * Live RTDB subscription to device arm state and siren state.
 * Returns null values while loading or if projectId is falsy.
 */
export function useDeviceState(projectId: string | undefined): DeviceState {
  const [armed, setArmed] = useState<boolean | null>(null);
  const [sirenActive, setSirenActive] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) {
      setArmed(null);
      setSirenActive(null);
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

    return () => {
      unsubArmed();
      unsubSiren();
    };
  }, [projectId]);

  return { armed, sirenActive, loading };
}
