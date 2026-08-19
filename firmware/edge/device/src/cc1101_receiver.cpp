#include "cc1101_receiver.h"

#include <Arduino.h>
#include <SPI.h>

namespace {
constexpr uint8_t REG_IOCFG0   = 0x02;
constexpr uint8_t REG_FIFOTHR  = 0x03;
constexpr uint8_t REG_PKTCTRL0 = 0x08;
constexpr uint8_t REG_FREQ2    = 0x0D;
constexpr uint8_t REG_FREQ1    = 0x0E;
constexpr uint8_t REG_FREQ0    = 0x0F;
constexpr uint8_t REG_MDMCFG4  = 0x10;
constexpr uint8_t REG_MDMCFG3  = 0x11;
constexpr uint8_t REG_MDMCFG2  = 0x12;
constexpr uint8_t REG_MCSM1    = 0x17;
constexpr uint8_t REG_MCSM0    = 0x18;
constexpr uint8_t REG_AGCCTRL2 = 0x1B;
constexpr uint8_t REG_AGCCTRL1 = 0x1C;
constexpr uint8_t REG_AGCCTRL0 = 0x1D;
constexpr uint8_t REG_FREND1   = 0x21;
constexpr uint8_t REG_RSSI     = 0x34;
constexpr uint8_t STROBE_SRES  = 0x30;
constexpr uint8_t STROBE_SRX   = 0x34;
constexpr uint8_t CC1101_WRITE       = 0x00;
constexpr uint8_t CC1101_READ        = 0x80;
constexpr uint8_t CC1101_STATUS_READ = 0xC0;
constexpr uint8_t REG_PARTNUM  = 0x30;
constexpr uint8_t REG_VERSION  = 0x31;

// Kerui timing constants (measured from real hardware):
//   Delimiter: long LOW > 5000µs between packet repetitions
//   After delimiter: (HIGH ~400µs)(LOW encodes bit) × 24
//   SHORT LOW ~400µs = bit 1,  LONG LOW ~1200µs = bit 0
constexpr uint32_t kDelimiterUs  = 5000;
constexpr uint32_t kBitThreshold = 700;
constexpr int      kBits         = 24;
}  // namespace

Cc1101Receiver* Cc1101Receiver::instance_ = nullptr;

void IRAM_ATTR Cc1101Receiver::isr() {
  Cc1101Receiver* self = instance_;
  if (!self) return;
  int count = self->edgeCount_;
  if (count < kBufSize) {
    self->edgeTs_[count] = (uint32_t)esp_timer_get_time();
    self->edgeLv_[count] = (GPIO.in >> self->gdo0Pin_) & 1;
    self->edgeCount_     = count + 1;
  }
  self->lastEdgeMs_ = (uint32_t)(esp_timer_get_time() / 1000);
}

bool Cc1101Receiver::begin(uint8_t csPin, uint8_t gdo0Pin) {
  csPin_   = csPin;
  gdo0Pin_ = gdo0Pin;

  pinMode(csPin_, OUTPUT);
  digitalWrite(csPin_, HIGH);
  pinMode(gdo0Pin_, INPUT);

  SPI.begin();

  strobe(STROBE_SRES);
  delay(10);

  uint8_t partnum = readStatusReg(REG_PARTNUM);
  uint8_t version = readStatusReg(REG_VERSION);
  Serial.printf("[cc1101] PARTNUM=0x%02X VERSION=0x%02X", partnum, version);
  if (partnum == 0x00 && version == 0x14) {
    Serial.println(" — chip OK");
  } else {
    Serial.println(" — UNEXPECTED (wiring problem?)");
    return false;
  }

  configureFor433MhzOok();
  strobe(STROBE_SRX);

  uint8_t iocfg0   = readReg(REG_IOCFG0);
  uint8_t pktctrl0 = readReg(REG_PKTCTRL0);
  Serial.printf("[cc1101] IOCFG0=0x%02X (exp 0x0D)%s  PKTCTRL0=0x%02X (exp 0x32)%s\n",
                iocfg0,   iocfg0   == 0x0D ? "" : " MISMATCH",
                pktctrl0, pktctrl0 == 0x32 ? "" : " MISMATCH");

  delay(5);
  uint8_t marcstate = readStatusReg(0x35) & 0x1F;
  Serial.printf("[cc1101] MARCSTATE=0x%02X (%s)\n", marcstate,
                marcstate == 0x0D ? "RX — good" : "unexpected");

  instance_ = this;
  attachInterrupt(digitalPinToInterrupt(gdo0Pin_), isr, CHANGE);
  return true;
}

bool Cc1101Receiver::poll(KeruiPacket* outPacket, int* outRssi) {
  // Wait until 1.5s of silence (sensor transmits ~300ms of repeated packets).
  if (edgeCount_ == 0) return false;
  // Process once we have a full burst: either 600ms of silence after edges,
  // or buffer is getting full (>800 edges) — whichever comes first.
  bool silence = (uint32_t)(esp_timer_get_time() / 1000) - lastEdgeMs_ > 600;
  bool almostFull = edgeCount_ > 800;
  if (!silence && !almostFull) return false;

  detachInterrupt(digitalPinToInterrupt(gdo0Pin_));

  int n = edgeCount_;
  static uint32_t ts[kBufSize];
  static uint8_t  lv[kBufSize];
  memcpy(ts, (void*)edgeTs_, n * sizeof(uint32_t));
  memcpy(lv, (void*)edgeLv_, n * sizeof(uint8_t));
  edgeCount_ = 0;

  attachInterrupt(digitalPinToInterrupt(gdo0Pin_), isr, CHANGE);

  uint32_t sensorId = 0;
  if (!decodeEdges(ts, lv, n, sensorId)) return false;

  // Debounce: suppress the same sensor ID within 3s to prevent one physical
  // trigger from counting multiple times in count_in_window rules.
  uint32_t nowMs = (uint32_t)(esp_timer_get_time() / 1000);
  if (sensorId == lastDecodedId_ && nowMs - lastDecodedMs_ < 3000) return false;
  lastDecodedId_ = sensorId;
  lastDecodedMs_ = nowMs;

  outPacket->sensorId  = sensorId;
  outPacket->batteryLow = false;
  *outRssi = (int8_t)readReg(REG_RSSI);
  return true;
}

bool Cc1101Receiver::decodeEdges(const uint32_t* ts, const uint8_t* lv, int n,
                                  uint32_t& sensorId) {
  uint32_t candidates[16];
  int nCandidates = 0;

  for (int i = 0; i < n - 1 && nCandidates < 16; i++) {
    uint32_t dur = ts[i + 1] - ts[i];
    if (lv[i] == 0 && dur > kDelimiterUs) {
      int start = i + 1;
      if (start + kBits * 2 > n) break;
      uint32_t id = 0;
      bool valid = true;
      for (int b = 0; b < kBits; b++) {
        int hi = start + b * 2;
        int lo = hi + 1;
        if (lo + 1 >= n)      { valid = false; break; }
        if (lv[hi] != 1)      { valid = false; break; }
        if (lv[lo] != 0)      { valid = false; break; }
        uint32_t lowDur = ts[lo + 1] - ts[lo];
        id = (id << 1) | (lowDur < kBitThreshold ? 1u : 0u);
      }
      if (valid) candidates[nCandidates++] = id;
    }
  }

  if (nCandidates == 0) return false;

  uint32_t bestId    = 0;
  int      bestCount = 0;
  for (int i = 0; i < nCandidates; i++) {
    int count = 0;
    for (int j = 0; j < nCandidates; j++)
      if (candidates[j] == candidates[i]) count++;
    if (count > bestCount) { bestCount = count; bestId = candidates[i]; }
  }

  if (bestCount < 2) return false;
  sensorId = bestId;
  return true;
}

void Cc1101Receiver::writeReg(uint8_t addr, uint8_t value) {
  digitalWrite(csPin_, LOW);
  SPI.transfer(addr | CC1101_WRITE);
  SPI.transfer(value);
  digitalWrite(csPin_, HIGH);
}

uint8_t Cc1101Receiver::readReg(uint8_t addr) {
  digitalWrite(csPin_, LOW);
  SPI.transfer(addr | CC1101_READ);
  uint8_t value = SPI.transfer(0x00);
  digitalWrite(csPin_, HIGH);
  return value;
}

uint8_t Cc1101Receiver::readStatusReg(uint8_t addr) {
  digitalWrite(csPin_, LOW);
  SPI.transfer(addr | CC1101_STATUS_READ);
  uint8_t value = SPI.transfer(0x00);
  digitalWrite(csPin_, HIGH);
  return value;
}

void Cc1101Receiver::strobe(uint8_t cmd) {
  digitalWrite(csPin_, LOW);
  SPI.transfer(cmd);
  digitalWrite(csPin_, HIGH);
}

void Cc1101Receiver::configureFor433MhzOok() {
  writeReg(REG_IOCFG0,   0x0D);
  writeReg(REG_PKTCTRL0, 0x32);
  writeReg(REG_FREQ2,    0x10);
  writeReg(REG_FREQ1,    0xB0);
  writeReg(REG_FREQ0,    0x71);
  writeReg(REG_MDMCFG2,  0x30);
  writeReg(REG_MDMCFG4,  0x87);
  writeReg(REG_MDMCFG3,  0x32);
  writeReg(REG_FIFOTHR,  0x07);
  writeReg(REG_AGCCTRL2, 0x03);
  writeReg(REG_AGCCTRL1, 0x00);
  writeReg(REG_AGCCTRL0, 0x91);
  writeReg(REG_FREND1,   0xB6);
  writeReg(REG_MCSM1,    0x30);
  writeReg(REG_MCSM0,    0x18);
}
