// Pairing command construction, kept free of Firebase imports so it is
// directly unit-testable.

// The device polls /commands every ~15s alternating with /config, so a
// command can take ~30s to arrive, and pairing then transmits for 10s. The
// window must comfortably exceed both or the device discards its own
// request as expired.
const DEFAULT_WINDOW_SEC = 180;

export interface PairCommand {
  n: number;
  until: number;
}

// A nonce rather than a bool: the device deduplicates by value, so a second
// pairing attempt with an identical payload would be silently ignored.
export const buildPairCommand = (
  nowMs: number,
  windowSec: number = DEFAULT_WINDOW_SEC
): PairCommand => ({
  n: Math.floor(Math.random() * 0xffffffff) + 1,
  until: Math.floor(nowMs / 1000) + windowSec,
});

export const formatSirenAddress = (addr: number | null): string =>
  addr === null || addr === undefined
    ? "unknown"
    : `0x${addr.toString(16).toUpperCase().padStart(6, "0")}`;
