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

  bool hasPendingPairRequest() const { return pendingPair_; }
  void clearPendingPairRequest() { pendingPair_ = false; }

  // Sounds the siren directly, bypassing arm state and alarm rules. Exists
  // because there is otherwise no way to make the siren sound on demand for
  // a bench test: /trigger only reaches the siren when the system is armed
  // AND a configured rule matches. /disarm always silences it again, so
  // this cannot leave the siren stuck on.
  bool hasPendingSirenTest() const { return pendingSirenTest_; }
  void clearPendingSirenTest() { pendingSirenTest_ = false; }

 private:
  void handleRoot();
  void handleStatus();
  void handleArm();
  void handleDisarm();
  void handleTrigger();
  void handlePairSiren();
  void handleSirenTest();
  String renderPage();

  WebServerClass webServer_{80};

  bool statusArmed_ = false;
  bool statusSirenActive_ = false;

  bool pendingArmCommand_ = false;
  bool pendingArmCommandValue_ = false;

  bool pendingTrigger_ = false;
  String pendingTriggerRfId_;

  bool pendingPair_ = false;
  bool pendingSirenTest_ = false;
};
