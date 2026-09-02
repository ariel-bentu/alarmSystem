#include <unity.h>
#include "remote_control.h"

// Measured from real hardware: remote 0xE45CA, buttons observed as
// nibble 0x2 (disarm) and 0x4 (arm). See the design doc.
void test_splits_measured_code_into_identity_and_nibble() {
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA2));
  TEST_ASSERT_EQUAL_HEX8(0x2, remoteNibbleOf(0xE45CA2));

  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA4));
  TEST_ASSERT_EQUAL_HEX8(0x4, remoteNibbleOf(0xE45CA4));
}

void test_all_four_buttons_share_one_identity() {
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA1));
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA2));
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA4));
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, remoteIdentityOf(0xE45CA8));
}

void test_maps_each_nibble_to_its_action() {
  TEST_ASSERT_EQUAL(RemoteAction::ArmHome, remoteActionFor(0x1));
  TEST_ASSERT_EQUAL(RemoteAction::Disarm,  remoteActionFor(0x2));
  TEST_ASSERT_EQUAL(RemoteAction::Arm,     remoteActionFor(0x4));
  TEST_ASSERT_EQUAL(RemoteAction::Sos,     remoteActionFor(0x8));
}

// The nibble is one-hot. A multi-bit or zero value is a corrupt decode or a
// device that is not this kind of remote; guessing an action from it could
// disarm the house on noise.
void test_rejects_non_one_hot_nibbles() {
  TEST_ASSERT_EQUAL(RemoteAction::None, remoteActionFor(0x0));
  TEST_ASSERT_EQUAL(RemoteAction::None, remoteActionFor(0x3));
  TEST_ASSERT_EQUAL(RemoteAction::None, remoteActionFor(0x6));
  TEST_ASSERT_EQUAL(RemoteAction::None, remoteActionFor(0xF));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_splits_measured_code_into_identity_and_nibble);
  RUN_TEST(test_all_four_buttons_share_one_identity);
  RUN_TEST(test_maps_each_nibble_to_its_action);
  RUN_TEST(test_rejects_non_one_hot_nibbles);
  return UNITY_END();
}
