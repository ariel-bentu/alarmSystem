// Reproducer for: FirebaseClient sync read loop cannot time out when the
// socket dies mid-response, because feedTimer() is called inside the loop.
//
//   g++ -std=c++17 timer_repro.cpp -o timer_repro && ./timer_repro
//
// No Arduino, no hardware, no network. The Timer class below is copied
// VERBATIM from src/core/Utils/Timer.h (v2.2.13, main @ 2a030ef); only
// millis() is replaced by a variable this file controls, so the loop
// structure of AsyncClient.h:1131-1153 can be driven deterministically.

#include <cstdio>

// ---- controllable clock -----------------------------------------------
static unsigned long g_ms = 0;
unsigned long millis() { return g_ms; }

// ---- VERBATIM from src/core/Utils/Timer.h -----------------------------
class Timer {
 private:
  unsigned long ts = 0, end = 0, period = 0, now = 0, ms = 0;
  bool enable = false;
  unsigned char feed_count = 0;

 public:
  explicit Timer(unsigned long sec = 60) { setInterval(sec); }
  ~Timer() {}
  void reset() { end = ts + period; }
  void start() {
    enable = true;
    loop();
    reset();
  }
  void stop() { enable = false; }
  void setInterval(unsigned long sec) {
    loop();
    period = sec;
    reset();
  }
  void feed(unsigned long sec) {
    feed_count++;
    if (sec == 0 || feed_count == 0) feed_count = 1;
    stop();
    setInterval(sec);
    start();
  }
  void loop() {
    if (enable && (unsigned long)(millis() - now) > 100) {
      now = millis();
      if (now / 1000 >= ts) {
        ts = now / 1000;
        ms = now;
      } else {
        ts += (unsigned long)(now - ms) / 1000;
      }
    }
  }
  unsigned long remaining() { return ready() ? 0 : end - ts; }
  unsigned char feedCount() const { return feed_count; }
  bool isRunning() const { return enable; }
  bool ready() {
    loop();
    return ts >= end;
  }
};
// ---- end verbatim -----------------------------------------------------

// Field conditions from the failure being reported.
static const unsigned long kBootMs = 66104957UL;  // device uptime at the -76
static const unsigned long kSyncReadTimeoutSec = 5;  // setSyncReadTimeout(5)
static const int kMaxIter = 5000000;

// Iteration rates to sweep, in ms. The point of the sweep is that the rate is
// IRRELEVANT: Timer::feed() -> setInterval() -> reset() recomputes
// `end = ts + period` from the CURRENT ts, so `end - ts == period` invariantly
// after every feed(), and `ready()` (`ts >= end`) is never true at any rate.
// 101ms and above also clear Timer::loop()'s `(millis() - now) > 100` guard,
// so ts genuinely advances — and it still never expires.
static const unsigned long kSweepMs[] = {1, 50, 101, 150, 1000};

// Case 1 — CURRENT CODE. AsyncClient.h:1131-1153. On a socket the peer has
// dropped, receive() returns ret_continue every time (readResponse() is a
// no-op because tcpAvailable()==0 but still returns true, so
// receive() hits `if (httpCode == 0) return ret_continue;`). The loop
// therefore never satisfies its exit condition, and the only bound left is
// handleReadTimeout() -> read_timer.remaining()==0.
static void case_current() {
  for (unsigned long step : kSweepMs) {
    g_ms = kBootMs;
    Timer read_timer;
    bool exited = false;
    for (int i = 0; i < kMaxIter; i++) {
      read_timer.feed(kSyncReadTimeoutSec);  // line 1133, top of EVERY iteration
      // receive(sData) -> ret_continue (socket dead, no bytes, no progress)
      if (read_timer.remaining() == 0) {     // line 1136, handleReadTimeout()
        printf("current code  step=%4lums : EXIT at %lus\n", step,
               (g_ms - kBootMs) / 1000);
        exited = true;
        break;
      }
      g_ms += step;
    }
    if (!exited)
      printf("current code  step=%4lums : NEVER EXITED (%lus simulated)\n", step,
             (g_ms - kBootMs) / 1000);
  }
}

// Case 2 — RECOMMENDED FIX: feed only when the iteration made progress.
// `made_progress` stands in for "respCtx.totalRead increased or respCtx.stage
// advanced". A dead socket never progresses, so the timer is never re-armed
// and expires at sync_read_timeout_sec.
static void case_progress_based(bool made_progress, const char *label) {
  g_ms = kBootMs;
  Timer read_timer;
  read_timer.feed(kSyncReadTimeoutSec);  // armed once when the read begins
  for (int i = 0; i < kMaxIter; i++) {
    if (made_progress) read_timer.feed(kSyncReadTimeoutSec);  // only on progress
    if (read_timer.remaining() == 0) {
      printf("%s : EXIT at %lus\n", label, (g_ms - kBootMs) / 1000);
      return;
    }
    g_ms += 50;
  }
  printf("%s : NEVER EXITED (%lus simulated) <- correct for a live transfer\n",
         label, (g_ms - kBootMs) / 1000);
}

// Case 3 — CONTROL: one receive() call that blocks longer than the timeout.
// This is the case the current arrangement handles correctly, and is why the
// in-loop feedTimer() looks right in ordinary (slow-but-live) operation.
static void case_slow_single_receive() {
  g_ms = kBootMs;
  Timer read_timer;
  read_timer.feed(kSyncReadTimeoutSec);
  g_ms += 6000;  // a single receive() took 6s > 5s timeout
  printf("slow receive() : remaining()=%lu (0 => timeout fires, as intended)\n",
         read_timer.remaining());
}

int main() {
  printf("FirebaseClient sync read-timeout reproducer\n");
  printf("Timer verbatim from v2.2.13; uptime=%lums, setSyncReadTimeout(%lu)\n\n",
         kBootMs, kSyncReadTimeoutSec);
  case_current();
  printf("\n");
  case_progress_based(false, "fix, dead socket   ");
  case_progress_based(true,  "fix, live transfer ");
  printf("\n");
  case_slow_single_receive();
  printf(
      "\nfeed() -> setInterval() -> reset() recomputes `end = ts + period` from\n"
      "the CURRENT ts, so `end - ts == period` after every feed() and\n"
      "`ready()` (ts >= end) is never true -- at ANY iteration rate, including\n"
      "rates above Timer::loop()'s 100ms guard. Feeding only on progress lets a\n"
      "stalled read expire while a live transfer still extends its deadline.\n");
  return 0;
}
