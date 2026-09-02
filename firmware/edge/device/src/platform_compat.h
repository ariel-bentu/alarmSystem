#pragma once

// Single place where ESP8266-vs-ESP32 differences live, so the rest of the
// firmware reads the same on both targets.
//
// Why two targets at all: the D1 Mini (ESP8266) hit a hard wall on cloud
// event writes — heap fragmentation pins the largest contiguous block at
// ~3.4KB after the first TLS cycle, which is below what a write needs, and
// attempting one below that floor RESETS the board rather than failing
// cleanly (see cloud_client.cpp's header comment for the umm_info numbers).
// The ESP32-S3 has ~320KB SRAM plus 8MB PSRAM and no 4KB cont stack, so
// none of that applies there. The 8266 env stays buildable as a fallback,
// and its hard-won evidence comments stay in the tree — they cost days to
// establish and are easy to reintroduce if deleted.
//
// The API deltas below were verified by reading the installed core headers,
// not assumed.

#include <Arduino.h>

#if defined(ARDUINO_ARCH_ESP32)

#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>

// Task watchdog + reset-reason reporting. Neither is declared by any Arduino
// core header, so both includes are required (same situation as
// esp_random.h below).
#include <esp_task_wdt.h>
#include <esp_system.h>

// ESP8266WebServer and ESP32's WebServer expose the same surface for
// everything this firmware uses (on/begin/stop/handleClient/send/arg/
// onNotFound), so a type alias is enough — no call-site changes.
using WebServerClass = WebServer;

// ESP8266: ESP.getMaxFreeBlockSize(). ESP32: ESP.getMaxAllocHeap().
inline uint32_t platformMaxAllocHeap() { return ESP.getMaxAllocHeap(); }

// ESP8266 needs explicit ESP.wdtFeed() inside long synchronous waits. On
// ESP32: once loopTask is subscribed to the Task WDT (see
// platformWatchdogBegin()), yield() alone is NOT enough — the TWDT tracks an
// explicit per-task reset, not scheduler activity. A task can yield happily
// forever and still be starved. So feed it properly AND yield, which keeps
// this correct for the long synchronous waits it was written for
// (cloud_client.cpp's mint response poll, main.cpp's siren pairing loop).
inline void platformFeedWatchdog() {
  esp_task_wdt_reset();
  yield();
}

// Reboot on a hung loop() instead of staying powered-but-dead.
//
// WHY THIS EXISTS: a board was found unresponsive after 9h16m uptime —
// powered, LED on, but off WiFi, off the LAN web server, and with its USB
// serial port gone from the host entirely. Only a physical power-cycle
// revived it, and it had been dead ~28 hours by then. Nothing in the
// firmware could have recovered it: Arduino-ESP32 does NOT subscribe
// loopTask to the TWDT by default, and nothing here called ESP.restart().
//
// The vanished serial port is the tell for a panic/abort() rather than a
// plain spin: the S3's USB-Serial/JTAG is software-serviced, so a halted
// CPU stops enumerating and the port disappears. A hardware UART would have
// kept its handle, which is why this looked like dead hardware.
//
// A reboot loses in-RAM state, but arm state and config live in EEPROM and
// are reloaded on boot, so the alarm comes back armed as it was. Trading a
// ~30s outage for a 28-hour one is the whole point.
inline void platformWatchdogBegin(uint32_t timeoutSec) {
  // NOTE: this core ships the OLDER TWDT API — esp_task_wdt_init(seconds,
  // panic), not the IDF v5 esp_task_wdt_config_t/esp_task_wdt_reconfigure()
  // pair. Verified by reading the installed header directly
  // (framework-arduinoespressif32/tools/sdk/esp32s3/include/esp_system/
  // include/esp_task_wdt.h); the v5 form does not compile here.
  // panic=true so a timeout reboots via the panic handler, which prints a
  // backtrace first — that backtrace is the point, since it names the hung
  // call site on the next boot.
  esp_task_wdt_init(timeoutSec, /*panic=*/true);
  esp_task_wdt_add(nullptr);  // nullptr = the CURRENT task, i.e. loopTask
}

// Why the last boot happened, in one short human-readable word. Written to
// RTDB at boot (see CloudClient::reportBoot) so the NEXT unexplained death
// is diagnosable from the cloud instead of guessed at: "panic" points at a
// crash/abort, "twdt" at a genuine hang caught by the watchdog above,
// "brownout" at power delivery, and "power_on" at an ordinary unplug.
inline const char* platformResetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "power_on";
    case ESP_RST_EXT:      return "external";
    case ESP_RST_SW:       return "sw_restart";
    case ESP_RST_PANIC:    return "panic";
    case ESP_RST_INT_WDT:  return "int_wdt";
    case ESP_RST_TASK_WDT: return "twdt";
    case ESP_RST_WDT:      return "other_wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO:     return "sdio";
    default:               return "unknown";
  }
}

// Low-water mark of free heap since boot. getFreeHeap() only shows the
// instant value, which says nothing about whether a slow leak came close to
// exhausting RAM between two samples. Reported on every heartbeat so a
// downward trend over hours is visible BEFORE the next death, not inferred
// after it.
inline uint32_t platformMinFreeHeap() { return ESP.getMinFreeHeap(); }

// ESP32's EEPROM class has getDataPtr() but no getConstDataPtr().
#define PLATFORM_EEPROM_CONST_DATA_PTR() (EEPROM.getDataPtr())

// mDNS on ESP32 is serviced by its own task; MDNS.update() does not exist.
inline void platformMdnsUpdate() {}

// Hardware RNG. esp_random() lives in ESP-IDF's esp_random.h and is NOT
// declared by any Arduino core header, so the include is required.
#include <esp_random.h>
#define PLATFORM_RANDOM32() (esp_random())

// The cont-stack headroom probe (&local - g_pcont->stack) is meaningless
// here: loop() runs as a normal FreeRTOS task with an 8KB+ stack, not on the
// ESP8266's 4KB cooperative cont stack.
#define PLATFORM_HAS_CONT_STACK 0

// TLS: ESP32's WiFiClientSecure is mbedTLS-backed and has no
// setBufferSizes() (that is a BearSSL API). It also does not need the
// tuning — the buffer sizing on the 8266 existed to fit a handshake into a
// fragmented heap.
#define PLATFORM_HAS_SET_BUFFER_SIZES 0

#elif defined(ARDUINO_ARCH_ESP8266)

#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>
#include <ESP8266WebServer.h>

using WebServerClass = ESP8266WebServer;

inline uint32_t platformMaxAllocHeap() { return ESP.getMaxFreeBlockSize(); }

inline void platformFeedWatchdog() { ESP.wdtFeed(); }

// The ESP8266 already has BOTH watchdogs (hardware + ~3s software) enabled
// by the SDK from boot, so there is nothing to subscribe to — a hung loop()
// resets this chip on its own. Present only so main.cpp has one code shape
// across targets. (This env does not currently compile anyway; see CLAUDE.md.)
inline void platformWatchdogBegin(uint32_t) {}

inline const char* platformResetReason() {
  // Free-form vendor string ("Software Watchdog", "Exception", ...) rather
  // than the ESP32's enum, but it answers the same question.
  return ESP.getResetReason().c_str();
}

inline uint32_t platformMinFreeHeap() {
  // No min-free-heap tracking in this core; the instant value is the best
  // available and still shows gross exhaustion.
  return ESP.getFreeHeap();
}

#define PLATFORM_EEPROM_CONST_DATA_PTR() (EEPROM.getConstDataPtr())

inline void platformMdnsUpdate() { MDNS.update(); }

// Hardware RNG register, exposed by the core's esp8266_peri.h (pulled in via
// Arduino.h). There is no esp_random() on this platform.
#define PLATFORM_RANDOM32() (RANDOM_REG32)

#define PLATFORM_HAS_CONT_STACK 1
#define PLATFORM_HAS_SET_BUFFER_SIZES 1

#endif
