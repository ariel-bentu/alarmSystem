#pragma once

#include <Arduino.h>

class ProvisionStore {
 public:
  bool begin();
  void load();
  bool save(const String& ssid, const String& password,
            const String& endpoint, const String& databaseUrl,
            const String& apiKey);
  bool isConfigured() const;
  void clear();

  const String& ssid() const { return ssid_; }
  const String& password() const { return password_; }
  const String& endpoint() const { return endpoint_; }
  const String& databaseUrl() const { return databaseUrl_; }
  const String& apiKey() const { return apiKey_; }

 private:
  static constexpr const char* kPath = "/provision.json";

  String ssid_;
  String password_;
  String endpoint_;
  String databaseUrl_;
  String apiKey_;
};
