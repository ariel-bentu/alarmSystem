#pragma once

#include <Arduino.h>
#include <DNSServer.h>

#include "platform_compat.h"
#include "provision_store.h"

class ProvisioningPortal {
 public:
  void begin(ProvisionStore* store);
  void start();
  void stop();
  void handle();

  bool hasPendingSave() const { return pendingSave_; }
  void takePendingSave(String* ssid, String* password, String* endpoint,
                        String* databaseUrl, String* apiKey);

  void showError() { showError_ = true; }

 private:
  void handleRoot();
  void handleScan();
  void handleSave();
  String renderPage();

  ProvisionStore* store_ = nullptr;
  DNSServer dnsServer_;
  WebServerClass webServer_{80};

  bool pendingSave_ = false;
  bool showError_ = false;
  String pendingSsid_, pendingPassword_, pendingEndpoint_, pendingDatabaseUrl_,
      pendingApiKey_;
};
