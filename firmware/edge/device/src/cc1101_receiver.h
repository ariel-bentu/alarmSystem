#pragma once

#include <cstdint>

#include "../../kerui_decoder.h"

// Drives a CC1101 433MHz transceiver over SPI in ASK/OOK receive mode.
// Uses an interrupt on GDO0 to capture edge timestamps into a ring buffer;
// poll() drains the buffer and decodes Kerui packets non-blockingly.
//
// CS and GDO0 are passed in by main.cpp (pin map lives there).
// SCK/MISO/MOSI are hardware SPI pins claimed by SPI.begin():
//   D1 Mini (ESP8266): D5/D6/D7 = GPIO14/12/13
//   ESP32-S3 (FSPI):   SCK 12, MISO 13, MOSI 11
class Cc1101Receiver {
 public:
  bool begin(uint8_t csPin, uint8_t gdo0Pin);

  // Non-blocking poll: returns true and fills *outPacket if a complete
  // Kerui packet was decoded from buffered edges since the last call.
  bool poll(KeruiPacket* outPacket, int* outRssi);

 private:
  uint8_t csPin_   = 0;
  uint8_t gdo0Pin_ = 0;

  static const int kBufSize = 1024;
  // Edge ring buffer — written by ISR, read by poll().
  volatile uint32_t edgeTs_[kBufSize];
  volatile uint8_t  edgeLv_[kBufSize];
  volatile int      edgeCount_ = 0;
  volatile uint32_t lastEdgeMs_ = 0;

  // Debounce: suppress repeated decodes of the same sensor within 3s.
  uint32_t lastDecodedId_ = 0;
  uint32_t lastDecodedMs_ = 0;

  // Pointer to singleton instance so the static ISR can reach it.
  static Cc1101Receiver* instance_;
  static void IRAM_ATTR isr();

  void     writeReg(uint8_t addr, uint8_t value);
  uint8_t  readReg(uint8_t addr);
  uint8_t  readStatusReg(uint8_t addr);
  void     strobe(uint8_t cmd);
  void     configureFor433MhzOok();

  // Decode all Kerui packets from a captured edge buffer.
  // Returns true if majority vote succeeded; fills sensorId.
  bool decodeEdges(const uint32_t* ts, const uint8_t* lv, int n,
                   uint32_t& sensorId);
};
