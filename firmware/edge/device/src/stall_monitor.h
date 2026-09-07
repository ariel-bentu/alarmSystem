#pragma once

// Stuck-loop monitor (2026-09-05). Watches loopTask from a SEPARATE FreeRTOS
// task and, ~40s into a stall, dumps where the loop is stuck OVER SERIAL WHILE
// THE USB PORT IS STILL ALIVE — a full 20s before the 60s TWDT panic, which on
// this S3 fires after the USB-Serial/JTAG has already stopped enumerating and
// so usually loses its own backtrace to the host.
//
// It does NOT reboot or otherwise recover: the existing task watchdog
// (platformWatchdogBegin) still owns that. This only makes the hang OBSERVABLE
// before the reboot, which every past hang was not — see
// docs/history/tls-handshake-watchdog-reboot.md.
//
// Split: StallDetector (stall_detector.h) is the pure, native-tested timing
// policy; everything Arduino / FreeRTOS lives here.
//
// ESP32-only. On the ESP8266 the SDK's own software watchdog already reboots a
// hung loop() and there is no second core to run a monitor on, so this is a
// no-op there (kept so main.cpp reads the same on both targets).

#include "stall_detector.h"

#if defined(ARDUINO_ARCH_ESP32)

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_debug_helpers.h>

namespace stallmon {

// Bumped by loop() once per iteration; read by the monitor task. `volatile`
// because the two run on different cores with no lock — a plain read could be
// hoisted out of the monitor's poll loop. A 32-bit aligned load/store is
// atomic on this core, so no mutex is needed for either field.
inline volatile uint32_t g_loopHeartbeatMs = 0;
// A coarse label for the blocking stretch loop() is currently in. This is the
// LOAD-BEARING signal: even when the cross-task backtrace comes back corrupt,
// the phase string names which synchronous call ate the budget ("cloud",
// "dns", "tls", "siren-tx", ...). Points at a string literal, so the read is
// always a valid (if possibly one-iteration-stale) pointer.
inline volatile const char* g_loopPhase = "boot";

// warnMs default lives with the detector; 40000 leaves 20s before the 60s TWDT.
inline StallDetector g_detector(40000);

// Called by loop() every iteration. Records progress and the current phase.
inline void bump(const char* phase) {
  g_loopHeartbeatMs = millis();
  if (phase != nullptr) g_loopPhase = phase;
  g_detector.bump(g_loopHeartbeatMs);
}

// Update only the phase, without a heartbeat — for tagging a blocking stretch
// ABOUT to start. If that stretch then hangs, the dump names it. The heartbeat
// is deliberately NOT bumped here: a hang inside the stretch must still trip
// the detector.
inline void phase(const char* p) {
  if (p != nullptr) g_loopPhase = p;
}

inline void dump() {
  // millis() is safe from another task. The phase pointer may be one iteration
  // stale, which is exactly what we want — it is whatever loop() last entered.
  const char* p = (const char*)g_loopPhase;
  uint32_t stalledMs = millis() - g_loopHeartbeatMs;
  Serial.printf(
      "\n*** [stall] loopTask has not progressed for %lums — phase='%s' ***\n",
      (unsigned long)stalledMs, p ? p : "(null)");
  Serial.printf("[stall] heap free=%u min=%u maxblock=%u\n",
                (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
                (unsigned)ESP.getMaxAllocHeap());
  // The monitor's OWN backtrace — proves the monitor is alive and shows it is
  // not itself the stuck task. A cross-task unwind of loopTask is not attempted
  // here: this core builds without the trace facility, so getting loopTask's
  // frame means raw TCB access that is fragile across core versions and prints
  // garbage as often as signal. The phase label above is the reliable answer to
  // "which call is it stuck in?"; the TWDT panic at 60s still carries the full
  // faulting backtrace for the cases where it survives.
  Serial.println("[stall] monitor-task backtrace (liveness, not the stuck task):");
  esp_backtrace_print(12);
  Serial.printf("[stall] TWDT will reboot at its %us budget; not intervening\n",
                60u);
}

inline void monitorTask(void*) {
  for (;;) {
    if (g_detector.shouldDump(millis())) {
      dump();
    }
    // 1s tick. vTaskDelay yields without feeding any watchdog, which is fine —
    // this task is deliberately NOT subscribed to the TWDT.
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

}  // namespace stallmon

// Launch the monitor. Call once, after platformWatchdogBegin(), from setup()
// (or onNormalOperation). Pinned to core 0 — the Arduino loopTask runs on core
// 1 (APP_CPU), so the monitor keeps ticking even while loopTask is wedged, and
// a stall that pins one core cannot starve the other. Priority 1 (just above
// idle): high enough to run against a busy-looping loopTask, low enough not to
// perturb timing-sensitive work.
inline void stallMonitorBegin() {
  xTaskCreatePinnedToCore(stallmon::monitorTask, "stallmon",
                          /*stackDepth=*/3072, nullptr, /*priority=*/1,
                          nullptr, /*coreID=*/0);
  Serial.println("[stall] monitor started (dump at 40s, TWDT reboot at 60s)");
}

// loop() calls this once per iteration; blocking stretches call phase() first.
inline void stallMonitorBump(const char* phase = "loop") {
  stallmon::bump(phase);
}
inline void stallMonitorPhase(const char* p) { stallmon::phase(p); }

#else  // ESP8266 — SDK watchdog already reboots a hung loop; no second core.

inline void stallMonitorBegin() {}
inline void stallMonitorBump(const char* = "loop") {}
inline void stallMonitorPhase(const char*) {}

#endif
