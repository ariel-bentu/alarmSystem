#include "ev1527_frame.h"

#include <cmath>
#include <cstring>

namespace Ev1527 {
namespace {

// Append `periods` worth of chips at the given carrier state. `chipIndex` is
// advanced in place. Returns false if the buffer would overflow.
bool emit(bool carrier, int periods, uint8_t* out, size_t outLen,
          size_t& chipIndex) {
  const int chips = periods * kChipsPerT;
  for (int i = 0; i < chips; i++) {
    if ((chipIndex >> 3) >= outLen) return false;
    const bool v = carrier ? kCarrierBit : !kCarrierBit;
    if (v) out[chipIndex >> 3] |= (uint8_t)(1u << (7 - (chipIndex & 7)));
    chipIndex++;
  }
  return true;
}

bool renderInto(uint32_t code, uint8_t* out, size_t outLen, size_t& chipIndex) {
  if (!emit(true, 1, out, outLen, chipIndex)) return false;    // sync pulse
  if (!emit(false, 31, out, outLen, chipIndex)) return false;  // sync gap
  for (int b = kBits - 1; b >= 0; b--) {                       // MSB first
    const bool one = (code >> b) & 1u;
    if (!emit(true, one ? 3 : 1, out, outLen, chipIndex)) return false;
    if (!emit(false, one ? 1 : 3, out, outLen, chipIndex)) return false;
  }
  return true;
}

}  // namespace

size_t renderFrame(uint32_t code, uint8_t* out, size_t outLen) {
  return renderBurst(code, 1, out, outLen);
}

size_t renderBurst(uint32_t code, int repeats, uint8_t* out, size_t outLen) {
  const size_t needed = ((size_t)kChipsPerFrame * repeats + 7) / 8;
  if (repeats <= 0 || outLen < needed) return 0;
  memset(out, 0, needed);
  size_t chipIndex = 0;
  for (int r = 0; r < repeats; r++) {
    if (!renderInto(code, out, outLen, chipIndex)) return 0;
  }
  return chipIndex;
}

void computeDrate(uint32_t chipUs, uint8_t* e, uint8_t* m) {
  const double want = 1e6 / (double)chipUs;
  double best = 1e18;
  *e = 0;
  *m = 0;
  for (int E = 0; E < 16; E++) {
    for (int M = 0; M < 256; M++) {
      const double r = (256.0 + M) * pow(2.0, E) * 26e6 / pow(2.0, 28);
      const double err = fabs(r - want);
      if (err < best) {
        best = err;
        *e = (uint8_t)E;
        *m = (uint8_t)M;
      }
    }
  }
}

}  // namespace Ev1527
