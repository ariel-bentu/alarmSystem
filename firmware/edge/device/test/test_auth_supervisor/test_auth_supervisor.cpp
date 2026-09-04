#include <unity.h>

#include "auth_supervisor.h"

// Regression tests for the silent cloud death of 2026-09-04: the device
// authenticated once, lost ready(), and could never re-mint because
// tokenMinted_ was a one-way latch. It stayed silent for hours with a
// healthy loopTask, so the watchdog never fired.
//
// The two things that must BOTH hold: an hourly token refresh blip must not
// cost a re-mint, and a genuinely dead session must always get one.

static void test_ready_app_never_reauths() {
  AuthSupervisor s;
  for (uint32_t t = 0; t < 10UL * 60UL * 60UL * 1000UL; t += 60000) {
    s.noteReady(true, t);
    TEST_ASSERT_FALSE(s.shouldForceReauth(t, true));
  }
}

// The regression that matters. Ten hours matches the observed uptime
// (38241s) before the device went silent in the field.
static void test_permanently_unready_app_is_reauthed() {
  AuthSupervisor s;
  bool fired = false;
  for (uint32_t t = 0; t < 10UL * 60UL * 60UL * 1000UL; t += 30000) {
    s.noteReady(false, t);
    if (s.shouldForceReauth(t, true)) { fired = true; break; }
  }
  TEST_ASSERT_TRUE_MESSAGE(fired, "a permanently un-ready app must re-mint");
}

// FirebaseApp drops ready() briefly on every ordinary ID-token refresh.
// Re-minting on that edge would discard a healthy session hourly.
static void test_brief_refresh_blip_does_not_reauth() {
  AuthSupervisor s;
  uint32_t t = 0;
  s.noteReady(true, t);
  // Un-ready for 30s — far longer than a real refresh, still well inside
  // the grace period.
  for (t = 1000; t <= 31000; t += 1000) {
    s.noteReady(false, t);
    TEST_ASSERT_FALSE(s.shouldForceReauth(t, true));
  }
  s.noteReady(true, 32000);
  TEST_ASSERT_FALSE(s.shouldForceReauth(32000, true));
}

static void test_no_reauth_before_grace_period() {
  AuthSupervisor s;
  s.noteReady(false, 1000);
  uint32_t justBefore = 1000 + kReauthGraceMs - 1;
  TEST_ASSERT_FALSE(s.shouldForceReauth(justBefore, true));
  TEST_ASSERT_TRUE(s.shouldForceReauth(1000 + kReauthGraceMs, true));
}

// Recovery must fully re-arm the supervisor, otherwise a device that
// recovers and dies again is never rescued the second time.
static void test_recovery_resets_the_timer() {
  AuthSupervisor s;
  s.noteReady(false, 1000);
  uint32_t recovered = 1000 + kReauthGraceMs - 1000;
  s.noteReady(true, recovered);
  // Second outage starts its own full grace period.
  s.noteReady(false, recovered + 1000);
  TEST_ASSERT_FALSE(s.shouldForceReauth(recovered + 1000 + kReauthGraceMs - 1, true));
  TEST_ASSERT_TRUE(s.shouldForceReauth(recovered + 1000 + kReauthGraceMs, true));
}

// Offline is NOT an error state — the alarm is cloud-independent by design.
// A re-mint with no network cannot succeed, so it must not be attempted.
static void test_no_reauth_while_wifi_is_down() {
  AuthSupervisor s;
  s.noteReady(false, 1000);
  uint32_t past = 1000 + kReauthGraceMs + 60000;
  TEST_ASSERT_FALSE(s.shouldForceReauth(past, false));
  // ...but the moment the link returns, the overdue re-mint fires.
  TEST_ASSERT_TRUE(s.shouldForceReauth(past, true));
}

// A failed re-mint must retry, but on the slow cadence — not every
// iteration, which would mean a TLS handshake per loop.
static void test_failed_reauth_retries_on_the_slow_cadence() {
  AuthSupervisor s;
  s.noteReady(false, 1000);
  uint32_t first = 1000 + kReauthGraceMs;
  TEST_ASSERT_TRUE(s.shouldForceReauth(first, true));

  // Still un-ready: no second attempt until the retry interval elapses.
  s.noteReady(false, first + 1000);
  TEST_ASSERT_FALSE(s.shouldForceReauth(first + 1000, true));
  s.noteReady(false, first + kReauthRetryMs - 1);
  TEST_ASSERT_FALSE(s.shouldForceReauth(first + kReauthRetryMs - 1, true));

  s.noteReady(false, first + kReauthRetryMs);
  TEST_ASSERT_TRUE(s.shouldForceReauth(first + kReauthRetryMs, true));
}

// millis() is 0 for the first millisecond after boot, and 0 is the
// "currently ready" sentinel. An outage starting exactly there must still
// be tracked rather than silently disabling the supervisor.
static void test_outage_beginning_at_time_zero_is_tracked() {
  AuthSupervisor s;
  s.noteReady(false, 0);
  TEST_ASSERT_TRUE(s.shouldForceReauth(kReauthGraceMs + 1, true));
}

static void test_not_ready_duration_is_reported() {
  AuthSupervisor s;
  s.noteReady(true, 500);
  TEST_ASSERT_EQUAL_UINT32(0, s.notReadyForMs(500));
  s.noteReady(false, 1000);
  TEST_ASSERT_EQUAL_UINT32(5000, s.notReadyForMs(6000));
  s.noteReady(true, 7000);
  TEST_ASSERT_EQUAL_UINT32(0, s.notReadyForMs(7000));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_ready_app_never_reauths);
  RUN_TEST(test_permanently_unready_app_is_reauthed);
  RUN_TEST(test_brief_refresh_blip_does_not_reauth);
  RUN_TEST(test_no_reauth_before_grace_period);
  RUN_TEST(test_recovery_resets_the_timer);
  RUN_TEST(test_no_reauth_while_wifi_is_down);
  RUN_TEST(test_failed_reauth_retries_on_the_slow_cadence);
  RUN_TEST(test_outage_beginning_at_time_zero_is_tracked);
  RUN_TEST(test_not_ready_duration_is_reported);
  return UNITY_END();
}
