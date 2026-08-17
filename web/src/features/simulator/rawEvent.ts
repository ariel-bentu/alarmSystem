// Pure helper: builds an RtdbRawEvent payload for the simulator.
import type { RtdbRawEvent } from "@/types";

/**
 * Constructs the raw event object that the device (or simulator) writes
 * to RTDB at /{projectId}/events/{rfId}/{timestamp}.
 */
export function buildRawEvent(
  eventType: string,
  batteryLow: boolean,
  rssi: number
): RtdbRawEvent {
  return {
    event: eventType,
    battery_low: batteryLow,
    rssi,
  };
}
