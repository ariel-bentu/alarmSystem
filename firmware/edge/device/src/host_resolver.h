#pragma once

#include <cstdint>
#include <cstring>

// Caches the resolved IP of the ONE host this device's data client talks to,
// so the blocking DNS lookup happens once per host instead of once per
// connect.
//
// WHY THIS EXISTS (Finding 1, 2026-09-05): FirebaseClient issues every poll
// and every alarm write through WiFiClientSecure::connect(host, port), which
// resolves the hostname with a blocking WiFi.hostByName() BEFORE the TCP and
// TLS timeouts apply. On this ESP32 core that wait is up to ~31s
// (WiFiGeneric.cpp: waitStatusBits(WIFI_DNS_IDLE_BIT, 16000) then
// waitStatusBits(WIFI_DNS_DONE_BIT, 15000)) and, like sys_idle()/delay(0) and
// the TLS handshake's vTaskDelay(2), it yields to FreeRTOS WITHOUT feeding the
// task watchdog. reportAlarm() does two sequential set() calls, so two slow
// resolves back to back can exceed the 60s watchdog budget and reboot a
// healthy device mid-alarm — presenting as reason=twdt, and matching the
// "stuck once in ~10h, recovered by the watchdog" field symptom.
//
// The lwIP DNS cache is not a substitute: it holds 4 entries with short,
// server-set TTLs (Google's frontends return ~tens of seconds), so an expired
// entry drops the next connect back onto the blocking path. This cache has no
// TTL and is invalidated explicitly on connect failure instead — see
// SslClientWithDns, which owns the Arduino-side lookup and the connect-by-IP.
//
// Kept free of Arduino/lwIP types (IPAddress is just a uint32 wrapper) so it
// is native-testable, the same reason config_parser, remote_control and
// auth_supervisor are split out. Single-slot: the client only ever talks to
// one host at a time, so a second host simply replaces the first.
class HostResolver {
 public:
  // True if `host` has a valid cached IP; writes it to *out when non-null.
  // A miss means the caller must perform the blocking resolve and store().
  bool cached(const char* host, uint32_t* out) const {
    if (!valid_) return false;
    if (host == nullptr || strncmp(host, host_, sizeof(host_) - 1) != 0) {
      return false;
    }
    if (out != nullptr) *out = ip_;
    return true;
  }

  // Record a freshly resolved IP for `host`. A zero IP is a failed lookup and
  // is NOT cached as valid — caching 0.0.0.0 would hand connect() a dead
  // address on every later call and skip the retry that would have fixed it.
  void store(const char* host, uint32_t ip) {
    if (host == nullptr || ip == 0) {
      valid_ = false;
      return;
    }
    strncpy(host_, host, sizeof(host_) - 1);
    host_[sizeof(host_) - 1] = '\0';
    ip_ = ip;
    valid_ = true;
  }

  // Drop the cached IP so the next cached() misses and the caller re-resolves.
  // Called after a failed connect: Google's frontend IPs rotate, so a cached
  // address that stops answering must not wedge the device onto it forever.
  void invalidate() { valid_ = false; }

 private:
  // DNS_MAX_NAME_LENGTH is 256 on this core, but RTDB/Functions hostnames are
  // well under 128. Fixed buffer so this has no heap footprint and no String.
  char host_[128] = {0};
  uint32_t ip_ = 0;
  bool valid_ = false;
};
