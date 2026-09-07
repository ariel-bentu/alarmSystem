#include <unity.h>

#include "stall_detector.h"

// Regression tests for the stuck-loop diagnostics (2026-09-05).
//
// The recurring fault family is a loopTask blocked inside a synchronous call
// (DNS, TLS handshake, sys_idle()) that yields to FreeRTOS but does NOT feed
// the task watchdog. The TWDT reboots at 60s (reason=twdt), but by then the
// S3's USB-Serial/JTAG has stopped enumerating, so the panic backtrace is
// often lost and the hang is diagnosed after the fact by heartbeat arithmetic.
//
// StallDetector is the pure decision layer for a separate monitor task: the
// loop bumps it once per iteration; the monitor asks shouldDump() on its own
// tick. It fires ONCE per stall, ~40s in — 20s before the 60s TWDT, while USB
// is still alive — and re-arms only after the loop resumes bumping. The actual
// serial dump, backtrace and heap read live in stall_monitor.h (Arduino /
// FreeRTOS types, not native-testable); this class holds only the timing
// policy, kept free of those types for the same reason as HostResolver and
// AuthSupervisor.
//
// Time is a plain uint32 of milliseconds here — exactly what millis() returns
// — so the real caller's values round-trip through this unchanged.

static constexpr uint32_t kWarnMs = 40000;  // must match production default

// A freshly-bumped detector is healthy: no dump while the loop is progressing.
static void test_healthy_loop_never_dumps() {
  StallDetector d(kWarnMs);
  d.bump(1000);
  TEST_ASSERT_FALSE(d.shouldDump(1000));
  TEST_ASSERT_FALSE(d.shouldDump(1000 + kWarnMs - 1));  // just under threshold
}

// At exactly the threshold the stall is declared (>=, not >): a loop that has
// not bumped for the full warn budget is stuck, and the boundary tick must not
// silently pass.
static void test_dump_fires_at_threshold() {
  StallDetector d(kWarnMs);
  d.bump(1000);
  TEST_ASSERT_TRUE(d.shouldDump(1000 + kWarnMs));
}

// THE POINT of firing once: the monitor polls every second, but a stall must
// produce exactly ONE dump, not one per monitor tick — otherwise a 20s stall
// floods the serial log with 20 identical backtraces and buries the signal.
static void test_dump_fires_only_once_per_stall() {
  StallDetector d(kWarnMs);
  d.bump(1000);
  TEST_ASSERT_TRUE(d.shouldDump(1000 + kWarnMs));       // first crossing
  TEST_ASSERT_FALSE(d.shouldDump(1000 + kWarnMs + 1000));  // still stuck, silent
  TEST_ASSERT_FALSE(d.shouldDump(1000 + kWarnMs + 5000));  // still stuck, silent
}

// After the loop resumes (a fresh bump), the detector re-arms so a LATER,
// separate stall dumps again. A one-shot that never re-arms would report only
// the first hang of the device's life.
static void test_rearms_after_bump() {
  StallDetector d(kWarnMs);
  d.bump(1000);
  TEST_ASSERT_TRUE(d.shouldDump(1000 + kWarnMs));  // stall 1 dumps
  d.bump(1000 + kWarnMs + 2000);                   // loop recovers
  TEST_ASSERT_FALSE(d.shouldDump(1000 + kWarnMs + 2000));            // healthy again
  TEST_ASSERT_TRUE(d.shouldDump(1000 + kWarnMs + 2000 + kWarnMs));   // stall 2 dumps
}

// millis() wraps at ~49.7 days. The elapsed computation must use unsigned
// subtraction so a bump before the wrap and a check after it still yields the
// true (small) elapsed time, not a ~49-day span that would either fire
// spuriously or, worse, mask a real stall.
static void test_survives_millis_wraparound() {
  StallDetector d(kWarnMs);
  const uint32_t nearMax = 0xFFFFFFFFu - 1000;  // 1s before wrap
  d.bump(nearMax);
  // 2s later, having wrapped through 0: elapsed is 2000ms, well under warn.
  TEST_ASSERT_FALSE(d.shouldDump(nearMax + 2000));
  // 40s after the bump, across the wrap: elapsed is exactly the threshold.
  TEST_ASSERT_TRUE(d.shouldDump(nearMax + kWarnMs));
}

// Before the first bump the detector must be inert: setup() runs for a while
// before loop() starts bumping, and a monitor that dumps at t=40s just because
// nothing bumped yet would false-alarm on every cold boot.
static void test_no_dump_before_first_bump() {
  StallDetector d(kWarnMs);
  TEST_ASSERT_FALSE(d.shouldDump(kWarnMs));
  TEST_ASSERT_FALSE(d.shouldDump(kWarnMs * 10));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_healthy_loop_never_dumps);
  RUN_TEST(test_dump_fires_at_threshold);
  RUN_TEST(test_dump_fires_only_once_per_stall);
  RUN_TEST(test_rearms_after_bump);
  RUN_TEST(test_survives_millis_wraparound);
  RUN_TEST(test_no_dump_before_first_bump);
  return UNITY_END();
}
