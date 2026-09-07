#include <unity.h>

#include "host_resolver.h"

// Regression tests for the blocking-DNS hang (Finding 1, 2026-09-05).
//
// Every FirebaseClient poll and every alarm write calls
// WiFiClientSecure::connect(host, port), which resolves the hostname with a
// blocking WiFi.hostByName() BEFORE the TCP/TLS timeouts apply — up to ~31s
// on this ESP32 core (WiFiGeneric.cpp: 16s WIFI_DNS_IDLE + 15s WIFI_DNS_DONE),
// and that wait does NOT feed the task watchdog. Two of those back to back in
// reportAlarm() can exceed the 60s watchdog and reboot a healthy device.
//
// HostResolver is the pure decision layer: it caches the resolved IP so the
// blocking lookup happens ONCE per host, not per connect. The actual
// WiFi.hostByName() call and connect-by-IP live in SslClientWithDns (Arduino
// types, not native-testable); this class holds only the cache policy, kept
// free of Arduino/FirebaseClient types for the same reason as AuthSupervisor.
//
// The IP is an opaque uint32 here (that is exactly what IPAddress wraps), so a
// real lookup result round-trips through this unchanged.

static void test_first_lookup_is_a_cache_miss() {
  HostResolver r;
  // Nothing cached yet: the caller MUST perform the blocking resolve.
  TEST_ASSERT_FALSE(r.cached("rtdb.example.com", nullptr));
}

static void test_cached_ip_is_returned_without_reresolving() {
  HostResolver r;
  r.store("rtdb.example.com", 0x01020304u);
  uint32_t ip = 0;
  TEST_ASSERT_TRUE(r.cached("rtdb.example.com", &ip));
  TEST_ASSERT_EQUAL_HEX32(0x01020304u, ip);
}

// A cache hit must not depend on the caller wanting the value back — the
// library sometimes only asks "do I need to resolve?".
static void test_cached_accepts_null_out() {
  HostResolver r;
  r.store("h", 0x0A0B0C0Du);
  TEST_ASSERT_TRUE(r.cached("h", nullptr));
}

// A different host is a miss even when something is cached: the RTDB URL and
// the mint URL are different hosts and must not alias each other.
static void test_different_host_is_a_miss() {
  HostResolver r;
  r.store("rtdb.example.com", 0x01020304u);
  uint32_t ip = 0;
  TEST_ASSERT_FALSE(r.cached("functions.example.com", &ip));
}

// THE FIX'S POINT: a failed connect invalidates the cache so the NEXT connect
// re-resolves. Google's frontend IPs rotate; a cached IP that stops answering
// must not wedge the device onto a dead address forever.
static void test_invalidate_forces_reresolve() {
  HostResolver r;
  r.store("h", 0x01020304u);
  TEST_ASSERT_TRUE(r.cached("h", nullptr));
  r.invalidate();
  TEST_ASSERT_FALSE(r.cached("h", nullptr));
}

// Re-storing after an invalidate (the re-resolve path) must adopt the new IP,
// not resurrect the old one.
static void test_restore_after_invalidate_adopts_new_ip() {
  HostResolver r;
  r.store("h", 0x01020304u);
  r.invalidate();
  r.store("h", 0x05060708u);
  uint32_t ip = 0;
  TEST_ASSERT_TRUE(r.cached("h", &ip));
  TEST_ASSERT_EQUAL_HEX32(0x05060708u, ip);
}

// A resolve that failed (IP 0) must never be cached as valid — 0.0.0.0 is not
// a host, and caching it would make every later connect skip the retry and
// hand connect() a dead address.
static void test_zero_ip_is_never_a_valid_cache() {
  HostResolver r;
  r.store("h", 0u);
  TEST_ASSERT_FALSE(r.cached("h", nullptr));
}

// Storing a new host replaces the previous cache entry (single-slot: the
// device only ever talks to one RTDB host at a time on this client).
static void test_new_host_replaces_previous() {
  HostResolver r;
  r.store("a", 0x01010101u);
  r.store("b", 0x02020202u);
  uint32_t ip = 0;
  TEST_ASSERT_FALSE(r.cached("a", &ip));
  TEST_ASSERT_TRUE(r.cached("b", &ip));
  TEST_ASSERT_EQUAL_HEX32(0x02020202u, ip);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_first_lookup_is_a_cache_miss);
  RUN_TEST(test_cached_ip_is_returned_without_reresolving);
  RUN_TEST(test_cached_accepts_null_out);
  RUN_TEST(test_different_host_is_a_miss);
  RUN_TEST(test_invalidate_forces_reresolve);
  RUN_TEST(test_restore_after_invalidate_adopts_new_ip);
  RUN_TEST(test_zero_ip_is_never_a_valid_cache);
  RUN_TEST(test_new_host_replaces_previous);
  return UNITY_END();
}
