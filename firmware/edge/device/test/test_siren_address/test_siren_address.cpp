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
