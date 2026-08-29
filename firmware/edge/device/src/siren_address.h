#pragma once

#include <cstdint>

// The device's EV1527 identity for its siren. The value itself is arbitrary
// — it is simply whatever we transmit while the siren is in learn mode — so
// it is generated randomly once and then persisted, keeping each device
// distinct and surviving reflashes.
namespace SirenAddress {

// Command nibbles (one-hot family, per the paired siren's protocol).
constexpr uint32_t kCmdArmAway = 0x1;
constexpr uint32_t kCmdDisarm  = 0x2;
constexpr uint32_t kCmdArmHome = 0x4;
constexpr uint32_t kCmdSos     = 0x8;

// Force `raw` into a usable base address: 24-bit, command nibble cleared.
// Never returns 0, because 0 is the "not yet generated" sentinel in EEPROM
// and a random draw must not collide with it.
uint32_t normalize(uint32_t raw);

// True if `addr` is a stored base address (non-zero, clean command nibble).
bool isValid(uint32_t addr);

#if defined(ARDUINO)
// Draw a fresh normalized address from the hardware RNG.
uint32_t generate();
#endif

}  // namespace SirenAddress
