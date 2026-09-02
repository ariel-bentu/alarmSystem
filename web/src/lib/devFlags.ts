// Build-time flags. Deliberately its own module, separate from lib/firebase:
// App.tsx and AppLayout.tsx import DEV_SIMULATOR for a single boolean, and
// when it lived alongside the SDK init that one import pulled the entire
// Firebase bundle onto the first-paint path.

// True only in a dev build with the simulator flag set.
export const DEV_SIMULATOR = import.meta.env.VITE_DEV_SIMULATOR === "true";
