#pragma once

#include <cstdint>

// Wall-clock deadline for a single synchronous socket operation. Pure decision
// layer, no Arduino / mbedTLS types, so it is native-testable — same split as
// HostResolver, StallDetector and AuthSupervisor.
//
// WHY THIS EXISTS (2026-09-06): a Firebase poll's TLS socket died mid-read
// (-76 MBEDTLS_ERR_NET_RECV_FAILED) and the loopTask spun in one of
// FirebaseClient's `while (...) { sys_idle(); }` waits — sys_idle() is delay(0)
// on ESP32, which yields to FreeRTOS WITHOUT feeding the task watchdog — until
// the 60s TWDT rebooted (reason=twdt). Same fault family as blocking DNS and
// the 120s TLS handshake: a synchronous cloud call that yields without feeding
// the watchdog. setSyncReadTimeout(5) is applied but did not cover this path.
//
// THE LEVER: FirebaseClient performs every sync wait through
// client->available() (available/read/connected all cascade from it — see
// WiFiClientSecure.cpp). So SslClientWithDns arms this deadline on connect(),
// re-arms it on every read that returns bytes (progress), and — once expired —
// force-stops the socket from inside available(), returning a hard error. That
// makes WHICHEVER library wait is spinning see a closed connection and abort,
// without needing to know which one it is or patching the vendored library.
//
// Progress-based, not a flat timeout: a large-but-steady transfer keeps
// re-arming and runs to completion; only a genuinely STALLED socket (no bytes
// for boundMs) is torn down. The bound (12s default) sits above the 5s sync
// read timeout and well under the 40s stall monitor / 60s TWDT.
class IoDeadline {
 public:
  explicit IoDeadline(uint32_t boundMs) : boundMs_(boundMs) {}

  // Start bounding a new operation. Called on connect(). Gives the op a fresh
  // full bound regardless of any prior expired state (a stalled poll must not
  // poison the next poll on a reused client).
  void arm(uint32_t nowMs) {
    lastProgressMs_ = nowMs;
    armed_ = true;
    closed_ = false;
  }

  // The operation made progress (bytes actually read). Resets the clock so a
  // slow-but-advancing transfer is never killed mid-stream.
  void progress(uint32_t nowMs) {
    if (armed_) lastProgressMs_ = nowMs;
  }

  // Operation finished / socket closed. Stops the deadline firing on the next
  // idle stretch between operations on a reused client.
  void disarm() {
    armed_ = false;
    closed_ = false;
  }

  // The socket was closed underneath this operation by the library itself.
  //
  // WHY (2026-09-08): base WiFiClientSecure::available() calls its OWN stop()
  // on a hard mbedTLS error (-76) — a non-virtual internal call, so our
  // stop() override and its disarm() are BYPASSED — and sets _connected=false.
  // Every later available() then takes the `if (!_connected) return peeked;`
  // early return and yields 0 forever, so the caller's `while (!available())`
  // spins on sys_idle() (no TWDT feed) to the 60s reboot.
  //
  // Marking it closed makes expired() true IMMEDIATELY rather than after the
  // remaining bound: a socket with no connection can never deliver another
  // byte, so waiting out the clock only burns watchdog budget.
  void socketClosed() {
    if (armed_) closed_ = true;
  }

  // True while an operation is in flight (armed by connect(), cleared by
  // disarm()). The caller uses this to skip dead-socket detection entirely
  // between operations: an idle client legitimately has no socket, and
  // reporting that as "closed under an in-flight read" produced false
  // positives on a healthy boot (2026-09-09) that made the field log
  // unusable for telling a real caught hang from ordinary reconnects.
  bool armed() const { return armed_; }

  // True once an armed operation has made no progress for the full bound. The
  // caller (SslClientWithDns::available) then stops the socket and returns an
  // error. Disarmed => never expires.
  bool expired(uint32_t nowMs) const {
    if (!armed_) return false;
    // Socket closed underneath us: dead now, not in boundMs. See socketClosed().
    if (closed_) return true;
    // Unsigned subtraction so an arm before the millis() wrap and a check after
    // it yield the true (small) elapsed time, not a ~49-day span.
    return (uint32_t)(nowMs - lastProgressMs_) >= boundMs_;
  }

 private:
  uint32_t boundMs_;
  uint32_t lastProgressMs_ = 0;
  bool armed_ = false;
  bool closed_ = false;
};
