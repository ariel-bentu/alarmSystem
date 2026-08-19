#include "provisioning_portal.h"

#include "platform_compat.h"

#include "setup_page.h"

namespace {
const IPAddress kApIp(10, 25, 0, 1);
const IPAddress kApNetmask(255, 255, 255, 0);
const char* kApSsid = "AlarmSystem-Setup";
const uint16_t kDnsPort = 53;
}  // namespace

void ProvisioningPortal::begin(ProvisionStore* store) { store_ = store; }

void ProvisioningPortal::start() {
  // Kill auto-reconnect BEFORE touching mode(), so the STA cannot start
  // retrying in the gap and steal the radio from the AP we are about to
  // bring up. Order matters here.
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false);

  // AP_STA, set ONCE here and never changed while the portal runs: /scan
  // needs a station interface, and switching mode mid-request drops live TCP
  // sockets. What made the AP unreachable before was not the STA existing,
  // it was auto-reconnect retrying a failing network forever and dragging
  // the shared radio off-channel — disabled just above, and left off.
  WiFi.mode(WIFI_AP_STA);
  // Stop any in-flight station association BEFORE bringing the AP up.
  //
  // AP and STA share ONE radio. If the station is still retrying a failed
  // network (e.g. a wrong password, which retries indefinitely), every
  // attempt hops the radio off the AP's channel to scan and associate. The
  // AP can only send beacons while the radio is on its own channel, so the
  // SSID flickers: visible for a second, then gone for several. That looks
  // like a flaky AP or a rebooting board, but the board is fine — it is
  // radio contention. Tolerable on the ESP8266; not on the ESP32, whose
  // retry loop is more aggressive.
  //
  // Args are (wifioff=false, eraseap=false): keep the radio powered for the
  // AP, and do NOT erase stored credentials — the portal pre-fills them and
  // a failed connect must not wipe a previously working config.
  // setAutoReconnect(true) (set in connectToWifi) makes the STA keep
  // retrying a failed network FOREVER in the background. Each retry hops the
  // radio off the AP's channel, so the portal AP becomes unreachable — a
  // client sees the SSID but its association times out. Turning it off here
  // is what actually keeps the AP usable; the earlier disconnect() alone did
  // not, because auto-reconnect immediately restarted the attempts.
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false);
  delay(100);

#if defined(ARDUINO_ARCH_ESP32)
  // Log AP-side client events. Without these there is no way to tell "the
  // laptop never reached the device" from "it joined and the web server is
  // broken" — both look like a hung browser.
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    const uint8_t* m = info.wifi_ap_staconnected.mac;
    Serial.printf("  [ap] client JOINED %02X:%02X:%02X:%02X:%02X:%02X\n",
                  m[0], m[1], m[2], m[3], m[4], m[5]);
  }, ARDUINO_EVENT_WIFI_AP_STACONNECTED);
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    const uint8_t* m = info.wifi_ap_stadisconnected.mac;
    Serial.printf("  [ap] client LEFT   %02X:%02X:%02X:%02X:%02X:%02X\n",
                  m[0], m[1], m[2], m[3], m[4], m[5]);
  }, ARDUINO_EVENT_WIFI_AP_STADISCONNECTED);
#endif

  WiFi.softAPConfig(kApIp, kApIp, kApNetmask);
  // Pin the AP to channel 1 and keep it visible. Explicit args are
  // (ssid, password=nullptr -> open, channel=1, hidden=0, max_connection=4).
  WiFi.softAP(kApSsid, nullptr, 1, 0, 4);
  // The modem sleeps between beacons by default, which on a quiet AP makes
  // it intermittently missable during a client's short scan window.
  WiFi.setSleep(false);

  // Wildcard DNS: answer every lookup with our own IP so any typed address
  // lands on the portal. setTTL(60) and the error reply below matter — the
  // default 0 TTL makes clients re-query constantly, and on a phone that
  // produced a UDP send storm ("endPacket(): could not send data: 12",
  // i.e. ENOMEM) heavy enough to starve the web server mid-request.
  dnsServer_.setErrorReplyCode(DNSReplyCode::ServerFailure);
  dnsServer_.setTTL(60);
  dnsServer_.start(kDnsPort, "*", kApIp);

  webServer_.on("/", HTTP_GET, [this]() { handleRoot(); });
  webServer_.on("/scan", HTTP_GET, [this]() { handleScan(); });
  webServer_.on("/save", HTTP_POST, [this]() { handleSave(); });

  // Apple's connectivity check. macOS/iOS fetches this the moment it joins
  // and expects EXACTLY this body; anything else (such as our setup page)
  // means "captive portal", so the OS opens its own cut-down browser and
  // keeps cycling the association — which showed up as /hotspot-detect.html
  // looping with client LEFT/JOINED between every request.
  //
  // Answering "Success" tells macOS the network is normal and stops the
  // loop. The user then reaches the portal by typing 10.25.0.1, which works
  // in a real browser instead of the captive-portal popup.
  webServer_.on("/hotspot-detect.html", HTTP_GET, [this]() {
    webServer_.send(200, "text/html",
                    "<HTML><HEAD><TITLE>Success</TITLE></HEAD>"
                    "<BODY>Success</BODY></HTML>");
  });
  // Android and Windows equivalents, same reasoning.
  webServer_.on("/generate_204", HTTP_GET,
                [this]() { webServer_.send(204); });
  webServer_.on("/gen_204", HTTP_GET, [this]() { webServer_.send(204); });
  webServer_.on("/ncsi.txt", HTTP_GET,
                [this]() { webServer_.send(200, "text/plain", "Microsoft NCSI"); });
  webServer_.on("/connecttest.txt", HTTP_GET,
                [this]() { webServer_.send(200, "text/plain", "Microsoft Connect Test"); });

  // Everything else: 302 to the portal rather than serving the page inline
  // under whatever path was requested, so the browser's address bar shows
  // the real URL and relative links resolve.
  webServer_.onNotFound([this]() {
    webServer_.sendHeader("Location", "http://10.25.0.1/", true);
    webServer_.send(302, "text/plain", "");
  });
  webServer_.begin();

  Serial.print("Portal AP started: ");
  Serial.println(kApSsid);
  Serial.printf("  ip=%s channel=%d mac=%s\n",
                WiFi.softAPIP().toString().c_str(), WiFi.channel(),
                WiFi.softAPmacAddress().c_str());
}

void ProvisioningPortal::stop() {
  webServer_.stop();
  dnsServer_.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
}

void ProvisioningPortal::handle() {
  // HTTP first, and DNS only between HTTP requests. A phone hammering the
  // captive-DNS wildcard can otherwise consume the whole loop and starve
  // the web server, which is what made 10.25.0.1 hang while DNS queries
  // were still being answered.
  webServer_.handleClient();
  dnsServer_.processNextRequest();
}

void ProvisioningPortal::takePendingSave(String* ssid, String* password,
                                          String* endpoint,
                                          String* databaseUrl,
                                          String* apiKey) {
  *ssid = pendingSsid_;
  *password = pendingPassword_;
  *endpoint = pendingEndpoint_;
  *databaseUrl = pendingDatabaseUrl_;
  *apiKey = pendingApiKey_;
  pendingSave_ = false;
}

String ProvisioningPortal::renderPage() {
  String page(FPSTR(SETUP_PAGE_HTML));
  page.replace("{{ERROR_BANNER}}",
               showError_
                   ? "<div class=\"error\">Couldn't connect &mdash; check the password and try again.</div>"
                   : "");
  page.replace("{{SSID}}", store_->ssid());
  page.replace("{{ENDPOINT}}", store_->endpoint());
  page.replace("{{DATABASE_URL}}", store_->databaseUrl());
  page.replace("{{API_KEY}}", store_->apiKey());
  showError_ = false;
  return page;
}

void ProvisioningPortal::handleRoot() {
  Serial.printf("  [http] GET %s from %s\n", webServer_.uri().c_str(),
                webServer_.client().remoteIP().toString().c_str());
  webServer_.send(200, "text/html", renderPage());
}

void ProvisioningPortal::handleScan() {
  // Scanning needs a station interface, but do NOT switch WiFi.mode() here:
  // changing mode mid-request tears down active TCP sockets, which killed
  // the very connection serving this page (the setup page fetches /scan on
  // load, so the browser just hung). The AP_STA switch is done once in
  // start() instead, and auto-reconnect is off so the idle STA stays quiet.
  int count = WiFi.scanNetworks();
  if (count < 0) count = 0;
  String json = "[";
  for (int i = 0; i < count; i++) {
    if (i > 0) json += ",";
    json += "{\"ssid\":\"" + WiFi.SSID(i) + "\",\"rssi\":" + WiFi.RSSI(i) + "}";
  }
  json += "]";
  WiFi.scanDelete();
  webServer_.send(200, "application/json", json);
}

void ProvisioningPortal::handleSave() {
  String ssid = webServer_.arg("ssid");
  if (ssid.length() == 0) {
    ssid = webServer_.arg("ssidSelect");
  }
  String password = webServer_.arg("password");
  String endpoint = webServer_.arg("endpoint");
  String databaseUrl = webServer_.arg("databaseUrl");
  String apiKey = webServer_.arg("apiKey");

  if (ssid.length() == 0 || endpoint.length() == 0 ||
      databaseUrl.length() == 0 || apiKey.length() == 0) {
    webServer_.send(400, "text/plain", "Missing required field");
    return;
  }

  pendingSsid_ = ssid;
  pendingPassword_ = password;
  pendingEndpoint_ = endpoint;
  pendingDatabaseUrl_ = databaseUrl;
  pendingApiKey_ = apiKey;
  pendingSave_ = true;

  webServer_.send(200, "text/html",
                   "<html><body><p>Connecting&hellip; check your device.</p></body></html>");
}
