// Minimal repro: hardcoded WiFi, a raw-socket POST to mintDeviceToken (proven
// working — see CLAUDE.md), then FirebaseClient RTDB set/get using the
// minted custom token. Purpose: test the RTDB path in isolation, the same
// way the mint call was isolated, since it's a completely different code
// path (FirebaseClient's async auth + streaming) that has never been tested
// standalone. Kept as a known-good minimal control: it exercises mint +
// RTDB write/read with none of the device firmware around it. See
// CLAUDE.md's "Current Status" section for the full history.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>

#define ENABLE_CUSTOM_TOKEN
#define ENABLE_DATABASE
#include <FirebaseClient.h>

// local_secrets.h is gitignored — copy local_secrets.h.example and fill in
// real values from .local-info and web/.env.local before building.
#include "local_secrets.h"

const char* kMintPath = "/mintDeviceToken";
const uint16_t kMintPort = 443;

String customTokenJwt;
String projectId;

void logPhase(const char* label, unsigned long startMs) {
  Serial.printf("[%8lu] %s (+%lums)\n", millis(), label, millis() - startMs);
}

bool mintCustomTokenRaw() {
  unsigned long t0 = millis();
  Serial.println("=== mint attempt start ===");

  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(2048, 2048);
  client.setTimeout(15000);

  logPhase("about to TCP+TLS connect", t0);
  unsigned long tConnectStart = millis();
  bool connected = client.connect(kMintHost, kMintPort);
  logPhase(connected ? "connect() returned OK" : "connect() returned FAIL", tConnectStart);
  if (!connected) {
    Serial.println("=== mint attempt aborted: connect failed ===");
    return false;
  }

  String body = String("{\"apiKey\":\"") + kDeviceApiKey + "\"}";
  String req = String("POST ") + kMintPath + " HTTP/1.1\r\n" +
               "Host: " + kMintHost + "\r\n" +
               "Content-Type: application/json\r\n" +
               "Content-Length: " + body.length() + "\r\n" +
               "Connection: close\r\n\r\n" + body;

  unsigned long tWriteStart = millis();
  client.print(req);
  logPhase("request written", tWriteStart);

  unsigned long tReadStart = millis();
  while (client.connected() && !client.available()) {
    ESP.wdtFeed();
    delay(10);
    if (millis() - tReadStart > 15000) {
      Serial.println("response wait: timed out");
      break;
    }
  }
  logPhase("response first byte (or timeout)", tReadStart);

  String response;
  while (client.available()) {
    response += (char)client.read();
  }
  client.stop();
  logPhase("mint attempt complete", t0);

  // Split headers from body on the blank line.
  int bodyStart = response.indexOf("\r\n\r\n");
  if (bodyStart < 0) {
    Serial.println("mint: malformed response, no header/body split found");
    return false;
  }
  String respBody = response.substring(bodyStart + 4);

  StaticJsonDocument<2048> respDoc;
  DeserializationError err = deserializeJson(respDoc, respBody);
  if (err) {
    Serial.printf("mint: JSON parse failed: %s\n", err.c_str());
    Serial.println(respBody.substring(0, 400));
    return false;
  }

  customTokenJwt = respDoc["customToken"].as<String>();
  projectId = respDoc["projectId"].as<String>();

  if (customTokenJwt.length() == 0 || projectId.length() == 0) {
    Serial.println("mint: response missing customToken/projectId");
    Serial.println(respBody.substring(0, 400));
    return false;
  }

  Serial.printf("mint OK: projectId=%s tokenLen=%u\n", projectId.c_str(), customTokenJwt.length());
  return true;
}

// ---- FirebaseClient RTDB test, mirroring cloud_client.cpp's pattern ----
WiFiClientSecure authSslClient;
WiFiClientSecure rtdbSslClient;
using AsyncClient = AsyncClientClass;
AsyncClient authClient(authSslClient);
AsyncClient rtdbClient(rtdbSslClient);

FirebaseApp app;
RealtimeDatabase database;
AsyncResult rtdbResult;

bool appAuthReady = false;
unsigned long authStartMs = 0;

void printResult(AsyncResult& result, const char* label) {
  if (result.isError()) {
    Serial.printf("[%s] ERROR: %s (code %d)\n", label, result.error().message().c_str(),
                  result.error().code());
  }
  if (result.isDebug()) {
    Serial.printf("[%s] debug: %s\n", label, result.debug().c_str());
  }
  if (result.available()) {
    Serial.printf("[%s] payload: %s\n", label, result.c_str());
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("spike_mint booting (mint + RTDB test)");

  WiFi.mode(WIFI_STA);
  WiFi.begin(kSsid, kPassword);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    delay(200);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi connect FAILED, halting");
    return;
  }
  Serial.printf("WiFi connected, IP=%s, took %lums\n", WiFi.localIP().toString().c_str(), millis() - t0);

  delay(500);

  if (!mintCustomTokenRaw()) {
    Serial.println("Halting: mint failed, can't test RTDB");
    return;
  }

  Serial.println("=== starting FirebaseClient RTDB auth ===");
  authSslClient.setInsecure();
  rtdbSslClient.setInsecure();

  CustomToken customToken(kFirebaseWebApiKey, customTokenJwt.c_str(), 3000);
  initializeApp(authClient, app, getAuth(customToken));
  app.getApp<RealtimeDatabase>(database);
  database.url(kDatabaseUrl);

  authStartMs = millis();
}

bool didWrite = false;
bool didRead = false;
unsigned long writeStartMs = 0;
unsigned long readStartMs = 0;

void loop() {
  if (customTokenJwt.length() == 0) {
    delay(1000);
    return;  // mint failed in setup(), nothing more to do
  }

  app.loop();
  bool ready = app.ready();

  if (!appAuthReady) {
    static unsigned long lastLog = 0;
    if (millis() - lastLog > 1000) {
      lastLog = millis();
      Serial.printf("[%8lu] waiting for app.ready()... (+%lums)\n", millis(), millis() - authStartMs);
    }
    if (ready) {
      appAuthReady = true;
      logPhase("FirebaseClient app.ready() == true", authStartMs);
    }
    if (millis() - authStartMs > 20000) {
      Serial.println("Auth timed out after 20s, halting further attempts");
      customTokenJwt = "";  // stop looping
    }
    return;
  }

  // database.rules.json only grants write access under commands/ (any
  // authed user) and events/ (device role only, projectId-scoped) — there
  // is no top-level catch-all .write, so an arbitrary path like
  // _spike_test would be silently permission-denied. Test against
  // events/, the same path shape cloud_client.cpp's reportEvent() uses.
  if (!didWrite) {
    didWrite = true;
    writeStartMs = millis();
    String path = String("/") + projectId + "/events/spike/1";
    Serial.printf("=== RTDB set %s ===\n", path.c_str());
    database.set<int>(rtdbClient, path, 42, rtdbResult);
    return;
  }

  if (didWrite && !didRead && millis() - writeStartMs > 2000) {
    didRead = true;
    readStartMs = millis();
    String path = String("/") + projectId + "/events/spike/1";
    Serial.printf("=== RTDB get %s ===\n", path.c_str());
    int value = database.get<int>(rtdbClient, path);
    Serial.printf("RTDB get returned: %d (+%lums)\n", value, millis() - readStartMs);
    Serial.println("=== spike complete, halting ===");
    customTokenJwt = "";  // stop looping
  }

  printResult(rtdbResult, "rtdb");
}
