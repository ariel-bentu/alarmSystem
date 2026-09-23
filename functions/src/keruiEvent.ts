// The Kerui nibble -> event table, cloud side.
//
// A Kerui packet is 24 bits: the TOP 20 are the sensor's identity, the
// BOTTOM 4 are an event code. The system used to treat the whole 24-bit
// value as the identity, so one physical sensor appeared as several
// unrelated "sensors" depending on what it did — a tamper (0x0061DB) did not
// match its own paired motion code (0x0061DA) and was logged as unpaired.
//
// THIS TABLE IS A LOCAL FINDING, NOT A PROTOCOL SPEC. EV1527 has no notion
// of these names; the meaning of a nibble is vendor-defined per model.
// rtl_433's kerui.c covers the models it was written against (D026, WD51,
// P831); we agree on 0xA / 0xB / 0xE, and 0x9 is ours.
//
// Deliberately DUPLICATED from firmware/edge/device/src/kerui_event.h rather
// than shared — separate languages, no shared module, the same reason
// types.ts exists in both functions/ and web/. keruiEvent.test.ts asserts
// this table matches the firmware's by value, so a drift fails the suite.
//
// NOTE: no sensor TYPE is derived from the nibble anywhere. 0x9 is sent both
// by four curtain sensors (beam cut) and by door family 0x2E5B7 (open,
// alongside its 0x3 close), so it identifies an EVENT, never a device class.
export type KeruiEvent =
  | "trigger"
  | "close"
  | "tamper"
  | "water"
  | "battery_low"
  // A nibble not in the table. Callers route it to "trigger" via
  // keruiEventName so an unrecognised code is never silently dropped — the
  // smoke detector (family 0xCC268, nibble 0x2) has never fired in 3,089
  // events, and a silently-ignored smoke alarm is the worst possible outcome.
  | "unknown";

const NIBBLE_EVENTS: Record<number, KeruiEvent> = {
  0x9: "trigger", // curtain beam cut / door open — ambiguous, see above
  0xa: "trigger", // motion (rtl_433 + our data)
  0xe: "trigger", // door open (rtl_433 `open` + our data)
  0x3: "close", // our data only, family 0x2E5B7 x40
  0x7: "close", // rtl_433; never observed here
  0xb: "tamper", // rtl_433 + our data (2 samples)
  0x5: "water", // rtl_433; never observed here
  0xf: "battery_low", // rtl_433; never observed here
};

/** Pure: nibble (low 4 bits; anything above is masked off) -> event. */
export function keruiEventOf(nibble: number): KeruiEvent {
  return NIBBLE_EVENTS[nibble & 0x0f] ?? "unknown";
}

/**
 * The event name used on the wire and in the timeline. "unknown" becomes
 * "trigger" so an unrecognised nibble still reaches the alarm rules.
 */
export function keruiEventName(event: KeruiEvent): Exclude<KeruiEvent, "unknown"> {
  return event === "unknown" ? "trigger" : event;
}

/**
 * The 20-bit identity of a 24-bit rfId, as the stored string form:
 * "0x0061DA" -> "0x0061D". Five upper-case hex digits, 0x-prefixed.
 *
 * Returns null when `rfId` is not parseable as hex — the RTDB /events keys
 * are device-written and mostly trustworthy, but the simulator has produced
 * five-digit artefacts like "0x11111" and a caller must be able to tell a
 * bad key from a real family.
 */
export function familyIdOf(rfId: string): string | null {
  const cleaned = rfId.trim();
  if (!/^0[xX][0-9a-fA-F]{1,8}$/.test(cleaned)) return null;
  const value = parseInt(cleaned, 16);
  if (!Number.isFinite(value)) return null;
  return formatFamilyId((value >>> 4) & 0xfffff);
}

/** A 20-bit family value as its canonical stored string, e.g. "0x0061D". */
export function formatFamilyId(family: number): string {
  return "0x" + ((family >>> 0) & 0xfffff).toString(16).toUpperCase().padStart(5, "0");
}

/** The event nibble of a 24-bit rfId, or null when unparseable. */
export function nibbleOf(rfId: string): number | null {
  const cleaned = rfId.trim();
  if (!/^0[xX][0-9a-fA-F]{1,8}$/.test(cleaned)) return null;
  const value = parseInt(cleaned, 16);
  if (!Number.isFinite(value)) return null;
  return value & 0x0f;
}
