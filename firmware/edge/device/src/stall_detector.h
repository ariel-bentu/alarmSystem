#pragma once

#include <cstdint>

// Timing policy for the stuck-loop monitor (2026-09-05). Pure decision layer,
// no Arduino / FreeRTOS types, so it is native-testable — same split as
// HostResolver and AuthSupervisor.
//
// WHY THIS EXISTS: the recurring hangs on this board are a loopTask blocked
// inside a synchronous call (DNS resolve, TLS handshake, sys_idle()) that
// yields to FreeRTOS but does NOT feed the task watchdog. The TWDT reboots at
// 60s with reason=twdt, but the S3's USB-Serial/JTAG stops enumerating the
// instant the CPU halts, so the panic's own backtrace is usually lost to the
// host — every past hang was reconstructed after the fact from heartbeat
// arithmetic, never observed live.
//
// THE FIX: a separate monitor task (stall_monitor.h) that watches loopTask via
// a heartbeat and, when this detector says so, dumps the loop's current phase
// + backtrace + heap over serial WHILE USB is still alive — ~40s in, a full
// 20s before the 60s TWDT fires. It does NOT reboot: the existing TWDT still
// owns recovery. This class decides only WHEN to dump.
//
// Contract:
//   - loop() calls bump(millis()) once per iteration.
//   - the monitor calls shouldDump(millis()) on its own ~1s tick.
//   - shouldDump() returns true EXACTLY ONCE per stall (the monitor polls every
//     second; without one-shot latching a 20s stall would print 20 identical
//     backtraces and bury the signal), and re-arms only after a fresh bump.
class StallDetector {
 public:
  // warnMs: how long loop() may go without a bump before it is declared stuck.
  // 40000 in production — comfortably above every legitimate blocking stretch
  // (each of which feeds the watchdog and keeps loop() progressing) and a full
  // 20s under the 60s TWDT, so the dump escapes before the port can vanish.
  explicit StallDetector(uint32_t warnMs) : warnMs_(warnMs) {}

  // Record that loop() made progress. Re-arms the one-shot: a stall that has
  // already dumped will dump again if the loop recovers and then stalls anew.
  void bump(uint32_t nowMs) {
    lastBumpMs_ = nowMs;
    bumped_ = true;
    dumped_ = false;
  }

  // True exactly once when loop() has not bumped for >= warnMs. Inert until the
  // first bump (setup() runs before loop() starts bumping, and a dump at t=40s
  // just because nothing has bumped yet would false-alarm on every cold boot).
  bool shouldDump(uint32_t nowMs) {
    if (!bumped_ || dumped_) return false;
    // Unsigned subtraction so a bump before the millis() wrap and a check after
    // it still yields the true (small) elapsed time, not a ~49-day span.
    if ((uint32_t)(nowMs - lastBumpMs_) < warnMs_) return false;
    dumped_ = true;
    return true;
  }

 private:
  uint32_t warnMs_;
  uint32_t lastBumpMs_ = 0;
  bool bumped_ = false;   // has loop() bumped at least once?
  bool dumped_ = false;   // has THIS stall already been reported?
};
