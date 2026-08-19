#include "relay_siren.h"

#include <Arduino.h>

void RelaySiren::begin(uint8_t relayPin) {
  relayPin_ = relayPin;
  pinMode(relayPin_, OUTPUT);
  digitalWrite(relayPin_, LOW);
}

void RelaySiren::turnOn(uint16_t durationSec, unsigned long nowMs) {
  if (durationSec == 0) return; // siren disabled

  digitalWrite(relayPin_, HIGH);
  active_ = true;
  autoOff_ = true;
  offAtMs_ = nowMs + (unsigned long)durationSec * 1000UL;
}

void RelaySiren::turnOff() {
  digitalWrite(relayPin_, LOW);
  active_ = false;
  autoOff_ = false;
}

void RelaySiren::tick(unsigned long nowMs) {
  if (active_ && autoOff_ && nowMs >= offAtMs_) {
    turnOff();
  }
}
