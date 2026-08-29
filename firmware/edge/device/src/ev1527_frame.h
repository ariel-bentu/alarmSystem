#pragma once

#include <cstddef>
#include <cstdint>

// EV1527 frame rendering, kept free of Arduino/SPI so it can be unit-tested
// on the host. The CC1101 streams this as a bit pattern through its TX FIFO,
// one chip per FIFO bit, where a chip is T/kChipsPerT long.
//
// EVERY CONSTANT HERE IS LOAD-BEARING. They were established by a clean-room
// rewrite (firmware/edge/spike_clean_tx) after a tuned transmitter failed for
// days; see docs/superpowers/specs/2026-08-29-siren-tx-firmware-port-design.md.
// In particular kCarrierBit = 1 is MEASURED — the inverse yields malformed
// frames — and our own Kerui receiver CANNOT validate this framing.
namespace Ev1527 {

constexpr uint16_t kPeriodUs = 300;   // base period T
constexpr int kChipsPerT = 4;         // FIFO chips per T (75us chips)
constexpr bool kCarrierBit = true;    // FIFO bit value that keys carrier ON
constexpr int kBits = 24;

// sync = 1T on + 31T off = 32T; each of 24 bits is a 4T cell.
constexpr int kPeriodsPerFrame = 32 + kBits * 4;          // 128 T
constexpr int kChipsPerFrame = kPeriodsPerFrame * kChipsPerT;  // 512 chips

// Render one frame into `out`, packed MSB-first within each byte.
// Returns chips written, or 0 if `outLen` cannot hold the frame.
size_t renderFrame(uint32_t code, uint8_t* out, size_t outLen);

// Render `repeats` back-to-back frames. Returns total chips written, or 0.
size_t renderBurst(uint32_t code, int repeats, uint8_t* out, size_t outLen);

// Solve the CC1101 data-rate registers for a chip of `chipUs` microseconds:
//   R = (256 + DRATE_M) * 2^DRATE_E * Fxosc / 2^28,  Fxosc = 26MHz
void computeDrate(uint32_t chipUs, uint8_t* e, uint8_t* m);

}  // namespace Ev1527
