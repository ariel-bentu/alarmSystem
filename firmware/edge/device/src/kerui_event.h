#pragma once

#include <cstdint>

// The bottom nibble of a Kerui 24-bit packet is an EVENT code; the top 20
// bits are the sensor's identity (see kerui_decoder.h's keruiParse).
//
// THIS TABLE IS A LOCAL FINDING, NOT A PROTOCOL SPEC. EV1527 has no notion
// of these names — the chip latches whichever of its four data pins the
// sensor's board pulls high, so a nibble's meaning is vendor-defined per
// model. rtl_433's kerui.c is the mapping for the models that decoder was
// written against (D026, WD51, P831); ours agrees on 0xA / 0xB / 0xE, and
// 0x9 is an addition measured on this house's sensors.
//
// 0x9 is the weakest entry: it means "this sensor's primary alarm event" —
// beam cut on four curtain sensors, door-open on family 0x2E5B7 (whose
// close code is 0x3, ×40 against ×12 opens over a 3,089-event history).
// It therefore canNOT identify a sensor TYPE, which is why no sensor type
// is derived anywhere in this system. Treat a future contradiction as new
// data, not a bug.
//
// Two close codes are both real: 0x7 (rtl_433's models) and 0x3 (ours).
// Two door sensors in the same house use different codes for the same act.
//
// Duplicated in functions/src/keruiEvent.ts and
// web/src/features/configure/keruiEvent.ts — separate languages, no shared
// module, same reason types.ts exists three times. The cloud test asserts
// the tables agree by value.
enum class KeruiEvent : uint8_t {
  TRIGGER,
  CLOSE,
  TAMPER,
  WATER,
  BATTERY_LOW,
  // A nibble not in the table. Deliberately routed to TRIGGER by callers so
  // an unrecognised code is never silently dropped — the smoke detector
  // (family 0xCC268, nibble 0x2) has never fired in 3,089 events, and a
  // silently-ignored smoke alarm is the worst outcome this table could
  // produce.
  UNKNOWN,
};

// Pure: nibble (low 4 bits; anything above is masked off) -> event.
inline KeruiEvent keruiEventOf(uint8_t nibble) {
  switch (nibble & 0x0F) {
    case 0x9:  // curtain beam cut / door open — ambiguous, see above
    case 0xA:  // motion (rtl_433 + our data)
    case 0xE:  // door open (rtl_433 `open` + our data)
      return KeruiEvent::TRIGGER;
    case 0x3:  // close — our data only, family 0x2E5B7 ×40
    case 0x7:  // close — rtl_433; never observed here
      return KeruiEvent::CLOSE;
    case 0xB:  // tamper (rtl_433 + our data, 2 samples)
      return KeruiEvent::TAMPER;
    case 0x5:  // water — rtl_433; never observed here
      return KeruiEvent::WATER;
    case 0xF:  // battery low — rtl_433; never observed here
      return KeruiEvent::BATTERY_LOW;
    default:
      return KeruiEvent::UNKNOWN;
  }
}

// The string reported to the cloud as /events/{rfId}/{ts}.event. UNKNOWN
// reports "trigger" so an unrecognised nibble still reaches the rules.
inline const char* keruiEventName(KeruiEvent e) {
  switch (e) {
    case KeruiEvent::CLOSE:
      return "close";
    case KeruiEvent::TAMPER:
      return "tamper";
    case KeruiEvent::WATER:
      return "water";
    case KeruiEvent::BATTERY_LOW:
      return "battery_low";
    case KeruiEvent::TRIGGER:
    case KeruiEvent::UNKNOWN:
      break;
  }
  return "trigger";
}

// The 20-bit identity of a 24-bit Kerui code.
inline uint32_t keruiFamilyOf(uint32_t sensorId) {
  return (sensorId >> 4) & 0xFFFFF;
}

// The event nibble of a 24-bit Kerui code.
inline uint8_t keruiNibbleOf(uint32_t sensorId) {
  return (uint8_t)(sensorId & 0x0F);
}
