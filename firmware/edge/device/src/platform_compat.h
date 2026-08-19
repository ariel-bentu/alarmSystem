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

// ESP8266WebServer and ESP32's WebServer expose the same surface for
// everything this firmware uses (on/begin/stop/handleClient/send/arg/
// onNotFound), so a type alias is enough — no call-site changes.
using WebServerClass = WebServer;

// ESP8266: ESP.getMaxFreeBlockSize(). ESP32: ESP.getMaxAllocHeap().
inline uint32_t platformMaxAllocHeap() { return ESP.getMaxAllocHeap(); }

// ESP8266 needs explicit ESP.wdtFeed() inside long synchronous waits. On
// ESP32 the task watchdog is satisfied by yielding to the scheduler, which
// delay(0)/yield() does; there is no wdtFeed() equivalent.
inline void platformFeedWatchdog() { yield(); }

// ESP32's EEPROM class has getDataPtr() but no getConstDataPtr().
#define PLATFORM_EEPROM_CONST_DATA_PTR() (EEPROM.getDataPtr())

// mDNS on ESP32 is serviced by its own task; MDNS.update() does not exist.
inline void platformMdnsUpdate() {}

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

#define PLATFORM_EEPROM_CONST_DATA_PTR() (EEPROM.getConstDataPtr())

inline void platformMdnsUpdate() { MDNS.update(); }

#define PLATFORM_HAS_CONT_STACK 1
#define PLATFORM_HAS_SET_BUFFER_SIZES 1

#endif
