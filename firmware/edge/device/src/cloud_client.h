#pragma once

#include <Arduino.h>

// NOTE(API adaptation): the brief's SSL_CLIENT macro comes from
// FirebaseClient's own examples/ExampleFunctions.h, which is not pulled in
// by the library itself. The library's real ESP8266 examples (e.g.
// examples/RealtimeDatabase/StreamEthernet/ESP8266/ESP8266.ino) construct
// AsyncClientClass directly from a plain WiFiClientSecure, so we do the
// same here rather than depending on an example-only header.
#include <WiFiClientSecure.h>

#define ENABLE_CUSTOM_TOKEN
#define ENABLE_DATABASE
#include <FirebaseClient.h>

#include "alarm_state.h"
#include "config_parser.h"

class CloudClient {
 public:
  // mintTokenUrl: the mintDeviceToken Cloud Function's URL; databaseUrl:
  // the project's RTDB URL; firebaseWebApiKey: public Web API key
  // (compile-time constant, safe to embed — see Task 11 note).
  bool begin(const String& mintTokenUrl, const String& databaseUrl,
             const String& firebaseWebApiKey, const String& deviceApiKey);

  // Performs the initial mint + FirebaseApp/stream setup synchronously.
  //
  // MUST be called from loop(), never from setup(). The TLS handshake's
  // wait loop (BearSSL::WiFiClientSecureCtx::_run_until) paces itself with
  // optimistic_yield(), which only actually yields when can_yield() is true
  // — i.e. only on the cont (sketch) stack. From setup() the handshake runs
  // in system context, the loop spins without feeding the watchdog, and a
  // Soft WDT reset follows at ~3s. loop()'s retry path calls this; nothing
  // else should. See main.cpp's onNormalOperation() for the full evidence.
  //
  // Blocking (seconds) — acceptable because loop() is re-entered afterwards
  // and a failure just falls through to the 30s retry.
  //
  // Returns true if the device is authenticated and streams are attached.
  bool beginInitialConnect();

  // Non-blocking; call every loop() iteration to service FirebaseClient's
  // async tasks (auth refresh, stream reconnects). Also retries the mint
  // with backoff if beginInitialConnect() did not succeed.
  // sirenActive: true = 1s poll cadence, false = 5s.
  void loop(bool sirenActive = false);

  bool isReady() const;  // true once authenticated and streams attached

  // Fire-and-forget event write to /{projectId}/events/{rfId}/{ts}.
  // No-op (silently skipped) if not yet authenticated — matches the
  // "no event buffering v1" decision.
  void reportEvent(const char* rfId, const char* event, bool batteryLow, int rssi,
                   const char* value = nullptr);

  // Write armed state to /{projectId}/state/armed so the web UI reflects
  // device-side arm/disarm (local web UI, physical button, etc.).
  // No-op if not yet authenticated.
  void reportArmedState(bool armed);

  // Write current epoch seconds to /{projectId}/state/last_seen.
  // Call every ~10s from loop() to drive the web UI's online indicator.
  // No-op if not yet authenticated.
  void reportHeartbeat();

  // Registered once in begin(); main.cpp polls these via getters rather
  // than a callback, to keep main.cpp's control flow linear.
  bool consumeArmedCommand(bool* armed);    // true if a new value arrived since last call
  bool consumeSirenCommand(bool* sirenOn);  // true if a new value arrived since last call
  bool consumeConfigUpdate(Config* config); // true if a new config arrived since last call
  // Pairing request: /commands/pair = { n: <nonce>, until: <epochSec> }.
  // A nonce rather than a bool so a repeat request is distinguishable from a
  // stale one; `until` lets the device ignore a request whose window has
  // already passed, so a command left in RTDB cannot make a device pair
  // itself on reboot days later.
  bool consumePairCommand(uint32_t* nonce, uint32_t* untilEpochSec);
  // Lets callers avoid putting a ~2.4KB Config on the 4KB cont stack unless
  // there is actually an update to take — see main.cpp's loop().
  bool hasPendingConfigUpdate() const { return hasPendingConfig_; }

 private:
  String mintTokenUrl_;
  String databaseUrl_;
  String deviceApiKey_;
  String firebaseWebApiKey_;
  bool tokenMinted_ = false;
  String customTokenJwt_;
  // Learned from mintDeviceToken's response (see mintCustomToken()); used to
  // prefix every RTDB path (/{projectId}/commands, /config, /events/...) per
  // the multi-tenant data layout — the device has no other way to know it.
  String projectId_;
  // NOTE(API adaptation): FirebaseApp::ready() is non-const in the real
  // library (it drives processAuth() as a side effect), but this class's
  // public isReady() is const per the brief's interface. loop() polls
  // app_.ready() once per iteration and caches the result here so isReady()
  // can stay a cheap const getter for main.cpp.
  bool appReady_ = false;

  // TWO SSL clients, not four — this is the shape spike_mint proved works on
  // this board (mint + RTDB auth + write + read, all succeeding).
  //
  // Four clients does NOT fit: constructing them costs ~11.8KB, dropping the
  // heap from 21,568 to 9,808, and BearSSL then fails a 3424-byte allocation
  // per handshake ("Unhandled C++ exception: OOM" in _connectSSL).
  // setBufferSizes(512,512) on all four did not save it — the number of
  // simultaneous TLS connections is the constraint, not their buffer size.
  //
  // So: one client for auth (FirebaseApp owns it), and ONE shared data
  // client used serially for config reads, command reads, and event writes.
  // Serial use is why SSE streaming is gone — see loop()'s polling comment.
  //
  // Heap-allocated after the mint, not plain members: each WiFiClientSecure
  // allocates a WiFiClientSecureCtx in its constructor, and holding those
  // through the mint's own handshake wastes the headroom it needs.
  WiFiClientSecure* authSslClient_ = nullptr;
  WiFiClientSecure* dataSslClient_ = nullptr;
  // mintCustomToken() uses a stack-local WiFiClientSecure, freshly
  // constructed per call — see its comment for why a long-lived version
  // (member, and separately a lazily-allocated pointer) both regressed to
  // crashing on the very first mint attempt on real hardware, worse than
  // the fragmentation-across-retries problem they were meant to fix.

  // Also deferred: these bind by reference to the SSL clients above, so
  // they cannot be constructed until those exist.
  using AsyncClient = AsyncClientClass;
  AsyncClient* authClient_ = nullptr;
  AsyncClient* dataClient_ = nullptr;

  FirebaseApp app_;
  RealtimeDatabase database_;

  AsyncResult dataResult_;

  // Polling cadence for config/commands, alternating so only one request is
  // ever in flight on the shared client.
  unsigned long lastPollMs_ = 0;
  bool pollConfigNext_ = false;
  // 5s normal cadence, 1s when siren is active (each path seen every 2x).
  //
  // This is a HEAP budget, not a latency preference. Steady-state free heap
  // with the long-lived data client is only ~5KB / ~3KB contiguous, and at a
  // 5s cadence the device died with "Unhandled C++ exception: OOM" on a
  // 540-byte allocation inside MDNSResponder::_readRRAnswer — i.e. mDNS
  // could not parse an inbound packet because the cloud path had consumed
  // everything. Polling less often leaves that margin intact.
  //
  // LAN arm/disarm via the local web server is unaffected and instant; this
  // only bounds REMOTE command latency.
  static constexpr unsigned long kPollIntervalMs = 5000;
  static constexpr unsigned long kPollIntervalAlarmMs = 1000;

  // Last-seen polled values. SSE delivered only changes; polling re-reads
  // the same value every few seconds, so these suppress no-op updates that
  // would otherwise re-apply commands and rewrite EEPROM continuously.
  // Minimum contiguous heap required to CREATE the data client (first use
  // only — reuse is never gated, see openDataClient()). BearSSL's handshake
  // allocation alone is 3424 bytes with request/response buffers on top, so
  // this needs real headroom. It is checked right after auth completes,
  // where ~15KB is free and fragmentation is still low.
  static constexpr uint32_t kMinBlockForWrite = 6000;

  // Separate, write-specific floor. An event write allocates more than the
  // small config/command reads, and attempting one below this does not fail
  // cleanly — it resets the board. Measured: writes crash at ~2.6KB; the
  // steady-state largest block after the first TLS cycle is ~3.4KB, so on
  // current hardware this floor means cloud event reporting is effectively
  // OFF while polling keeps working. Intentional: a lost event is better
  // than a reset that takes the alarm state machine with it.
  static constexpr uint32_t kMinBlockForEventWrite = 5000;

  bool hadArmedValue_ = false;
  bool lastArmedValue_ = false;
  bool hadSirenValue_ = false;
  bool lastSirenValue_ = false;
  bool hadConfigValue_ = false;
  String lastConfigJson_;

  bool pendingArmed_ = false;
  bool hasPendingArmed_ = false;
  bool pendingSiren_ = false;
  bool hasPendingSiren_ = false;
  bool hasPendingConfig_ = false;
  Config pendingConfig_;

  uint32_t lastPairNonce_ = 0;
  bool hadPairNonce_ = false;
  uint32_t pendingPairNonce_ = 0;
  uint32_t pendingPairUntil_ = 0;
  bool hasPendingPair_ = false;

  bool mintCustomToken();
  // Parse a polled /commands or /config payload. Actual config parsing lives
  // in config_parser.h/.cpp (pure, native-testable).
  void applyCommandsJson(const String& json);
  void applyConfigJson(const String& json);
  // Factored out of begin() so the mint-retry path in loop() can perform the
  // same post-mint setup without duplicating it.
  void startAppAndStreams();
  // Data client lifecycle — see their definitions for why it is transient.
  bool openDataClient();
  void closeDataClient();

  unsigned long lastMintAttemptMs_ = 0;
  // Drives loop()'s retry backoff: fast retries while low, slow after.
  unsigned int mintFailureCount_ = 0;
  // False until loop()'s retry-gate has fired at least once — lets the
  // first mint attempt happen on loop()'s first iteration regardless of
  // millis()'s value at boot, instead of waiting out a full 30s backoff.
  bool mintAttempted_ = false;
};
