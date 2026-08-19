#pragma once

#include <cstdint>

class RelaySiren {
 public:
  void begin(uint8_t relayPin);
  void turnOn(uint16_t durationSec, unsigned long nowMs);
  void turnOff();
  void tick(unsigned long nowMs);
  bool isActive() const { return active_; }

 private:
  uint8_t relayPin_ = 0;
  bool active_ = false;
  unsigned long offAtMs_ = 0;
  bool autoOff_ = false;
};
