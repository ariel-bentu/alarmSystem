#include "siren_address.h"

#if defined(ARDUINO)
#include "platform_compat.h"
#endif

namespace SirenAddress {
namespace {
// Used when a draw normalizes to zero. Arbitrary but fixed, and valid.
constexpr uint32_t kFallback = 0xA1B2C0;
}  // namespace

uint32_t normalize(uint32_t raw) {
  const uint32_t addr = raw & 0xFFFFF0u;
  return addr == 0 ? kFallback : addr;
}

bool isValid(uint32_t addr) {
  return addr != 0 && (addr & 0x0Fu) == 0 && (addr & 0xFF000000u) == 0;
}

#if defined(ARDUINO)
uint32_t generate() { return normalize(PLATFORM_RANDOM32()); }
#endif

}  // namespace SirenAddress
