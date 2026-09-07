#include <unity.h>

#include "io_deadline.h"

// Regression tests for the broken-socket read spin (2026-09-06).
//
// A Firebase poll's TLS socket died mid-read (-76 MBEDTLS_ERR_NET_RECV_FAILED)
// and the loopTask spun in a sys_idle() wait that never fed the task watchdog,
// rebooting at 60s (reason=twdt). FirebaseClient drives every sync wait through
// client->available(); IoDeadline is the pure policy that lets our
// SslClientWithDns bound that wait by wall clock: once an operation has made no
// progress for `boundMs`, available() force-stops the socket so EVERY library
// wait (available/read/connected all cascade from available()) aborts, no
// matter which one is spinning.
//
// The Arduino/mbedTLS calls (WiFi.hostByName, WiFiClientSecure::stop) live in
// SslClientWithDns; this class holds only the timing decision, kept free of
// Arduino types for the same reason as HostResolver, StallDetector and
// AuthSupervisor. Time is a plain uint32 of millis().

static constexpr uint32_t kBoundMs = 12000;  // must match production default

// A disarmed deadline never expires: between operations there is no socket to
// bound, and a spurious "expired" would tear down an idle-but-healthy client.
static void test_disarmed_never_expires() {
  IoDeadline d(kBoundMs);
  TEST_ASSERT_FALSE(d.expired(0));
  TEST_ASSERT_FALSE(d.expired(1000000));
}

// Armed and still within the bound: not expired. The wait is young; a healthy
// round-trip (observed well under 1s) must not be killed.
static void test_armed_within_bound_not_expired() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  TEST_ASSERT_FALSE(d.expired(1000));
  TEST_ASSERT_FALSE(d.expired(1000 + kBoundMs - 1));
}

// Armed and the full bound has elapsed with no progress: expired. This is the
// stalled socket the fix exists to catch.
static void test_armed_past_bound_expires() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  TEST_ASSERT_TRUE(d.expired(1000 + kBoundMs));
}

// Progress re-arms the deadline: a slow-but-advancing transfer (each chunk
// resets the clock) must run to completion, only a truly stalled one dies.
// Without this, a large payload arriving in steady small reads would be killed
// mid-download at boundMs even though it was healthy.
static void test_progress_rearms_deadline() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  // 8s in, a chunk arrives — resets the clock.
  d.progress(1000 + 8000);
  // 8s after THAT (16s total) is still fine because progress moved the mark.
  TEST_ASSERT_FALSE(d.expired(1000 + 8000 + 8000));
  // But boundMs after the last progress with nothing further: expired.
  TEST_ASSERT_TRUE(d.expired(1000 + 8000 + kBoundMs));
}

// Disarm (operation completed / socket closed) stops the deadline firing on the
// NEXT idle stretch — e.g. between two polls on the reused client.
static void test_disarm_after_completion() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  d.disarm();
  TEST_ASSERT_FALSE(d.expired(1000 + kBoundMs * 100));
}

// millis() wraps at ~49.7 days. Unsigned subtraction must make an arm before
// the wrap and a check after it yield the true small elapsed time, not a
// ~49-day span that would fire instantly and tear down a healthy socket.
static void test_survives_millis_wraparound() {
  IoDeadline d(kBoundMs);
  const uint32_t nearMax = 0xFFFFFFFFu - 1000;  // 1s before wrap
  d.arm(nearMax);
  // 2s later, wrapped through 0: elapsed 2000ms, healthy.
  TEST_ASSERT_FALSE(d.expired(nearMax + 2000));
  // boundMs after arm, across the wrap: expired.
  TEST_ASSERT_TRUE(d.expired(nearMax + kBoundMs));
}

// Re-arming a fresh operation after one expired must give the new op the full
// bound, not inherit the expired state — otherwise the first stalled poll would
// poison every later poll on the reused client.
static void test_rearm_after_expiry_is_fresh() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  TEST_ASSERT_TRUE(d.expired(1000 + kBoundMs));  // op 1 stalled
  d.arm(1000 + kBoundMs + 5000);                 // op 2 starts
  TEST_ASSERT_FALSE(d.expired(1000 + kBoundMs + 5000));            // fresh
  TEST_ASSERT_TRUE(d.expired(1000 + kBoundMs + 5000 + kBoundMs));  // op 2 stalls
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_disarmed_never_expires);
  RUN_TEST(test_armed_within_bound_not_expired);
  RUN_TEST(test_armed_past_bound_expires);
  RUN_TEST(test_progress_rearms_deadline);
  RUN_TEST(test_disarm_after_completion);
  RUN_TEST(test_survives_millis_wraparound);
  RUN_TEST(test_rearm_after_expiry_is_fresh);
  return UNITY_END();
}
