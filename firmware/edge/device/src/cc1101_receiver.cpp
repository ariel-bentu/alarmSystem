#include "cc1101_receiver.h"

#include <Arduino.h>
#include <SPI.h>

#include "platform_compat.h"

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

constexpr uint8_t REG_PKTCTRL1 = 0x07;
constexpr uint8_t REG_MDMCFG1  = 0x13;
constexpr uint8_t REG_MDMCFG0  = 0x14;
constexpr uint8_t REG_FREND0   = 0x22;
constexpr uint8_t REG_PATABLE  = 0x3E;
constexpr uint8_t REG_TXBYTES  = 0x3A;
constexpr uint8_t REG_TXFIFO   = 0x3F;
constexpr uint8_t STROBE_SIDLE = 0x36;
constexpr uint8_t STROBE_STX   = 0x35;
constexpr uint8_t STROBE_SFTX  = 0x3B;
constexpr uint8_t CC1101_BURST = 0x40;
// PA level ported verbatim from spike_clean_tx. Do NOT tune this to close
// the unexplained 24dB gap against the older sender — the weaker setting is
// the one the siren actually responds to.
constexpr uint8_t kPaLevel = 0xC0;
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
  initialised_ = true;
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
  // familyId and eventNibble are part of the struct's contract, so poll()
  // fills them here. Callers currently re-derive the family from sensorId,
  // but leaving these unset left them holding whatever was on the caller's
  // stack — which surfaced as a garbage 32-bit `family` and a >4-bit `nibble`
  // in the packet log, differing between two packets from the same sensor.
  outPacket->familyId = (sensorId >> 4) & 0xFFFFF;
  outPacket->eventNibble = (uint8_t)(sensorId & 0x0F);
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

  // Undo configureForTx()'s writes to these five registers so RX does not
  // depend on a preceding SRES ever having run. begin() only ever reaches
  // this function via SRES, so until transmit() existed these always sat at
  // their power-on-reset defaults; configureForTx() overwrites them, so this
  // function must restore them explicitly rather than assume the reset
  // default. PATABLE in particular biases the receive front end — an
  // unrestored value here previously flattened every received pulse to a
  // uniform width and destroyed the short/long distinction decodeEdges()
  // depends on.
  writeReg(REG_PKTCTRL1, 0x04);
  writeReg(REG_MDMCFG1,  0x22);
  writeReg(REG_MDMCFG0,  0xF8);
  writeReg(REG_FREND0,   0x10);
  digitalWrite(csPin_, LOW);     // PATABLE POR default: [0]=0xC6, rest 0x00
  SPI.transfer(REG_PATABLE | CC1101_BURST);
  SPI.transfer(0xC6);
  for (int i = 1; i < 8; i++) SPI.transfer(0x00);
  digitalWrite(csPin_, HIGH);
}

// TX register set. Also writes PATABLE, FREND0, PKTCTRL1, MDMCFG1 and
// MDMCFG0 away from their RX values — configureFor433MhzOok() must (and
// does) restore all five, not just the registers that are obviously
// TX-specific.
void Cc1101Receiver::configureForTx() {
  strobe(STROBE_SIDLE);
  delay(2);

  writeReg(REG_IOCFG0,   0x06);  // packet status (unused in TX)
  writeReg(REG_PKTCTRL0, 0x00);  // fixed length, no CRC/whitening
  writeReg(REG_PKTCTRL1, 0x00);  // no address check
  writeReg(REG_FREQ2,    0x10);
  writeReg(REG_FREQ1,    0xB0);  // 433.92MHz
  writeReg(REG_FREQ0,    0x71);
  writeReg(REG_MDMCFG2,  0x30);  // OOK, no Manchester, no sync word
  writeReg(REG_MDMCFG1,  0x02);  // NUM_PREAMBLE = 0
  writeReg(REG_MDMCFG0,  0x00);

  uint8_t e = 0, m = 0;
  Ev1527::computeDrate(Ev1527::kPeriodUs / Ev1527::kChipsPerT, &e, &m);
  writeReg(REG_MDMCFG4, (uint8_t)(0x80 | e));
  writeReg(REG_MDMCFG3, m);

  // FREND0 PA_POWER=1 selects PATABLE[1] as the "carrier on" entry. Without
  // it the PA has no off entry and holds a continuous carrier: a commanded
  // 50ms pulse was measured arriving as 158ms.
  writeReg(REG_FREND0, 0x11);
  writeReg(REG_MCSM1,  0x30);
  writeReg(REG_MCSM0,  0x18);

  digitalWrite(csPin_, LOW);     // PATABLE: [0] = off, [1] = on
  SPI.transfer(REG_PATABLE | CC1101_BURST);
  SPI.transfer(0x00);
  SPI.transfer(kPaLevel);
  for (int i = 2; i < 8; i++) SPI.transfer(0x00);
  digitalWrite(csPin_, HIGH);
}

// Stream `numBytes` of txBits_ through the TX FIFO, refilling as it drains.
// Returns true if the whole buffer was fed AND the FIFO fully drained
// within their respective deadlines; false means the frame was truncated
// and the caller must not treat the transmission as having succeeded.
bool Cc1101Receiver::streamTxFifo(size_t numBytes) {
  strobe(STROBE_SFTX);
  writeReg(REG_PKTCTRL0, 0x02);  // infinite packet length while streaming

  size_t first = numBytes < 60 ? numBytes : 60;
  digitalWrite(csPin_, LOW);
  SPI.transfer(REG_TXFIFO | CC1101_BURST);
  for (size_t i = 0; i < first; i++) SPI.transfer(txBits_[i]);
  digitalWrite(csPin_, HIGH);

  size_t sent = first;
  strobe(STROBE_STX);

  const unsigned long fillDeadline = millis() + 2000;  // never spin forever
  while (sent < numBytes && millis() < fillDeadline) {
    if ((readStatusReg(REG_TXBYTES) & 0x7F) < 40) {
      size_t chunk = numBytes - sent;
      if (chunk > 20) chunk = 20;
      digitalWrite(csPin_, LOW);
      SPI.transfer(REG_TXFIFO | CC1101_BURST);
      for (size_t i = 0; i < chunk; i++) SPI.transfer(txBits_[sent + i]);
      digitalWrite(csPin_, HIGH);
      sent += chunk;
    }
    delayMicroseconds(100);
    platformFeedWatchdog();
  }
  bool filled = (sent >= numBytes);

  // Separate deadline for drain: a fill that used most of its 2000ms budget
  // must not leave the drain loop starved, since draining the last chunk
  // out over the air still takes real time regardless of how the fill went.
  const unsigned long drainDeadline = millis() + 2000;
  while ((readStatusReg(REG_TXBYTES) & 0x7F) > 0 && millis() < drainDeadline) {
    delayMicroseconds(100);
    platformFeedWatchdog();
  }
  bool drained = ((readStatusReg(REG_TXBYTES) & 0x7F) == 0);

  delayMicroseconds(Ev1527::kPeriodUs * 4);  // let the modulator drain
  strobe(STROBE_SIDLE);

  return filled && drained;
}

bool Cc1101Receiver::transmit(uint32_t code, int repeats) {
  if (!initialised_) return false;
  if (repeats < 1) repeats = 1;
  if (repeats > kMaxTxRepeats) repeats = kMaxTxRepeats;

  const size_t chips = Ev1527::renderBurst(code, repeats, txBits_, sizeof(txBits_));
  if (chips == 0) return false;

  // Stop capturing before touching the radio's mode, and drop whatever
  // partial burst was mid-flight — those edges would decode as noise.
  detachInterrupt(digitalPinToInterrupt(gdo0Pin_));
  edgeCount_ = 0;

  configureForTx();
  bool ok = streamTxFifo((chips + 7) / 8);

  // Restore receive. This is the regression that matters: a sensor decoded
  // after a transmit is the proof the register restore is complete. Always
  // run this, even if the FIFO didn't drain in time — the radio must not be
  // left in TX mode either way.
  configureFor433MhzOok();
  strobe(STROBE_SRX);
  edgeCount_ = 0;
  lastEdgeMs_ = (uint32_t)(esp_timer_get_time() / 1000);
  attachInterrupt(digitalPinToInterrupt(gdo0Pin_), isr, CHANGE);

  if (!ok) {
    Serial.printf("[cc1101] tx 0x%06lX x%d FAILED (FIFO did not drain within "
                  "deadline — frame truncated)\n",
                  (unsigned long)code, repeats);
    return false;
  }

  Serial.printf("[cc1101] tx 0x%06lX x%d (%u chips)\n",
                (unsigned long)code, repeats, (unsigned)chips);
  return true;
}
