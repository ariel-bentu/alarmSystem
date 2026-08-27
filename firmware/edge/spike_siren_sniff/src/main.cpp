// spike_siren_sniff — THROWAWAY DIAGNOSTIC.
//
// Question it answers: when the W184 hub tells its wireless siren to sound,
// does it emit a STATIC (replayable) RF packet, or a ROLLING code?
//
// Method: trigger the siren from the Tuya app several times. The only
// over-the-air hop in that path is hub -> siren, so anything heard during
// the window is the siren command. Compare the fingerprint across presses:
//   identical every time  -> static, replayable  -> build TX next
//   different every time  -> rolling code        -> Phase 2 needs a rethink
//
// Unlike spike_cc1101 this makes NO framing assumptions: the hub's packet
// may be a different length, bit encoding and repeat count than the 24-bit
// sensor packets. Raw edge timings are dumped first; the Kerui decoder is
// then tried opportunistically, since the hub may speak the same protocol.
//
// Wiring (unchanged): GPIO10=CS, GPIO12=SCK, GPIO11=MOSI, GPIO13=MISO, GPIO4=GDO0.

#include <Arduino.h>
#include <SPI.h>

static const uint8_t kCsPin   = 10;
static const uint8_t kGdo0Pin = 4;

// 2048 (vs spike_cc1101's 512): the hub's burst length is unknown and a
// truncated capture would silently produce a wrong conclusion. A 24-bit
// sensor packet is ~50 edges/copy, so this holds a very long burst.
static const int kBufSize = 2048;
static volatile uint32_t gTs[kBufSize];
static volatile uint8_t  gLv[kBufSize];
static volatile int      gCount = 0;
static volatile uint32_t gLastEdgeMs = 0;
static volatile bool     gOverflow = false;

static int gBurstNumber = 0;

void IRAM_ATTR onEdge() {
  if (gCount < kBufSize) {
    gTs[gCount] = (uint32_t)esp_timer_get_time();
    gLv[gCount] = (GPIO.in >> kGdo0Pin) & 1;
    gCount++;
  } else {
    gOverflow = true;
  }
  gLastEdgeMs = (uint32_t)(esp_timer_get_time() / 1000);
}

static void spiWrite(uint8_t addr, uint8_t val) {
  digitalWrite(kCsPin, LOW);
  SPI.transfer(addr);
  SPI.transfer(val);
  digitalWrite(kCsPin, HIGH);
}

static uint8_t spiReadStatus(uint8_t addr) {
  digitalWrite(kCsPin, LOW);
  SPI.transfer(addr | 0xC0);
  uint8_t v = SPI.transfer(0);
  digitalWrite(kCsPin, HIGH);
  return v;
}

static void strobe(uint8_t cmd) {
  digitalWrite(kCsPin, LOW);
  SPI.transfer(cmd);
  digitalWrite(kCsPin, HIGH);
}

// ---------------------------------------------------------------------------
// Analysis helpers — all assumption-free except where noted.
// ---------------------------------------------------------------------------

// Bucket pulse durations so repeated structure is visible at a glance.
// A clean OOK protocol shows 2-4 tight clusters (short/long, plus delimiter).
// Noise shows a smear with no clusters.
struct Bucket {
  uint32_t lo, hi;
  const char* label;
};
static const Bucket kBuckets[] = {
  {    0,   200, "<200us   " },
  {  200,   600, "200-600  " },
  {  600,  1000, "600-1000 " },
  { 1000,  1600, "1000-1600" },
  { 1600,  3000, "1600-3000" },
  { 3000,  6000, "3000-6000" },
  { 6000, 15000, "6-15ms   " },
  {15000, 0xFFFFFFFF, ">15ms   " },
};
static const int kNumBuckets = sizeof(kBuckets) / sizeof(kBuckets[0]);

static void printHistogram(const uint32_t* ts, const uint8_t* lv, int n) {
  int highCounts[kNumBuckets] = {0};
  int lowCounts[kNumBuckets]  = {0};
  for (int i = 0; i < n - 1; i++) {
    uint32_t dur = ts[i + 1] - ts[i];
    for (int b = 0; b < kNumBuckets; b++) {
      if (dur >= kBuckets[b].lo && dur < kBuckets[b].hi) {
        if (lv[i]) highCounts[b]++; else lowCounts[b]++;
        break;
      }
    }
  }
  Serial.println("  duration      HIGH   LOW");
  for (int b = 0; b < kNumBuckets; b++) {
    if (highCounts[b] || lowCounts[b])
      Serial.printf("  %s  %5d %5d\n", kBuckets[b].label, highCounts[b], lowCounts[b]);
  }
}

// Find long gaps — candidate packet delimiters — WITHOUT assuming whether the
// delimiter is a HIGH or a LOW. (Kerui sensors use a long LOW, but the hub is
// a different transmitter and may differ.) Prints the repeat structure, which
// is the single most informative view: equal spacing = a repeating packet.
static void printGapStructure(const uint32_t* ts, const uint8_t* lv, int n) {
  const uint32_t kGapUs = 3000;
  Serial.println("  long gaps (>3ms) — candidate delimiters:");
  int shown = 0;
  int prevIdx = -1;
  for (int i = 0; i < n - 1 && shown < 24; i++) {
    uint32_t dur = ts[i + 1] - ts[i];
    if (dur > kGapUs) {
      int edgesSince = (prevIdx < 0) ? 0 : (i - prevIdx);
      Serial.printf("    idx %4d  %s  %6luus   edges since prev gap: %d\n",
                    i, lv[i] ? "HIGH" : "LOW ", (unsigned long)dur, edgesSince);
      prevIdx = i;
      shown++;
    }
  }
  if (shown == 0) Serial.println("    (none — packet may use a different framing)");
}

// Opportunistic Kerui decode: same rules as the working receiver
// (delimiter = LOW >5ms; bit = LOW duration, short<700us = 1).
// Prints EVERY copy, not a majority vote — for the rolling-vs-static question
// we need to see whether the copies differ from each other.
static void tryKeruiDecode(const uint32_t* ts, const uint8_t* lv, int n) {
  const uint32_t kDelimiterUs  = 5000;
  const uint32_t kBitThreshold = 700;
  const int      kBits         = 24;

  int found = 0;
  Serial.println("  Kerui-style 24-bit decode attempt (all copies):");
  for (int i = 0; i < n - 1; i++) {
    uint32_t dur = ts[i + 1] - ts[i];
    if (lv[i] == 0 && dur > kDelimiterUs) {
      int start = i + 1;
      if (start + kBits * 2 > n) break;
      uint32_t id = 0;
      bool valid = true;
      for (int b = 0; b < kBits; b++) {
        int hi = start + b * 2;
        int lo = hi + 1;
        if (lo + 1 >= n) { valid = false; break; }
        if (lv[hi] != 1) { valid = false; break; }
        if (lv[lo] != 0) { valid = false; break; }
        uint32_t lowDur = ts[lo + 1] - ts[lo];
        id = (id << 1) | (lowDur < kBitThreshold ? 1u : 0u);
      }
      if (valid) {
        Serial.printf("    copy %2d: 0x%06X\n", found, id);
        found++;
      }
    }
  }
  if (found == 0)
    Serial.println("    (no Kerui-framed packet — hub likely uses different framing)");
}

// If a command and its acknowledgement arrive <600ms apart they land in the
// SAME burst, so the inter-burst gap above would not reveal them. This walks
// the decoded copies in order and reports where the transmitter ID CHANGES
// mid-burst, with the time gap at the changeover — a hub->siren handover.
static void printIdTransitions(const uint32_t* ts, const uint8_t* lv, int n) {
  const uint32_t kDelimiterUs  = 5000;
  const uint32_t kBitThreshold = 700;
  const int      kBits         = 24;

  uint32_t prevId = 0;
  uint32_t prevEndUs = 0;
  bool havePrev = false;
  bool anyTransition = false;

  for (int i = 0; i < n - 1; i++) {
    uint32_t dur = ts[i + 1] - ts[i];
    if (lv[i] == 0 && dur > kDelimiterUs) {
      int start = i + 1;
      if (start + kBits * 2 > n) break;
      uint32_t id = 0;
      bool valid = true;
      for (int b = 0; b < kBits; b++) {
        int hi = start + b * 2;
        int lo = hi + 1;
        if (lo + 1 >= n) { valid = false; break; }
        if (lv[hi] != 1 || lv[lo] != 0) { valid = false; break; }
        id = (id << 1) | ((ts[lo + 1] - ts[lo]) < kBitThreshold ? 1u : 0u);
      }
      if (!valid) continue;

      if (havePrev && (id >> 4) != (prevId >> 4)) {
        if (!anyTransition) {
          Serial.println("  *** TRANSMITTER CHANGED MID-BURST ***");
          anyTransition = true;
        }
        Serial.printf("    0x%06X (id 0x%05X) -> 0x%06X (id 0x%05X) after %lums\n",
                      prevId, prevId >> 4, id, id >> 4,
                      (unsigned long)((ts[start] - prevEndUs) / 1000));
      }
      prevId = id;
      prevEndUs = ts[start + kBits * 2 - 1];
      havePrev = true;
    }
  }
}

// ---------------------------------------------------------------------------
// WIDER NET — config-independent energy detector.
//
// Every decode above assumes OOK at ~406kHz BW. If the hub->siren command is
// FSK, Manchester, or OOK at a very different data rate, the edge capture on
// GDO0 (async serial) renders it as noise or nothing, and we would wrongly
// conclude "0x622374 is the command". RSSI does NOT care about modulation:
// the CC1101 reports received power whatever the waveform. So this scanner
// sits in RX with a WIDE bandwidth and samples RSSI as fast as SPI allows,
// flagging any excursion above the ambient floor. If a triggered SOS produces
// a strong RSSI spike that our OOK edge capture shows as noise, the real
// command is on a modulation we have never actually captured.
//
// Baseline (measured, CLAUDE.md): ambient floor ~-86..-92dBm; real Kerui
// bursts -55..-62dBm. -75dBm cleanly separates "something is transmitting".
static int rssiDbm() {
  int8_t raw = (int8_t)spiReadStatus(0x34);  // RSSI status register
  return (raw >= 0 ? raw / 2 : (raw + 256) / 2 - 128) - 74;
}

// Reconfigure the modem's RX bandwidth / data rate WITHOUT changing frequency
// or leaving RX. MDMCFG4 high nibble = CHANBW; low nibble = DRATE_E exponent.
static void applyRxConfig(uint8_t mdmcfg4, uint8_t mdmcfg2, const char* note) {
  strobe(0x36);              // SIDLE
  spiWrite(0x10, mdmcfg4);
  spiWrite(0x12, mdmcfg2);
  strobe(0x34);              // SRX
  delay(3);
  Serial.printf(">> RX config: MDMCFG4=0x%02X MDMCFG2=0x%02X  (%s)\n",
                mdmcfg4, mdmcfg2, note);
}

// Fast RSSI scan for `ms` milliseconds under the CURRENT config. Prints the
// peak and every sample above threshold with a timestamp, so a strong burst
// during an SOS is visible even when it cannot be decoded.
static void rssiScan(uint32_t ms) {
  const int kThreshDbm = -75;
  uint32_t t0 = millis();
  int peak = -200;
  uint32_t peakAtMs = 0;
  int flagged = 0;
  Serial.printf("  RSSI scan %lums (flag > %ddBm):\n", (unsigned long)ms, kThreshDbm);
  while (millis() - t0 < ms) {
    int d = rssiDbm();
    if (d > peak) { peak = d; peakAtMs = millis() - t0; }
    if (d > kThreshDbm && flagged < 40) {
      Serial.printf("    t+%4lums  RSSI=%ddBm  *** ENERGY\n",
                    (unsigned long)(millis() - t0), d);
      flagged++;
    }
    delayMicroseconds(300);
  }
  Serial.printf("  peak %ddBm at t+%lums%s\n", peak, (unsigned long)peakAtMs,
                peak > kThreshDbm ? "" : "   (nothing above floor — quiet band)");
}

// Sweep several OOK/FSK configs, RSSI-scanning under each. Run this DURING a
// held SOS (or repeatedly while triggering) to see which config, if any, hears
// strong energy. Restores the proven decode config at the end.
static void widerNetSweep() {
  Serial.println("=========================================================");
  Serial.println("WIDER-NET RSSI SWEEP — trigger/hold the siren SOS NOW");
  Serial.println("=========================================================");
  struct Cfg { uint8_t m4, m2; const char* note; };
  static const Cfg cfgs[] = {
    { 0x87, 0x30, "OOK ~406kHz (our decode config)" },
    { 0x87, 0x00, "OOK narrow-BW, DRATE as-is" },
    { 0x57, 0x30, "OOK ~406kHz, faster DRATE" },
    { 0xC7, 0x30, "OOK ~58kHz BW, slow DRATE" },
    { 0x87, 0x10, "2-FSK ~406kHz (carrier-energy probe)" },
    { 0x87, 0x40, "MSK ~406kHz (carrier-energy probe)" },
  };
  for (unsigned c = 0; c < sizeof(cfgs) / sizeof(cfgs[0]); c++) {
    applyRxConfig(cfgs[c].m4, cfgs[c].m2, cfgs[c].note);
    rssiScan(2500);
    Serial.println();
  }
  // Restore the known-good decode config.
  applyRxConfig(0x87, 0x30, "restored decode config");
  Serial.println("Sweep done. If a probe row showed ENERGY the OOK row did not,");
  Serial.println("the hub->siren command is NOT the OOK we have been replaying.");
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);
  delay(100);
  Serial.println();
  Serial.println("=== spike_siren_sniff ===");

  pinMode(kCsPin, OUTPUT);
  digitalWrite(kCsPin, HIGH);
  pinMode(kGdo0Pin, INPUT);
  SPI.begin(/*sck=*/12, /*miso=*/13, /*mosi=*/11, /*ss=*/kCsPin);

  strobe(0x30); delay(10);  // SRES

  uint8_t pn  = spiReadStatus(0x30);
  uint8_t ver = spiReadStatus(0x31);
  Serial.printf("PARTNUM=0x%02X VERSION=0x%02X %s\n", pn, ver,
                (pn == 0 && ver == 0x14) ? "OK" : "UNEXPECTED — check wiring");
  if (pn != 0 || ver != 0x14) { Serial.println("Halting."); while (1) delay(1000); }

  // Identical to the proven config in device/src/cc1101_receiver.cpp.
  spiWrite(0x02, 0x0D);  // IOCFG0: async serial
  spiWrite(0x08, 0x32);  // PKTCTRL0: async, infinite
  spiWrite(0x0D, 0x10);  // FREQ2
  spiWrite(0x0E, 0xB0);  // FREQ1
  spiWrite(0x0F, 0x71);  // FREQ0 -> 433.92MHz
  spiWrite(0x12, 0x30);  // MDMCFG2: OOK, no sync
  spiWrite(0x10, 0x87);  // MDMCFG4: CHANBW ~406kHz
  spiWrite(0x11, 0x32);  // MDMCFG3
  spiWrite(0x03, 0x07);  // FIFOTHR
  spiWrite(0x1B, 0x03);  // AGCCTRL2
  spiWrite(0x1C, 0x00);  // AGCCTRL1
  spiWrite(0x1D, 0x91);  // AGCCTRL0
  spiWrite(0x21, 0xB6);  // FREND1
  spiWrite(0x17, 0x30);  // MCSM1: stay RX
  spiWrite(0x18, 0x18);  // MCSM0: auto-cal

  strobe(0x34);  // SRX
  delay(5);

  uint8_t ms = spiReadStatus(0x35) & 0x1F;
  Serial.printf("MARCSTATE=0x%02X (%s)\n", ms, ms == 0x0D ? "RX" : "unexpected");

  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);

  Serial.println();
  Serial.println("Listening continuously. Trigger the siren from the Tuya app.");
  Serial.println("Cloud latency means the burst arrives a second or two after you tap —");
  Serial.println("that is fine, every burst is captured and timestamped.");
  Serial.println("Trigger 4-5 times, then compare the fingerprints below.");
  Serial.println("If there is a separate siren-OFF command, capture that too.");
  Serial.println();
  Serial.println("WIDER NET: press 's' then immediately trigger/hold the SOS to run");
  Serial.println("the RSSI config sweep — detects strong RF our OOK config can't decode.");
  Serial.println();
}

void loop() {
  // Serial command: 's' runs the wider-net RSSI sweep (config-independent
  // energy detector). Detach the edge ISR while sweeping — the sweep drives
  // RX config directly and does not want spurious edge captures.
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 's') {
      detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
      widerNetSweep();
      gCount = 0;
      attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);
      return;
    }
  }

  uint32_t nowMs = (uint32_t)(esp_timer_get_time() / 1000);
  bool silence    = gCount > 0 && (nowMs - gLastEdgeMs > 600);
  bool almostFull = gCount > (kBufSize - 200);
  if (!silence && !almostFull) return;

  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));

  int n = gCount;
  static uint32_t ts[kBufSize];
  static uint8_t  lv[kBufSize];
  memcpy(ts, (void*)gTs, n * sizeof(uint32_t));
  memcpy(lv, (void*)gLv, n * sizeof(uint8_t));
  bool overflowed = gOverflow;
  gCount = 0;
  gOverflow = false;

  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);

  // Ignore trivial bursts — stray noise, not a transmission.
  if (n < 20) return;

  uint32_t spanUs = ts[n - 1] - ts[0];
  Serial.println("---------------------------------------------------------");
  Serial.printf("BURST #%d  at t=%lus  edges=%d  span=%lums%s%s\n",
                ++gBurstNumber, (unsigned long)(nowMs / 1000), n,
                (unsigned long)(spanUs / 1000),
                overflowed ? "  *** BUFFER OVERFLOW — capture truncated ***" : "",
                almostFull ? "  (drained early: buffer near full)" : "");

  // Gap since the previous burst — the discriminator between two competing
  // explanations of the two observed transmitter IDs:
  //   tens of ms  -> causal pair: hub commands, siren ACKNOWLEDGES
  //   seconds     -> independent transmissions (e.g. two separate sirens)
  // The device firmware cannot answer this: it logs arrival order, not timing.
  static uint32_t sPrevBurstEndUs = 0;
  if (sPrevBurstEndUs != 0) {
    uint32_t gapMs = (ts[0] - sPrevBurstEndUs) / 1000;
    Serial.printf("  gap since previous burst: %lums%s\n", (unsigned long)gapMs,
                  gapMs < 500 ? "   <-- TIGHT: likely a response to the previous burst"
                              : "");
  }
  sPrevBurstEndUs = ts[n - 1];

  printHistogram(ts, lv, n);
  printGapStructure(ts, lv, n);
  tryKeruiDecode(ts, lv, n);
  printIdTransitions(ts, lv, n);

  // Raw head of the burst — the ground truth, in case every assumption above
  // is wrong about this transmitter.
  Serial.println("  first 40 edges:");
  for (int i = 0; i < 40 && i < n - 1; i++) {
    Serial.printf("    %3d %s %6luus\n", i, lv[i] ? "HIGH" : "LOW ",
                  (unsigned long)(ts[i + 1] - ts[i]));
  }
  Serial.println();
}
