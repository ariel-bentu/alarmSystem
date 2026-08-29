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
  // Within 2% of 13333.3: 13066.6 to 13600.0
  TEST_ASSERT(rate >= 13066.6 && rate <= 13600.0);
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
