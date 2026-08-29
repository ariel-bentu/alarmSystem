#include "relay_siren.h"

#include <Arduino.h>

#include "siren_address.h"

void RelaySiren::begin(uint8_t relayPin, Cc1101Receiver* radio,
                       uint32_t baseAddress) {
  relayPin_ = relayPin;
  radio_ = radio;
  baseAddress_ = baseAddress;
  pinMode(relayPin_, OUTPUT);
  digitalWrite(relayPin_, LOW);
}

void RelaySiren::setBaseAddress(uint32_t baseAddress) {
  baseAddress_ = baseAddress;
}

void RelaySiren::sendCommand(uint32_t nibble) {
  if (radio_ == nullptr || !SirenAddress::isValid(baseAddress_)) return;
  radio_->transmit(baseAddress_ | nibble, kCommandRepeats);
}

void RelaySiren::turnOn(uint16_t durationSec, unsigned long nowMs) {
  if (durationSec == 0) return;  // siren disabled

  digitalWrite(relayPin_, HIGH);
  sendCommand(SirenAddress::kCmdSos);
  active_ = true;
  autoOff_ = true;
  offAtMs_ = nowMs + (unsigned long)durationSec * 1000UL;
}

void RelaySiren::turnOff() {
  digitalWrite(relayPin_, LOW);
  // MUST transmit, not merely drop the pin: an RF siren sounds until it is
  // told to stop, so a silent expiry would leave it sounding until switched
  // off by hand.
  sendCommand(SirenAddress::kCmdDisarm);
  active_ = false;
  autoOff_ = false;
}

void RelaySiren::tick(unsigned long nowMs) {
  if (active_ && autoOff_ && nowMs >= offAtMs_) {
    turnOff();
  }
}
