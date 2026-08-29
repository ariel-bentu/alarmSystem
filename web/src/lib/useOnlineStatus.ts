// Tracks browser connectivity for the offline banner and for disabling
// arm/disarm.
//
// navigator.onLine is a weak signal — it reports link state, not whether
// Firebase is reachable — but it is the only synchronous one available, and
// it is reliably correct in the case that matters here (airplane mode / no
// signal). Firestore's own `fromCache` metadata covers the "connected to a
// network that cannot reach Firebase" case where data is displayed.
import { useEffect, useState } from "react";

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
