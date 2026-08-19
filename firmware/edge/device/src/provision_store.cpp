#include "provision_store.h"

#include <ArduinoJson.h>
#include <LittleFS.h>

bool ProvisionStore::begin() {
  if (LittleFS.begin()) {
    return true;
  }
  Serial.println("LittleFS mount failed, formatting...");
  if (!LittleFS.format()) {
    Serial.println("LittleFS format failed");
    return false;
  }
  return LittleFS.begin();
}

void ProvisionStore::load() {
  if (!LittleFS.exists(kPath)) {
    return;
  }
  File f = LittleFS.open(kPath, "r");
  if (!f) {
    return;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    Serial.print("provision.json parse error: ");
    Serial.println(err.c_str());
    return;
  }
  ssid_ = doc["ssid"] | "";
  password_ = doc["password"] | "";
  endpoint_ = doc["endpoint"] | "";
  databaseUrl_ = doc["databaseUrl"] | "";
  apiKey_ = doc["apiKey"] | "";
}

bool ProvisionStore::save(const String& ssid, const String& password,
                           const String& endpoint, const String& databaseUrl,
                           const String& apiKey) {
  JsonDocument doc;
  doc["ssid"] = ssid;
  doc["password"] = password;
  doc["endpoint"] = endpoint;
  doc["databaseUrl"] = databaseUrl;
  doc["apiKey"] = apiKey;

  File f = LittleFS.open(kPath, "w");
  if (!f) {
    Serial.println("Failed to open provision.json for write");
    return false;
  }
  bool ok = serializeJson(doc, f) > 0;
  f.close();
  if (ok) {
    ssid_ = ssid;
    password_ = password;
    endpoint_ = endpoint;
    databaseUrl_ = databaseUrl;
    apiKey_ = apiKey;
  }
  return ok;
}

bool ProvisionStore::isConfigured() const {
  return ssid_.length() > 0 && endpoint_.length() > 0 &&
         databaseUrl_.length() > 0 && apiKey_.length() > 0;
}

void ProvisionStore::clear() {
  LittleFS.remove(kPath);
  ssid_ = "";
  password_ = "";
  endpoint_ = "";
  databaseUrl_ = "";
  apiKey_ = "";
}
