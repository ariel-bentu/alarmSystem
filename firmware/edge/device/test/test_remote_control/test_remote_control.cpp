#include <unity.h>
#include "alarm_state.h"
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

void test_recognises_a_paired_identity() {
  Config config;
  config.remoteCount = 1;
  config.remotes[0] = 0xE45CA;

  TEST_ASSERT_TRUE(remoteIsPaired(config, 0xE45CA));
  TEST_ASSERT_FALSE(remoteIsPaired(config, 0x3F010));
}

void test_pairs_an_unknown_remote() {
  Config config;
  TEST_ASSERT_EQUAL(RemotePairResult::Paired,
                    remotePair(&config, 0xE45CA, /*armed=*/false));
  TEST_ASSERT_EQUAL(1, config.remoteCount);
  TEST_ASSERT_TRUE(remoteIsPaired(config, 0xE45CA));
}

// Pairing is idempotent so a user mashing the button does not consume slots.
void test_pairing_the_same_remote_twice_is_a_no_op() {
  Config config;
  remotePair(&config, 0xE45CA, false);
  TEST_ASSERT_EQUAL(RemotePairResult::AlreadyPaired,
                    remotePair(&config, 0xE45CA, false));
  TEST_ASSERT_EQUAL(1, config.remoteCount);
}

// Otherwise anyone in RF range could pair their own remote to an armed
// system and then disarm it.
void test_refuses_to_pair_while_armed() {
  Config config;
  TEST_ASSERT_EQUAL(RemotePairResult::RefusedArmed,
                    remotePair(&config, 0xE45CA, /*armed=*/true));
  TEST_ASSERT_EQUAL(0, config.remoteCount);
}

void test_refuses_to_pair_when_full() {
  Config config;
  for (uint8_t i = 0; i < Config::kMaxRemotes; i++) {
    TEST_ASSERT_EQUAL(RemotePairResult::Paired,
                      remotePair(&config, 0x10000 + i, false));
  }
  TEST_ASSERT_EQUAL(RemotePairResult::Full,
                    remotePair(&config, 0xE45CA, false));
  TEST_ASSERT_EQUAL(Config::kMaxRemotes, config.remoteCount);
}

// Any one button pairs the whole remote, because identity is shared.
void test_pairing_from_any_button_covers_all_buttons() {
  Config config;
  remotePair(&config, remoteIdentityOf(0xE45CA8), false); // paired via SOS
  TEST_ASSERT_TRUE(remoteIsPaired(config, remoteIdentityOf(0xE45CA2)));
  TEST_ASSERT_TRUE(remoteIsPaired(config, remoteIdentityOf(0xE45CA4)));
}

// 0 is the empty-slot marker, so it must never match — otherwise a decode
// of 0x00000X would look like a paired remote on a half-empty list.
void test_zero_identity_is_never_paired() {
  Config config;
  config.remoteCount = 2;
  config.remotes[0] = 0xE45CA;
  TEST_ASSERT_FALSE(remoteIsPaired(config, 0));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_splits_measured_code_into_identity_and_nibble);
  RUN_TEST(test_all_four_buttons_share_one_identity);
  RUN_TEST(test_maps_each_nibble_to_its_action);
  RUN_TEST(test_rejects_non_one_hot_nibbles);
  RUN_TEST(test_recognises_a_paired_identity);
  RUN_TEST(test_pairs_an_unknown_remote);
  RUN_TEST(test_pairing_the_same_remote_twice_is_a_no_op);
  RUN_TEST(test_refuses_to_pair_while_armed);
  RUN_TEST(test_refuses_to_pair_when_full);
  RUN_TEST(test_pairing_from_any_button_covers_all_buttons);
  RUN_TEST(test_zero_identity_is_never_paired);
  return UNITY_END();
}
