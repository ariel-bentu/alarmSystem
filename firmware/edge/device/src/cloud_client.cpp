#include "cloud_client.h"

#include <ArduinoJson.h>
#include "platform_compat.h"
#include "stall_monitor.h"
#include <WiFiClientSecure.h>
#include <ctime>

#if PLATFORM_HAS_CONT_STACK
extern "C" {
#include "cont.h"
}
#endif

namespace {
// ===========================================================================
// OPEN LIMITATION: cloud EVENT WRITES do not work on the ESP8266.
//
// Everything else does: mint, RTDB auth, and polling /config and /commands.
// Only reportEvent()'s write is disabled, by the kMinBlockForEventWrite
// floor, because attempting it below ~5KB contiguous RESETS the board
// (Exception 29) rather than failing cleanly.
//
// Cause is heap FRAGMENTATION, not exhaustion. Measured with umm_info():
//
//   point                 free     largest-block   frag metric
//   at app.ready()       15,072       10,568           54
//   after 1st poll        4,824        3,400           32
//   after close          10,648        3,472           50
//
// After the first TLS cycle the largest contiguous block settles at ~3.4KB
// and never recovers, even though ~10KB is free. Small polls (51- and
// 14-byte reads) fit in that; an event write does not. umm_malloc has no
// compaction, so there is no way to reassemble the space.
//
// Tried and measured, none sufficient:
//   - Allocating the data client eagerly at auth time, while a 10.5KB block
//     still exists (helps polling — kept — but the first cycle still drops
//     the ceiling to ~3.4KB).
//   - dataSslClient_->stop() between operations to free BearSSL's buffers.
//     It does free them (stop() -> _freeSSL()), but reconnecting re-cuts
//     them from a fragmented heap; frag metric rose 32 -> 50 per close.
//   - Destroying and recreating the client: crashes (dangling entry in
//     FirebaseApp's global client vector — see openDataClient()).
//   - setBufferSizes(512/1024) on the long-lived clients.
//
// Deferred to the ESP32 migration (~320KB RAM, mbedTLS), where the whole
// four-connection design becomes viable again. If it must work on ESP8266,
// the realistic option is writing events through the plain-HTTP
// deviceIngest function instead of a direct TLS RTDB write.
// ===========================================================================
//
// RESOLVED (2026-08-20): this call used to trip a Soft WDT reset on every
// boot, hanging inside client.connect(). The cause was cont-stack
// exhaustion, not heap, not network, and not this file.
//
// loop() runs on a 4KB cont stack and is entered with ~1568 bytes left.
// GCC gives a function ONE frame, sized for its worst-case path and
// allocated in full on entry, so when main.cpp's loop() inlined its helpers
// (a ~2.4KB Config, KeruiPacket + decoder buffers, String temporaries)
// their locals all merged into that single frame. By the time
// CloudClient::loop() ran the mint, BearSSL's handshake had ~992 bytes to
// work with. It could not proceed, so it never yielded, so the watchdog
// fired — which presented as a hang in _run_until rather than a clean
// allocation failure.
//
// Fix: main.cpp marks those helpers __attribute__((noinline)) and calls
// cloudClient.loop() first in loop(). Handshake headroom went 992 -> 3504
// bytes and the mint connects in ~1.4s. See main.cpp's handleSensorEvent().
//
// Measured on hardware, so don't re-litigate these:
//   - Heap is NOT the constraint. Fails at 22,008 free / 22,136 max block
//     and succeeds at 23,192 — a 1KB difference cannot explain an 8.2KB
//     allocation. Fragmentation was 1-2% in every run, good and bad.
//     (An older note claimed the device crashed with MORE free heap than
//     spike_mint. That was a mismeasurement: the spike runs at ~36,360
//     free, not ~20KB. The device always had less.)
//   - A slow handshake is NOT fatal. spike_mint was measured completing one
//     in 4093ms — past the ~3s watchdog window — with no reset. BearSSL
//     yields correctly while it is making progress. Being stuck is fatal.
//   - Not the TLS buffer size (1024/1024 still hung), not LittleFS staying
//     mounted, not the CC1101 poll or its floating GDO0, not the local web
//     server, not the Cloud Function's latency (<1s, warm), and not the
//     board: a second D1 Mini reproduced it identically.
//
// Two measurement traps, recorded so nobody repeats them:
//   - ESP.getFreeContStack() is a high-water mark, not live headroom. It
//     reads 0 at the top of a perfectly healthy loop(). Measure live
//     headroom as (&local - g_pcont->stack), as the probe below does.
//   - Adding a diagnostic WiFi.hostByName() before connect() warms lwIP's
//     DNS cache and masks the real failure, making the bug look like it
//     lives in DNS resolution. It does not.
//
// Earlier ruled-out attempts (all reproduced the crash): Ticker-fed
// wdtFeed() during a blocking HTTPClient call, wdtDisable()/wdtEnable()
// bracketing, long-lived vs per-call WiFiClientSecure (long-lived was
// strictly worse), WiFi.mode(WIFI_STA), deferring mDNS/NTP/CC1101/local web
// server, and -DCONT_STACKSIZE=8192 (boot-loops this board — do not
// re-enable; the noinline fix makes it unnecessary anyway).
//
// The socket timeout below still matters: _run_until bounds itself with
// `oneShotMs loopTimeout(_timeout)`, i.e. by whatever setTimeout() was
// given. 2500ms keeps a genuinely slow handshake inside the ~3s watchdog
// window so it fails cleanly and is retried, instead of resetting the board.
constexpr unsigned long kMintSocketTimeoutMs = 2500;

// Separate, longer budget for waiting on the response body. That loop is
// ours (see below) and feeds the watchdog explicitly, so it may exceed 3s.
constexpr unsigned long kMintResponseTimeoutMs = 15000;
constexpr uint16_t kMintPort = 443;

// Parses "https://host/path" into host + path. mintTokenUrl_ is always
// https (Cloud Functions), so the scheme and port are fixed rather than
// parsed.
bool splitUrl(const String& url, String* host, String* path) {
  const char* kScheme = "https://";
  if (!url.startsWith(kScheme)) return false;
  int hostStart = strlen(kScheme);
  int pathStart = url.indexOf('/', hostStart);
  if (pathStart < 0) {
    *host = url.substring(hostStart);
    *path = "/";
  } else {
    *host = url.substring(hostStart, pathStart);
    *path = url.substring(pathStart);
  }
  return host->length() > 0;
}
}  // namespace

bool CloudClient::mintCustomToken() {
  // A request fired the instant WiFi.status() first reports WL_CONNECTED
  // can hit a still-settling radio/stack; re-check and give it a brief
  // moment if the link isn't stable right now.
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }
  // 500ms (not 200) to match spike_mint/main.cpp's post-WiFi settle delay
  // exactly — one fewer variable when comparing the two builds' timings.
  delay(500);

  String host, path;
  if (!splitUrl(mintTokenUrl_, &host, &path)) return false;

  // DIAGNOSTIC (temporary): mirrors spike_mint's logPhase() timing so this
  // path can be compared directly against the spike's measured numbers on
  // the same board. Reference run (spike, this hardware/network):
  //   connect() returned OK   +1488ms
  //   response first byte     +2906ms
  // The ~3s Soft WDT budget therefore has ~1.5s of margin in the spike, so
  // a crash inside connect() here means something in this build makes the
  // same call block longer — not that the handshake is inherently too slow.
  unsigned long tMintStart = millis();

  // Stack-local, freshly constructed every call, connecting by name —
  // identical to spike_mint/'s working implementation. Long-lived variants
  // (a plain member, and a lazily-new'd pointer) were both tried and were
  // strictly worse: they broke even the first mint attempt.
  WiFiClientSecure client;
  client.setInsecure();  // TODO(hardware bring-up): pin the mintDeviceToken
                          // host's cert instead of setInsecure() before
                          // shipping past the bring-up phase.
  // MEASURED CAUSE of the long-standing mint hang: this device build has
  // ~21.7KB of contiguous heap at this point vs spike_mint's ~36.2KB (both
  // at 1% fragmentation) — a ~14.4KB deficit from larger statics plus the
  // already-running local web server. At 2048/2048 BearSSL's handshake
  // allocation does not fit, connect() never progresses, so _run_until spins
  // without yielding and the watchdog fires. Note a SLOW handshake is not
  // itself fatal: the spike was measured completing one in 4093ms, well past
  // the ~3s window, without a reset — BearSSL yields fine while it is making
  // progress. 1024/1024 fits the available block. See setBufferSizes() in
  // the BearSSL docs: 1024 receive is below the 16KB TLS record maximum, so
  // it requires the server to honour the max_fragment_length extension.
  // Reverted to 2048/2048 (spike_mint's value): 1024/1024 was tested on
  // hardware and did NOT prevent the hang, so the handshake buffer size is
  // not the binding constraint. Keeping the spike's value holds this
  // variable fixed while the heap-headroom question is settled.
  //
  // ESP32: setBufferSizes() does not exist (mbedTLS, not BearSSL) and the
  // tuning is moot — the whole paragraph above describes fitting a handshake
  // into a ~21KB heap, which is not a constraint with 320KB SRAM + 8MB PSRAM.
#if PLATFORM_HAS_SET_BUFFER_SIZES
  client.setBufferSizes(2048, 2048);
#endif
  client.setTimeout(kMintSocketTimeoutMs);

  // Guard against regressing the cont-stack bug fixed in main.cpp: loop()
  // runs on a 4KB cont stack and BearSSL's handshake is the deepest consumer
  // in the firmware. Measured on hardware: 3504 bytes here -> connects;
  // 992 bytes (when loop() inlined its big helpers into one frame) -> the
  // handshake cannot proceed, never yields, and the watchdog resets the
  // board. If this number drops toward ~1KB again, that is the cause.
  {
#if PLATFORM_HAS_CONT_STACK
    char stackMarker;
    extern cont_t* g_pcont;
    Serial.printf("mint: heap=%u maxblock=%u contStack=%ld\n",
                  ESP.getFreeHeap(), ESP.getMaxFreeBlockSize(),
                  (long)((ptrdiff_t)(&stackMarker) - (ptrdiff_t)(g_pcont->stack)));
#else
    // No cont stack on ESP32 — loop() is a FreeRTOS task with an 8KB+ stack.
    Serial.printf("mint: heap=%u maxblock=%u\n", ESP.getFreeHeap(),
                  platformMaxAllocHeap());
#endif
  }
  Serial.printf("[%8lu] about to TCP+TLS connect (+%lums)\n", millis(),
                millis() - tMintStart);
  unsigned long tConnectStart = millis();
  bool connected = client.connect(host.c_str(), kMintPort);
  Serial.printf("[%8lu] connect() returned %s (+%lums)\n", millis(),
                connected ? "OK" : "FAIL", millis() - tConnectStart);
  if (!connected) {
    Serial.println("mint: connect failed");
    return false;
  }

  StaticJsonDocument<128> reqDoc;
  reqDoc["apiKey"] = deviceApiKey_;
  String reqBody;
  serializeJson(reqDoc, reqBody);

  String req = String("POST ") + path + " HTTP/1.1\r\n" +
               "Host: " + host + "\r\n" +
               "Content-Type: application/json\r\n" +
               "Content-Length: " + reqBody.length() + "\r\n" +
               "Connection: close\r\n\r\n" + reqBody;
  client.print(req);

  // HTTPClient's own blocking response-read loop gave calling code no
  // opportunity to feed the watchdog during the wait for a response, which
  // is what actually tripped the Soft WDT reset (not the TLS handshake —
  // see the note above). Feeding manually here, in a short poll loop with
  // control returning to the caller between iterations, is what fixed it.
  unsigned long waitStart = millis();
  while (client.connected() && !client.available()) {
    platformFeedWatchdog();
    delay(10);
    if (millis() - waitStart > kMintResponseTimeoutMs) {
      Serial.printf("[%8lu] response wait: TIMED OUT (+%lums)\n", millis(),
                    millis() - waitStart);
      client.stop();
      return false;
    }
  }
  Serial.printf("[%8lu] response first byte (+%lums)\n", millis(),
                millis() - waitStart);

  // Bounded and watchdog-fed, like the wait loop above. available() going
  // 0 is NOT a reliable terminator mid-response: a body arriving in TLS
  // records with a gap between them can momentarily read 0 while the peer is
  // still sending, and conversely a half-closed socket can keep this loop
  // alive. Unbounded and unfed, either shape stalls loop() until the
  // watchdog fires.
  //
  // Reserved up front rather than grown one char at a time: the response is
  // ~957 bytes and `response += char` reallocates repeatedly, which both
  // wastes time here and fragments the heap the TLS client is about to need.
  String response;
  response.reserve(1280);
  unsigned long readStart = millis();
  while (client.connected() || client.available()) {
    while (client.available()) {
      response += (char)client.read();
    }
    // Whole body already in hand — stop before the timeout rather than
    // waiting for the peer to drop a Connection: close socket.
    if (response.indexOf("\r\n\r\n") >= 0) break;
    platformFeedWatchdog();
    delay(1);
    if (millis() - readStart > kMintResponseTimeoutMs) {
      Serial.printf("[%8lu] response read: TIMED OUT (+%lums, %u bytes)\n",
                    millis(), millis() - readStart, response.length());
      client.stop();
      return false;
    }
  }
  client.stop();

  int bodyStart = response.indexOf("\r\n\r\n");
  if (bodyStart < 0) {
    Serial.println("mint: malformed response (no header/body split)");
    return false;
  }
  int statusLineEnd = response.indexOf("\r\n");
  // Status line is "HTTP/1.x NNN ...": the code starts right after the
  // first space, regardless of HTTP version.
  int codeStart = response.indexOf(' ') + 1;
  if (codeStart <= 0 || codeStart >= statusLineEnd ||
      !response.substring(codeStart, codeStart + 3).equals("200")) {
    Serial.printf("mint: HTTP status not 200: %s\n",
                  response.substring(0, statusLineEnd).c_str());
    return false;
  }

  // Parse in place, off the stack. A StaticJsonDocument<2048> here is a 2KB
  // STACK object, and mintCustomToken() runs from loop() with ~3.4KB of cont
  // stack total — it does not fit alongside BearSSL's frames, and taking a
  // separate substring() copy of the ~957-byte body wastes heap too.
  // JsonDocument (ArduinoJson 7) allocates on the heap, where there is ~21KB
  // free at this point. deserializeJson() stops cleanly at the end of the
  // JSON object, so pointing it at the body offset needs no copy.
  JsonDocument respDoc;  // custom tokens are long signed JWTs (~890 bytes)
  DeserializationError err =
      deserializeJson(respDoc, response.c_str() + bodyStart + 4);
  if (err) {
    Serial.printf("mint: JSON parse failed: %s\n", err.c_str());
    return false;
  }

  customTokenJwt_ = respDoc["customToken"].as<String>();
  projectId_ = respDoc["projectId"].as<String>();
  if (customTokenJwt_.length() == 0 || projectId_.length() == 0) {
    Serial.println("mint: response missing customToken/projectId");
    return false;
  }
  Serial.printf("mint OK: projectId=%s tokenLen=%u\n", projectId_.c_str(),
                customTokenJwt_.length());
  return true;
}

void CloudClient::startAppAndStreams() {
  // TODO(hardware bring-up): confirm the exact RTDB base URL format
  // FirebaseClient expects (with or without trailing slash, project-scoped
  // vs full DB) against the library's Set/Get examples once building for
  // real hardware against a real project.
  // Allocate the long-lived SSL/async clients now — after the mint's TLS
  // handshake has completed and released its buffers. See their
  // declarations in cloud_client.h for why they are not plain members.
  // FirebaseApp owns the auth client and needs it for token refresh.
  //
  // (This comment used to claim the DATA client is created per operation and
  // destroyed immediately after. That is no longer true and was left stale:
  // closeDataClient() is an empty no-op and the data client is kept for the
  // life of the program, because destroying it caused an Exception 29 reset.
  // See openDataClient()'s comment for the measurements.)
  //
  // Guarded because this function runs a SECOND time after forceReauth():
  // allocating unconditionally would `new` straight over the live pointers,
  // leaking ~7KB of TLS buffers per recovery on a device that is expected to
  // run for months. The clients are stateless enough to re-initializeApp()
  // against, and deleting them is not an option (see forceReauth()).
  if (!authSslClient_) authSslClient_ = new SslClientWithDns();
  if (!authClient_) authClient_ = new AsyncClient(*authSslClient_);

  CustomToken customToken(firebaseWebApiKey_, customTokenJwt_.c_str(), 3000);
  initializeApp(*authClient_, app_, getAuth(customToken));

  app_.getApp<RealtimeDatabase>(database_);
  database_.url(databaseUrl_);

  // TODO(hardware bring-up): setInsecure() skips TLS cert validation on all
  // four connections below. Replace with proper cert pinning (FirebaseClient
  // supports setCACert() per its SSL client examples) before this leaves the
  // bring-up/testing phase, since these connections carry the device's auth
  // token.
  authSslClient_->setInsecure();
  // Same 120s-handshake trap as the data client — see openDataClient(). This
  // one matters too: FirebaseApp reconnects this socket on every token
  // refresh (~hourly), and app_.loop() is called from OUR loop(), so a stalled
  // refresh handshake blocks the same task the watchdog is watching.
  authSslClient_->setHandshakeTimeout(kHandshakeTimeoutSec);
  authSslClient_->setTimeout(kSocketTimeoutSec);
  // 1024-byte buffers: below the 16KB TLS record maximum, so this relies on
  // the server honouring the max_fragment_length extension (Google's
  // frontends do). The mint itself still uses 2048/2048 since it runs
  // before this exists. ESP32: no such API (mbedTLS) and not needed.
#if PLATFORM_HAS_SET_BUFFER_SIZES
  authSslClient_->setBufferSizes(1024, 1024);
#endif

  Serial.printf("cloud: app started (heap %u maxblock %u)\n",
                ESP.getFreeHeap(), platformMaxAllocHeap());

  // No SSE subscription here. Two persistent streams meant two more
  // simultaneous TLS connections, which is exactly what would not fit;
  // loop() polls /config and /commands on the single shared data client
  // instead. See the class's SSL-client declarations for the measurements.
  lastPollMs_ = millis();
}

bool CloudClient::begin(const String& mintTokenUrl, const String& databaseUrl,
                         const String& firebaseWebApiKey, const String& deviceApiKey) {
  mintTokenUrl_ = mintTokenUrl;
  databaseUrl_ = databaseUrl;
  firebaseWebApiKey_ = firebaseWebApiKey;
  deviceApiKey_ = deviceApiKey;

  // Only stores config. The initial mint is done by beginInitialConnect(),
  // which main.cpp calls from setup() before the local web server starts —
  // see beginInitialConnect()'s declaration for why that ordering matters.
  // mintAttempted_ = false leaves loop()'s retry-gate armed to fire on its
  // first check, so if the initial connect fails the retry happens promptly
  // rather than after a full 30s backoff.
  mintAttempted_ = false;
  return true;
}

bool CloudClient::beginInitialConnect() {
  mintAttempted_ = true;
  lastMintAttemptMs_ = millis();

  if (!mintCustomToken()) {
    mintFailureCount_++;
    Serial.printf("Mint failed (attempt %u) — will retry from loop()\n",
                  mintFailureCount_);
    return false;
  }

  tokenMinted_ = true;
  startAppAndStreams();
  return true;
}

// Tear the auth session down far enough that loop()'s existing mint-retry
// path can rebuild it from scratch.
//
// What is deliberately NOT done here: deleting authSslClient_/authClient_.
// FirebaseApp::loop() walks a global client vector by address, and freeing
// clients out from under it produced an Exception 29 (StoreProhibited)
// reset — see openDataClient()'s comment for the full measurement. That
// hazard is exactly as real on this path, and a recovery routine that
// crashes the board is worse than the hang it is recovering from. The
// clients are reusable, so they are kept and handed to initializeApp()
// again by startAppAndStreams().
//
// deinitializeApp() only clears the token/auth state and resets the event
// flags (verified by reading FirebaseApp.h:676) — it does not touch the
// client vector or sData, so it is safe to call here and re-initialize
// afterwards on the same object.
void CloudClient::forceReauth() {
  deinitializeApp(app_);

  // Back to square one, which re-arms the retry block at the top of loop().
  tokenMinted_ = false;
  appReady_ = false;
  customTokenJwt_ = String();

  // mintAttempted_ = false makes the retry fire on the NEXT iteration rather
  // than waiting out a backoff: the supervisor already burned 15 minutes of
  // silence deciding this was necessary, so there is nothing left to be
  // polite about.
  mintAttempted_ = false;
  // Not reset: mintFailureCount_. If the mint endpoint is genuinely
  // unreachable, the existing 3s->30s backoff should stay backed off rather
  // than restarting fast every time the supervisor re-fires.

  // The data client is deliberately left in place too, for the SAME reason
  // as the auth client. It looks tempting to drop it here — its TLS session
  // was authenticated with the token we just discarded — but closeDataClient()
  // is an empty no-op precisely because deleting this object crashed the
  // board (Exception 29 / StoreProhibited on the second event, at 11,424
  // bytes free, so never a memory shortage). It is created once and kept for
  // the life of the program.
  //
  // Not dropping it is also harmless: RTDB auth is carried per REQUEST as a
  // query parameter from app_'s current token, not pinned to the TCP
  // session, so the existing connection starts sending the NEW token as soon
  // as the re-mint completes.
}

void CloudClient::loop(bool sirenActive) {
  if (!tokenMinted_) {
    // Retry-with-backoff: this is also where the FIRST mint attempt
    // happens (begin() only stores config; see its comment). Retry
    // infrequently (30s+) so this network call never floods loop() or
    // gates CC1101 polling/alarm evaluation, which run earlier in
    // main.cpp's loop() regardless of cloud state.
    // Retry quickly for the first few attempts, then back off. The 2500ms
    // handshake cap means a slow-but-recoverable TLS negotiation now fails
    // cleanly rather than resetting the board, and retrying promptly costs
    // little — a fresh handshake often succeeds where one attempt did not.
    unsigned long now = millis();
    unsigned long backoffMs = (mintFailureCount_ < 5) ? 3000UL : 30000UL;
    if (!mintAttempted_ || now - lastMintAttemptMs_ >= backoffMs) {
      // beginInitialConnect() sets mintAttempted_/lastMintAttemptMs_ itself.
      // This is the ONLY caller — the mint must run on loop()'s cont stack
      // so BearSSL's handshake wait can yield; see its declaration.
      // Tag finely: mint is a TLS handshake + token exchange, one of the two
      // watchdog-blind stretches in this function (see the get() below). If a
      // stall dumps here it names 'cloud:mint', not the generic 'cloud'.
      stallMonitorPhase("cloud:mint");
      beginInitialConnect();
      stallMonitorPhase("cloud");
    }
    return;
  }

  // app_.loop() drives the auth state machine and any in-flight refresh; it
  // does TLS and yields via sys_idle() without feeding the TWDT. Tag it so a
  // stall here reads 'cloud:app' rather than the generic 'cloud'.
  stallMonitorPhase("cloud:app");
  app_.loop();
  stallMonitorPhase("cloud");
  bool nowReady = app_.ready();
  if (nowReady != appReady_) {
    Serial.printf("cloud: app.ready() -> %s (heap %u)\n",
                  nowReady ? "true" : "false", ESP.getFreeHeap());
  }
  // Allocate the data client the moment auth completes, while the heap still
  // has a large contiguous block (~15KB free / low fragmentation here, vs
  // ~3.5KB largest block a few polls later). Deferring it to first use meant
  // competing with an already-fragmented heap and losing.
  if (nowReady && !appReady_ && !dataClient_) {
    if (openDataClient()) {
      Serial.printf("cloud: data client ready (maxblock %u)\n",
                    platformMaxAllocHeap());
    } else {
      Serial.println("cloud: data client alloc FAILED at auth time");
    }
  }
  appReady_ = nowReady;

  // Fed BEFORE the log below reads notReadyForMs(), otherwise the first line
  // of every outage reports 0s — the supervisor would not yet have recorded
  // when the outage started.
  authSupervisor_.noteReady(appReady_, (uint32_t)millis());

  // Make the silent window audible. reportHeartbeat() only prints while
  // isReady(), i.e. exactly when nothing is wrong — during the outage this
  // fix exists for, the serial console went completely quiet and there was
  // no way to tell a dead auth session from a dead board. Print a countdown
  // instead, rate-limited to once a minute so it traces the outage without
  // flooding a console being used for anything else.
  if (!appReady_) {
    unsigned long now = millis();
    if (lastNotReadyLogMs_ == 0 || now - lastNotReadyLogMs_ >= 60000UL) {
      lastNotReadyLogMs_ = now;
      Serial.printf("cloud: NOT ready for %lus (re-mint at %lus, wifi %s)\n",
                    (unsigned long)(authSupervisor_.notReadyForMs(now) / 1000),
                    (unsigned long)(kReauthGraceMs / 1000),
                    WiFi.status() == WL_CONNECTED ? "up" : "DOWN");
    }
  } else {
    lastNotReadyLogMs_ = 0;
  }

  // Watch for an auth session that has died and will not come back.
  //
  // THE BUG THIS FIXES: tokenMinted_ used to be a one-way latch. Once the
  // first mint succeeded it was never cleared, so the retry block at the top
  // of this function — guarded by `if (!tokenMinted_)` — could never run
  // again. If ready() went false for good (custom token expired, refresh
  // rejected, TLS session lost), the `return` below fired every iteration
  // forever: no heartbeat, no events, no alarm reporting, and no recovery
  // short of a power cycle.
  //
  // The task watchdog cannot catch this. It watches for a BLOCKED loopTask,
  // and this failure leaves loopTask perfectly healthy — feeding the
  // watchdog, decoding RF, serving the LAN UI, silently cloud-dead. Observed
  // in the field as 28h and 31.76h silences, and caught live on 2026-09-04
  // after 10.6h of uptime with the watchdog never firing.
  //
  // The alarm itself is unaffected while this happens (rules and siren are
  // local by design), but the premises are unmonitored REMOTELY, and the
  // offline alert is the only thing that would have told anyone.
  if (authSupervisor_.shouldForceReauth((uint32_t)millis(),
                                        WiFi.status() == WL_CONNECTED)) {
    Serial.printf("cloud: auth dead for %lus — forcing re-mint (heap %u)\n",
                  (unsigned long)(authSupervisor_.notReadyForMs(millis()) / 1000),
                  ESP.getFreeHeap());
    forceReauth();
    return;  // next iteration takes the !tokenMinted_ path and re-mints
  }

  if (!appReady_) return;  // still authenticating

  // Poll /config and /commands alternately on the single shared data client.
  // Only one request is ever in flight, which is the whole point: two
  // persistent SSE streams needed two more concurrent TLS connections and
  // exhausted the heap. Polling trades push-latency (up to 2x
  // kPollIntervalMs) for fitting in RAM.
  unsigned long now = millis();
  if (now - lastPollMs_ < (sirenActive ? kPollIntervalAlarmMs : kPollIntervalMs)) return;
  lastPollMs_ = now;

  // Paths are namespaced per project — see CLAUDE.md's Firebase Data Layout
  // and the design spec's canonical /{projectId}/... paths.
  pollConfigNext_ = !pollConfigNext_;
  String path = String("/") + projectId_ +
                (pollConfigNext_ ? "/config" : "/commands");

  if (!openDataClient()) {
    Serial.println("cloud: poll skipped — not enough heap for a TLS client");
    return;
  }
  // The synchronous poll read. THIS is where the 2026-09-06 hang was caught:
  // the TLS socket died mid-read (-76 NET_RECV_FAILED) and get() spun in a
  // sys_idle() wait to the 60s TWDT. IoDeadline in SslClientWithDns now bounds
  // it (12s), but tag it too so a recurrence names the exact op — and which
  // path — instead of the coarse 'cloud' the first capture showed.
  stallMonitorPhase(pollConfigNext_ ? "cloud:poll-config" : "cloud:poll-commands");
  String json = database_.get<String>(*dataClient_, path);
  stallMonitorPhase("cloud");
  bool failed = dataResult_.isError() && dataResult_.error().code() != 0;
  if (failed) {
    Serial.printf("cloud: poll %s error %d: %s\n", path.c_str(),
                  dataResult_.error().code(),
                  dataResult_.error().message().c_str());
  }
  closeDataClient();
  if (failed || json.length() == 0 || json == "null") return;

  if (pollConfigNext_) {
    applyConfigJson(json);
  } else {
    applyCommandsJson(json);
  }
}

// Lazily creates the data client on first use, then keeps it for the life
// of the program. It is NOT destroyed between operations.
//
// Destroying it crashes the board. FirebaseApp::loop() walks a global client
// vector by address (cvec_address_list -> staticLoop) that RealtimeDatabase
// populated when the request was issued; ~AsyncClientClass deregisters via
// addRemoveClientVec(). Deleting after a request left that walk touching
// freed memory, producing an Exception 29 (StoreProhibited) reset on the
// SECOND event — after the first had already written to RTDB successfully.
// Calling stopAsync(true) and draining app_.loop() before the delete did not
// make it safe either (verified on hardware: still crashed at 11,424 bytes
// free, so this was never a memory shortage).
//
// Keeping it alive costs ~7KB of steady-state heap.
//
// The headroom check applies to REUSE as well as creation. An earlier
// version returned early when the client already existed, on the assumption
// that an established connection needs no further allocation. That is
// wrong: observed on hardware, a write attempted at 2760 bytes contiguous
// returned failure (silently, because the bool was discarded) and the event
// never reached RTDB. FirebaseClient still allocates request/response
// buffers per operation, and TLS may renegotiate.
//
// Lazy rather than created in startAppAndStreams() so the mint's own
// handshake still gets maximum headroom.
bool CloudClient::openDataClient() {
  // Reuse is the normal path and must NOT be gated on free heap: once the
  // client exists its buffers are already allocated, so a low
  // maxFreeBlockSize says nothing about whether this operation can proceed.
  // Gating it here is what wedged the device — every poll and every event
  // was skipped at ~4KB contiguous while 10KB was free but fragmented.
  if (dataClient_) return true;

  // Only the FIRST allocation needs headroom.
  if (platformMaxAllocHeap() < kMinBlockForWrite) return false;

  dataSslClient_ = new SslClientWithDns();
  if (!dataSslClient_) return false;
  dataSslClient_->setInsecure();
  // THE WATCHDOG-REBOOT FIX. Both of these default far above the watchdog
  // budget, and neither is covered by setSyncReadTimeout/setSyncSendTimeout —
  // those bound reads and writes on an ESTABLISHED socket, not the connect
  // that precedes them.
  //
  //   handshake_timeout defaults to 120000 ms — DOUBLE kWatchdogTimeoutSec.
  //   _timeout          defaults to  30000 ms.
  //
  // ssl_client.cpp's handshake loop spins on `vTaskDelay(2)` until
  // handshake_timeout expires. vTaskDelay yields to FreeRTOS but does NOT
  // reset the TWDT — the same trap as FirebaseClient's sys_idle()/delay(0)
  // documented on kSyncTimeoutSec. So a TLS handshake to a silent or
  // packet-dropping peer blocks loop() for up to two minutes with nothing
  // feeding the watchdog, and the board reboots at 60s with reason=twdt.
  //
  // Observed on hardware 2026-09-04: two twdt reboots 45 minutes apart, on a
  // build that already had the sync-read/write timeouts capped at 5s.
  //
  // NOTE the units differ, which is an easy way to get this wrong:
  // setHandshakeTimeout() takes SECONDS, setTimeout() takes SECONDS on
  // ESP32 (it stores seconds * 1000 internally).
  dataSslClient_->setHandshakeTimeout(kHandshakeTimeoutSec);
  dataSslClient_->setTimeout(kSocketTimeoutSec);
#if PLATFORM_HAS_SET_BUFFER_SIZES
  dataSslClient_->setBufferSizes(1024, 1024);
#endif
  dataClient_ = new AsyncClient(*dataSslClient_);
  if (!dataClient_) {
    delete dataSslClient_;
    dataSslClient_ = nullptr;
    return false;
  }
  // MUST be set here, on the one and only client, before any operation runs.
  // Without these the library falls back to its own 30s socket timeouts,
  // which equals the watchdog budget — see kSyncTimeoutSec for the full
  // reasoning. This is the fix for the intermittent "device gets stuck".
  dataClient_->setSyncReadTimeout(kSyncTimeoutSec);
  dataClient_->setSyncSendTimeout(kSyncTimeoutSec);
  return true;
}

// Deliberately does NOTHING. Both alternatives were measured and are worse.
//
// Destroying the client crashes the board: FirebaseApp::loop() walks a
// global client vector by address, so a freed AsyncClientClass leaves a
// dangling entry (Exception 29 after an otherwise successful write).
//
// Calling dataSslClient_->stop() between operations does free BearSSL's
// buffers (stop() -> _freeSSL()), but reconnecting re-allocates them from a
// heap that other subsystems have meanwhile carved up. umm_info showed the
// result: free space recovered to 10,648 bytes while the largest CONTIGUOUS
// block was only 3,472, with the fragmentation metric rising 32 -> 50 across
// a single close. Every later operation then failed the headroom check even
// though there was nominally plenty of heap.
//
// Holding one connection open keeps its buffers in place instead of
// re-cutting them out of a fragmenting heap on every poll.
void CloudClient::closeDataClient() {}

bool CloudClient::isReady() const {
  return tokenMinted_ && appReady_;
}

// Polling returns the whole /commands object ({"armed":bool,"siren":bool}),
// not the per-path events SSE delivered. Only report a command as pending
// when its value actually CHANGED, so re-polling the same value every few
// seconds doesn't re-apply (and re-persist to EEPROM) it forever.
void CloudClient::applyCommandsJson(const String& json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return;

  if (doc["armed"].is<bool>()) {
    bool v = doc["armed"].as<bool>();
    if (!hadArmedValue_ || v != lastArmedValue_) {
      hadArmedValue_ = true;
      lastArmedValue_ = v;
      pendingArmed_ = v;
      hasPendingArmed_ = true;
      Serial.printf("cloud: commands.armed -> %s\n", v ? "true" : "false");
    }
  }
  if (doc["siren"].is<bool>()) {
    bool v = doc["siren"].as<bool>();
    if (!hadSirenValue_) {
      // FIRST poll after boot. Adopt the value as the known state WITHOUT
      // acting on it.
      //
      // Acting on it caused an audible beep on every power-on: the siren is
      // already off at boot, but a stored "siren": false looked like a fresh
      // false and drove turnOff(), which transmits kCmdDisarm — and the siren
      // answers that with a short ack beep. There was nothing to turn off.
      //
      // A stored `true` is deliberately not honoured either: it means a siren
      // command was in flight when the device last died, and re-sounding the
      // siren because a board rebooted is far worse than missing a stale
      // command. A genuine false->true after this point still fires normally.
      hadSirenValue_ = true;
      lastSirenValue_ = v;
      Serial.printf("cloud: commands.siren = %s (adopted at boot, not applied)\n",
                    v ? "true" : "false");
    } else if (v != lastSirenValue_) {
      lastSirenValue_ = v;
      pendingSiren_ = v;
      hasPendingSiren_ = true;
      Serial.printf("cloud: commands.siren -> %s\n", v ? "true" : "false");
    }
  }
  if (doc["pair"]["n"].is<uint32_t>()) {
    uint32_t n = doc["pair"]["n"].as<uint32_t>();
    if (!hadPairNonce_ || n != lastPairNonce_) {
      hadPairNonce_ = true;
      lastPairNonce_ = n;
      pendingPairNonce_ = n;
      pendingPairUntil_ = doc["pair"]["until"].is<uint32_t>()
                              ? doc["pair"]["until"].as<uint32_t>()
                              : 0;
      hasPendingPair_ = true;
      Serial.printf("cloud: commands.pair -> nonce %lu until %lu\n",
                    (unsigned long)pendingPairNonce_,
                    (unsigned long)pendingPairUntil_);
    }
  }
}

void CloudClient::applyConfigJson(const String& json) {
  Config parsed;
  if (!ConfigParser::parseConfigJson(json.c_str(), &parsed)) {
    Serial.printf("cloud: config parse failed (%u bytes)\n", json.length());
    return;
  }
  // Same rationale as commands: only surface an actual change, so a
  // re-polled identical config doesn't rewrite EEPROM every few seconds.
  if (hadConfigValue_ && json == lastConfigJson_) return;
  hadConfigValue_ = true;
  lastConfigJson_ = json;
  pendingConfig_ = parsed;
  hasPendingConfig_ = true;
  Serial.printf("cloud: config updated (%u bytes, %u sensors)\n", json.length(),
                parsed.sensorCount);
  // Which sensors are actually armed is otherwise invisible from the device
  // side, and "armed but nothing fires" is indistinguishable from a broken
  // alarm path without it. Small and only printed on change.
  for (uint8_t i = 0; i < parsed.sensorCount; i++) {
    Serial.printf("cloud:   sensor[%u] family=%s conditions=%u\n", i,
                  parsed.sensors[i].familyId, parsed.sensors[i].conditionCount);
    for (uint8_t c = 0; c < parsed.sensors[i].conditionCount; c++) {
      const Condition& cond = parsed.sensors[i].conditions[c];
      Serial.printf("cloud:     cond[%u] t=%u n=%u w=%u y=%u kLen=%u\n", c,
                    cond.t, cond.n, cond.w, cond.y, cond.kLen);
    }
  }
}

bool CloudClient::consumeArmedCommand(bool* armed) {
  if (!hasPendingArmed_) return false;
  *armed = pendingArmed_;
  hasPendingArmed_ = false;
  return true;
}

bool CloudClient::consumeSirenCommand(bool* sirenOn) {
  if (!hasPendingSiren_) return false;
  *sirenOn = pendingSiren_;
  hasPendingSiren_ = false;
  return true;
}

bool CloudClient::consumeConfigUpdate(Config* config) {
  if (!hasPendingConfig_) return false;
  *config = pendingConfig_;
  hasPendingConfig_ = false;
  return true;
}

bool CloudClient::consumePairCommand(uint32_t* nonce, uint32_t* untilEpochSec) {
  if (!hasPendingPair_) return false;
  *nonce = pendingPairNonce_;
  *untilEpochSec = pendingPairUntil_;
  hasPendingPair_ = false;
  return true;
}

bool CloudClient::reportEvent(const char* rfId, const char* event, bool batteryLow, int rssi,
                              const char* value) {
  if (!isReady()) return false;  // no buffering v1 — drop if not connected/authed

  // Hard floor. BearSSL needs a ~3424-byte contiguous block for the
  // handshake this write triggers; attempting it with less does not fail
  // cleanly, it crashes the board (observed: Exception 29 StoreProhibited,
  // reset, at 5328 free / 4584 max block). Dropping the event is the
  // correct trade — "no event buffering v1" already accepts event loss, and
  // a lost event beats a reset that also drops the alarm state machine.
  if (!openDataClient()) {
    Serial.printf("cloud: reportEvent %s DROPPED — no data client (%u "
                  "contiguous bytes free)\n",
                  rfId, platformMaxAllocHeap());
    return false;
  }

  // KNOWN LIMITATION (ESP8266 heap fragmentation) — see the note at the top
  // of this file. A write needs a bigger contiguous block than the small
  // config/command polls do, and after the first TLS cycle the largest free
  // block settles at ~3.4KB even though ~10KB is free. Attempting the write
  // below that does not fail cleanly: it returns an error AND then resets
  // the board (Exception 29). Skipping keeps the alarm running — local
  // siren, EEPROM state and LAN control are unaffected; only the cloud copy
  // of this event is lost, which the "no event buffering v1" decision
  // already accepts.
  const uint32_t block = platformMaxAllocHeap();
  if (block < kMinBlockForEventWrite) {
    Serial.printf("cloud: reportEvent %s SKIPPED — %u contiguous bytes free, "
                  "need %u (heap fragmentation; see cloud_client.cpp)\n",
                  rfId, block, kMinBlockForEventWrite);
    return false;
  }
  Serial.printf("cloud: reportEvent %s (heap %u maxblock %u)\n", rfId,
                ESP.getFreeHeap(), block);

  JsonDocument doc;
  doc["event"] = event;
  doc["battery_low"] = batteryLow;
  doc["rssi"] = rssi;
  if (value != nullptr) doc["value"] = value;
  String json;
  serializeJson(doc, json);

  // Event key must be epoch milliseconds (wall-clock), not millis() uptime —
  // onSensorEvent.ts does Timestamp.fromMillis(Number(timestamp)) and uses
  // it for sensor lastSeen/ordering. time(nullptr) reflects NTP sync
  // started in main.cpp's onNormalOperation(); if NTP hasn't completed yet
  // this is briefly epoch-adjacent rather than blocking on it (see NTP sync
  // note in main.cpp).
  uint64_t nowMs = (uint64_t)time(nullptr) * 1000ULL;
  char tsBuf[21];  // uint64 max is 20 digits + null
  snprintf(tsBuf, sizeof(tsBuf), "%llu", (unsigned long long)nowMs);
  String path = String("/") + projectId_ + "/events/" + rfId + "/" + tsBuf;
  object_t payload(json.c_str());
  // Shares the one data client with config/command polling. Both are driven
  // from loop() (polling here, this via main.cpp's handleSensorEvent), so
  // they never overlap.
  // The bool return was previously discarded, so a FAILED write still
  // printed "done" — the device looked healthy while events silently never
  // reached RTDB. Always report the real outcome.
  bool ok = database_.set<object_t>(*dataClient_, path, payload);
  if (!ok) {
    int code = dataResult_.error().code();
    Serial.printf("cloud: reportEvent %s FAILED (code %d: %s) heap=%u "
                  "maxblock=%u\n",
                  rfId, code, dataResult_.error().message().c_str(),
                  ESP.getFreeHeap(), platformMaxAllocHeap());
  } else {
    Serial.printf("cloud: reportEvent %s ok (heap %u)\n", rfId,
                  ESP.getFreeHeap());
  }
  closeDataClient();
  return ok;
}

void CloudClient::reportArmedState(bool armed, const char* source) {
  if (!isReady()) return;
  if (!openDataClient()) return;

  // Written FIRST so onDeviceArmStateChange, which triggers on state/armed
  // below, always finds the source already in place. Without it that
  // function cannot tell a remote disarm from a LAN one — and naming who
  // disarmed the house is the only mitigation a replayable fixed-code
  // remote has.
  if (source != nullptr) {
    String sourcePath = String("/") + projectId_ + "/state/armed_by";
    object_t sourcePayload(String("\"" + String(source) + "\"").c_str());
    database_.set<object_t>(*dataClient_, sourcePath, sourcePayload);
  }

  String path = String("/") + projectId_ + "/state/armed";
  object_t payload(armed ? "true" : "false");
  bool ok = database_.set<object_t>(*dataClient_, path, payload);
  Serial.printf("cloud: reportArmedState %s%s%s %s (code %d)\n",
                armed ? "true" : "false", source ? " by " : "",
                source ? source : "", ok ? "ok" : "FAILED",
                dataClient_->lastError().code());
}

void CloudClient::reportAlarm(const char* rfId, uint8_t conditionType) {
  if (!isReady()) return;
  if (!openDataClient()) {
    Serial.printf("cloud: reportAlarm %s DROPPED — no data client (%u "
                  "contiguous bytes free)\n",
                  rfId, platformMaxAllocHeap());
    return;
  }

  // Same wall-clock source as reportEvent — onAlarm compares `at` against
  // Date.now() and ignores a cause older than CAUSE_MAX_AGE_MS, so an
  // uptime value here would make every cause look stale.
  uint64_t nowMs = (uint64_t)time(nullptr) * 1000ULL;

  JsonDocument doc;
  doc["rfId"] = rfId;
  doc["ct"] = conditionType;
  doc["at"] = nowMs;
  String json;
  serializeJson(doc, json);

  String causePath = String("/") + projectId_ + "/state/alarm_cause";
  object_t causePayload(json.c_str());
  // The two set()s below are the double blocking write that first motivated
  // the DNS fix — the highest-stakes stall path, since a hang here reboots the
  // device mid-alarm. Tag so a stall names 'cloud:report-alarm', wherever in
  // loop() the trigger arrived from. Cleared to 'loop' at the end.
  stallMonitorPhase("cloud:report-alarm");
  bool causeOk = database_.set<object_t>(*dataClient_, causePath, causePayload);
  if (!causeOk) {
    // Non-fatal: onAlarm falls back to a generic "Alarm triggered!" message.
    // Sounding the alarm matters more than naming it, so we still continue.
    Serial.printf("cloud: reportAlarm cause FAILED (code %d) — siren_active "
                  "still being set\n",
                  dataClient_->lastError().code());
  }

  // Written second: onAlarm triggers on this edge and reads the cause above.
  String sirenPath = String("/") + projectId_ + "/state/siren_active";
  object_t sirenPayload("true");
  bool sirenOk = database_.set<object_t>(*dataClient_, sirenPath, sirenPayload);
  stallMonitorPhase("loop");
  Serial.printf("cloud: reportAlarm %s ct=%u %s (code %d)\n", rfId,
                (unsigned)conditionType, sirenOk ? "ok" : "FAILED",
                dataClient_->lastError().code());
  closeDataClient();
}

void CloudClient::reportAlarmLabel(const char* label) {
  if (!isReady()) return;
  if (!openDataClient()) {
    Serial.printf("cloud: reportAlarmLabel %s DROPPED — no data client (%u "
                  "contiguous bytes free)\n",
                  label, platformMaxAllocHeap());
    return;
  }

  // Same wall-clock source as reportAlarm — onAlarm ignores a cause older
  // than CAUSE_MAX_AGE_MS, so an uptime value here would look stale.
  uint64_t nowMs = (uint64_t)time(nullptr) * 1000ULL;

  // {label, at} rather than {rfId, ct, at}: alarmCause.ts takes a
  // server-written label outright, so this names the SOS directly instead
  // of mapping a nonexistent sensor.
  JsonDocument doc;
  doc["label"] = label;
  doc["at"] = nowMs;
  doc["side"] = "device";
  String json;
  serializeJson(doc, json);

  String causePath = String("/") + projectId_ + "/state/alarm_cause";
  object_t causePayload(json.c_str());
  bool causeOk = database_.set<object_t>(*dataClient_, causePath, causePayload);
  if (!causeOk) {
    // Non-fatal, same as reportAlarm: sounding the alarm matters more than
    // naming it.
    Serial.printf("cloud: reportAlarmLabel cause FAILED (code %d) — "
                  "siren_active still being set\n",
                  dataClient_->lastError().code());
  }

  // Written second: onAlarm triggers on this edge and reads the cause above.
  String sirenPath = String("/") + projectId_ + "/state/siren_active";
  object_t sirenPayload("true");
  bool sirenOk = database_.set<object_t>(*dataClient_, sirenPath, sirenPayload);
  Serial.printf("cloud: reportAlarmLabel %s %s (code %d)\n", label,
                sirenOk ? "ok" : "FAILED", dataClient_->lastError().code());
  closeDataClient();
}

void CloudClient::clearAlarm() {
  if (!isReady()) return;
  if (!openDataClient()) return;
  String path = String("/") + projectId_ + "/state/siren_active";
  object_t payload("false");
  bool ok = database_.set<object_t>(*dataClient_, path, payload);
  Serial.printf("cloud: clearAlarm %s (code %d)\n", ok ? "ok" : "FAILED",
                dataClient_->lastError().code());
}

void CloudClient::reportHeartbeat() {
  if (!isReady()) return;
  if (!openDataClient()) return;
  String path = String("/") + projectId_ + "/state/last_seen";
  char tsBuf[12];
  snprintf(tsBuf, sizeof(tsBuf), "%lu", (unsigned long)(millis() / 1000));
  object_t payload(tsBuf);
  bool ok = database_.set<object_t>(*dataClient_, path, payload);
  // Heap trend, not just the instant value. A slow leak is invisible in
  // getFreeHeap() sampled once, but shows clearly as minFree marching
  // downward across hours of heartbeats — and this device died after 9h16m
  // with no evidence either way, which is what made that death unexplainable.
  // Printed rather than written to RTDB: serial is free, and an extra RTDB
  // write every 10s is not.
  Serial.printf("cloud: heartbeat uptime=%s %s (code %d) heap=%u min=%u "
                "maxblock=%u\n",
                tsBuf, ok ? "ok" : "FAILED", dataClient_->lastError().code(),
                ESP.getFreeHeap(), platformMinFreeHeap(),
                platformMaxAllocHeap());
}

void CloudClient::reportBoot() {
  if (!isReady()) return;
  if (!openDataClient()) return;

  JsonDocument doc;
  doc["reason"] = platformResetReason();
  // Wall-clock, so this is comparable against event timestamps and against
  // Date.now() in the web UI. NTP may not have synced this early, in which
  // case it is epoch-adjacent — the reason string is the load-bearing part.
  doc["at"] = (uint64_t)time(nullptr) * 1000ULL;
  String json;
  serializeJson(doc, json);

  String path = String("/") + projectId_ + "/state/boot";
  object_t payload(json.c_str());
  bool ok = database_.set<object_t>(*dataClient_, path, payload);
  Serial.printf("cloud: reportBoot reason=%s %s (code %d)\n",
                platformResetReason(), ok ? "ok" : "FAILED",
                dataClient_->lastError().code());
}
