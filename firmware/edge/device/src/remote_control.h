#pragma once

#include <cstdint>

#include "alarm_state.h"

// A 433MHz 4-button remote in the same fixed-code EV1527 family as the
// Kerui sensors: one 24-bit code per press, where the TOP 20 BITS are the
// remote's identity and the BOTTOM NIBBLE is which button, one-hot.
//
// Measured on real hardware (see docs/superpowers/specs/
// 2026-09-02-remote-control-design.md): remote 0xE45CA emits 0xE45CA2 for
// disarm and 0xE45CA4 for arm.
//
// NOTE: this is the same wire format the Kerui sensor decoder produces, so
// the receive path is shared. It is NOT the EV1527 framing we TRANSMIT to
// the siren — never validate one against the other.

enum class RemoteAction : uint8_t {
  None = 0,   // not a recognised button
  ArmHome,    // "S" — decoded deliberately, but does nothing (see design doc)
  Disarm,
  Arm,        // arms with the CURRENT config; does not select a profile
  Sos,
};

// Top 20 bits: stable per remote, shared by all four buttons.
inline uint32_t remoteIdentityOf(uint32_t code) { return code >> 4; }

// Bottom 4 bits: which button.
inline uint8_t remoteNibbleOf(uint32_t code) {
  return static_cast<uint8_t>(code & 0xF);
}

// Map a button nibble to its action. The nibble is ONE-HOT; anything else
// is a corrupt decode and returns None rather than a guessed action.
RemoteAction remoteActionFor(uint8_t nibble);

// Why pairing was refused. Distinguishable so the UI can say which.
enum class RemotePairResult : uint8_t {
  Paired = 0,
  AlreadyPaired,  // idempotent success
  RefusedArmed,
  Full,
};

// Is this identity one of the paired remotes?
bool remoteIsPaired(const Config& config, uint32_t identity);

// Adopt `identity` as a paired remote.
//
// Refused while armed: an attacker in RF range could otherwise pair their
// own remote against an armed system and immediately disarm it. Idempotent,
// so repeated presses during the pairing window do not consume slots.
// Caller is responsible for persisting `config` afterwards.
RemotePairResult remotePair(Config* config, uint32_t identity, bool armed);
