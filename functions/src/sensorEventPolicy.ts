// What each sensor event type is allowed to do. The behaviour table from
// docs/superpowers/specs/2026-09-23-sensor-event-families-design.md, as pure
// logic so it is unit-tested rather than discovered in production.
//
// | Event       | Siren           | Telegram | Alarm rules |
// |-------------|-----------------|----------|-------------|
// | trigger     | via rules       | via rules| yes         |
// | tamper      | yes, EVEN       | always   | no          |
// |             | WHILE DISARMED  |          | (own path)  |
// | water       | no              | once     | no          |
// | battery_low | no              | once     | no          |
// | close       | no              | no       | no          |
//
// Each row is a deliberate policy choice, not an emergent behaviour.

import { EventType } from "./types";
import { KeruiEvent } from "./keruiEvent";

export interface EventPolicy {
  /** The EventType written to the timeline. */
  eventType: EventType;
  /**
   * Whether this event is fed to the alarm-rule evaluator. Only `trigger`
   * is: tamper has its own path (it fires regardless of arm state, which no
   * rule can express), and close/water/battery_low drive nothing.
   */
  evaluateRules: boolean;
  /**
   * Whether this event notifies regardless of the project's
   * notifyEverySensorTrigger toggle. Safety events ignore a noise
   * preference — that toggle exists to silence routine motion, not to hide
   * a tampered sensor or a leak.
   */
  alwaysNotify: boolean;
  /**
   * The Sensor field that latches a once-per-condition alert, or null when
   * this event notifies every time. Without the marker a leaking sensor
   * would Telegram on every packet, which is every few seconds.
   */
  onceMarker: "waterAlertSentAt" | "batteryAlertSentAt" | null;
  /**
   * Whether this event is mirrored to Firestore and Telegram at all.
   * `close` is mirrored (history stays complete) but silent.
   */
  notify: boolean;
}

/**
 * Policy for a decoded Kerui event.
 *
 * `unknown` is deliberately treated exactly as `trigger`: the smoke detector
 * sits on nibble 0x2, which is in no table and has never fired in 3,089
 * events, so it is unverified. Routing it anywhere else would silently
 * disable a smoke alarm — the worst outcome this refactor could produce.
 */
export function classifyEvent(event: KeruiEvent): EventPolicy {
  switch (event) {
    case "tamper":
      return {
        eventType: "tamper",
        // NOT rule-evaluated. Tamper sirens even while DISARMED, which no
        // rule can express — see the siren decision in onSensorEvent.
        evaluateRules: false,
        alwaysNotify: true,
        // Every tamper notifies. Unlike water, tamper is an event, not a
        // standing condition: a second one is a second act of interference.
        onceMarker: null,
        notify: true,
      };
    case "water":
      return {
        eventType: "water",
        evaluateRules: false,
        alwaysNotify: true,
        onceMarker: "waterAlertSentAt",
        notify: true,
      };
    case "battery_low":
      return {
        eventType: "battery_low",
        evaluateRules: false,
        alwaysNotify: true,
        // Shared with the stale-battery check on purpose: both mean "the
        // user has been told this battery needs attention", and a second
        // field would let one battery produce two different Telegrams.
        onceMarker: "batteryAlertSentAt",
        notify: true,
      };
    case "close":
      return {
        eventType: "close",
        evaluateRules: false,
        alwaysNotify: false,
        onceMarker: null,
        // Mirrored to the timeline so history is complete, but silent: the
        // system has no concept of a door's open/closed STATE, only of
        // events, and adding one is separate work.
        notify: false,
      };
    case "trigger":
    case "unknown":
      return {
        eventType: "trigger",
        evaluateRules: true,
        alwaysNotify: false,
        onceMarker: null,
        notify: true,
      };
  }
}

/**
 * Whether the device-reported `event` string wins over the nibble.
 *
 * The firmware derives the event from the nibble itself and reports it, so
 * the two normally agree. But the LOCAL WEB SIMULATOR posts an arbitrary
 * rfId with a hardcoded "trigger", and deviceIngest (legacy, used by smoke/)
 * accepts any event string — so an explicit non-trigger string from the
 * device is authoritative, and anything else falls back to the nibble.
 */
export function eventFromReport(
  reported: string | undefined,
  fromNibble: KeruiEvent
): KeruiEvent {
  switch (reported) {
    case "tamper":
    case "water":
    case "battery_low":
    case "close":
      return reported;
    default:
      return fromNibble;
  }
}
