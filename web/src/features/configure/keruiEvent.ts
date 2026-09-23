// The Kerui nibble -> event table, web side — for DISPLAY and for pairing.
//
// A Kerui packet is 24 bits: the TOP 20 are the sensor's identity, the
// BOTTOM 4 are an event code. Pairing stores the 20-bit family, so one
// physical sensor is one row however many codes it sends.
//
// THIS TABLE IS A LOCAL FINDING, NOT A PROTOCOL SPEC. EV1527 has no notion
// of these names; a nibble's meaning is vendor-defined per model. rtl_433's
// kerui.c covers the models it was written against (D026, WD51, P831); we
// agree on 0xA / 0xB / 0xE, and 0x9 is ours.
//
// Deliberately DUPLICATED from functions/src/keruiEvent.ts and
// firmware/edge/device/src/kerui_event.h — no shared module across three
// languages, same reason types.ts exists twice. The cloud suite reads this
// file as text and asserts all three agree, so a drift fails there.
//
// NO SENSOR TYPE is derived from the nibble. 0x9 is sent by four curtain
// sensors (beam cut) AND by door family 0x2E5B7 (open, alongside its 0x3
// close), so it identifies an EVENT, never a device class. A derived,
// non-editable type would have mislabelled real sensors with no way to fix
// it — see docs/superpowers/specs/2026-09-23-sensor-event-families-design.md.

export type KeruiEvent =
  | "trigger"
  | "close"
  | "tamper"
  | "water"
  | "battery_low"
  // Not in the table. Rendered as a trigger, never dropped: the smoke
  // detector's nibble (0x2) is unverified and must still reach the rules.
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
 * The 20-bit identity of a 24-bit rfId, as the stored string form:
 * "0x0061DA" -> "0x0061D". Five upper-case hex digits, 0x-prefixed.
 * Null when the input is not parseable hex — RTDB event keys include
 * non-sensor entries like "REMOTE".
 */
export function familyIdOf(rfId: string): string | null {
  const cleaned = rfId.trim();
  if (!/^0[xX][0-9a-fA-F]{1,8}$/.test(cleaned)) return null;
  const value = parseInt(cleaned, 16);
  if (!Number.isFinite(value)) return null;
  return (
    "0x" +
    (((value >>> 4) & 0xfffff) >>> 0).toString(16).toUpperCase().padStart(5, "0")
  );
}

/**
 * Canonicalise a value that is ALREADY a 20-bit family ("0x0061d" ->
 * "0x0061D"), or null when it is not one.
 *
 * Told apart from a full rfId by LENGTH — exactly five hex digits. Running
 * familyIdOf on an already-shifted family would shift it a second time,
 * turning "0x0061D" into "0x00061" and matching nothing, so a caller
 * handling a mix of both forms must check this first.
 */
export function normaliseFamilyId(value: string): string | null {
  const cleaned = value.trim();
  if (!/^0[xX][0-9a-fA-F]{5}$/.test(cleaned)) return null;
  return "0x" + cleaned.slice(2).toUpperCase();
}

/** The event nibble of a 24-bit rfId, or null when unparseable. */
export function nibbleOf(rfId: string): number | null {
  const cleaned = rfId.trim();
  if (!/^0[xX][0-9a-fA-F]{1,8}$/.test(cleaned)) return null;
  const value = parseInt(cleaned, 16);
  if (!Number.isFinite(value)) return null;
  return value & 0x0f;
}

/** The event implied by an observed rfId, for display beside it. */
export function eventOfRfId(rfId: string): KeruiEvent {
  const nibble = nibbleOf(rfId);
  return nibble === null ? "unknown" : keruiEventOf(nibble);
}

/** Human label for an event, used in the sensors list and the timeline. */
export function keruiEventLabel(event: KeruiEvent): string {
  switch (event) {
    case "trigger":
      return "Trigger";
    case "close":
      return "Close";
    case "tamper":
      return "Tamper";
    case "water":
      return "Water";
    case "battery_low":
      return "Battery low";
    case "unknown":
      return "Unknown";
  }
}
