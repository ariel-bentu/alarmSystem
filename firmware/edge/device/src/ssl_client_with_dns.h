#pragma once

#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "host_resolver.h"
#include "io_deadline.h"
#include "platform_compat.h"

// A WiFiClientSecure that resolves each host AT MOST ONCE and then connects by
// IP, so the blocking DNS lookup is kept off the per-connect hot path.
//
// THE PROBLEM (Finding 1, 2026-09-05): FirebaseClient drives every poll and
// every alarm write through Client::connect(host, port). The base
// WiFiClientSecure::connect(host, ...) calls WiFi.hostByName() first, which on
// this core blocks up to ~31s (WiFiGeneric.cpp: 16s WIFI_DNS_IDLE + 15s
// WIFI_DNS_DONE) BEFORE setTimeout()/setHandshakeTimeout() apply — and that
// wait does NOT feed the task watchdog. reportAlarm() issues two set() calls
// back to back, so two slow resolves can exceed the 60s watchdog and reboot a
// healthy device mid-alarm (reason=twdt). See host_resolver.h for the full
// note and the field symptom this matches.
//
// THE FIX: override connect(host, port). On a cache miss, resolve once (fed on
// both sides, like connectToWifi()'s scanNetworks()), cache the IP, and
// connect by IP. On a hit, connect straight to the cached IP with no DNS at
// all. SNI is preserved by passing the original hostname to the IP-connect
// overload, so Google's frontend still routes correctly under setInsecure().
// A failed connect invalidates the cache, so a rotated frontend IP forces a
// fresh resolve on the next attempt rather than wedging on a dead address.
//
// connect(const char*, uint16_t) is virtual in the Client base, and
// FirebaseClient holds the client as Client* (ConnectionHandler.h) and calls
// it virtually, so this override is dispatched. The IPAddress and no-host
// overloads are left to the base class untouched.
class SslClientWithDns : public WiFiClientSecure {
 public:
  int connect(const char* host, uint16_t port) override {
    if (host == nullptr) return 0;

    // A literal IP needs no resolution and no cache: hand it straight to the
    // base, which also short-circuits hostByName() for a dotted quad.
    IPAddress literal;
    if (literal.fromString(host)) {
      return WiFiClientSecure::connect(literal, port);
    }

    uint32_t cachedIp = 0;
    if (!resolver_.cached(host, &cachedIp)) {
      // Cache miss: the one blocking resolve. Fed on both sides because
      // hostByName() can block for seconds without touching the TWDT — the
      // same guard connectToWifi() puts around its synchronous scanNetworks().
      IPAddress resolved;
      platformFeedWatchdog();
      bool ok = WiFi.hostByName(host, resolved);
      platformFeedWatchdog();
      if (!ok || (uint32_t)resolved == 0) {
        Serial.printf("[dns] resolve of %s FAILED — connect aborted\n", host);
        return 0;
      }
      cachedIp = (uint32_t)resolved;
      resolver_.store(host, cachedIp);
      Serial.printf("[dns] resolved %s -> %s (cached)\n", host,
                    IPAddress(cachedIp).toString().c_str());
    }

    // Connect by IP, but pass the ORIGINAL hostname as the SNI/cert host so
    // Google's frontend routes the TLS session correctly. This overload takes
    // cert args; nullptr is correct under setInsecure() (verification is off).
    IPAddress ip(cachedIp);
    int rc = WiFiClientSecure::connect(ip, port, host, nullptr, nullptr, nullptr);
    if (rc <= 0) {
      // The cached IP did not answer. Drop it so the next connect re-resolves
      // rather than retrying the same dead frontend address forever.
      Serial.printf("[dns] connect to cached %s for %s failed — invalidating\n",
                    ip.toString().c_str(), host);
      resolver_.invalidate();
    } else {
      // Start bounding this operation. Every FirebaseClient sync wait polls
      // available() (read/connected cascade from it); the deadline lets us tear
      // a stalled socket down from there — see available() below and
      // io_deadline.h for the -76 hang this fixes.
      deadline_.arm(millis());
    }
    return rc;
  }

  // Bound the read wait by wall clock. FirebaseClient's sync loops spin on
  // available() (and read()/connected(), which both funnel through it) calling
  // sys_idle() between polls — which yields WITHOUT feeding the task watchdog.
  // The base available() already stops the socket and returns <0 on a HARD
  // mbedTLS error (-76), but a socket that simply goes silent (peer wedged, not
  // errored) returns 0 forever and the library can spin to the 60s TWDT. So:
  // once this operation has made no progress for the bound, force it closed and
  // report the error, which makes the spinning wait abort.
  int available() override {
    if (deadline_.expired(millis())) {
      Serial.println("[io] socket stalled past deadline — stopping to unblock loop");
      WiFiClientSecure::stop();  // clears _connected; connected() now returns 0
      deadline_.disarm();
      return -1;  // any nonzero breaks `while(!available())`; <0 breaks read()
    }
    int n = WiFiClientSecure::available();
    // Bytes ready == progress: re-arm so a slow-but-advancing transfer runs to
    // completion and only a genuinely stalled socket is torn down.
    if (n > 0) deadline_.progress(millis());
    return n;
  }

  int read(uint8_t* buf, size_t size) override {
    int n = WiFiClientSecure::read(buf, size);
    if (n > 0) deadline_.progress(millis());
    return n;
  }

  void stop() override {
    deadline_.disarm();
    WiFiClientSecure::stop();
  }

  // Keep the base overloads visible — only the (host, port) form is
  // specialised; everything else (IP connect, timeout form, etc.) must still
  // resolve to WiFiClientSecure's implementations.
  using WiFiClientSecure::connect;
  using WiFiClientSecure::read;

 private:
  HostResolver resolver_;
  // 12s: above the 5s sync read timeout (so it is a backstop, not the primary
  // bound), and well under the 40s stall monitor / 60s TWDT.
  IoDeadline deadline_{12000};
};
