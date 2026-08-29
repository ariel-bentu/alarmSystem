# Siren RF Transmit — Firmware Port and Cloud-Initiated Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the proven EV1527 siren transmitter from `firmware/edge/spike_clean_tx` into the device firmware, and let a user pair a siren from the cloud web UI.

**Architecture:** Transmit becomes a method on the existing `Cc1101Receiver` (only one owner may hold the radio's mode). `RelaySiren` keeps its interface but drives RF as its primary output. The siren's base address is randomly generated once per device and persisted in EEPROM. Pairing is triggered by a nonce written to `/{projectId}/commands/pair`, executed by the device, and confirmed by the user in the web UI — the device cannot hear the siren's beep, so the user is the only possible success oracle.

**Tech Stack:** C++ (Arduino, PlatformIO — `esp32s3` primary, `d1_mini` fallback, `native` for Unity tests), TypeScript (Cloud Functions gen-2, `europe-west1`), React + TypeScript (Vite), Firebase RTDB + Firestore.

**Spec:** `docs/superpowers/specs/2026-08-29-siren-tx-firmware-port-design.md`

## Global Constraints

These apply to every task. Values are copied verbatim from the spec and from measurements already recorded in `CLAUDE.md`.

- **Never validate our transmitter with our own receiver.** `kerui_decoder.h`'s rule reads our own EV1527 frame as `0x9DDC8B`, not `0x622374`. Ground truth for TX is the siren's physical response or a capture of a genuine third-party transmitter. Do not "fix" the decoder to agree with the encoder — that is the circular-tuning bug this design exists to avoid.
- **TX frame constants are load-bearing, ported verbatim:** `T = 300us`, `kChipsPerT = 4`, `kCarrierBit = 1`, `FREND0 (0x22) = 0x11`, `PATABLE = {0x00, 0xC0}`, `MDMCFG2 (0x12) = 0x30`. Frame is `1T` carrier + `31T` silence, then 24 bits MSB first, bit 1 = `3T` ON + `1T` off, bit 0 = `1T` ON + `3T` off.
- **Command nibbles (one-hot family):** `8` = SOS, `4` = arm home, `1` = arm away, `2` = disarm.
- **Polling cadence stays at 15s.** It is a heap budget, not a latency preference — at 5s the board died with an OOM inside `MDNSResponder::_readRRAnswer`. Do not lower it to make pairing feel faster.
- **Build with an explicit env:** `pio run -e esp32s3`. A bare `pio run` also builds `[env:native]`, which fails to link outside a test run.
- **Tests:** `pio test -e native` must stay green (20 tests passing before this plan; 26 after).
- **Large buffers are never stack locals** in code reachable from `loop()`: the ESP8266 cont stack is 4KB and enters `loop()` with ~1568 bytes free.

---

### Task 1: EV1527 frame renderer (pure logic, native-tested)

Extract the frame rendering and data-rate maths from the spike into a standalone, native-testable unit. No SPI, no hardware — this is why it can be tested on the host.

**Files:**
- Create: `firmware/edge/device/src/ev1527_frame.h`
- Create: `firmware/edge/device/src/ev1527_frame.cpp`
- Create: `firmware/edge/device/test/test_ev1527_frame/test_ev1527_frame.cpp`
- Modify: `firmware/edge/device/platformio.ini` (add `+<ev1527_frame.cpp>` to `[env:native]`'s `build_src_filter`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `namespace Ev1527 { ... }`
  - `constexpr uint16_t kPeriodUs = 300;`
  - `constexpr int kChipsPerT = 4;`
  - `constexpr bool kCarrierBit = true;`
  - `constexpr int kChipsPerFrame = 512;` (sync `32T` + 24 bits x `4T` = `128T`; `128 * 4` chips)
  - `size_t renderFrame(uint32_t code, uint8_t* out, size_t outLen);` — returns chips written, 0 if `outLen` too small. Bit-packs MSB-first within each byte.
  - `size_t renderBurst(uint32_t code, int repeats, uint8_t* out, size_t outLen);` — returns total chips written.
  - `void computeDrate(uint32_t chipUs, uint8_t* e, uint8_t* m);`

- [ ] **Step 1: Write the failing test**

Create `firmware/edge/device/test/test_ev1527_frame/test_ev1527_frame.cpp`:

```cpp
#include <unity.h>
#include <cstring>
#include "ev1527_frame.h"

// Read chip i out of the packed buffer (MSB-first within each byte).
static bool chipAt(const uint8_t* buf, size_t i) {
  return (buf[i >> 3] >> (7 - (i & 7))) & 1;
}

// Count how many consecutive chips starting at `from` have value `want`.
static size_t runLength(const uint8_t* buf, size_t from, size_t total, bool want) {
  size_t n = 0;
  while (from + n < total && chipAt(buf, from + n) == want) n++;
  return n;
}

void test_frame_starts_with_1T_carrier_then_31T_silence() {
  uint8_t buf[64] = {};
  size_t chips = Ev1527::renderFrame(0xFFFFFF, buf, sizeof(buf));
  TEST_ASSERT_EQUAL(Ev1527::kChipsPerFrame, chips);

  // Sync pulse: exactly 1T of carrier == kChipsPerT chips.
  TEST_ASSERT_EQUAL(Ev1527::kCarrierBit, chipAt(buf, 0));
  TEST_ASSERT_EQUAL(Ev1527::kChipsPerT,
                    runLength(buf, 0, chips, Ev1527::kCarrierBit));

  // Sync gap: exactly 31T of silence.
  TEST_ASSERT_EQUAL(31 * Ev1527::kChipsPerT,
                    runLength(buf, Ev1527::kChipsPerT, chips, !Ev1527::kCarrierBit));
}

void test_bit_one_is_3T_on_1T_off() {
  // All-ones payload: after the 32T sync, every bit cell is 3T on + 1T off.
  uint8_t buf[64] = {};
  size_t chips = Ev1527::renderFrame(0xFFFFFF, buf, sizeof(buf));
  size_t p = 32 * Ev1527::kChipsPerT;  // first data chip

  TEST_ASSERT_EQUAL(3 * Ev1527::kChipsPerT,
                    runLength(buf, p, chips, Ev1527::kCarrierBit));
  p += 3 * Ev1527::kChipsPerT;
  TEST_ASSERT_EQUAL(Ev1527::kChipsPerT,
                    runLength(buf, p, chips, !Ev1527::kCarrierBit));
}

void test_bit_zero_is_1T_on_3T_off() {
  // All-zeros payload: every bit cell is 1T on + 3T off. The 3T off of the
  // last sync period merges with nothing here because sync ends with silence,
  // so check the first data cell explicitly at its known offset.
  uint8_t buf[64] = {};
  size_t chips = Ev1527::renderFrame(0x000000, buf, sizeof(buf));
  size_t p = 32 * Ev1527::kChipsPerT;

  TEST_ASSERT_EQUAL(Ev1527::kChipsPerT,
                    runLength(buf, p, chips, Ev1527::kCarrierBit));
  p += Ev1527::kChipsPerT;
  TEST_ASSERT_EQUAL(3 * Ev1527::kChipsPerT,
                    runLength(buf, p, chips, !Ev1527::kCarrierBit));
}

void test_bits_are_sent_msb_first() {
  // 0x800000 has ONLY the MSB set: the first data cell must be a 1 (3T on)
  // and the second a 0 (1T on).
  uint8_t buf[64] = {};
  size_t chips = Ev1527::renderFrame(0x800000, buf, sizeof(buf));
  size_t p = 32 * Ev1527::kChipsPerT;

  TEST_ASSERT_EQUAL(3 * Ev1527::kChipsPerT,
                    runLength(buf, p, chips, Ev1527::kCarrierBit));
  p += 4 * Ev1527::kChipsPerT;  // advance one full 4T cell
  TEST_ASSERT_EQUAL(Ev1527::kChipsPerT,
                    runLength(buf, p, chips, Ev1527::kCarrierBit));
}

void test_render_frame_rejects_undersized_buffer() {
  uint8_t small[4] = {};
  TEST_ASSERT_EQUAL(0, Ev1527::renderFrame(0xA1B2C8, small, sizeof(small)));
}

void test_render_burst_repeats_the_frame() {
  uint8_t buf[256] = {};
  size_t chips = Ev1527::renderBurst(0xA1B2C8, 3, buf, sizeof(buf));
  TEST_ASSERT_EQUAL(3 * Ev1527::kChipsPerFrame, chips);

  // The second frame must begin with the same sync pulse as the first.
  size_t second = Ev1527::kChipsPerFrame;
  TEST_ASSERT_EQUAL(Ev1527::kCarrierBit, chipAt(buf, second));
  TEST_ASSERT_EQUAL(Ev1527::kChipsPerT,
                    runLength(buf, second, chips, Ev1527::kCarrierBit));
}

void test_compute_drate_matches_datasheet_formula() {
  // R = (256 + M) * 2^E * 26e6 / 2^28. For a 75us chip (T=300, 4 chips per T)
  // the wanted rate is 13333.3 chips/s. Verify the solved pair reproduces that
  // within 2%, rather than hardcoding an (E,M) the implementation might reach
  // by a different-but-equivalent route.
  uint8_t e = 0, m = 0;
  Ev1527::computeDrate(75, &e, &m);
  double rate = (256.0 + m) * (double)(1u << e) * 26e6 / 268435456.0;
  TEST_ASSERT_DOUBLE_WITHIN(13333.3 * 0.02, 13333.3, rate);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_frame_starts_with_1T_carrier_then_31T_silence);
  RUN_TEST(test_bit_one_is_3T_on_1T_off);
  RUN_TEST(test_bit_zero_is_1T_on_3T_off);
  RUN_TEST(test_bits_are_sent_msb_first);
  RUN_TEST(test_render_frame_rejects_undersized_buffer);
  RUN_TEST(test_render_burst_repeats_the_frame);
  RUN_TEST(test_compute_drate_matches_datasheet_formula);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd firmware/edge/device && pio test -e native`
Expected: FAIL — `ev1527_frame.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/edge/device/src/ev1527_frame.h`:

```cpp
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
```

Create `firmware/edge/device/src/ev1527_frame.cpp`:

```cpp
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
```

Modify `firmware/edge/device/platformio.ini` — in `[env:native]`'s `build_src_filter`, add after `+<config_parser.cpp>`:

```
    +<ev1527_frame.cpp>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS — 27 tests total (20 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/ev1527_frame.h \
        firmware/edge/device/src/ev1527_frame.cpp \
        firmware/edge/device/test/test_ev1527_frame/test_ev1527_frame.cpp \
        firmware/edge/device/platformio.ini
git commit -m "Add native-testable EV1527 frame renderer

Extracted from spike_clean_tx. Pure logic, no SPI, so the frame shape is
verified on the host: 1T sync + 31T gap, bit 1 = 3T on, MSB first."
```

---

### Task 2: Siren address generation and EEPROM persistence

The base address is arbitrary — it is whatever we transmit while the siren is in learn mode. Generating it per device avoids every unit sharing an identity, and EEPROM survives reflashing so a physical pairing outlives firmware updates.

**Files:**
- Modify: `firmware/edge/device/src/alarm_state.h:27-32` (add field to `Config`)
- Modify: `firmware/edge/device/src/eeprom_store.h:28` (bump magic)
- Create: `firmware/edge/device/src/siren_address.h`
- Create: `firmware/edge/device/src/siren_address.cpp`
- Modify: `firmware/edge/device/src/platform_compat.h` (add RNG macro to both branches)
- Modify: `firmware/edge/device/test/test_eeprom_store/test_eeprom_store.cpp`
- Create: `firmware/edge/device/test/test_siren_address/test_siren_address.cpp`
- Modify: `firmware/edge/device/platformio.ini` (add `+<siren_address.cpp>` to native filter)

**Interfaces:**
- Consumes: `Config` from `alarm_state.h`.
- Produces:
  - `Config::sirenBaseAddress` (`uint32_t`, default 0 = unset)
  - `namespace SirenAddress { uint32_t normalize(uint32_t raw); bool isValid(uint32_t addr); uint32_t generate(); }`
  - `normalize()` masks to the top 20 bits (`raw & 0xFFFFF0`) and maps a zero result to a fixed non-zero fallback, so "unset" stays unambiguous.
  - `PLATFORM_RANDOM32()` macro in `platform_compat.h`.

- [ ] **Step 1: Write the failing tests**

Create `firmware/edge/device/test/test_siren_address/test_siren_address.cpp`:

```cpp
#include <unity.h>
#include "siren_address.h"

void test_normalize_clears_the_command_nibble() {
  // The bottom nibble carries the command, never identity.
  TEST_ASSERT_EQUAL_HEX32(0xA1B2C0, SirenAddress::normalize(0xA1B2CF));
  TEST_ASSERT_EQUAL_HEX32(0xA1B2C0, SirenAddress::normalize(0xA1B2C8));
}

void test_normalize_masks_to_24_bits() {
  // Anything above bit 23 is not transmittable in a 24-bit frame.
  TEST_ASSERT_EQUAL_HEX32(0x123450, SirenAddress::normalize(0xFF123456));
}

void test_normalize_never_returns_zero() {
  // Zero means "unset" in EEPROM, so a random draw of 0 must not collide
  // with it — otherwise the device regenerates its address on every boot
  // and silently breaks an existing pairing.
  TEST_ASSERT_NOT_EQUAL(0u, SirenAddress::normalize(0x00000000));
  TEST_ASSERT_NOT_EQUAL(0u, SirenAddress::normalize(0x0000000F));
}

void test_is_valid_rejects_unset_and_accepts_normalized() {
  TEST_ASSERT_FALSE(SirenAddress::isValid(0));
  TEST_ASSERT_TRUE(SirenAddress::isValid(0xA1B2C0));
  // A value with a dirty command nibble was never stored by us.
  TEST_ASSERT_FALSE(SirenAddress::isValid(0xA1B2C8));
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_normalize_clears_the_command_nibble);
  RUN_TEST(test_normalize_masks_to_24_bits);
  RUN_TEST(test_normalize_never_returns_zero);
  RUN_TEST(test_is_valid_rejects_unset_and_accepts_normalized);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
```

Add to `firmware/edge/device/test/test_eeprom_store/test_eeprom_store.cpp`, before `setup()`:

```cpp
void test_siren_base_address_round_trips() {
  Config config;
  config.sirenBaseAddress = 0xA1B2C0;

  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(false, true, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  TEST_ASSERT_TRUE(
      EepromStore::decode(buffer, written, &armedOut, &localWebOut, &configOut));
  TEST_ASSERT_EQUAL_HEX32(0xA1B2C0, configOut.sirenBaseAddress);
}

void test_decode_rejects_pre_siren_address_magic() {
  // Adding sirenBaseAddress changed sizeof(Config), so a record written by
  // the previous firmware must be REJECTED rather than misread as garbage
  // siren state. The magic bump is that mechanism.
  Config config;
  uint8_t buffer[EepromStore::kReservedBytes];
  EepromStore::encode(true, true, config, buffer, sizeof(buffer));
  const uint32_t previousMagic = 0xA1A2B3B5;
  memcpy(buffer, &previousMagic, sizeof(previousMagic));

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  TEST_ASSERT_FALSE(
      EepromStore::decode(buffer, sizeof(buffer), &armedOut, &localWebOut, &configOut));
}
```

And register both in that file's `setup()`:

```cpp
  RUN_TEST(test_siren_base_address_round_trips);
  RUN_TEST(test_decode_rejects_pre_siren_address_magic);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd firmware/edge/device && pio test -e native`
Expected: FAIL — `siren_address.h: No such file or directory`, and `'struct Config' has no member named 'sirenBaseAddress'`.

- [ ] **Step 3: Write the implementation**

In `firmware/edge/device/src/alarm_state.h`, extend `Config`:

```cpp
struct Config {
  bool armed = false;
  uint16_t sirenDurationSec = 0;
  // EV1527 base address this device uses to talk to its siren: top 20 bits
  // are identity, bottom nibble is the command and is always 0 here.
  // 0 means "not yet generated". Randomly generated once on first boot and
  // persisted, so a physical pairing survives reflashing.
  uint32_t sirenBaseAddress = 0;
  SensorConfig sensors[16];
  uint8_t sensorCount = 0;
};
```

In `firmware/edge/device/src/eeprom_store.h`, bump the magic and extend its comment:

```cpp
  // Bumped from 0xA1A2B3B5 — adding Config::sirenBaseAddress changed
  // sizeof(Config), so records written by earlier firmware must be rejected
  // rather than misread. A magic mismatch is decode()'s rejection mechanism.
  static constexpr uint32_t kMagic = 0xA1A2B3B6;
```

`EepromStore::encode`/`decode` need no change — they `memcpy` the whole `Config` struct, so the new field is covered automatically.

Create `firmware/edge/device/src/siren_address.h`:

```cpp
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
```

Create `firmware/edge/device/src/siren_address.cpp`:

```cpp
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
```

In `firmware/edge/device/src/platform_compat.h`, add to the **ESP32 branch** (after the `platformMdnsUpdate` definition):

```cpp
// Hardware RNG. esp_random() lives in ESP-IDF's esp_random.h and is NOT
// declared by any Arduino core header, so the include is required.
#include <esp_random.h>
#define PLATFORM_RANDOM32() (esp_random())
```

and to the **ESP8266 branch** (after its `platformMdnsUpdate`):

```cpp
// Hardware RNG register, exposed by the core's esp8266_peri.h (pulled in via
// Arduino.h). There is no esp_random() on this platform.
#define PLATFORM_RANDOM32() (RANDOM_REG32)
```

Modify `firmware/edge/device/platformio.ini` — add to `[env:native]`'s `build_src_filter`:

```
    +<siren_address.cpp>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS — 33 tests (27 from Task 1 + 4 siren address + 2 EEPROM).

- [ ] **Step 5: Verify both hardware envs still compile**

Run: `cd firmware/edge/device && pio run -e esp32s3 && pio run -e d1_mini`
Expected: both SUCCESS. This is what proves the `PLATFORM_RANDOM32()` macro is right on each platform — the native tests never exercise it.

- [ ] **Step 6: Commit**

```bash
git add firmware/edge/device/src/alarm_state.h \
        firmware/edge/device/src/eeprom_store.h \
        firmware/edge/device/src/siren_address.h \
        firmware/edge/device/src/siren_address.cpp \
        firmware/edge/device/src/platform_compat.h \
        firmware/edge/device/test/test_siren_address/test_siren_address.cpp \
        firmware/edge/device/test/test_eeprom_store/test_eeprom_store.cpp \
        firmware/edge/device/platformio.ini
git commit -m "Add per-device siren base address, persisted in EEPROM

Randomly generated once so devices don't share an identity, and kept in
EEPROM so a physical pairing survives reflashing. Magic bumped because
sizeof(Config) changed: old records must be rejected, not misread."
```

---

### Task 3: CC1101 transmit and RX restore

Transmit lives on the receiver object because only one owner may hold the radio's mode, CS pin and SPI bus. Two objects would invite a mode race with no way to detect it.

**Files:**
- Modify: `firmware/edge/device/src/cc1101_receiver.h`
- Modify: `firmware/edge/device/src/cc1101_receiver.cpp`

**Interfaces:**
- Consumes: `Ev1527::renderBurst`, `Ev1527::computeDrate`, `Ev1527::kPeriodUs`, `Ev1527::kChipsPerT` (Task 1).
- Produces: `bool Cc1101Receiver::transmit(uint32_t code, int repeats);` — blocking, ~384ms for `repeats = 10` (512 chips x 75us per frame); returns false if the chip was never initialised. Restores RX before returning in every path.

- [ ] **Step 1: Add the declarations**

In `firmware/edge/device/src/cc1101_receiver.h`, add to the public section after `poll()`:

```cpp
  // Transmit an EV1527 frame `repeats` times, then restore receive mode.
  //
  // BLOCKING for ~38ms per repeat (512 chips x 75us), so ~384ms at the
  // 10 repeats used for a command: the radio cannot hear sensors
  // while transmitting, because in TX mode the chip is not demodulating at
  // all. Accepted deliberately — Kerui sensors repeat each burst 5-7 times,
  // and we only transmit when the siren is already being commanded. A
  // non-blocking chunked FIFO feed was rejected: an underrun mid-frame
  // produces a malformed frame the siren rejects, trading a certain small
  // loss for an intermittent large one.
  //
  // NOTE: this framing is NOT the Kerui sensor framing that poll() decodes.
  // They are different protocols sharing a chip; do not attempt to verify
  // this against our own decoder (it reads our EV1527 frames as garbage).
  bool transmit(uint32_t code, int repeats);
```

and to the private section:

```cpp
  bool initialised_ = false;

  // Rendered chip pattern. A MEMBER, not a stack local: at 10 repeats this
  // is 640 bytes and loop()'s ESP8266 cont stack has ~1.5KB total.
  static const int kMaxTxRepeats = 12;
  uint8_t txBits_[(Ev1527::kChipsPerFrame * kMaxTxRepeats + 7) / 8];

  void configureForTx();
  void streamTxFifo(size_t numBytes);
```

Add the include at the top of the header:

```cpp
#include "ev1527_frame.h"
```

- [ ] **Step 2: Implement transmit**

In `firmware/edge/device/src/cc1101_receiver.cpp`, add these register constants to the anonymous namespace:

```cpp
constexpr uint8_t REG_PKTCTRL1 = 0x07;
constexpr uint8_t REG_MDMCFG1  = 0x13;
constexpr uint8_t REG_MDMCFG0  = 0x14;
constexpr uint8_t REG_FREND0   = 0x22;
constexpr uint8_t REG_PATABLE  = 0x3E;
constexpr uint8_t REG_TXBYTES  = 0x3A;
constexpr uint8_t REG_TXFIFO   = 0x3F;
constexpr uint8_t STROBE_SIDLE = 0x36;
constexpr uint8_t STROBE_STX   = 0x35;
constexpr uint8_t STROBE_SFTX  = 0x3B;
constexpr uint8_t CC1101_BURST = 0x40;
// PA level ported verbatim from spike_clean_tx. Do NOT tune this to close
// the unexplained 24dB gap against the older sender — the weaker setting is
// the one the siren actually responds to.
constexpr uint8_t kPaLevel = 0xC0;
```

Set `initialised_ = true;` in `begin()`, immediately before `return true;`.

Then add:

```cpp
// TX register set. Note this writes FIVE registers the RX config does not
// write back on its own — PATABLE, FREND0, PKTCTRL1, MDMCFG1, MDMCFG0 —
// so configureFor433MhzOok() must restore them explicitly rather than
// relying on the power-on reset it used to inherit them from.
void Cc1101Receiver::configureForTx() {
  strobe(STROBE_SIDLE);
  delay(2);

  writeReg(REG_IOCFG0,   0x06);  // packet status (unused in TX)
  writeReg(REG_PKTCTRL0, 0x00);  // fixed length, no CRC/whitening
  writeReg(REG_PKTCTRL1, 0x00);  // no address check
  writeReg(REG_FREQ2,    0x10);
  writeReg(REG_FREQ1,    0xB0);  // 433.92MHz
  writeReg(REG_FREQ0,    0x71);
  writeReg(REG_MDMCFG2,  0x30);  // OOK, no Manchester, no sync word
  writeReg(REG_MDMCFG1,  0x02);  // NUM_PREAMBLE = 0
  writeReg(REG_MDMCFG0,  0x00);

  uint8_t e = 0, m = 0;
  Ev1527::computeDrate(Ev1527::kPeriodUs / Ev1527::kChipsPerT, &e, &m);
  writeReg(REG_MDMCFG4, (uint8_t)(0x80 | e));
  writeReg(REG_MDMCFG3, m);

  // FREND0 PA_POWER=1 selects PATABLE[1] as the "carrier on" entry. Without
  // it the PA has no off entry and holds a continuous carrier: a commanded
  // 50ms pulse was measured arriving as 158ms.
  writeReg(REG_FREND0, 0x11);
  writeReg(REG_MCSM1,  0x30);
  writeReg(REG_MCSM0,  0x18);

  digitalWrite(csPin_, LOW);     // PATABLE: [0] = off, [1] = on
  SPI.transfer(REG_PATABLE | CC1101_BURST);
  SPI.transfer(0x00);
  SPI.transfer(kPaLevel);
  for (int i = 2; i < 8; i++) SPI.transfer(0x00);
  digitalWrite(csPin_, HIGH);
}

// Stream `numBytes` of txBits_ through the TX FIFO, refilling as it drains.
void Cc1101Receiver::streamTxFifo(size_t numBytes) {
  strobe(STROBE_SFTX);
  writeReg(REG_PKTCTRL0, 0x02);  // infinite packet length while streaming

  size_t first = numBytes < 60 ? numBytes : 60;
  digitalWrite(csPin_, LOW);
  SPI.transfer(REG_TXFIFO | CC1101_BURST);
  for (size_t i = 0; i < first; i++) SPI.transfer(txBits_[i]);
  digitalWrite(csPin_, HIGH);

  size_t sent = first;
  strobe(STROBE_STX);

  const unsigned long deadline = millis() + 2000;  // never spin forever
  while (sent < numBytes && millis() < deadline) {
    if ((readStatusReg(REG_TXBYTES) & 0x7F) < 40) {
      size_t chunk = numBytes - sent;
      if (chunk > 20) chunk = 20;
      digitalWrite(csPin_, LOW);
      SPI.transfer(REG_TXFIFO | CC1101_BURST);
      for (size_t i = 0; i < chunk; i++) SPI.transfer(txBits_[sent + i]);
      digitalWrite(csPin_, HIGH);
      sent += chunk;
    }
    delayMicroseconds(100);
    platformFeedWatchdog();
  }
  while ((readStatusReg(REG_TXBYTES) & 0x7F) > 0 && millis() < deadline) {
    delayMicroseconds(100);
    platformFeedWatchdog();
  }
  delayMicroseconds(Ev1527::kPeriodUs * 4);  // let the modulator drain
  strobe(STROBE_SIDLE);
}

bool Cc1101Receiver::transmit(uint32_t code, int repeats) {
  if (!initialised_) return false;
  if (repeats < 1) repeats = 1;
  if (repeats > kMaxTxRepeats) repeats = kMaxTxRepeats;

  const size_t chips = Ev1527::renderBurst(code, repeats, txBits_, sizeof(txBits_));
  if (chips == 0) return false;

  // Stop capturing before touching the radio's mode, and drop whatever
  // partial burst was mid-flight — those edges would decode as noise.
  detachInterrupt(digitalPinToInterrupt(gdo0Pin_));
  edgeCount_ = 0;

  configureForTx();
  streamTxFifo((chips + 7) / 8);

  // Restore receive. This is the regression that matters: a sensor decoded
  // after a transmit is the proof the register restore is complete.
  configureFor433MhzOok();
  strobe(STROBE_SRX);
  edgeCount_ = 0;
  lastEdgeMs_ = (uint32_t)(esp_timer_get_time() / 1000);
  attachInterrupt(digitalPinToInterrupt(gdo0Pin_), isr, CHANGE);

  Serial.printf("[cc1101] tx 0x%06lX x%d (%u chips)\n",
                (unsigned long)code, repeats, (unsigned)chips);
  return true;
}
```

Add `#include "platform_compat.h"` near the top of `cc1101_receiver.cpp` for `platformFeedWatchdog()`.

- [ ] **Step 3: Verify it compiles on both targets**

Run: `cd firmware/edge/device && pio run -e esp32s3 && pio run -e d1_mini`
Expected: both SUCCESS.

- [ ] **Step 4: Confirm the native tests still pass**

Run: `cd firmware/edge/device && pio test -e native`
Expected: PASS — still 33 tests. (`cc1101_receiver.cpp` is not in the native build; this guards against an accidental break in the shared headers.)

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/cc1101_receiver.h \
        firmware/edge/device/src/cc1101_receiver.cpp
git commit -m "Add CC1101 transmit with RX restore

TX is a method on the receiver because only one owner may hold the radio's
mode. Registers ported verbatim from spike_clean_tx, including FREND0=0x11
and the PA level that measures weaker but is the one the siren answers."
```

---

### Task 4: Drive the siren over RF

`RelaySiren` keeps its interface so `alarm_state`, `local_web_server` and `main.cpp` need no changes at their call sites.

**Files:**
- Modify: `firmware/edge/device/src/relay_siren.h`
- Modify: `firmware/edge/device/src/relay_siren.cpp`
- Modify: `firmware/edge/device/src/main.cpp:405-408` (wire the transmitter and address in)

**Interfaces:**
- Consumes: `Cc1101Receiver::transmit` (Task 3), `SirenAddress::kCmdSos`/`kCmdDisarm`/`isValid`/`generate` (Task 2).
- Produces: `void RelaySiren::begin(uint8_t relayPin, Cc1101Receiver* radio, uint32_t baseAddress);` and `void RelaySiren::setBaseAddress(uint32_t baseAddress);`

- [ ] **Step 1: Update the header**

Replace the contents of `firmware/edge/device/src/relay_siren.h`:

```cpp
#pragma once

#include <cstdint>

#include "cc1101_receiver.h"

// Drives the siren two ways at once: an RF command over the CC1101 (the
// proven path — the siren is paired directly to this device, no hub) and a
// GPIO relay (built, still untested, kept for when hardware is wired).
//
// The interface is unchanged from the relay-only version so alarm_state,
// local_web_server and main.cpp call sites are untouched.
class RelaySiren {
 public:
  // `radio` and `baseAddress` may be null/0, in which case only the relay is
  // driven — the device still works as an alarm with no siren paired.
  void begin(uint8_t relayPin, Cc1101Receiver* radio, uint32_t baseAddress);
  void setBaseAddress(uint32_t baseAddress);
  void turnOn(uint16_t durationSec, unsigned long nowMs);
  void turnOff();
  void tick(unsigned long nowMs);
  bool isActive() const { return active_; }

 private:
  static const int kCommandRepeats = 10;

  uint8_t relayPin_ = 0;
  Cc1101Receiver* radio_ = nullptr;
  uint32_t baseAddress_ = 0;
  bool active_ = false;
  unsigned long offAtMs_ = 0;
  bool autoOff_ = false;

  void sendCommand(uint32_t nibble);
};
```

- [ ] **Step 2: Update the implementation**

Replace the contents of `firmware/edge/device/src/relay_siren.cpp`:

```cpp
#include "relay_siren.h"

#include <Arduino.h>

#include "siren_address.h"

void RelaySiren::begin(uint8_t relayPin, Cc1101Receiver* radio,
                       uint32_t baseAddress) {
  relayPin_ = relayPin;
  radio_ = radio;
  baseAddress_ = baseAddress;
  pinMode(relayPin_, OUTPUT);
  digitalWrite(relayPin_, LOW);
}

void RelaySiren::setBaseAddress(uint32_t baseAddress) {
  baseAddress_ = baseAddress;
}

void RelaySiren::sendCommand(uint32_t nibble) {
  if (radio_ == nullptr || !SirenAddress::isValid(baseAddress_)) return;
  radio_->transmit(baseAddress_ | nibble, kCommandRepeats);
}

void RelaySiren::turnOn(uint16_t durationSec, unsigned long nowMs) {
  if (durationSec == 0) return;  // siren disabled

  digitalWrite(relayPin_, HIGH);
  sendCommand(SirenAddress::kCmdSos);
  active_ = true;
  autoOff_ = true;
  offAtMs_ = nowMs + (unsigned long)durationSec * 1000UL;
}

void RelaySiren::turnOff() {
  digitalWrite(relayPin_, LOW);
  // MUST transmit, not merely drop the pin: an RF siren sounds until it is
  // told to stop, so a silent expiry would leave it sounding until switched
  // off by hand.
  sendCommand(SirenAddress::kCmdDisarm);
  active_ = false;
  autoOff_ = false;
}

void RelaySiren::tick(unsigned long nowMs) {
  if (active_ && autoOff_ && nowMs >= offAtMs_) {
    turnOff();
  }
}
```

- [ ] **Step 3: Wire it up in main.cpp**

In `firmware/edge/device/src/main.cpp`, add the include after `#include "provisioning_portal.h"`:

```cpp
#include "siren_address.h"
```

Then replace lines 405-408 (the `cc1101.begin(...)` / `siren.begin(...)` block) in `onNormalOperation()`:

```cpp
  bool radioReady = cc1101.begin(kCc1101CsPin, kCc1101Gdo0Pin);
  if (!radioReady) {
    Serial.println("[cc1101] init FAILED — RF receive and siren TX disabled");
  }

  // Generate the siren identity on first boot and persist it, so a physical
  // pairing survives reflashing.
  if (!SirenAddress::isValid(config.sirenBaseAddress)) {
    config.sirenBaseAddress = SirenAddress::generate();
    eepromStore.save(armed, localWebEnabled, config);
    Serial.printf("[siren] generated new base address 0x%06lX\n",
                  (unsigned long)config.sirenBaseAddress);
  }
  Serial.printf("[siren] base address 0x%06lX\n",
                (unsigned long)config.sirenBaseAddress);
  siren.begin(kRelayPin, radioReady ? &cc1101 : nullptr, config.sirenBaseAddress);
```

Note: `applyPendingConfigUpdate()` overwrites `config` wholesale from the cloud, which would clear the locally generated address. Guard it — in that function, after `newConfig.armed = armed;` add:

```cpp
  // The siren address is device-owned and never sent by the cloud; preserve
  // it across a config push or the device forgets its pairing.
  newConfig.sirenBaseAddress = config.sirenBaseAddress;
```

- [ ] **Step 4: Verify both targets compile**

Run: `cd firmware/edge/device && pio run -e esp32s3 && pio run -e d1_mini`
Expected: both SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/relay_siren.h \
        firmware/edge/device/src/relay_siren.cpp \
        firmware/edge/device/src/main.cpp
git commit -m "Drive the siren over RF, keeping the relay path

turnOff() transmits disarm rather than only dropping the pin: an RF siren
sounds until told to stop. The device-owned base address is preserved
across cloud config pushes, which would otherwise erase the pairing."
```

---

### Task 5: Pairing command on the device

**Files:**
- Modify: `firmware/edge/device/src/cloud_client.h`
- Modify: `firmware/edge/device/src/cloud_client.cpp` (`applyCommandsJson` near line 531; add consumer near line 574)
- Modify: `firmware/edge/device/src/main.cpp` (pairing routine + `loop()` wiring)

**Interfaces:**
- Consumes: `Cc1101Receiver::transmit` (Task 3), `Config::sirenBaseAddress` (Task 2).
- Produces: `bool CloudClient::consumePairCommand(uint32_t* nonce, uint32_t* untilEpochSec);` — true once per new nonce.

- [ ] **Step 1: Declare the consumer**

In `firmware/edge/device/src/cloud_client.h`, add after `consumeSirenCommand` (line 59):

```cpp
  // Pairing request: /commands/pair = { n: <nonce>, until: <epochSec> }.
  // A nonce rather than a bool so a repeat request is distinguishable from a
  // stale one; `until` lets the device ignore a request whose window has
  // already passed, so a command left in RTDB cannot make a device pair
  // itself on reboot days later.
  bool consumePairCommand(uint32_t* nonce, uint32_t* untilEpochSec);
```

and to the private state, alongside the other `pending*`/`had*` members:

```cpp
  uint32_t lastPairNonce_ = 0;
  bool hadPairNonce_ = false;
  uint32_t pendingPairNonce_ = 0;
  uint32_t pendingPairUntil_ = 0;
  bool hasPendingPair_ = false;
```

- [ ] **Step 2: Parse and consume it**

In `firmware/edge/device/src/cloud_client.cpp`, inside `applyCommandsJson`, after the `siren` block:

```cpp
  if (doc["pair"]["n"].is<uint32_t>()) {
    uint32_t n = doc["pair"]["n"].as<uint32_t>();
    if (!hadPairNonce_ || n != lastPairNonce_) {
      hadPairNonce_ = true;
      lastPairNonce_ = n;
      pendingPairNonce_ = n;
      pendingPairUntil_ = doc["pair"]["until"].is<uint32_t>()
                              ? doc["pair"]["until"].as<uint32_t>()
                              : 0;
      hasPendingPair_ = true;
      Serial.printf("cloud: commands.pair -> nonce %lu until %lu\n",
                    (unsigned long)pendingPairNonce_,
                    (unsigned long)pendingPairUntil_);
    }
  }
```

and next to the other consumers:

```cpp
bool CloudClient::consumePairCommand(uint32_t* nonce, uint32_t* untilEpochSec) {
  if (!hasPendingPair_) return false;
  *nonce = pendingPairNonce_;
  *untilEpochSec = pendingPairUntil_;
  hasPendingPair_ = false;
  return true;
}
```

- [ ] **Step 3: Add the pairing routine to main.cpp**

In `firmware/edge/device/src/main.cpp`, add after `applyPendingConfigUpdate()`:

```cpp
// Loop the base address on air so a siren held in learn mode can bind it.
// Blocking ~10s and largely deaf to sensors throughout — acceptable
// because pairing is a deliberate, user-initiated act, and the web UI says
// so before the user starts.
//
// noinline for the cont-stack reason documented on handleSensorEvent().
__attribute__((noinline))
void runSirenPairing() {
  const unsigned long kPairingWindowMs = 10000UL;
  Serial.printf("[siren] pairing: looping 0x%06lX for 10s — press SET on the siren\n",
                (unsigned long)config.sirenBaseAddress);
  const unsigned long start = millis();
  while (millis() - start < kPairingWindowMs) {
    cc1101.transmit(config.sirenBaseAddress | SirenAddress::kCmdArmHome, 6);
    delay(300);
    platformFeedWatchdog();
  }
  Serial.println("[siren] pairing window closed");
}
```

Then in `loop()`, after the `consumeSirenCommand` block:

```cpp
  uint32_t pairNonce = 0, pairUntil = 0;
  if (cloudClient.consumePairCommand(&pairNonce, &pairUntil)) {
    // Ignore an expired request: time(nullptr) is only meaningful once NTP
    // has synced, so a zero/unset `until` is treated as "no deadline".
    const uint32_t nowSec = (uint32_t)time(nullptr);
    if (pairUntil != 0 && nowSec > 100000UL && nowSec > pairUntil) {
      Serial.printf("[siren] ignoring expired pair request (now %lu > until %lu)\n",
                    (unsigned long)nowSec, (unsigned long)pairUntil);
    } else {
      runSirenPairing();
    }
  }
```

- [ ] **Step 4: Verify both targets compile**

Run: `cd firmware/edge/device && pio run -e esp32s3 && pio run -e d1_mini`
Expected: both SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/cloud_client.h \
        firmware/edge/device/src/cloud_client.cpp \
        firmware/edge/device/src/main.cpp
git commit -m "Run siren pairing on a cloud command

Nonce-keyed and self-expiring, so a command left in RTDB cannot make a
device pair itself on a later reboot."
```

---

### Task 6: LAN pairing fallback

The only path that works when the cloud is unreachable, and a few lines on top of the same routine.

**Files:**
- Modify: `firmware/edge/device/src/local_web_server.h`
- Modify: `firmware/edge/device/src/local_web_server.cpp`
- Modify: `firmware/edge/device/src/local_web_page.h`
- Modify: `firmware/edge/device/src/main.cpp` (`loop()`)

**Interfaces:**
- Consumes: `runSirenPairing()` (Task 5).
- Produces: `bool LocalWebServer::hasPendingPairRequest();` and `void LocalWebServer::clearPendingPairRequest();`

- [ ] **Step 1: Read the existing handler pattern**

Run: `sed -n '1,80p' firmware/edge/device/src/local_web_server.cpp`

Follow the exact shape of the existing arm/disarm and simulate-trigger handlers — matching the file's own pattern matters more than the sketch below.

- [ ] **Step 2: Add the endpoint**

In `firmware/edge/device/src/local_web_server.h`, add to the public section:

```cpp
  bool hasPendingPairRequest() const { return pendingPair_; }
  void clearPendingPairRequest() { pendingPair_ = false; }
```

and to the private state:

```cpp
  bool pendingPair_ = false;
```

In `firmware/edge/device/src/local_web_server.cpp`, register a handler alongside the existing routes in `begin()`:

```cpp
  server_.on("/pair-siren", HTTP_POST, [this]() {
    pendingPair_ = true;
    server_.send(200, "text/plain",
                 "Pairing for 10s - press SET on the siren now");
  });
```

In `firmware/edge/device/src/local_web_page.h`, add a button to the page body, matching the markup style already used there:

```html
<h2>Siren</h2>
<p>Press SET on the siren until its lights come on, then start pairing.
   The alarm cannot hear sensors for 10 seconds while it transmits.</p>
<button onclick="fetch('/pair-siren',{method:'POST'}).then(r=>r.text()).then(t=>alert(t))">
  Pair siren (10s)
</button>
```

- [ ] **Step 3: Wire it into loop()**

In `firmware/edge/device/src/main.cpp`, inside the `if (localWebEnabled)` block, after the pending-trigger handling:

```cpp
    if (localWebServer.hasPendingPairRequest()) {
      localWebServer.clearPendingPairRequest();
      runSirenPairing();
    }
```

- [ ] **Step 4: Verify both targets compile**

Run: `cd firmware/edge/device && pio run -e esp32s3 && pio run -e d1_mini`
Expected: both SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add firmware/edge/device/src/local_web_server.h \
        firmware/edge/device/src/local_web_server.cpp \
        firmware/edge/device/src/local_web_page.h \
        firmware/edge/device/src/main.cpp
git commit -m "Add LAN siren pairing fallback

Works with no cloud, which is the point: the cloud flow is the primary
path but cannot help when the network is down."
```

---

### Task 7: Hardware verification (device side)

Everything so far is compile-checked and host-tested. **None of it has touched the air.** This task is the real gate; do not proceed to the web work if it fails.

**Files:** none — this is a hardware test.

- [ ] **Step 1: Flash and watch the boot**

```bash
ls /dev/cu.*   # the ESP32-S3 enumerates as usbmodem*; the suffix moves between sessions
cd firmware/edge/device && pio run -e esp32s3 -t upload --upload-port /dev/cu.usbmodem1101
python3 firmware/edge/read_serial.py 40
```

Expected: `[cc1101] PARTNUM=0x00 VERSION=0x14 — chip OK`, then either `[siren] generated new base address 0x......` (first boot after this change) or `[siren] base address 0x......`.

- [ ] **Step 2: Confirm the address persists**

Reset the board and capture the log again. Expected: the SAME address, now without the "generated" line. If it regenerates every boot, EEPROM persistence is broken — stop and fix Task 2 before continuing.

- [ ] **Step 3: Pair the siren over LAN**

Press SET on the siren until its lights come on, then POST to the endpoint (substitute the device's IP):

```bash
curl -X POST http://alarm.local/pair-siren
```

Expected: **two beeps** from the siren. That is the documented success signal. If nothing happens, retry — the learn window is short — and only then investigate.

- [ ] **Step 4: Sound and silence it**

With `sirenDurationSec` set to something short (10s), trigger via the local web simulator. Expected: the siren sounds, then **stops by itself** when the timer expires. A siren that keeps sounding means `turnOff()` is not transmitting — the exact failure Task 4 guards against.

- [ ] **Step 5: Verify RX survives TX (the key regression)**

After the transmit above, trigger a real Kerui door sensor. Expected: `[cc1101] packet sensorId=0x......` in the log. If sensor decode is dead after a transmit, the RX register restore in Task 3 is incomplete — fix before continuing.

- [ ] **Step 6: Record the results**

Note in the commit message what worked, the generated address, and the pairing distance. If the range is poor, say so plainly — the spec flags range as unmeasured and it bears on decommissioning the hub.

```bash
git commit --allow-empty -m "Hardware: siren pairs, sounds and silences from device firmware

<record: address, beeps observed, auto-off confirmed, sensor decode after TX,
approximate range>"
```

---

### Task 8: RTDB path helpers and the pairing command writer

**Files:**
- Modify: `web/src/lib/rtdb.ts`
- Create: `web/src/features/configure/sirenPairing.ts`
- Create: `web/src/features/configure/sirenPairing.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the wire format is the contract).
- Produces:
  - `commandsPairPath(projectId)`, `commandsPairRef(projectId)`, `stateSirenBasePath(projectId)`, `stateSirenBaseRef(projectId)`
  - `buildPairCommand(nowMs: number, windowSec?: number): { n: number; until: number }`
  - `formatSirenAddress(addr: number | null): string`

- [ ] **Step 1: Write the failing test**

Create `web/src/features/configure/sirenPairing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPairCommand, formatSirenAddress } from "./sirenPairing";

describe("buildPairCommand", () => {
  it("expires the request after the pairing window", () => {
    const nowMs = 1_700_000_000_000;
    const cmd = buildPairCommand(nowMs, 120);
    // until is an epoch SECOND, not a millisecond — the device compares it
    // against time(nullptr).
    expect(cmd.until).toBe(Math.floor(nowMs / 1000) + 120);
  });

  it("defaults to a window that covers poll latency plus transmit time", () => {
    // The device polls /commands every ~30s and then transmits for 10s, so a
    // window shorter than ~90s can expire before the device even sees it.
    const cmd = buildPairCommand(1_700_000_000_000);
    const seconds = cmd.until - 1_700_000_000;
    expect(seconds).toBeGreaterThanOrEqual(120);
  });

  it("produces a different nonce each call so a repeat is not deduped", () => {
    const a = buildPairCommand(1_700_000_000_000);
    const b = buildPairCommand(1_700_000_000_000);
    expect(a.n).not.toBe(b.n);
  });

  it("keeps the nonce a positive integer the firmware can parse as uint32", () => {
    const cmd = buildPairCommand(1_700_000_000_000);
    expect(Number.isInteger(cmd.n)).toBe(true);
    expect(cmd.n).toBeGreaterThan(0);
    expect(cmd.n).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("formatSirenAddress", () => {
  it("renders as the 0x-prefixed 6-digit hex used everywhere else", () => {
    expect(formatSirenAddress(0xa1b2c0)).toBe("0xA1B2C0");
  });

  it("pads short addresses to six digits", () => {
    expect(formatSirenAddress(0x0012c0)).toBe("0x0012C0");
  });

  it("reports an unknown address rather than rendering a misleading 0x000000", () => {
    expect(formatSirenAddress(null)).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/features/configure/sirenPairing.test.ts`
Expected: FAIL — cannot resolve `./sirenPairing`.

- [ ] **Step 3: Write the implementation**

Create `web/src/features/configure/sirenPairing.ts`:

```ts
// Pairing command construction, kept free of Firebase imports so it is
// directly unit-testable.

// The device polls /commands every ~15s alternating with /config, so a
// command can take ~30s to arrive, and pairing then transmits for 10s. The
// window must comfortably exceed both or the device discards its own
// request as expired.
const DEFAULT_WINDOW_SEC = 180;

export interface PairCommand {
  n: number;
  until: number;
}

// A nonce rather than a bool: the device deduplicates by value, so a second
// pairing attempt with an identical payload would be silently ignored.
export const buildPairCommand = (
  nowMs: number,
  windowSec: number = DEFAULT_WINDOW_SEC
): PairCommand => ({
  n: Math.floor(Math.random() * 0xffffffff) + 1,
  until: Math.floor(nowMs / 1000) + windowSec,
});

export const formatSirenAddress = (addr: number | null): string =>
  addr === null || addr === undefined
    ? "unknown"
    : `0x${addr.toString(16).toUpperCase().padStart(6, "0")}`;
```

Append to `web/src/lib/rtdb.ts`:

```ts
export const commandsPairPath = (projectId: string) =>
  `${projectId}/commands/pair`;
export const stateSirenBasePath = (projectId: string) =>
  `${projectId}/state/siren_base`;

export const commandsPairRef = (projectId: string): DatabaseReference =>
  ref(rtdb, commandsPairPath(projectId));
export const stateSirenBaseRef = (projectId: string): DatabaseReference =>
  ref(rtdb, stateSirenBasePath(projectId));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/features/configure/sirenPairing.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/rtdb.ts \
        web/src/features/configure/sirenPairing.ts \
        web/src/features/configure/sirenPairing.test.ts
git commit -m "Add siren pairing command builder and RTDB paths

The window defaults to 180s because the device can take ~30s to poll the
command and then transmits for 10s."
```

---

### Task 9: Pairing UI

Three steps, with the user as the success oracle — the device cannot hear the siren's beep.

**Files:**
- Create: `web/src/features/configure/SirenTab.tsx`
- Modify: `web/src/features/configure/ConfigurePage.tsx` (register the tab)

**Interfaces:**
- Consumes: `buildPairCommand`, `formatSirenAddress` (Task 8); `commandsPairRef`, `stateSirenBaseRef` (Task 8); `sirens/{id}` Firestore write (Task 10).
- Produces: `<SirenTab projectId={string} />`

- [ ] **Step 1: Read the existing tab pattern**

Run: `sed -n '1,60p' web/src/features/configure/ConfigurePage.tsx && sed -n '1,50p' web/src/features/configure/SensorsTab.tsx`

Match that file's conventions for data loading, error handling and styling rather than inventing new ones.

- [ ] **Step 2: Build the tab**

Create `web/src/features/configure/SirenTab.tsx` implementing this state machine:

- `idle` — shows the paired address from `state/siren_base` via `formatSirenAddress`, or "waiting for device" when absent. Instruction text: *"Press SET on the siren until the lights come on."* Button: **Send pairing signal**.
- `sending` — `set(commandsPairRef(projectId), buildPairCommand(Date.now()))`, then show *"Waiting for device (up to 30s)…"*.
- `transmitting` — *"Transmitting for 10s — the siren should beep twice."* Advance on a timer; the device reports nothing back.
- `confirming` — *"Did the siren beep twice?"* with **Yes** and **No, try again**.
- `paired` — on Yes, write the Firestore siren doc (Task 10) and show the paired address.
- `failed` — on No, show the likely causes verbatim: *"Learn mode may have timed out — press SET again immediately before retrying."* and *"The siren may be out of range of the alarm device."* Offer retry.

Warn before the user starts, since it is genuinely true: *"The alarm cannot detect sensors while it is transmitting (about 10 seconds)."*

Follow `SensorsTab.tsx` for layout and styling.

- [ ] **Step 3: Register the tab**

In `web/src/features/configure/ConfigurePage.tsx`, add "Siren" alongside the existing Sensors and Profiles tabs, following the same pattern.

- [ ] **Step 4: Typecheck and build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: both SUCCESS.

- [ ] **Step 5: Run the full web test suite**

Run: `cd web && npx vitest run`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/configure/SirenTab.tsx \
        web/src/features/configure/ConfigurePage.tsx
git commit -m "Add siren pairing UI

The user confirms success: the device cannot hear the siren's beep, so
there is no telemetry that could close this loop automatically."
```

---

### Task 10: Mirror the siren address and record the pairing

The device cannot write `state/` — `database.rules.json` sets `".write": false` there and the device token is scoped to `events`. Rather than widen the device's write surface for a display field, a function mirrors it.

**Files:**
- Create: `functions/src/onSirenAddress.ts`
- Modify: `functions/src/index.ts` (export the new function)
- Create: `functions/src/onSirenAddress.test.ts`

**Interfaces:**
- Consumes: the device's address-reporting event.
- Produces: `state/siren_base` in RTDB; a `sirens/{id}` document in Firestore.

- [ ] **Step 1: Read the existing mirroring pattern**

Run: `sed -n '1,60p' functions/src/onSensorEvent.ts && sed -n '1,40p' functions/src/index.ts`

`onSensorEvent` already mirrors RTDB events into Firestore and is the model to follow — including its deliberate behaviour of keeping unpaired-sensor RTDB nodes.

- [ ] **Step 2: Write the failing test**

Create `functions/src/onSirenAddress.test.ts`, following the structure of the existing `functions/src/*.test.ts` files. Cover the pure logic, not the SDK plumbing:

```ts
import { describe, it, expect } from "vitest";
import { parseSirenAddressEvent } from "./onSirenAddress";

describe("parseSirenAddressEvent", () => {
  it("extracts the base address from a device report", () => {
    expect(parseSirenAddressEvent({ event: "siren_address", value: "0xA1B2C0" }))
      .toBe(0xa1b2c0);
  });

  it("ignores ordinary sensor events", () => {
    expect(parseSirenAddressEvent({ event: "trigger" })).toBeNull();
  });

  it("rejects a malformed address rather than writing garbage to state", () => {
    expect(parseSirenAddressEvent({ event: "siren_address", value: "nope" }))
      .toBeNull();
  });

  it("rejects an address wider than the 24-bit frame", () => {
    expect(parseSirenAddressEvent({ event: "siren_address", value: "0xFF123456" }))
      .toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd functions && npx vitest run src/onSirenAddress.test.ts`
Expected: FAIL — cannot resolve `./onSirenAddress`.

- [ ] **Step 4: Implement**

Create `functions/src/onSirenAddress.ts` exporting:

```ts
export interface SirenAddressEvent {
  event?: string;
  value?: string;
}

// Returns the parsed 24-bit address, or null if this is not a well-formed
// siren-address report. Validation matters: this value is written to
// state/siren_base and displayed as the device's identity.
export const parseSirenAddressEvent = (
  payload: SirenAddressEvent
): number | null => {
  if (payload.event !== "siren_address" || typeof payload.value !== "string") {
    return null;
  }
  if (!/^0x[0-9A-Fa-f]{6}$/.test(payload.value)) return null;
  const parsed = Number.parseInt(payload.value, 16);
  return Number.isNaN(parsed) ? null : parsed;
};
```

plus an RTDB-triggered function on `/{projectId}/events/{rfId}/{timestamp}` that calls `parseSirenAddressEvent` and, on a non-null result, writes `state/siren_base`. Follow `onSensorEvent.ts`'s region (`europe-west1`) and trigger style. Export it from `functions/src/index.ts` alongside the existing functions.

Have the device report the address once after `app.ready()`, via the existing `reportEvent` path, using a reserved rfId such as `0xSIREN0` — this reuses the only write the device is authorised to make.

- [ ] **Step 5: Run the tests**

Run: `cd functions && npx vitest run && npm run build`
Expected: both PASS.

- [ ] **Step 6: Deploy and verify**

```bash
firebase deploy --only functions:onSirenAddress
```

Then reboot the device and confirm `state/siren_base` appears in the RTDB console.

- [ ] **Step 7: Commit**

```bash
git add functions/src/onSirenAddress.ts \
        functions/src/onSirenAddress.test.ts \
        functions/src/index.ts
git commit -m "Mirror the device's siren address into state/

The device cannot write state/ under the current RTDB rules and the token
is scoped to events, so a function mirrors it rather than widening the
device's write surface for a display field."
```

---

### Task 11: End-to-end verification and documentation

- [ ] **Step 1: Full cloud pairing run**

Factory-reset the siren (10+ clicks on SET, per the siren's own procedure), then pair it entirely from the web UI: press SET, click **Send pairing signal**, wait for the device to poll, confirm the two beeps, click **Yes**. Verify the Firestore `sirens/{id}` document appears.

- [ ] **Step 2: Alarm-path verification**

Arm the system, trigger a real door sensor, and confirm the siren sounds and then silences itself when `sirenDurationSec` expires.

- [ ] **Step 3: Confirm the tests are all green**

```bash
cd firmware/edge/device && pio test -e native
cd web && npx vitest run
cd functions && npx vitest run
```

Expected: 33 native tests, and both JS suites passing with no regressions.

- [ ] **Step 4: Update CLAUDE.md**

Move siren TX from "Next" into "Done". Under the "CC1101 transmit" section, record that it is now in the device firmware, and add a short note stating plainly that the Kerui decoder and the EV1527 encoder are different protocols that must never be validated against each other. Update the "Next" list: the remaining items become the relay bring-up, running in parallel with the W184, the Telegram webhook, and decommissioning.

- [ ] **Step 5: Update todo.txt**

Remove item D (siren untested) if the relay is still unwired but RF now works — reword rather than delete, since the relay path genuinely remains untested.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md todo.txt
git commit -m "Document siren RF control landing in the device firmware"
```
