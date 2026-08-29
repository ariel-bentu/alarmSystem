#pragma once

#include <cstdint>

#include "cc1101_receiver.h"

// Drives the siren two ways at once: an RF command over the CC1101 (the
// proven path — the siren is paired directly to this device, no hub) and a
// GPIO relay (built, still untested, kept for when hardware is wired).
//
// The interface is unchanged from the relay-only version so alarm_state,
// local_web_server and main.cpp call sites are untouched.
class RelaySiren {
 public:
  // `radio` and `baseAddress` may be null/0, in which case only the relay is
  // driven — the device still works as an alarm with no siren paired.
  void begin(uint8_t relayPin, Cc1101Receiver* radio, uint32_t baseAddress);
  void setBaseAddress(uint32_t baseAddress);
  void turnOn(uint16_t durationSec, unsigned long nowMs);
  void turnOff();
  void tick(unsigned long nowMs);
  bool isActive() const { return active_; }

 private:
  static const int kCommandRepeats = 10;

  uint8_t relayPin_ = 0;
  Cc1101Receiver* radio_ = nullptr;
  uint32_t baseAddress_ = 0;
  bool active_ = false;
  unsigned long offAtMs_ = 0;
  bool autoOff_ = false;

  void sendCommand(uint32_t nibble);
};
