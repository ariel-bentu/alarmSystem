#include <unity.h>

#include "io_deadline.h"
#include "ssl_socket_state.h"

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

// --- The 2026-09-08 recurrence: the base class stops the socket underneath us.
//
// WHY THESE EXIST: on 2026-09-08 05:09 (and in the 09-07 19:08 soak log) the
// device rebooted with reason=twdt after a -76 (MBEDTLS_ERR_NET_RECV_FAILED),
// stalled 40968ms in phase='cloud:poll-config' — the SAME fault IoDeadline was
// added to fix. It did not fire. Read WiFiClientSecure.cpp:240-252:
//
//   int WiFiClientSecure::available() {
//       int peeked = (_peek >= 0);
//       if (!_connected) return peeked;                     // <-- 0 forever
//       int res = data_to_read(sslclient);
//       if (res < 0) { stop(); return peeked?peeked:res; }  // base stop(), not ours
//       return res+peeked;
//   }
//
// On -76 the base calls its OWN stop() — a non-virtual internal call, so our
// SslClientWithDns::stop() override (and its disarm()) is BYPASSED — and sets
// _connected=false. The first available() returns -76, but every call after it
// takes the !_connected early return and yields 0 forever. FirebaseClient's
// wait re-polls, sees a steady 0, and spins on sys_idle() (= delay(0), which
// does NOT feed the TWDT) to the 60s reboot.
//
// So the deadline stays armed but the socket is already dead, and the caller
// keeps polling. The policy must report the operation as UNRECOVERABLE the
// moment we learn the socket was stopped underneath us — not merely wait out
// the remaining bound, because a wait that returns 0 makes no progress and the
// caller has no other exit.

// The moment we observe the socket was stopped underneath us, the operation is
// dead: expired() must be true IMMEDIATELY, without waiting out the bound. The
// caller polls available() every few ms, so making it wait the full 12s here
// burns budget for a socket that can never deliver another byte.
static void test_socket_closed_underneath_expires_immediately() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  d.socketClosed();  // base available() hit -76 and called its own stop()
  TEST_ASSERT_TRUE(d.expired(1000));
}

// A closed socket stays expired on every subsequent poll. This is the actual
// hang: the caller re-polls thousands of times over 40s, and EVERY one of those
// calls must keep reporting expired so the wait aborts rather than spinning.
static void test_socket_closed_stays_expired_on_repeated_polls() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  d.socketClosed();
  TEST_ASSERT_TRUE(d.expired(1001));
  TEST_ASSERT_TRUE(d.expired(1050));
  TEST_ASSERT_TRUE(d.expired(2000));
  TEST_ASSERT_TRUE(d.expired(1000 + kBoundMs * 10));
}

// A fresh connect() on the reused client must clear the closed flag, otherwise
// one dead socket would poison every later poll on that client — the same
// "do not inherit stale state" property as test_rearm_after_expiry_is_fresh.
static void test_arm_clears_closed_state() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  d.socketClosed();
  TEST_ASSERT_TRUE(d.expired(1000));
  d.arm(5000);  // reconnect
  TEST_ASSERT_FALSE(d.expired(5000));
  TEST_ASSERT_FALSE(d.expired(5000 + kBoundMs - 1));
}

// Disarm must also clear it, so a clean stop() between operations does not
// leave the next idle stretch reporting expired on a client with no socket.
static void test_disarm_clears_closed_state() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  d.socketClosed();
  d.disarm();
  TEST_ASSERT_FALSE(d.expired(1000));
  TEST_ASSERT_FALSE(d.expired(1000 + kBoundMs * 10));
}

// A closed socket that was never armed must NOT expire. Between operations the
// client legitimately has no socket; firing there would tear down a healthy
// idle client before its next connect.
static void test_closed_while_disarmed_does_not_expire() {
  IoDeadline d(kBoundMs);
  d.socketClosed();
  TEST_ASSERT_FALSE(d.expired(1000));
}

// --- Sentinel regression (2026-09-09): the fd is 0 after teardown, not -1.
//
// The 2026-09-08 fix above shipped and STILL rebooted (twdt at 18.36h, same
// -76 -> phase='cloud:poll-config' -> 40802ms stall). The policy here was
// right; the CALLER's detection was wrong, so socketClosed() was never called.
//
// ssl_client.cpp stop_ssl_socket() sets socket = -1 at line 325 — and then
// line 346 does `memset(ssl_client, 0, sizeof(sslclient_context))`, which
// overwrites it with **0**. A live fd from lwip_socket() is > 0. So the
// post-teardown sentinel is 0, and the shipped test `socket < 0` never
// matched. The predicate must be `socket <= 0`.
//
// This is a caller-side bug, but it is pinned here because the log line these
// tests describe is the observable proof the path ran. See
// ssl_client_with_dns.h for the detection itself.

// The live fd from lwip_socket() is > 0; after teardown the memset leaves 0;
// -1 is the momentary value at stop_ssl_socket():325 and the pre-connect init.
// All three non-positive cases mean "no usable socket".
static void test_socket_gone_covers_zero_and_negative() {
  TEST_ASSERT_TRUE(sslSocketIsGone(0));   // THE BUG: memset leaves exactly 0
  TEST_ASSERT_TRUE(sslSocketIsGone(-1));  // stop_ssl_socket() line 325
  TEST_ASSERT_FALSE(sslSocketIsGone(1));  // a real fd
  TEST_ASSERT_FALSE(sslSocketIsGone(42));
}

// A hard negative from the base available() (the FIRST call after the peer
// drops returns -76) is itself proof the socket is gone, independent of the fd.
static void test_hard_error_from_base_means_gone() {
  TEST_ASSERT_TRUE(sslReadFailed(-76));  // MBEDTLS_ERR_NET_RECV_FAILED
  TEST_ASSERT_TRUE(sslReadFailed(-1));
  TEST_ASSERT_FALSE(sslReadFailed(0));   // silent-but-open: deadline's job
  TEST_ASSERT_FALSE(sslReadFailed(5));   // bytes ready
}

// --- What available() must RETURN on a dead socket (2026-09-09, second fix).
//
// The first two fixes returned a NEGATIVE from available(). That breaks
// `while (!tcpAvailable())` at AsyncClient.h:1118 — but that loop was never
// the broken one (no in-loop feedTimer(), its timeout works, it exits).
//
// The loop that actually hangs (AsyncClient.h:1131) never calls available()
// directly. It reaches it only through readResponse()'s gate:
//
//     if (sData->response.tcpAvailable() > 0) { readHeader(); readPayload(); }
//
// A NEGATIVE fails `> 0` exactly like 0 does — nothing in FirebaseClient
// treats available() < 0 specially; every use is `> 0` or `== 0`. So the
// no-op -> ret_continue -> spin was completely unaffected by both fixes.
//
// Returning POSITIVE opens that gate and hands control to the library's OWN
// teardown: readPayload() (ResponseHandler.h:466) enters on
// `connected() || available()`, calls readResponse<>(), whose read() returns
// -1 on the dead socket and spins to its internal 5000ms bound, returning -2
// -> `len < 0` -> `respCtx.stage = response_stage_finished` -> the outer loop
// exits. Bounded at ~5s, well under the 40s stall dump and 60s TWDT.
//
// (The immediate exit at ResponseHandler.h:263 is unreachable for us: it also
// requires respCtx.totalRead == 0, and totalRead resets only per request in
// begin():91, so a MID-RESPONSE death always has totalRead > 0.)
static void test_dead_socket_return_is_positive_to_open_the_gate() {
  // Must be > 0: `tcpAvailable() > 0` is the gate we need to pass.
  TEST_ASSERT_GREATER_THAN(0, sslDeadSocketAvailable());
}

// It must NOT be negative — that is the shipped behaviour that did nothing for
// the hanging loop. Pinned separately so a future "return -1 is tidier"
// refactor fails loudly instead of silently restoring the hang.
static void test_dead_socket_return_is_not_negative() {
  TEST_ASSERT_FALSE(sslDeadSocketAvailable() < 0);
}

// --- Only an IN-FLIGHT operation can have a socket die "under a read".
//
// Observed on hardware 2026-09-09 immediately after flashing: three
// `[io] socket closed under an in-flight read (rc=0 fd=-1 / fd=0)` lines during
// normal, healthy boot. Those are IDLE clients between operations — a client
// that has not connected yet legitimately has no socket. Harmless (the device
// ran fine) but it destroys the field signal: `grep` can no longer tell a real
// caught hang from boot noise, which is the whole point of the log line.
//
// `armed()` exposes the state that distinguishes them: armed == an operation is
// in flight, so a missing socket is a genuine mid-read teardown.
static void test_not_armed_before_any_operation() {
  IoDeadline d(kBoundMs);
  TEST_ASSERT_FALSE(d.armed());
}

static void test_armed_while_operation_in_flight() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  TEST_ASSERT_TRUE(d.armed());
}

static void test_not_armed_after_disarm() {
  IoDeadline d(kBoundMs);
  d.arm(1000);
  d.disarm();
  TEST_ASSERT_FALSE(d.armed());
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
  RUN_TEST(test_socket_closed_underneath_expires_immediately);
  RUN_TEST(test_socket_closed_stays_expired_on_repeated_polls);
  RUN_TEST(test_arm_clears_closed_state);
  RUN_TEST(test_disarm_clears_closed_state);
  RUN_TEST(test_closed_while_disarmed_does_not_expire);
  RUN_TEST(test_socket_gone_covers_zero_and_negative);
  RUN_TEST(test_hard_error_from_base_means_gone);
  RUN_TEST(test_dead_socket_return_is_positive_to_open_the_gate);
  RUN_TEST(test_dead_socket_return_is_not_negative);
  RUN_TEST(test_not_armed_before_any_operation);
  RUN_TEST(test_armed_while_operation_in_flight);
  RUN_TEST(test_not_armed_after_disarm);
  return UNITY_END();
}
