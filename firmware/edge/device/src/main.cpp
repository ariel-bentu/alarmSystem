#include <Arduino.h>
#include <time.h>

#include "platform_compat.h"

#include "alarm_state.h"
#include "cc1101_receiver.h"
#include "cloud_client.h"
#include "eeprom_store.h"
#include "local_web_server.h"
#include "provision_store.h"
#include "provisioning_portal.h"
#include "remote_control.h"
#include "siren_address.h"
#include "relay_siren.h"

#ifndef FIREBASE_WEB_API_KEY
#define FIREBASE_WEB_API_KEY "REPLACE_WITH_PROJECT_WEB_API_KEY"
#endif

namespace {
const uint8_t kForcePortalPin = 0;  // GPIO0 / FLASH button
const unsigned long kWifiConnectTimeoutMs = 15000;

ProvisionStore provisionStore;
ProvisioningPortal portal;
bool portalActive = false;

// Pin map. The two targets share no numbering, so keep them apart.
//
// ESP32-S3 (esp32-s3-devkitc-1, probed: quad SPI flash + embedded 8MB
// PSRAM). Pins avoided and why:
//   - GPIO26-32  : reserved for the SPI flash / PSRAM bus. Using them
//                  breaks the board in ways that look like random crashes.
//   - GPIO33-37  : left alone too. Free on a quad part, but taken by an
//                  octal PSRAM bus, and this module has embedded PSRAM
//                  whose wiring is not exposed — not worth the risk.
//   - GPIO0      : BOOT strapping pin, already used for kForcePortalPin.
//   - GPIO3,45,46: strapping (JTAG source / VDD_SPI / boot mode).
//   - GPIO19,20  : native USB D-/D+, which is our serial console.
//   - GPIO43,44  : UART0 TX/RX.
//   - GPIO35,36,37 on some N8R8 modules are consumed by PSRAM — see above.
//
// Hardware SPI (FSPI) defaults on this variant: SCK 12, MISO 13, MOSI 11.
// Those are wired to the CC1101 as SCK/SO/SI and are NOT configurable
// here — SPI.begin() claims them. Only CS and GDO0 are chosen below, from
// the safe low bank.
#if defined(ARDUINO_ARCH_ESP32)
const uint8_t kCc1101CsPin = 10;    // FSPI default SS
const uint8_t kCc1101Gdo0Pin = 4;   // any free digital input
const uint8_t kRelayPin = 5;        // free digital output
#else
const uint8_t kCc1101CsPin = 15;    // D8 — confirm against final wiring during hardware bring-up
const uint8_t kCc1101Gdo0Pin = 4;   // D2 — confirm against final wiring during hardware bring-up
const uint8_t kRelayPin = 5;        // D1 — confirm against final wiring during hardware bring-up
#endif

EepromStore eepromStore;
AlarmState alarmState;
Cc1101Receiver cc1101;
RelaySiren siren;
CloudClient cloudClient;
LocalWebServer localWebServer;

bool armed = false;
bool localWebEnabled = true;
Config config;

// Which input last changed the arm state, reported to state/armed_by so the
// Telegram alert can name it ("remote" vs "local" vs "cloud"). A fixed-code
// remote is replayable, so attribution is the only available mitigation —
// see the design doc's Security section.
const char* armedBySource = "cloud";

// Non-blocking remote pairing window; 0 = closed. Deliberately NOT modelled
// on runSirenPairing(), which blocks the loop for 10s and leaves the alarm
// deaf to sensors. Remote pairing is receive-only, so it needs no blocking
// at all: it is a deadline checked inside the packet path.
unsigned long remotePairUntilMs = 0;
constexpr unsigned long kRemotePairWindowMs = 30000UL;

// mDNS and configTime()'s SNTP setup are both deferred until the first
// mint attempt settles. Two theories motivated this originally (DNS
// contention, then heap headroom) and BOTH were wrong — the mint crash was
// cont-stack exhaustion, fixed by the noinline attributes above. Kept
// anyway: both allocate, and there is no reason to do that work before the
// device has authenticated. LAN arm/disarm-by-IP works from boot
// regardless, since the web server itself is unaffected.
bool mdnsStarted = false;
unsigned long normalOperationStartMs = 0;
constexpr unsigned long kDnsUsersStartFallbackMs = 60000UL;  // start anyway if cloud never comes up

// Reported once per boot, strictly after the cloud is actually ready (not
// merely "settled" — that fallback also fires if the cloud never comes up,
// in which case there is nothing to report to). A later Cloud Function
// reads this to show the address in the web UI. Kept out-of-line and
// gated by a bool so it costs nothing on the other ~thousands of loop()
// iterations per boot — see handleSensorEvent()'s note on why frame size
// in loop() matters on this hardware.
bool sirenAddressReported = false;
// True between reporting an alarm to the cloud and clearing state/siren_active
// again. See the falling-edge clear in loop().
bool alarmReportedToCloud = false;
unsigned long lastHeartbeatMs = 0;
static constexpr unsigned long kHeartbeatIntervalMs = 10000UL;

// Watchdog budget. Must exceed the longest LEGITIMATE blocking stretch in
// the firmware, or a healthy device reboots itself: connectToWifi() 15s,
// the mint response wait 15s, runSirenPairing() 10s. Those all call
// platformFeedWatchdog() as they go, so the real requirement is just that
// this comfortably exceeds one loop() iteration.
static constexpr uint32_t kWatchdogTimeoutSec = 30;

// Boot cause is reported once, after the cloud comes up. Same gating shape
// as sirenAddressReported — strictly isReady(), since there is nothing to
// report to otherwise.
bool bootReported = false;

// Steady-state WiFi supervision. setup() connects, but until now NOTHING
// re-checked the link afterwards: loop() trusted WiFi.setAutoReconnect(true)
// with no fallback, so a device whose auto-reconnect failed to re-associate
// stayed silently offline until a human noticed. The alarm itself keeps
// working (siren, EEPROM, LAN are all local), but remote arm/disarm and
// every cloud alert are gone, which is a large silent failure.
unsigned long lastWifiCheckMs = 0;
static constexpr unsigned long kWifiCheckIntervalMs = 30000UL;
// Grace period before intervening. WiFi.begin() is asynchronous and the SDK
// does its own reconnect attempts; reconnecting on the first missed check
// would fight it and could thrash the radio.
unsigned long wifiDownSinceMs = 0;
static constexpr unsigned long kWifiDownGraceMs = 120000UL;

// When to give up nudging and reboot. TWO HOURS, deliberately — this is NOT
// a "connectivity is broken, restart it" timer.
//
// An offline device still fully protects the premises: RF decode, rule
// evaluation, the siren and EEPROM arm state are all local and cloud-
// independent by design (see CLAUDE.md's Key Decisions). A router reboot,
// an ISP outage or a moved AP must NOT cost anything, and a reboot is
// strictly worse than staying up — every restart is a window in which no
// sensor is being watched at all, and a short timer during a long outage
// turns that into a loop.
//
// So the reboot exists only for the case a nudge cannot fix: a wedged radio
// or a driver stuck past any plausible outage. At 2h the local alarm has had
// every chance to keep working, and the one-off ~15s restart is a fair price
// for recovering a device that would otherwise stay offline indefinitely.
static constexpr unsigned long kWifiDownRebootMs = 2UL * 60UL * 60UL * 1000UL;

__attribute__((noinline))
void reportSirenAddressOnce() {
  char addrHex[9];
  snprintf(addrHex, sizeof(addrHex), "0x%06X", (unsigned int)config.sirenBaseAddress);
  cloudClient.reportEvent("SIREN0", "siren_address", false, 0, addrHex);
  sirenAddressReported = true;
}

void startMdnsIfNeeded() {
  if (mdnsStarted || !localWebEnabled) return;
  // Single DNS label, no embedded dot. The previous "local.alarm" advertised
  // as "local.alarm.local", which is not a valid one-label mDNS hostname —
  // macOS/Bonjour would not resolve it (verified: curl and ping both failed
  // while the device was serving fine on its IP).
  if (MDNS.begin("alarm")) {
    // Advertise the HTTP service too, not just the hostname: some clients
    // (and Bonjour browsers) discover via _http._tcp rather than resolving
    // the A record directly.
    MDNS.addService("http", "tcp", 80);
    Serial.println("mDNS responder started: http://alarm.local "
                    "(exact resolution depends on OS/browser mDNS support)");
  } else {
    Serial.println("mDNS responder failed to start — local web server "
                    "still reachable via IP");
  }
  mdnsStarted = true;
}

// Wall-clock sync for event timestamps (cloud_client.cpp's reportEvent()
// uses time(nullptr) for the RTDB event key so onSensorEvent.ts's
// Timestamp.fromMillis() reflects real time, not device uptime). Deferred
// alongside mDNS — see the note above for why that deferral is retained.
bool ntpStarted = false;

void startNtpSyncIfNeeded() {
  if (ntpStarted) return;
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  ntpStarted = true;
}

// Shared by the real CC1101 decode path (loop()) and LocalWebServer's
// simulate-trigger endpoint — both must exercise the exact same
// alarm-evaluation pipeline, not a duplicated shortcut.
//
// noinline is load-bearing on ESP8266, not a hint. (On ESP32 loop() is a
// normal FreeRTOS task with an 8KB+ stack, so it costs nothing there and is
// kept for a single code shape.) loop() runs on the 4KB cont stack
// and is entered with ~1568 bytes left. When GCC inlines helpers like this
// one into loop(), their locals (String temporaries, JSON buffers, a ~2.4KB
// Config) merge into loop()'s single frame, which is allocated in full on
// entry regardless of which branch actually runs. That left BearSSL's TLS
// handshake ~992 bytes and produced the long-standing Soft WDT reset.
// Keeping these out-of-line means each frame exists only while its call is
// on the stack, and the mint (called near the top of loop()) sees ~3.5KB.
// Measured: inlined 992 bytes -> crash; out-of-line 3504 bytes -> connects.
__attribute__((noinline))
void handleSensorEvent(const char* rfId, unsigned long now, bool batteryLow = false, int rssi = 0) {
  TriggerCause cause;
  bool shouldFire = alarmState.onSensorEvent(rfId, now, &cause);
  // "armed but nothing happened" is otherwise silent and indistinguishable
  // from a broken decode; one line per trigger makes the decision visible.
  Serial.printf("[alarm] %s armed=%d fire=%d sirenEnabled=%d\n", rfId,
                config.armed, shouldFire, config.sirenEnabled);
  if (shouldFire && config.sirenEnabled) {
    siren.turnOn(config.sirenDurationSec, now);
  }
  cloudClient.reportEvent(rfId, "trigger", batteryLow, rssi);
  // Reported whenever the alarm fires, NOT gated on sirenEnabled: turning the
  // siren off is a noise preference, not a "stop telling me about intrusions"
  // one. Gating both on it produced a silent alarm — no siren AND no Telegram
  // — which is precisely when the notification matters most.
  // Written after the event so the timeline entry exists before the alert.
  if (shouldFire) {
    cloudClient.reportAlarm(cause.rfId, cause.conditionType);
    alarmReportedToCloud = true;
  }
}

// Entry-delay expiry. Out-of-line and called from loop() so its TriggerCause
// never joins loop()'s single merged frame — see handleSensorEvent()'s note.
__attribute__((noinline))
void pollEntryDelay(unsigned long now) {
  TriggerCause cause;
  if (!alarmState.tickEntryDelay(now, &cause)) return;
  if (config.sirenEnabled) {
    siren.turnOn(config.sirenDurationSec, now);
  }
  // Not gated on sirenEnabled — see handleSensorEvent()'s note.
  cloudClient.reportAlarm(cause.rfId, cause.conditionType);
  alarmReportedToCloud = true;
}

// Shared by the cloud arm/disarm command path and LocalWebServer's
// arm/disarm endpoints — both must update state, alarm evaluation, siren,
// and EEPROM persistence identically.
// noinline for the cont-stack reason documented on handleSensorEvent().
__attribute__((noinline))
void applyArmedCommand(bool newArmed) {
  armed = newArmed;
  config.armed = armed;
  alarmState.setConfig(config);
  if (!armed) {
    alarmState.disarm();
    siren.turnOff();
  }
  eepromStore.save(armed, localWebEnabled, config);
  cloudClient.reportArmedState(armed, armedBySource);
  // Reset to the default so a stale source cannot mislabel the NEXT change:
  // callers that care (remote, local web) set it immediately before calling.
  armedBySource = "cloud";
}

// The CC1101 poll and the config-update handler both carry large locals
// (KeruiPacket + decoder buffers; a ~2.4KB Config). Held out-of-line so
// their frames never become part of loop()'s always-allocated frame — see
// handleSensorEvent()'s note for the full reasoning and measurements.
// Route a decoded packet that belongs to a paired remote. Returns true when
// the packet was consumed, so the caller must NOT fall through to the sensor
// path — a remote must never be able to trigger an alarm rule.
//
// noinline for the cont-stack reason documented on handleSensorEvent(): it
// touches the ~2.4KB Config, and that frame must not join loop()'s
// always-allocated one.
__attribute__((noinline))
bool handleRemotePacket(uint32_t code, unsigned long now) {
  uint32_t identity = remoteIdentityOf(code);
  if (!remoteIsPaired(config, identity)) return false;

  RemoteAction action = remoteActionFor(remoteNibbleOf(code));
  Serial.printf("[remote] 0x%05X button=0x%X action=%d\n", (unsigned)identity,
                remoteNibbleOf(code), (int)action);

  switch (action) {
    case RemoteAction::Arm:
      // Arms with whatever config is currently loaded. The remote does NOT
      // select a profile — see the design doc.
      armedBySource = "remote";
      applyArmedCommand(true);
      break;
    case RemoteAction::Disarm:
      armedBySource = "remote";
      applyArmedCommand(false);
      break;
    case RemoteAction::Sos:
      // Fires regardless of arm state — a panic button gated on armed is
      // useless. Still honours sirenEnabled, which is a noise preference.
      if (config.sirenEnabled) {
        siren.turnOn(config.sirenDurationSec, now);
      }
      cloudClient.reportAlarmLabel("SOS (remote)");
      alarmReportedToCloud = true;
      break;
    case RemoteAction::ArmHome:
      // "S" is decoded deliberately and does nothing, so an unmapped button
      // is visibly ignored rather than silently falling through to the
      // sensor path.
      Serial.println("[remote] arm-home (S) ignored");
      break;
    case RemoteAction::None:
      Serial.println("[remote] unrecognised button nibble, ignored");
      break;
  }
  return true;
}

__attribute__((noinline))
void pollCc1101(unsigned long now) {
  KeruiPacket packet;
  int rssi;
  if (!cc1101.poll(&packet, &rssi)) return;
  char rfIdHex[11];
  // Log every decoded packet so RF receive can be verified independently of
  // the cloud path (reportEvent may be skipped on low heap).
  Serial.printf("[cc1101] packet sensorId=0x%06X battery=%d rssi=%d\n",
                packet.sensorId, packet.batteryLow, rssi);
  // Before the sensor path: a paired remote is a CONTROL device, not a
  // trigger. Returning here keeps it out of handleSensorEvent entirely, so
  // it cannot satisfy an alarm rule or be written to /events as a trigger.
  if (handleRemotePacket(packet.sensorId, now)) return;
  // 0x-prefixed to match the format used everywhere else in the system
  // (Firestore sensor.rfId, buildConfig.ts, smoke scripts, web pairing UI
  // reading event keys) — see alarm_state.h's SensorConfig::rfId sizing.
  snprintf(rfIdHex, sizeof(rfIdHex), "0x%06X", packet.sensorId);
  handleSensorEvent(rfIdHex, now, packet.batteryLow, rssi);
}

__attribute__((noinline))
void applyPendingConfigUpdate() {
  Config newConfig;
  if (!cloudClient.consumeConfigUpdate(&newConfig)) return;
  newConfig.armed = armed;  // armed is tracked separately from config pushes
  // The siren address is device-owned and never sent by the cloud; preserve
  // it across a config push or the device forgets its pairing.
  newConfig.sirenBaseAddress = config.sirenBaseAddress;
  config = newConfig;
  alarmState.setConfig(config);
  eepromStore.save(armed, localWebEnabled, config);
}

// Loop the base address on air so a siren held in learn mode can bind it.
// Blocking and largely deaf to sensors throughout — acceptable because
// pairing is a deliberate, user-initiated act, and the web UI says so
// before the user starts.
//
// 10s, measured: a real pairing succeeded well inside this window (the
// siren answered with its two-beep acknowledgement), and at one burst per
// 300ms that is still ~33 transmissions — ample for a siren already in
// learn mode. The window was originally 60s, which was simply a guess; it
// is a direct cost, since the device serves no HTTP and hears no sensors
// while it runs, so it is kept only as long as it needs to be.
//
// noinline for the cont-stack reason documented on handleSensorEvent().
__attribute__((noinline))
void runSirenPairing() {
  const unsigned long kPairingWindowMs = 10000UL;
  Serial.printf("[siren] pairing: looping 0x%06lX for 10s — press SET on the siren\n",
                (unsigned long)config.sirenBaseAddress);
  const unsigned long start = millis();
  while (millis() - start < kPairingWindowMs) {
    cc1101.transmit(config.sirenBaseAddress | SirenAddress::kCmdArmHome, 6);
    delay(300);
    platformFeedWatchdog();
  }
  Serial.println("[siren] pairing window closed");
}

bool connectToWifi(const String& ssid, const String& password,
                    unsigned long timeoutMs) {
  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);
  // Shape only, never the secret: enough to tell "arrived intact" from
  // "truncated / empty / has stray whitespace from autofill", which are
  // indistinguishable from a plain association timeout.
  // Length alone cannot tell a correct 25-char password from a wrong one of
  // the same length, so add a cheap FNV-1a fingerprint plus first/last
  // characters. Not reversible, but enough to confirm the exact bytes that
  // reached the radio match what was typed: compute the same hash over the
  // intended string and compare.
  uint32_t fp = 2166136261u;
  for (size_t i = 0; i < password.length(); i++) {
    fp = (fp ^ (uint8_t)password[i]) * 16777619u;
  }
  Serial.printf("  ssid len=%u, password len=%u fp=%08X first='%c' last='%c'%s\n",
                ssid.length(), password.length(), fp,
                password.length() ? password[0] : '?',
                password.length() ? password[password.length() - 1] : '?',
                (password.length() > 0 &&
                 (password[0] == ' ' || password[password.length() - 1] == ' '))
                    ? " [WARNING: leading/trailing space]"
                    : "");
  // WiFi.mode() persists across reboots via the SDK's saved flash config, so
  // a device that previously ran the provisioning portal (WIFI_AP_STA) can
  // reboot straight into normal operation with the softAP radio still up.
  // Forcing WIFI_STA (as spike_mint/ does) guarantees a clean station-only
  // state and releases the softAP's memory. This did not by itself fix the
  // mint crash, but it is correct regardless.
  // Keep the AP up if the portal is serving. connectToWifi() is called from
  // two places: boot (no portal — plain STA is right) and the portal's save
  // handler. In the latter case forcing WIFI_STA tears the AP down for the
  // whole 15s attempt, so a user who just submitted the form sees the
  // network vanish under them and, on failure, has to rejoin to retry.
  // Staying in AP_STA keeps the portal reachable throughout.
  WiFi.mode(portalActive ? WIFI_AP_STA : WIFI_STA);

  // The ESP8266 build connected to this same network reliably with nothing
  // more than mode()+begin(), so the extra work below is ESP32-specific.
  //
  // The ESP32 caches WiFi config in NVS and reuses it on begin(). A stale or
  // half-written entry from an earlier failed attempt survives reboots and
  // reflashes (NVS is not touched by a firmware upload) and can keep
  // poisoning the association — which is consistent with the auth rejection
  // flipping between status=4 and status=6 on identical, correct
  // credentials. persistent(false) stops us writing new entries;
  // disconnect(true, true) clears the radio state and erases the stored one.
  //
  // setSleep(false) is separate: the ESP32's default power-save can make it
  // miss handshake frames, which presents as an auth failure rather than a
  // timeout.
  WiFi.persistent(false);
  // wifioff must stay false while the portal is serving, or the AP goes down
  // with the station and the user loses the page they just submitted.
  WiFi.disconnect(/*wifioff=*/!portalActive, /*eraseap=*/true);
  delay(200);
  if (portalActive) WiFi.mode(WIFI_AP_STA);  // restore if disconnect reset it
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  // The SDK knows exactly why an association was refused; WiFi.status() only
  // reports that it was. Reason 15 (4WAY_HANDSHAKE_TIMEOUT) means the PSK is
  // being rejected, 201 (NO_AP_FOUND) means the BSSID was never reachable,
  // and 2/8/3 point at the AP dropping us. Printing it turns this from
  // inference into the AP's own answer.
#if defined(ARDUINO_ARCH_ESP32)
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    uint8_t r = info.wifi_sta_disconnected.reason;
    const char* meaning =
        r == 15  ? "4WAY_HANDSHAKE_TIMEOUT -> PSK rejected (wrong password)"
        : r == 201 ? "NO_AP_FOUND -> could not reach that BSSID"
        : r == 2   ? "AUTH_EXPIRE"
        : r == 4   ? "ASSOC_EXPIRE"
        : r == 8   ? "ASSOC_LEAVE"
        : r == 205 ? "CONNECTION_FAIL"
        : r == 3   ? "DEAUTH_LEAVING -> AP actively kicked us"
                   : "see esp_wifi_types.h";
    Serial.printf("  [wifi] disconnect reason=%u (%s)\n", r, meaning);
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
#endif

  // Pick the STRONGEST BSSID for this SSID and target it explicitly.
  //
  // This network has two APs (mesh/repeater) broadcasting BENTU on the same
  // channel, consistently seen at ~-55dBm and ~-88dBm. Plain begin() leaves
  // the choice to the SDK, which can lock onto the distant one and then get
  // ignored at auth (reason=2 AUTH_EXPIRE) — indistinguishable from a
  // router-side refusal. Scanning first and pinning the BSSID removes that
  // ambiguity: if it still fails, the near AP really is refusing us.
#if defined(ARDUINO_ARCH_ESP32)
  int best = -1, bestRssi = -127;
  // Blocking scan, seconds long — feed the task watchdog either side. This
  // one runs on EVERY boot, not just the failure path.
  platformFeedWatchdog();
  int found = WiFi.scanNetworks(false, true);
  platformFeedWatchdog();
  for (int i = 0; i < found; i++) {
    if (WiFi.SSID(i) == ssid && WiFi.RSSI(i) > bestRssi) {
      bestRssi = WiFi.RSSI(i);
      best = i;
    }
  }
  if (best >= 0) {
    // COPY the BSSID and drop the scan results BEFORE begin(). WiFi.BSSID()
    // returns a pointer INTO the scan table, and begin() is asynchronous —
    // calling scanDelete() afterwards freed the memory the SDK was still
    // about to read. That use-after-free made a request for one SSID
    // associate against a stale BSSID belonging to a different network,
    // producing a confusing mix of AUTH_EXPIRE and NO_AP_FOUND.
    uint8_t bssid[6];
    memcpy(bssid, WiFi.BSSID(best), sizeof(bssid));
    int32_t chan = WiFi.channel(best);
    Serial.printf("  targeting BSSID %02X:%02X:%02X:%02X:%02X:%02X ch%d %ddBm\n",
                  bssid[0], bssid[1], bssid[2], bssid[3], bssid[4], bssid[5],
                  chan, bestRssi);
    WiFi.scanDelete();
    WiFi.begin(ssid.c_str(), password.c_str(), chan, bssid, true);
  } else {
    Serial.printf("  '%s' not found in scan — connecting without BSSID pin\n",
                  ssid.c_str());
    WiFi.scanDelete();
    WiFi.begin(ssid.c_str(), password.c_str());
  }
#else
  WiFi.begin(ssid.c_str(), password.c_str());
#endif

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > timeoutMs) {
      Serial.println("WiFi connect timed out");
#if defined(ARDUINO_ARCH_ESP32)
      // A bare timeout cannot distinguish "wrong password" from "SSID not
      // visible", and the ESP32 is 2.4GHz-only — a dual-band router
      // advertising one SSID looks identical to a typo from here. Scan and
      // report what the radio can actually see, so the next attempt is
      // diagnosed rather than guessed.
      Serial.printf("  status=%d (4=CONNECT_FAILED/bad auth, 6=DISCONNECTED, 1=NO_SSID_AVAIL)\n",
                    (int)WiFi.status());
      // WiFi.disconnect() first: a STA stuck in a retry loop makes the scan
      // return WIFI_SCAN_RUNNING (-2) instead of a count, which reads as
      // "no networks" and produces a confidently wrong diagnosis.
      WiFi.disconnect(false, false);
      delay(100);
      // A synchronous scan blocks for seconds without yielding to the task
      // watchdog. Feed on both sides so the DIAGNOSTIC path cannot itself
      // reset the board and hide the diagnosis it exists to print.
      platformFeedWatchdog();
      int n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/true);
      platformFeedWatchdog();
      if (n < 0) {
        Serial.printf("  scan did not complete (rc=%d) — cannot diagnose\n", n);
        WiFi.scanDelete();
        return false;
      }
      Serial.printf("  visible 2.4GHz networks (%d):\n", n);
      bool sawTarget = false;
      for (int i = 0; i < n; i++) {
        bool match = WiFi.SSID(i) == ssid;
        if (match) sawTarget = true;
        // Print the exact auth mode, not just open/enc. WPA3-only and
        // WPA2/WPA3 mixed are the classic causes of a status=4 rejection
        // against a strong, visible AP with a correct password — and they
        // are invisible if this only says "enc".
        const char* auth = "?";
        switch (WiFi.encryptionType(i)) {
          case WIFI_AUTH_OPEN: auth = "open"; break;
          case WIFI_AUTH_WEP: auth = "WEP"; break;
          case WIFI_AUTH_WPA_PSK: auth = "WPA"; break;
          case WIFI_AUTH_WPA2_PSK: auth = "WPA2"; break;
          case WIFI_AUTH_WPA_WPA2_PSK: auth = "WPA/WPA2"; break;
          case WIFI_AUTH_WPA2_ENTERPRISE: auth = "WPA2-ENT"; break;
          case WIFI_AUTH_WPA3_PSK: auth = "WPA3 <-- ESP32 often fails"; break;
          case WIFI_AUTH_WPA2_WPA3_PSK: auth = "WPA2/WPA3 <-- try WPA2-only"; break;
          case WIFI_AUTH_WAPI_PSK: auth = "WAPI"; break;
          default: auth = "other"; break;
        }
        Serial.printf("   %c %-32s ch%-3d %ddBm %s\n", match ? '*' : ' ',
                      WiFi.SSID(i).c_str(), WiFi.channel(i), WiFi.RSSI(i), auth);
      }
      if (!sawTarget) {
        Serial.printf("  '%s' NOT VISIBLE to this radio — it is almost certainly\n"
                      "  5GHz-only. The ESP32 has no 5GHz radio. Use the 2.4GHz\n"
                      "  SSID (often a separate name, or split the bands).\n",
                      ssid.c_str());
      } else {
        Serial.println("  SSID is visible, so the band is fine — check the password.");
      }
      WiFi.scanDelete();
#endif
      return false;
    }
    // Feed explicitly. delay() is vTaskDelay on ESP32 — it blocks the task
    // WITHOUT resetting the task watchdog, so this 15s loop would otherwise
    // trip it and reboot the device mid-association. That would boot-loop on
    // a slow-but-working AP: exactly the failure the watchdog is meant to
    // protect against, caused by the watchdog itself.
    platformFeedWatchdog();
    delay(250);
  }
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

// Watch the station link and recover it if auto-reconnect does not.
//
// Deliberately conservative, in this order:
//   1. Link up              -> clear the timer, do nothing.
//   2. Down < 2min          -> let the SDK's own auto-reconnect work.
//   3. Down > 2min          -> WiFi.reconnect() on each check, a cheap
//                              non-blocking nudge. Repeated, not one-shot:
//                              an AP that comes back after an hour must be
//                              rejoined, and this is the only thing trying.
//   4. Down > 2h            -> ESP.restart(), the last resort.
//
// BEING OFFLINE IS NOT AN ERROR STATE. The alarm is cloud-independent by
// design — RF decode, rule evaluation, siren and EEPROM arm state are all
// local — so a device with no WiFi is still protecting the premises. It
// loses remote arm/disarm and cloud alerts, which is worth recovering from,
// but NOT at the price of restarting a working alarm every few minutes
// through a long outage. Each reboot is a gap in which nothing is watched.
//
// Hence 2h before the restart: long past any router reboot or ISP blip, so
// it only ever fires for a genuinely wedged radio that nudging cannot fix.
// A reboot re-runs the connect path cleanly and reloads arm state from
// EEPROM, so the alarm returns armed exactly as it was.
//
// noinline for the cont-stack reason documented on handleSensorEvent().
__attribute__((noinline))
void superviseWifi(unsigned long now) {
  if (portalActive) return;  // the portal owns the radio; leave it alone
  if (now - lastWifiCheckMs < kWifiCheckIntervalMs) return;
  lastWifiCheckMs = now;

  if (WiFi.status() == WL_CONNECTED) {
    if (wifiDownSinceMs != 0) {
      Serial.printf("[wifi] link restored after %lus (IP %s)\n",
                    (now - wifiDownSinceMs) / 1000,
                    WiFi.localIP().toString().c_str());
      wifiDownSinceMs = 0;
    }
    return;
  }

  if (wifiDownSinceMs == 0) {
    wifiDownSinceMs = now;
    Serial.printf("[wifi] link DOWN (status=%d) — alarm still armed locally, "
                  "waiting for auto-reconnect\n",
                  (int)WiFi.status());
    return;
  }

  const unsigned long downMs = now - wifiDownSinceMs;
  if (downMs >= kWifiDownRebootMs) {
    Serial.printf("[wifi] down %lumin — rebooting to recover the radio\n",
                  downMs / 60000);
    Serial.flush();
    ESP.restart();
  }
  if (downMs >= kWifiDownGraceMs) {
    Serial.printf("[wifi] down %lumin — nudging reconnect\n", downMs / 60000);
    WiFi.reconnect();
  }
}

void enterPortalMode() {
  portalActive = true;
  portal.begin(&provisionStore);
  portal.start();
  Serial.println("Portal mode active — waiting for setup submission");
}

void onNormalOperation() {
  Serial.println("Entering normal operation");

  // Configure the cloud client but do NOT mint here — loop() does it.
  // The mint must run on the cont (sketch) stack, where BearSSL's
  // _run_until can actually yield: optimistic_yield() is a no-op unless
  // can_yield() is true, which holds only on that stack. loop() also calls
  // cloudClient.loop() first, so the handshake gets maximum stack headroom
  // — see handleSensorEvent()'s note for why that matters.
  {
    String endpoint = provisionStore.endpoint();
    while (endpoint.endsWith("/")) endpoint.remove(endpoint.length() - 1);
    cloudClient.begin(endpoint + "/mintDeviceToken", provisionStore.databaseUrl(),
                       FIREBASE_WEB_API_KEY, provisionStore.apiKey());
  }

  eepromStore.begin();
  if (!eepromStore.load(&armed, &localWebEnabled, &config)) {
    Serial.println("No valid EEPROM state found — starting disarmed, local web enabled, empty config");
    armed = false;
    localWebEnabled = true;
    config = Config();
  }
  config.armed = armed;
  alarmState.setConfig(config);

  bool radioReady = cc1101.begin(kCc1101CsPin, kCc1101Gdo0Pin);
  if (!radioReady) {
    Serial.println("[cc1101] init FAILED — RF receive and siren TX disabled");
  }

  // Generate the siren identity on first boot and persist it, so a physical
  // pairing survives reflashing.
  if (!SirenAddress::isValid(config.sirenBaseAddress)) {
    config.sirenBaseAddress = SirenAddress::generate();
    eepromStore.save(armed, localWebEnabled, config);
    Serial.printf("[siren] generated new base address 0x%06lX\n",
                  (unsigned long)config.sirenBaseAddress);
  }
  Serial.printf("[siren] base address 0x%06lX\n",
                (unsigned long)config.sirenBaseAddress);
  siren.begin(kRelayPin, radioReady ? &cc1101 : nullptr, config.sirenBaseAddress);

  // NTP sync (configTime()) is deferred until cloud settles — see
  // startNtpSyncIfNeeded(). Harmless either way (mDNS/NTP/CC1101 timing
  // were all ruled out as causes of the mint crash investigated in this
  // codebase's history), but deferring still slightly reduces startup
  // work before the first mint try.

  if (localWebEnabled) {
    // mDNS start is deferred — see startMdnsIfNeeded()'s comment above.
    localWebServer.begin();
    localWebServer.start();
    Serial.println("Local web server enabled");
  } else {
    Serial.println("Local web server disabled (localWebEnabled=false)");
  }

  normalOperationStartMs = millis();
}
}  // namespace

void setup() {
  // 115200 to match spike_mint — at 9600 the mint-path diagnostics in
  // cloud_client.cpp block long enough to perturb the timings they measure.
  Serial.begin(115200);
#if defined(ARDUINO_ARCH_ESP32)
  // Native USB CDC (not a UART): the endpoint does not exist until the host
  // enumerates it, which takes ~1s after reset. Anything printed before then
  // is written into the void, so an early banner simply never appears and
  // the board looks dead while running perfectly. Wait for the host, but
  // bound the wait — on a standalone power supply there is no host at all
  // and the alarm must still boot.
  {
    const unsigned long kUsbWaitMs = 2000;
    unsigned long start = millis();
    while (!Serial && millis() - start < kUsbWaitMs) delay(10);
    delay(100);  // let the host attach its reader before the first write
  }
#else
  delay(200);
#endif
  Serial.printf("Alarm system device booting... (last reset: %s)\n",
                platformResetReason());

  // Start the watchdog BEFORE anything that can block, so a hang during
  // provisioning or the WiFi connect is caught too. 30s is deliberately
  // generous: connectToWifi() alone budgets 15s, the mint's response wait
  // 15s, and runSirenPairing() blocks for 10s — all legitimate, and all
  // feed the watchdog explicitly via platformFeedWatchdog(). This only
  // fires for a genuine hang, never for slow-but-progressing work.
  platformWatchdogBegin(kWatchdogTimeoutSec);

  pinMode(kForcePortalPin, INPUT_PULLUP);
  bool forcePortal = digitalRead(kForcePortalPin) == LOW;

  if (!provisionStore.begin()) {
    Serial.println("FATAL: LittleFS unavailable");
  }
  provisionStore.load();

  if (forcePortal) {
    Serial.println("Boot button held — forcing portal mode");
    enterPortalMode();
    return;
  }

  if (provisionStore.isConfigured() &&
      connectToWifi(provisionStore.ssid(), provisionStore.password(),
                     kWifiConnectTimeoutMs)) {
    onNormalOperation();
    return;
  }

  enterPortalMode();
}

void loop() {
  // Every path below returns through here, including the portal's early
  // return, so this single call covers the whole firmware. A hang anywhere
  // else now reboots the board within kWatchdogTimeoutSec instead of leaving
  // it powered and dead — see platformWatchdogBegin()'s comment.
  platformFeedWatchdog();

  if (portalActive) {
    portal.handle();
    if (portal.hasPendingSave()) {
      String ssid, password, endpoint, databaseUrl, apiKey;
      portal.takePendingSave(&ssid, &password, &endpoint, &databaseUrl, &apiKey);
      provisionStore.save(ssid, password, endpoint, databaseUrl, apiKey);

      if (connectToWifi(ssid, password, kWifiConnectTimeoutMs)) {
        portal.stop();
        portalActive = false;
        onNormalOperation();
      } else {
        portal.showError();
      }
    }
    return;
  }

  unsigned long now = millis();

  superviseWifi(now);

  // The mint runs from here (CloudClient::loop() -> beginInitialConnect()),
  // and its TLS handshake is the deepest stack consumer in the whole
  // firmware. Call it FIRST, before any of the work below, so it sees the
  // most cont-stack headroom available. Everything after this point is
  // cheap or held out-of-line — see handleSensorEvent()'s note.
  cloudClient.loop(siren.isActive());

  pollCc1101(now);

  pollEntryDelay(now);
  siren.tick(now);

  // Clear state/siren_active once the alarm is over. onAlarm triggers on the
  // false->true edge, so a flag left true makes every LATER alarm a silent
  // no-op — the feature would work exactly once. Edge-triggered so this
  // costs one write per alarm, not one per loop.
  if (alarmReportedToCloud && !siren.isActive()) {
    alarmReportedToCloud = false;
    cloudClient.clearAlarm();
  }

  bool cloudSettled = cloudClient.isReady() ||
                       millis() - normalOperationStartMs > kDnsUsersStartFallbackMs;

  if (localWebEnabled && !mdnsStarted && cloudSettled) {
    startMdnsIfNeeded();
  }
  if (!ntpStarted && cloudSettled) {
    startNtpSyncIfNeeded();
  }

  // Strictly isReady(), not the cloudSettled fallback above — that fallback
  // also fires if the cloud never comes up, and reportEvent() would just
  // no-op then anyway. Only mark it done once the call has actually fired.
  if (!sirenAddressReported && cloudClient.isReady()) {
    reportSirenAddressOnce();
  }

  // Why the last boot happened. Reported once, and only once the cloud is
  // actually up — this is the record that makes the NEXT unexplained death
  // diagnosable instead of reconstructed from heartbeat arithmetic.
  if (!bootReported && cloudClient.isReady()) {
    bootReported = true;
    cloudClient.reportBoot();
  }

  if (cloudClient.isReady() && now - lastHeartbeatMs >= kHeartbeatIntervalMs) {
    lastHeartbeatMs = now;
    cloudClient.reportHeartbeat();
  }

  bool newArmed;
  if (cloudClient.consumeArmedCommand(&newArmed)) {
    applyArmedCommand(newArmed);
  }

  bool sirenCommandOn;
  if (cloudClient.consumeSirenCommand(&sirenCommandOn)) {
    if (sirenCommandOn) {
      siren.turnOn(config.sirenDurationSec, now);
    } else {
      siren.turnOff();
    }
  }

  uint32_t pairNonce = 0, pairUntil = 0;
  if (cloudClient.consumePairCommand(&pairNonce, &pairUntil)) {
    // Ignore an expired request: time(nullptr) is only meaningful once NTP
    // has synced, so a zero/unset `until` is treated as "no deadline".
    const uint32_t nowSec = (uint32_t)time(nullptr);
    if (pairUntil != 0 && nowSec > 100000UL && nowSec > pairUntil) {
      Serial.printf("[siren] ignoring expired pair request (now %lu > until %lu)\n",
                    (unsigned long)nowSec, (unsigned long)pairUntil);
    } else {
      runSirenPairing();
    }
  }

  // Gated so the ~2.4KB Config inside is only ever allocated when there is
  // actually an update to apply, and out-of-line so its frame is never part
  // of loop()'s.
  if (cloudClient.hasPendingConfigUpdate()) {
    applyPendingConfigUpdate();
  }

  if (localWebEnabled) {
    if (mdnsStarted) platformMdnsUpdate();
    localWebServer.setStatus(armed, siren.isActive());
    localWebServer.handle();

    if (localWebServer.hasPendingArmCommand()) {
      bool newArmedFromWeb = localWebServer.takePendingArmCommand();
      // Tagged so onDeviceArmStateChange can say "from local web UI" — this
      // path produced NO notification at all before that function existed.
      armedBySource = "local";
      applyArmedCommand(newArmedFromWeb);
    }

    if (localWebServer.hasPendingTrigger()) {
      String rfId;
      localWebServer.takePendingTrigger(&rfId);
      handleSensorEvent(rfId.c_str(), now);
    }

    if (localWebServer.hasPendingPairRequest()) {
      localWebServer.clearPendingPairRequest();
      runSirenPairing();
    }

    // Bench aid: sound the siren on demand, independently of arm state and
    // alarm rules. Deliberately passes the configured duration so the
    // auto-off timer runs exactly as it would for a real alarm; POST
    // /disarm silences it early. If sirenDurationSec is 0 the siren is
    // disabled and turnOn() is a no-op, which is the correct behaviour.
    if (localWebServer.hasPendingSirenTest()) {
      localWebServer.clearPendingSirenTest();
      // Falls back to 30s when no duration has been synced from the cloud.
      // Without this the bench test is silently a no-op on a device whose
      // config has not arrived yet: turnOn() treats 0 as "siren disabled"
      // and returns before transmitting, which looks exactly like a broken
      // radio. Observed on a freshly flashed board: "sounding for 0s" and
      // no tx line at all.
      uint16_t testDuration = config.sirenDurationSec > 0
                                  ? config.sirenDurationSec
                                  : 30;
      Serial.printf("[siren] bench test: sounding for %us (config=%us) — "
                    "POST /disarm to stop\n",
                    testDuration, config.sirenDurationSec);
      siren.turnOn(testDuration, now);
    }
  }
}
