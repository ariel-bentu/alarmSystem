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
#include "auth_supervisor.h"
#include "config_parser.h"
#include "ssl_client_with_dns.h"

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

  // Event write to /{projectId}/events/{rfId}/{ts}.
  // No-op (silently skipped) if not yet authenticated — matches the
  // "no event buffering v1" decision.
  //
  // Returns true only if the write actually reached RTDB. Sensor triggers
  // ignore this (a lost event is accepted by design), but the siren-address
  // report MUST check it: that write is what persists the device's identity
  // to Firestore, and it is also skipped when contiguous heap is low. Marking
  // it "reported" after a skipped write would strand the address on-device
  // forever, which is the very failure this reporting exists to prevent.
  bool reportEvent(const char* rfId, const char* event, bool batteryLow, int rssi,
                   const char* value = nullptr);

  // Write armed state to /{projectId}/state/armed so the web UI reflects
  // device-side arm/disarm (local web UI, physical button, etc.).
  // No-op if not yet authenticated.
  // `source` ("remote", "local", "cloud") is written to
  // /{projectId}/state/armed_by BEFORE state/armed, so onDeviceArmStateChange
  // — which triggers on state/armed — always finds it already present. Same
  // ordering discipline reportAlarm() uses for alarm_cause before
  // siren_active. Pass nullptr to leave armed_by untouched.
  void reportArmedState(bool armed, const char* source = nullptr);

  // Report a device-side alarm: writes /{projectId}/state/alarm_cause
  // ({rfId, ct, at}) and then sets /state/siren_active true. The cause goes
  // first so onAlarm, which triggers on siren_active, always finds it.
  // rfId/conditionType come from AlarmState's TriggerCause.
  // No-op if not yet authenticated.
  void reportAlarm(const char* rfId, uint8_t conditionType);

  // Report an alarm that has no sensor behind it (SOS from a remote).
  // Writes /{projectId}/state/alarm_cause as {label, at} — the shape
  // alarmCause.ts already supports, where a label wins outright over rfId
  // mapping — then sets /state/siren_active true, exactly like
  // reportAlarm(). Do NOT pass a remote's raw code to reportAlarm()
  // instead: it would make the Telegram alert name an unpaired sensor.
  // No-op if not yet authenticated.
  void reportAlarmLabel(const char* label);

  // Clear /{projectId}/state/siren_active. REQUIRED after every reportAlarm:
  // onAlarm triggers on the false->true edge, so a flag left true swallows
  // every later alarm silently. No-op if not yet authenticated.
  void clearAlarm();

  // Write device UPTIME SECONDS (millis()/1000) to
  // /{projectId}/state/last_seen. NOT epoch — an earlier version of this
  // comment said "epoch seconds" and it is wrong; the web UI timestamps the
  // ARRIVAL of the update instead, so online detection works before NTP has
  // synced (see useDeviceState.ts). The uptime value is what allowed a
  // silent death to be dated after the fact, so keep the semantics.
  // Call every ~10s from loop() to drive the web UI's online indicator.
  // No-op if not yet authenticated.
  void reportHeartbeat();

  // Write /{projectId}/state/boot = { reason, at, uptime_before }.
  //
  // Called once per boot, as soon as the cloud is ready. This is the whole
  // point of the watchdog work: a device that dies unexplained comes back,
  // says WHY it died, and the next investigation reads it from RTDB instead
  // of reconstructing it from heartbeat arithmetic. "panic" vs "twdt" vs
  // "brownout" separates a crash from a hang from a power fault — three
  // very different bugs that look identical from the outside.
  void reportBoot();

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

  // True once a config has been successfully read from RTDB at all — even an
  // unchanged one that produced no pending update.
  //
  // This is deliberately NOT "a config update was applied". main.cpp needs to
  // know whether the cloud has been HEARD FROM before it may generate a siren
  // address, and a device whose config never changes gets no updates at all;
  // gating on updates alone would mean it never generates one.
  bool hasReceivedConfig() const { return hadConfigValue_; }

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

  // Decides when an un-ready app has been un-ready for too long to be
  // recovering on its own, and must be re-minted from scratch. Pure logic,
  // native-tested in test/test_auth_supervisor — see auth_supervisor.h for
  // the field failure that made it necessary.
  AuthSupervisor authSupervisor_;
  // Rate-limits the "NOT ready" trace to once a minute; 0 = not logging.
  unsigned long lastNotReadyLogMs_ = 0;

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
  //
  // SslClientWithDns (not a plain WiFiClientSecure): resolves each host once
  // and connects by IP, so FirebaseClient's per-poll/per-write connect() no
  // longer runs a blocking DNS lookup that the watchdog cannot see. Matters
  // for BOTH — the auth client reconnects on every ~hourly token refresh, and
  // that handshake blocks the same loop task the watchdog watches. See
  // ssl_client_with_dns.h.
  SslClientWithDns* authSslClient_ = nullptr;
  SslClientWithDns* dataSslClient_ = nullptr;
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
  // *** THE PARAGRAPH BELOW IS ESP8266-ONLY HISTORY. *** It described a
  // board with ~5KB free heap, where the cloud path could starve mDNS of a
  // 540-byte allocation. The ESP32-S3 runs this at ~258KB free / ~192KB
  // largest block, so 5s is NOT a heap risk there and 15000 is not required.
  // Kept because the measurement is real and still applies if the 8266 env
  // is ever revived — but do not cite it as a constraint on current
  // hardware. (It was mistakenly blamed for an unexplained ESP32 hang on
  // 2026-09-02; see CLAUDE.md's "Watchdog + boot reporting".)
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

  // How long a single synchronous FirebaseClient operation may block loop().
  //
  // THIS IS A WATCHDOG CONSTRAINT, NOT A LATENCY PREFERENCE. database_.get()
  // and database_.set() are SYNCHRONOUS: they block inside loop() in
  //   while (!sData->response.tcpAvailable()) { sys_idle(); ... }
  // (FirebaseClient AsyncClient.h), and sys_idle() on ESP32 is just delay(0)
  // — it yields to FreeRTOS but does NOT feed the task watchdog.
  //
  // Left unset, that wait is bounded only by the library's own
  // FIREBASE_TCP_READ_TIMEOUT_SEC / FIREBASE_TCP_WRITE_TIMEOUT_SEC, both 30s
  // (core/Options.h, marked "Do not change"). The default applies whenever
  // setSyncReadTimeout()/setSyncSendTimeout() are not called, because the
  // library reads `sync_*_timeout_sec > 0 ? sync_*_timeout_sec : -1` and -1
  // means "use the 30s default".
  //
  // kWatchdogTimeoutSec was ALSO 30, so one stalled poll could consume the
  // entire watchdog budget and reboot a perfectly healthy device — the
  // occasional "device gets stuck" reports. reportAlarm() is the worst case:
  // two sequential blocking set() calls, i.e. up to 60s, DURING AN ALARM.
  //
  // 5s is far longer than a healthy round-trip (observed well under 1s) and
  // far shorter than the watchdog budget, so a stalled network now fails the
  // poll cleanly and loop() keeps running — RF decode, the siren and the LAN
  // UI are all local and must not be held hostage by a slow socket.
  static constexpr uint32_t kSyncTimeoutSec = 5;

  // TLS CONNECT budget — a DIFFERENT bound from kSyncTimeoutSec above, and
  // the one that was missing.
  //
  // setSyncReadTimeout/setSyncSendTimeout govern reads and writes on an
  // ESTABLISHED socket. They do NOT cover the connect that precedes them:
  // FirebaseClient's SlotManager::connect() calls straight through to
  // WiFiClientSecure::connect(), whose Arduino-ESP32 defaults are
  //
  //     handshake_timeout = 120000 ms   (DOUBLE the 60s watchdog)
  //     _timeout          =  30000 ms
  //
  // and ssl_client.cpp's handshake loop spins on vTaskDelay(2), which yields
  // to FreeRTOS WITHOUT resetting the TWDT — the identical trap to
  // sys_idle()/delay(0) described above. A handshake to a silent or
  // packet-dropping peer therefore blocks loop() for up to two minutes and
  // the board reboots at 60s with reason=twdt, having done nothing wrong.
  //
  // This was the cause of the twdt reboots observed on hardware 2026-09-04,
  // two of them 45 minutes apart, on a build that ALREADY capped the sync
  // read/write timeouts at 5s. Capping those was necessary but not
  // sufficient — the connect phase was never covered.
  //
  // 10s: comfortably above a healthy handshake (observed ~900ms in the mint
  // path) and well under the 60s budget, leaving room for the poll's own
  // read/write timeouts on top. Both setters take SECONDS on ESP32.
  static constexpr uint32_t kHandshakeTimeoutSec = 10;
  static constexpr uint32_t kSocketTimeoutSec = 10;

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
  // same post-mint setup without duplicating it. Safe to call more than once
  // — forceReauth() drives it a second time.
  void startAppAndStreams();
  // Discard the dead auth session so loop()'s mint-retry path rebuilds it.
  // See its definition for what is deliberately NOT freed, and why.
  void forceReauth();
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
