#pragma once

#include <Arduino.h>

#include "platform_compat.h"

class LocalWebServer {
 public:
  void begin();
  void start();
  void stop();
  void handle();

  void setStatus(bool armed, bool sirenActive);

  bool hasPendingArmCommand() const { return pendingArmCommand_; }
  bool takePendingArmCommand();

  bool hasPendingTrigger() const { return pendingTrigger_; }
  void takePendingTrigger(String* rfId);

 private:
  void handleRoot();
  void handleStatus();
  void handleArm();
  void handleDisarm();
  void handleTrigger();
  String renderPage();

  WebServerClass webServer_{80};

  bool statusArmed_ = false;
  bool statusSirenActive_ = false;

  bool pendingArmCommand_ = false;
  bool pendingArmCommandValue_ = false;

  bool pendingTrigger_ = false;
  String pendingTriggerRfId_;
};
