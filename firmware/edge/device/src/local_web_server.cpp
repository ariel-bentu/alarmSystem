#include "local_web_server.h"

#include "local_web_page.h"

void LocalWebServer::begin() {
  webServer_.on("/", HTTP_GET, [this]() { handleRoot(); });
  webServer_.on("/status", HTTP_GET, [this]() { handleStatus(); });
  webServer_.on("/arm", HTTP_POST, [this]() { handleArm(); });
  webServer_.on("/disarm", HTTP_POST, [this]() { handleDisarm(); });
  webServer_.on("/trigger", HTTP_POST, [this]() { handleTrigger(); });
  webServer_.on("/pair-siren", HTTP_POST, [this]() { handlePairSiren(); });
  webServer_.on("/siren-test", HTTP_POST, [this]() { handleSirenTest(); });
}

void LocalWebServer::start() {
  webServer_.begin();
  Serial.println("Local web server started on port 80");
}

void LocalWebServer::stop() {
  webServer_.stop();
}

void LocalWebServer::handle() {
  webServer_.handleClient();
}

void LocalWebServer::setStatus(bool armed, bool sirenActive) {
  statusArmed_ = armed;
  statusSirenActive_ = sirenActive;
}

bool LocalWebServer::takePendingArmCommand() {
  pendingArmCommand_ = false;
  return pendingArmCommandValue_;
}

void LocalWebServer::takePendingTrigger(String* rfId) {
  *rfId = pendingTriggerRfId_;
  pendingTrigger_ = false;
}

String LocalWebServer::renderPage() {
  String page(FPSTR(LOCAL_WEB_PAGE_HTML));
  page.replace("{{ARMED}}", statusArmed_ ? "yes" : "no");
  page.replace("{{SIREN}}", statusSirenActive_ ? "ACTIVE" : "off");
  return page;
}

void LocalWebServer::handleRoot() {
  webServer_.send(200, "text/html", renderPage());
}

void LocalWebServer::handleStatus() {
  String json = "{\"armed\":";
  json += statusArmed_ ? "true" : "false";
  json += ",\"siren\":";
  json += statusSirenActive_ ? "true" : "false";
  json += "}";
  webServer_.send(200, "application/json", json);
}

void LocalWebServer::handleArm() {
  pendingArmCommand_ = true;
  pendingArmCommandValue_ = true;
  webServer_.send(200, "text/plain", "ok");
}

void LocalWebServer::handleDisarm() {
  pendingArmCommand_ = true;
  pendingArmCommandValue_ = false;
  webServer_.send(200, "text/plain", "ok");
}

void LocalWebServer::handleTrigger() {
  String rfId = webServer_.arg("rfId");
  if (rfId.length() == 0) {
    webServer_.send(400, "text/plain", "Missing rfId");
    return;
  }
  pendingTriggerRfId_ = rfId;
  pendingTrigger_ = true;
  webServer_.send(200, "text/plain", "ok");
}

void LocalWebServer::handleSirenTest() {
  pendingSirenTest_ = true;
  webServer_.send(200, "text/plain",
                   "Sounding the siren - POST /disarm to silence it");
}

void LocalWebServer::handlePairSiren() {
  pendingPair_ = true;
  webServer_.send(200, "text/plain",
                   "Pairing for 10s - press SET on the siren now");
}
