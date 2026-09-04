#include <unity.h>

#include "siren_policy.h"

// The siren answers a disarm command with a short ack beep. These tests pin
// down when that beep is allowed to happen: only when the user has the siren
// enabled, EXCEPT that a sounding siren must always be stoppable.

static void test_disarm_beeps_when_enabled_and_idle() {
  // The ordinary case: siren enabled, nothing sounding, user disarms. The ack
  // beep is wanted here — it is the audible confirmation of a disarm.
  TEST_ASSERT_TRUE(shouldTransmitSirenStop(/*enabled=*/true, /*active=*/false));
}

static void test_disarm_is_silent_when_siren_disabled() {
  // The reported bug: a beep on every disarm despite the siren being turned
  // off in the UI.
  TEST_ASSERT_FALSE(shouldTransmitSirenStop(/*enabled=*/false, /*active=*/false));
}

static void test_sounding_siren_is_always_stopped() {
  // Disabling the siren mid-alarm must still silence it. An RF siren sounds
  // until told to stop, so skipping this leaves it wailing until someone
  // unplugs it — the stop is not an ack beep, it is the off switch.
  TEST_ASSERT_TRUE(shouldTransmitSirenStop(/*enabled=*/false, /*active=*/true));
}

static void test_sounding_siren_stopped_when_enabled_too() {
  TEST_ASSERT_TRUE(shouldTransmitSirenStop(/*enabled=*/true, /*active=*/true));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_disarm_beeps_when_enabled_and_idle);
  RUN_TEST(test_disarm_is_silent_when_siren_disabled);
  RUN_TEST(test_sounding_siren_is_always_stopped);
  RUN_TEST(test_sounding_siren_stopped_when_enabled_too);
  return UNITY_END();
}
