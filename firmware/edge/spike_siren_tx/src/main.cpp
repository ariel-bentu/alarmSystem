// spike_siren_tx — THROWAWAY DIAGNOSTIC.
//
// Goal: learn to TRANSMIT Kerui packets, and find which captured code sounds
// the wireless siren.
//
// Captured during an app-triggered SOS on/off (two transmitters, static codes):
//     0x622374   id 0x62237  nibble 4     <- SOS on?
//     0x3F0108   id 0x3F010  nibble 8     <- SOS on?
//     0x3F0102   id 0x3F010  nibble 2     <- off?
//     0x622372   id 0x62237  nibble 2     <- off?
// Nibble 4/8 appeared once each at the start, nibble 2 four times after,
// so 4/8 = activate and 2 = deactivate is the working hypothesis.
//
// The receiver stays ACTIVE between transmissions, so if the siren (or hub)
// answers a command, we see it. That tests the "the siren acknowledges"
// idea as a side effect of the transmit experiment.
//
// STATUS (2026-08-28): board-to-board TX is PROVEN — 'g' sends 0x622374 and a
// second board decodes it 5/5. Whether these codes actually drive the W184
// siren is UNTESTED. Transmitting may sound a real siren; the off code is
// sent automatically after each on code, and 'x' sends every known off code.
//
// Two hardware findings that made this work (see CLAUDE.md):
//   - async serial TX via GDO0 radiates NOTHING on this wiring (-86dBm);
//     the FIFO path reads -19dBm. GDO2 is not connected on this module.
//   - FREND0 must be 0x11 or the PA holds continuous carrier.
//   - the RECEIVED pulse width tracks the GAP, not the pulse, so the bit is
//     encoded in the carrier-off gap with a constant keying pulse.
//
// Wiring (unchanged): GPIO10=CS, GPIO12=SCK, GPIO11=MOSI, GPIO13=MISO, GPIO4=GDO0.

#include <Arduino.h>
#include <SPI.h>

static const uint8_t kCsPin   = 10;
static const uint8_t kGdo0Pin = 4;

// --- Kerui timing, measured from real hardware (see CLAUDE.md) -------------
// Async serial mode (IOCFG0=0x0D on RX): GDO0 LOW = carrier present.
// A bit is encoded in the LOW (carrier-on) duration; HIGH is a fixed gap.
//   SHORT carrier ~400us  = bit 1
//   LONG  carrier ~1200us = bit 0
//   inter-bit gap ~400us  (carrier off)
//   delimiter    ~12400us (carrier off) between packet repetitions
// Tunable: the receiver clips the leading/trailing edge of every carrier-ON
// pulse (measured: a commanded 400us arrives as ~348us, while the 400us gap
// arrives as ~1218us). Compensating on the TX side — longer ON, shorter gap —
// makes the pulses arrive at the intended durations.
static uint32_t kShortUs     = 400;   // carrier on, bit 1
static uint32_t kLongUs      = 1200;  // carrier on, bit 0
static uint32_t kGapUs       = 400;   // carrier off, between bits
static uint32_t kDelimiterUs = 12400; // carrier off, between copies
static int32_t  gOnAdjust    = 0;     // us added to every carrier-ON pulse
static int32_t  gGapAdjust   = 0;     // us added to every carrier-OFF gap
static const int      kBits        = 24;
static const int      kRepeats     = 3;     // keep one burst inside the receiver's capture window

// --- RX capture (unchanged from the sniffer) -------------------------------
static const int kBufSize = 1024;
static volatile uint32_t gTs[kBufSize];
static volatile uint8_t  gLv[kBufSize];
static volatile int      gCount = 0;
static volatile uint32_t gLastEdgeMs = 0;

void IRAM_ATTR onEdge() {
  if (gCount < kBufSize) {
    gTs[gCount] = (uint32_t)esp_timer_get_time();
    gLv[gCount] = (GPIO.in >> kGdo0Pin) & 1;
    gCount++;
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

// Registers shared by RX and TX.
// MDMCFG4/MDMCFG3 set the modem's data rate. In async serial TX the chip
// still filters the bit-banged stream at this rate, so a mismatch against
// our 400us/1200us pulses mangles them. Runtime-tunable to find the fit.
static uint8_t gMdmcfg4 = 0x87;  // default: ~4.8 kBaud (the RX setting)
static uint8_t gMdmcfg3 = 0x32;

// PKTCTRL0 bit 5:4 = PKT_FORMAT (3 = async serial), bit 1:0 = LENGTH_CONFIG.
//   0x32 -> async + infinite-packet (a FIFO mode; can underflow and drop TX)
//   0x30 -> async + fixed-length    (pure GDO0 path, no FIFO involvement)
// The chip should take data only from GDO0 in async serial, so the FIFO
// length mode is suspect. Runtime-tunable to test both.
static uint8_t gPktctrl0 = 0x30;

// MDMCFG2 selects modulation and sync mode. The carrier not following GDO0
// at all points here — it is the last untested register in the async path.
//   0x30 = OOK/ASK, no sync   (what RX uses)
//   0x03 = 2-FSK, 30/32 sync  (wrong modulation, useful as a contrast)
static uint8_t gMdmcfg2 = 0x30;

static void writeCommonConfig() {
  spiWrite(0x08, gPktctrl0);
  spiWrite(0x0D, 0x10);  // FREQ2
  spiWrite(0x0E, 0xB0);  // FREQ1
  spiWrite(0x0F, 0x71);  // FREQ0 -> 433.92MHz
  spiWrite(0x12, gMdmcfg2);
  spiWrite(0x10, gMdmcfg4);
  spiWrite(0x11, gMdmcfg3);
  spiWrite(0x03, 0x07);  // FIFOTHR
  spiWrite(0x1B, 0x03);  // AGCCTRL2
  spiWrite(0x1C, 0x00);  // AGCCTRL1
  spiWrite(0x1D, 0x91);  // AGCCTRL0
  // MCSM0 FS_AUTOCAL (bits 5:4): 1 = calibrate on every IDLE->TX/RX.
  // With TXOFF now returning to IDLE that recalibration fires mid-burst
  // and stalls the PA. 0x08 = calibrate only when LEAVING TX/RX.
  spiWrite(0x18, 0x08);  // MCSM0: FS_AUTOCAL on exit, not on entry
}

// RX: GDO0 is an OUTPUT from the CC1101 carrying the demodulated bitstream.
static void enterRxMode() {
  strobe(0x36);          // SIDLE
  spiWrite(0x02, 0x0D);  // IOCFG0: async serial data output
  spiWrite(0x21, 0xB6);  // FREND1: RX front-end
  spiWrite(0x17, 0x30);  // MCSM1: stay in RX after packet
  writeCommonConfig();
  pinMode(kGdo0Pin, INPUT);
  strobe(0x34);          // SRX
  // Wait for the radio to actually reach RX (0x0D) rather than assuming it.
  // A fixed short delay can catch it mid-CALIBRATE (0x08) and mislead.
  for (int i = 0; i < 100; i++) {
    if ((spiReadStatus(0x35) & 0x1F) == 0x0D) break;
    delayMicroseconds(200);
  }
  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);
}

// TX: GDO0 becomes an INPUT to the CC1101 — we drive it, and the chip keys
// the carrier to follow it. Note the inversion vs RX: here HIGH = carrier on.
static void enterTxMode() {
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36);          // SIDLE
  spiWrite(0x02, 0x2D);  // IOCFG0: GDO0 = async serial data INPUT
  spiWrite(0x21, 0x56);  // FREND1: TX
  // MCSM1 TXOFF_MODE (bits 1:0) = 0 -> return to IDLE after TX. With
  // 0x30 the radio stayed in TX and the PA latched on, which is why
  // fast keying failed even after FREND0 fixed the slow case.
  spiWrite(0x17, 0x00);  // MCSM1: TXOFF=IDLE, no CCA gating
  writeCommonConfig();
  // For OOK the PA must switch between two PATABLE entries: index 0 = off
  // (0x00) and index 1 = on. FREND0's PA_POWER field selects the "on" index,
  // so it MUST be 0x11 — the previous code never set FREND0 at all, leaving
  // the PA pointed at a single entry, which is why the carrier stayed on
  // continuously regardless of GDO0.
  spiWrite(0x22, 0x11);       // FREND0: PA_POWER = 1 -> use PATABLE[1] for ON
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40);  // PATABLE burst write
  SPI.transfer(0x00);         // index 0 = carrier OFF
  SPI.transfer(0xC0);         // index 1 = carrier ON (~+10dBm)
  digitalWrite(kCsPin, HIGH);

  pinMode(kGdo0Pin, OUTPUT);
  digitalWrite(kGdo0Pin, LOW);  // carrier off
  strobe(0x35);                 // STX
  // Wait for TX (0x13) before bit-banging — transmitting during PLL settle
  // would corrupt the leading bits of every packet.
  uint8_t st = 0;
  for (int i = 0; i < 100; i++) {
    st = spiReadStatus(0x35) & 0x1F;
    if (st == 0x13) break;
    delayMicroseconds(200);
  }
  if (st != 0x13) Serial.printf("    [warn] MARCSTATE=0x%02X, expected 0x13 TX\n", st);

  // Read back the registers that govern async TX. A write that does not
  // stick (or a value the chip rejects) would explain the carrier failing
  // to follow GDO0 at all.
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x02 | 0x80);
  uint8_t rbIocfg0 = SPI.transfer(0);
  digitalWrite(kCsPin, HIGH);
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x08 | 0x80);
  uint8_t rbPkt = SPI.transfer(0);
  digitalWrite(kCsPin, HIGH);
  if (rbIocfg0 != 0x2D || rbPkt != gPktctrl0)
    Serial.printf("    [tx] REGISTER MISMATCH IOCFG0=0x%02X PKTCTRL0=0x%02X\n",
                  rbIocfg0, rbPkt);
}

// Which GDO0 level the CC1101 keys the carrier ON for, in TX async mode.
// The datasheet says HIGH, but this is the one assumption not verified against
// this hardware — 'p' flips it and 'l' runs a loopback test to settle it.
static bool gTxCarrierHigh = true;

// Drive the carrier on/off for a duration, honouring the polarity setting.
static inline void carrier(bool on, uint32_t us) {
  digitalWrite(kGdo0Pin, (on == gTxCarrierHigh) ? HIGH : LOW);
  delayMicroseconds(us);
}

// Send one 24-bit code, repeated kRepeats times.
//
// Frame matches what the RECEIVER measures (CLAUDE.md, measured on hardware):
//   delimiter:  carrier ON  ~12400us   (decoder: "LOW >5ms" = carrier present)
//   per bit:    carrier OFF ~400us     (decoder: the "HIGH ~400us" gap)
//               carrier ON  400/1200us (decoder: LOW duration encodes the bit)
//
// NOTE: an earlier version drove the VARIABLE duration on the carrier-off
// phase and the fixed gap on carrier-on — i.e. it swapped which phase carries
// the data. That is why the first attempt decoded as 0x7BFFFF (all-ones).
static void transmitCode(uint32_t code) {
  enterTxMode();

  uint32_t t0 = micros();
  for (int r = 0; r < kRepeats; r++) {
    // The receiver measures the delimiter as a >5ms CARRIER-ON period, but
    // sustaining a 12.4ms PA burst is exactly what this module fails at
    // (measured: delimiters never arrive, while 400us/1200us bits do).
    // Build it from repeated short pulses instead of one long one, so the
    // PA is re-keyed rather than held.
    // 20 x 1000us: comfortably past the receiver's 5ms delimiter threshold
    // even when the PA droops (measured 6.4ms delivered from 12 chunks).
    for (int k = 0; k < 20; k++) {
      carrier(true, 1000);
      carrier(true, 0);   // re-assert without releasing
    }
    carrier(false, 400);  // separate the delimiter from the first bit
    carrier(false, 400);  // separate the delimiter from the first bit

    for (int b = kBits - 1; b >= 0; b--) {  // MSB first, matching the decoder
      bool one = (code >> b) & 1;
      int32_t gap = (int32_t)kGapUs + gGapAdjust;
      int32_t on  = (int32_t)(one ? kShortUs : kLongUs) + gOnAdjust;
      if (gap < 50) gap = 50;
      if (on  < 50) on  = 50;
      carrier(false, (uint32_t)gap);        // fixed inter-bit gap
      carrier(true,  (uint32_t)on);         // duration encodes the bit
    }
  }
  uint32_t elapsed = micros() - t0;

  // Confirm the radio actually STAYED in TX for the whole burst. If it
  // dropped out (underflow, or an unexpected state change) the carrier
  // stops keying and only fragments get radiated.
  uint8_t endState = spiReadStatus(0x35) & 0x1F;
  if (endState != 0x13)
    Serial.printf("    [tx] LEFT TX! MARCSTATE=0x%02X at end of burst\n", endState);

  // Expected wall-clock: kRepeats * (delimiter + 24 * (gap + avg bit)).
  // A large shortfall means the pin is not being driven for as long as
  // asked — the loop itself, not the radio, is then the problem.
  uint32_t expected = kRepeats * (kDelimiterUs + kBits * (kGapUs + (kShortUs + kLongUs) / 2));
  (void)elapsed; (void)expected;

  carrier(false, 200);
  strobe(0x36);  // SIDLE
  enterRxMode();
}

// --- RX decode, for observing replies --------------------------------------
static void drainAndReport(const char* context) {
  if (gCount == 0) return;
  uint32_t nowMs = (uint32_t)(esp_timer_get_time() / 1000);
  if (nowMs - gLastEdgeMs < 200) return;  // burst still arriving

  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  int n = gCount;
  static uint32_t ts[kBufSize];
  static uint8_t  lv[kBufSize];
  memcpy(ts, (void*)gTs, n * sizeof(uint32_t));
  memcpy(lv, (void*)gLv, n * sizeof(uint8_t));
  gCount = 0;
  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);

  if (n < 20) return;

  const uint32_t kDelimUs = 5000, kThresh = 700;
  uint32_t lastId = 0;
  int found = 0;
  for (int i = 0; i < n - 1; i++) {
    if (lv[i] == 0 && (ts[i + 1] - ts[i]) > kDelimUs) {
      int start = i + 1;
      if (start + kBits * 2 > n) break;
      uint32_t id = 0;
      bool valid = true;
      for (int b = 0; b < kBits; b++) {
        int hi = start + b * 2, lo = hi + 1;
        if (lo + 1 >= n || lv[hi] != 1 || lv[lo] != 0) { valid = false; break; }
        id = (id << 1) | ((ts[lo + 1] - ts[lo]) < kThresh ? 1u : 0u);
      }
      if (valid) {
        if (found == 0 || id != lastId)
          Serial.printf("    <<< RX %s: 0x%06X (id 0x%05X nibble %X)\n",
                        context, id, id >> 4, id & 0xF);
        lastId = id;
        found++;
      }
    }
  }
  if (found > 1) Serial.printf("    (%d copies)\n", found);
}

// Listen for `ms`, reporting anything received.
static void listenFor(uint32_t ms, const char* context) {
  uint32_t until = millis() + ms;
  while ((int32_t)(until - millis()) > 0) {
    drainAndReport(context);
    delay(10);
  }
  drainAndReport(context);
}

static void fifoSendCode(uint32_t code);  // defined below; the working TX path

struct Code { uint32_t value; const char* note; };
static const Code kOnCodes[] = {
  { 0x622374, "id 0x62237 nibble 4" },
  { 0x3F0108, "id 0x3F010 nibble 8" },
};
static const Code kOffCodes[] = {
  { 0x622372, "id 0x62237 nibble 2" },
  { 0x3F0102, "id 0x3F010 nibble 2" },
};

static void sendAllOff() {
  Serial.println(">>> sending ALL off codes");
  for (auto& c : kOffCodes) {
    Serial.printf("  TX 0x%06X (%s)\n", c.value, c.note);
    fifoSendCode(c.value);
    listenFor(1500, "after off");
  }
}

// Send one on-code, watch for a reply, then send its MATCHING off-code
// (same 20-bit id, nibble 2) — not the other transmitter's.
//
// Uses fifoSendCode, NOT transmitCode: the GDO0 async-serial path radiates
// nothing on this wiring (-86dBm vs -19dBm, measured). transmitCode is kept
// only as the record of that dead end.
static void runPair(int index) {
  const Code& on  = kOnCodes[index];
  const Code& off = kOffCodes[index];

  Serial.println();
  Serial.println("=========================================================");
  Serial.printf(">>> TX ON  0x%06X (%s)\n", on.value, on.note);
  fifoSendCode(on.value);

  Serial.println("    listening 8s — IS THE SIREN SOUNDING?");
  listenFor(8000, "after ON");

  Serial.printf(">>> TX OFF 0x%06X (%s)\n", off.value, off.note);
  fifoSendCode(off.value);
  listenFor(3000, "after OFF");
  Serial.println("    (did the siren stop?)");
}

// Transmit a known code and check whether OUR OWN receiver decodes it back.
// This separates "is my TX well-formed?" from "does the siren care?" — the
// two questions that were tangled together in the first attempt.
static void loopbackTest() {
  const uint32_t kTestCode = 0x622374;
  Serial.println();
  Serial.println(">>> LOOPBACK TEST — transmit, then decode our own signal");
  Serial.printf("    polarity: carrier ON = GDO0 %s\n", gTxCarrierHigh ? "HIGH" : "LOW");

  gCount = 0;
  transmitCode(kTestCode);

  // Give the burst time to land, then decode whatever was captured.
  delay(300);
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  int n = gCount;
  static uint32_t ts[kBufSize];
  static uint8_t  lv[kBufSize];
  if (n > kBufSize) n = kBufSize;
  memcpy(ts, (void*)gTs, n * sizeof(uint32_t));
  memcpy(lv, (void*)gLv, n * sizeof(uint8_t));
  gCount = 0;
  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);

  Serial.printf("    captured %d edges\n", n);
  if (n < 20) {
    Serial.println("    FAIL: almost nothing captured — TX not radiating, or");
    Serial.println("          the receiver is deaf while transmitting.");
    Serial.println("          Try 'p' to flip polarity, then 'l' again.");
    return;
  }

  const uint32_t kDelimUs = 5000, kThresh = 700;
  int matches = 0, decoded = 0;
  for (int i = 0; i < n - 1; i++) {
    if (lv[i] == 0 && (ts[i + 1] - ts[i]) > kDelimUs) {
      int start = i + 1;
      if (start + kBits * 2 > n) break;
      uint32_t id = 0;
      bool valid = true;
      for (int b = 0; b < kBits; b++) {
        int hi = start + b * 2, lo = hi + 1;
        if (lo + 1 >= n || lv[hi] != 1 || lv[lo] != 0) { valid = false; break; }
        id = (id << 1) | ((ts[lo + 1] - ts[lo]) < kThresh ? 1u : 0u);
      }
      if (valid) {
        decoded++;
        if (id == kTestCode) matches++;
        else if (decoded <= 3) Serial.printf("    decoded 0x%06X (expected 0x%06X)\n", id, kTestCode);
      }
    }
  }

  if (matches > 0) {
    Serial.printf("    PASS: %d/%d copies decoded as 0x%06X — TX IS CORRECT.\n",
                  matches, decoded, kTestCode);
    Serial.println("    If the siren still ignores it, the code/nibble is wrong,");
    Serial.println("    not the transmitter.");
  } else if (decoded > 0) {
    Serial.printf("    FAIL: %d packets decoded, none matched. Framing is wrong.\n", decoded);
    Serial.println("          Try 'p' to flip polarity, then 'l' again.");
  } else {
    Serial.println("    FAIL: edges captured but no packet framing found.");
    Serial.println("          Try 'p' to flip polarity, then 'l' again.");
    Serial.println("    first 30 edges:");
    for (int i = 0; i < 30 && i < n - 1; i++)
      Serial.printf("      %2d %s %6luus\n", i, lv[i] ? "HIGH" : "LOW ",
                    (unsigned long)(ts[i + 1] - ts[i]));
  }
}

// Sweep candidate data-rate settings, transmitting a known code at each.
// The INDEPENDENT receiver reports which setting yields clean 400/1200us
// pulses — something this board cannot judge about its own transmission.
struct RateOpt { uint8_t m4, m3; const char* note; };
static const RateOpt kRates[] = {
  { 0x87, 0x32, "~4.8 kBaud  (current RX setting)" },
  { 0x86, 0x32, "~2.4 kBaud" },
  { 0x85, 0x32, "~1.2 kBaud" },
  { 0x88, 0x32, "~9.6 kBaud" },
  { 0x8A, 0x32, "~38 kBaud" },
  { 0x8C, 0x22, "~100 kBaud (minimal filtering)" },
};

static void sweepRates() {
  const uint32_t kTestCode = 0x622374;
  uint8_t save4 = gMdmcfg4, save3 = gMdmcfg3;
  Serial.println();
  Serial.println(">>> DATA-RATE SWEEP — watch the OTHER board for a clean decode");
  for (auto& r : kRates) {
    gMdmcfg4 = r.m4;
    gMdmcfg3 = r.m3;
    Serial.printf("    MDMCFG4=0x%02X MDMCFG3=0x%02X  %s\n", r.m4, r.m3, r.note);
    transmitCode(kTestCode);
    delay(1200);  // let the receiver print its verdict before the next burst
  }
  gMdmcfg4 = save4;
  gMdmcfg3 = save3;
  Serial.println("    sweep done — restored original rate.");
}

// Transmit deliberately SLOW, unambiguous pulses (50ms on / 50ms off).
// This separates "does the chip key the carrier at all?" from "does it keep
// up with 400us switching?" — at 50ms nothing can be blamed on timing
// resolution, filtering or data rate. If the receiver does not report ~50ms
// pulses, the carrier is not following GDO0 and the fault is upstream of
// any protocol detail.
static void slowPulseTest() {
  Serial.println();
  Serial.println(">>> SLOW PULSE TEST — 6x (50ms carrier ON, 50ms OFF)");
  Serial.println("    the other board should report ~50000us pulses");
  enterTxMode();
  for (int i = 0; i < 6; i++) {
    // delayMicroseconds is unreliable above ~16ms, so use delay() here.
    digitalWrite(kGdo0Pin, gTxCarrierHigh ? HIGH : LOW);
    delay(50);
    digitalWrite(kGdo0Pin, gTxCarrierHigh ? LOW : HIGH);
    delay(50);
  }
  carrier(false, 200);
  strobe(0x36);
  enterRxMode();
  Serial.println("    sent.");
}

// Sweep the registers that could stop the carrier following GDO0, running
// the unambiguous slow-pulse test at each. The other board reports the
// longest carrier-ON: ~50000us means that combination WORKS.
struct TxCfg { uint8_t iocfg0, pktctrl0, mdmcfg2; const char* note; };
static const TxCfg kTxCfgs[] = {
  { 0x2D, 0x30, 0x30, "IOCFG0=2D async-in, PKT=fixed,    OOK no-sync" },
  { 0x2D, 0x32, 0x30, "IOCFG0=2D async-in, PKT=infinite, OOK no-sync" },
  { 0x2E, 0x30, 0x30, "IOCFG0=2E (3-state),PKT=fixed,    OOK no-sync" },
  { 0x0D, 0x30, 0x30, "IOCFG0=0D (as RX),  PKT=fixed,    OOK no-sync" },
  { 0x2D, 0x30, 0x32, "IOCFG0=2D async-in, PKT=fixed,    OOK 15/16 sync" },
  { 0x2D, 0x22, 0x30, "IOCFG0=2D async-in, PKT=random,   OOK no-sync" },
};

static void sweepTxConfigs() {
  uint8_t s0 = gPktctrl0, s2 = gMdmcfg2;
  Serial.println();
  Serial.println(">>> TX CONFIG SWEEP — slow 50ms pulses at each setting");
  Serial.println("    WATCH THE OTHER BOARD: 'longest carrier-ON ~50000us' = WORKING");
  for (auto& c : kTxCfgs) {
    Serial.printf("\n    --- %s\n", c.note);
    gPktctrl0 = c.pktctrl0;
    gMdmcfg2  = c.mdmcfg2;

    detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
    strobe(0x36);
    spiWrite(0x02, c.iocfg0);
    spiWrite(0x21, 0x56);
    spiWrite(0x17, 0x30);
    writeCommonConfig();
    digitalWrite(kCsPin, LOW);
    SPI.transfer(0x3E | 0x40);
    SPI.transfer(0xC0);
    digitalWrite(kCsPin, HIGH);
    pinMode(kGdo0Pin, OUTPUT);
    digitalWrite(kGdo0Pin, LOW);
    strobe(0x35);
    delay(2);

    for (int i = 0; i < 4; i++) {
      digitalWrite(kGdo0Pin, gTxCarrierHigh ? HIGH : LOW);
      delay(50);
      digitalWrite(kGdo0Pin, gTxCarrierHigh ? LOW : HIGH);
      delay(50);
    }
    strobe(0x36);
    delay(900);  // let the receiver report before the next combination
  }
  gPktctrl0 = s0;
  gMdmcfg2  = s2;
  enterRxMode();
  Serial.println("\n    sweep done.");
}

// Can the ESP32 actually DRIVE GPIO4, or is the CC1101 holding it? Every TX
// config produced an unmodulated carrier, which is what you would see if
// GDO0 never changes state. Drive it and read it back to find out — this
// tests the pin itself, independent of any radio behaviour.
static void pinDriveTest() {
  Serial.println();
  Serial.println(">>> GPIO4 DRIVE TEST");

  // First with the radio idle.
  strobe(0x36);
  delay(2);
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  pinMode(kGdo0Pin, OUTPUT);
  digitalWrite(kGdo0Pin, HIGH); delayMicroseconds(50);
  int hiIdle = digitalRead(kGdo0Pin);
  digitalWrite(kGdo0Pin, LOW);  delayMicroseconds(50);
  int loIdle = digitalRead(kGdo0Pin);
  Serial.printf("    radio IDLE: drove HIGH->read %d, drove LOW->read %d  %s\n",
                hiIdle, loIdle,
                (hiIdle == 1 && loIdle == 0) ? "pin is drivable" : "*** PIN STUCK ***");

  // Then in TX, where the CC1101 may be contending for the pin.
  spiWrite(0x02, 0x2D);
  writeCommonConfig();
  pinMode(kGdo0Pin, OUTPUT);
  digitalWrite(kGdo0Pin, LOW);
  strobe(0x35);
  delay(2);
  digitalWrite(kGdo0Pin, HIGH); delayMicroseconds(50);
  int hiTx = digitalRead(kGdo0Pin);
  digitalWrite(kGdo0Pin, LOW);  delayMicroseconds(50);
  int loTx = digitalRead(kGdo0Pin);
  uint8_t st = spiReadStatus(0x35) & 0x1F;
  Serial.printf("    radio TX:   drove HIGH->read %d, drove LOW->read %d  (MARCSTATE=0x%02X)  %s\n",
                hiTx, loTx, st,
                (hiTx == 1 && loTx == 0) ? "pin is drivable" : "*** PIN STUCK — CC1101 is holding GDO0 ***");
  strobe(0x36);
  enterRxMode();
}

// Sweep TX-side timing compensation. The receiver clips carrier-ON pulses
// and stretches gaps, so bit-0 (1200us) pulses arrive under the 700us
// decision threshold and every bit reads as 1. Lengthening ON while
// shortening the gap should make 0x622374 decode correctly on the other board.
struct Adj { int32_t on, gap; };
static const Adj kAdjs[] = {
  {   0,    0 },
  { 200, -200 },
  { 400, -300 },
  { 600, -300 },
  { 800, -300 },
  { 400,    0 },
  { 800, -200 },
};

// Grid over the registers that govern PA ramping and OOK decay, plus the
// PATABLE power level. Judged only by whether the other board decodes
// 0x622374 — individual register tuning has hit diminishing returns.
struct PaCfg { uint8_t frend0, patable, mdmcfg4; const char* note; };
static const PaCfg kPaCfgs[] = {
  { 0x11, 0xC0, 0x87, "FREND0=11 PA=C0 rate=87" },
  { 0x11, 0x60, 0x87, "FREND0=11 PA=60 (lower power)" },
  { 0x11, 0xC0, 0xF7, "FREND0=11 PA=C0 rate=F7 (slower)" },
  { 0x11, 0xC0, 0x57, "FREND0=11 PA=C0 rate=57 (faster)" },
  { 0x10, 0xC0, 0x87, "FREND0=10 PA=C0" },
  { 0x11, 0x50, 0x87, "FREND0=11 PA=50" },
  { 0x11, 0x84, 0x87, "FREND0=11 PA=84" },
  { 0x11, 0xC0, 0xC7, "FREND0=11 PA=C0 rate=C7" },
};

static void sweepPa() {
  Serial.println();
  Serial.println(">>> PA/RAMP SWEEP — target decode 0x622374 on the other board");
  uint8_t save4 = gMdmcfg4;
  for (auto& c : kPaCfgs) {
    Serial.printf("    %s\n", c.note);
    gMdmcfg4 = c.mdmcfg4;

    detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
    strobe(0x36);
    spiWrite(0x02, 0x2D);
    spiWrite(0x21, 0x56);
    spiWrite(0x17, 0x00);
    writeCommonConfig();
    spiWrite(0x22, c.frend0);
    digitalWrite(kCsPin, LOW);
    SPI.transfer(0x3E | 0x40);
    SPI.transfer(0x00);
    SPI.transfer(c.patable);
    digitalWrite(kCsPin, HIGH);
    pinMode(kGdo0Pin, OUTPUT);
    digitalWrite(kGdo0Pin, LOW);
    strobe(0x35);
    delay(2);

    for (int r = 0; r < 6; r++) {
      carrier(true, kDelimiterUs);
      for (int b = kBits - 1; b >= 0; b--) {
        bool one = (0x622374u >> b) & 1;
        carrier(false, kGapUs);
        carrier(true, one ? kShortUs : kLongUs);
      }
    }
    carrier(false, 200);
    strobe(0x36);
    delay(1300);
  }
  gMdmcfg4 = save4;
  enterRxMode();
  Serial.println("    sweep done.");
}

static void sweepTiming() {
  int32_t s1 = gOnAdjust, s2 = gGapAdjust;
  Serial.println();
  Serial.println(">>> TIMING SWEEP — target decode is 0x622374 on the other board");
  for (auto& a : kAdjs) {
    gOnAdjust  = a.on;
    gGapAdjust = a.gap;
    Serial.printf("    on%+ldus gap%+ldus\n", (long)a.on, (long)a.gap);
    transmitCode(0x622374);
    delay(1300);
  }
  gOnAdjust  = s1;
  gGapAdjust = s2;
  Serial.println("    sweep done.");
}

// Measure how long carrier() ACTUALLY holds the pin, using the same call
// path as transmitCode. Pulses have been arriving at roughly 1/5th of the
// commanded duration, and the slow test (which used delay(), not
// delayMicroseconds) was accurate — so verify the fast path directly.
// DEVIATN (0x15) and the RX-side OOK decay in AGCCTRL were never set for TX.
// The ESP32 pin timing is provably exact, so the envelope distortion is
// inside the CC1101. Sweep the remaining envelope-shaping registers.
struct EnvCfg { uint8_t deviatn, agcctrl2, agcctrl1, agcctrl0; const char* note; };
static const EnvCfg kEnvCfgs[] = {
  { 0x15, 0x03, 0x00, 0x91, "DEVIATN=15 (default) agc as-is" },
  { 0x00, 0x03, 0x00, 0x91, "DEVIATN=00" },
  { 0x15, 0x07, 0x00, 0x91, "AGCCTRL2=07 (max gain)" },
  { 0x15, 0x03, 0x00, 0x92, "AGCCTRL0=92" },
  { 0x15, 0x03, 0x40, 0x91, "AGCCTRL1=40" },
  { 0x15, 0xC7, 0x00, 0xB2, "TI OOK-recommended AGC" },
};

static void sweepEnvelope() {
  Serial.println();
  Serial.println(">>> ENVELOPE SWEEP — target decode 0x622374 on the other board");
  for (auto& c : kEnvCfgs) {
    Serial.printf("    %s\n", c.note);
    detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
    strobe(0x36);
    spiWrite(0x02, 0x2D);
    spiWrite(0x21, 0x56);
    spiWrite(0x17, 0x00);
    writeCommonConfig();
    spiWrite(0x15, c.deviatn);
    spiWrite(0x1B, c.agcctrl2);
    spiWrite(0x1C, c.agcctrl1);
    spiWrite(0x1D, c.agcctrl0);
    spiWrite(0x22, 0x11);
    digitalWrite(kCsPin, LOW);
    SPI.transfer(0x3E | 0x40);
    SPI.transfer(0x00);
    SPI.transfer(0xC0);
    digitalWrite(kCsPin, HIGH);
    pinMode(kGdo0Pin, OUTPUT);
    digitalWrite(kGdo0Pin, LOW);
    strobe(0x35);
    delay(2);

    for (int r = 0; r < 6; r++) {
      carrier(true, kDelimiterUs);
      for (int b = kBits - 1; b >= 0; b--) {
        bool one = (0x622374u >> b) & 1;
        carrier(false, kGapUs);
        carrier(true, one ? kShortUs : kLongUs);
      }
    }
    carrier(false, 200);
    strobe(0x36);
    delay(1300);
  }
  enterRxMode();
  Serial.println("    sweep done.");
}

// Hold an unmodulated carrier so the other board can read a steady RSSI.
// At ~10cm with a working PA this should read around -30dBm; the measured
// -86dBm during packets is the noise floor, so this isolates whether the
// PA is producing any output at all.
// Transmit via the FIFO instead of async-serial/GDO0. This removes GDO0
// from the path entirely: if the PA still radiates nothing here, the fault
// is the module's RF output, not the async serial configuration.
// Transmit a Kerui packet through the TX FIFO.
//
// Async serial via GDO0 does not work on this wiring (proven: continuous
// carrier reads -86dBm at the receiver, while FIFO TX reads -19dBm), so the
// pulse timing is encoded as a BIT PATTERN instead. In OOK each FIFO bit is
// one symbol period of carrier on (1) or off (0), so a 100us symbol makes:
//   400us  = 4 bits,  1200us = 12 bits,  12400us = 124 bits
// MDMCFG4/3 are set for ~10 kBaud to give that 100us symbol.
// Measured on hardware: with MDMCFG4=0x88/MDMCFG3=0x22 a nominal 400us
// pulse (4 symbols) arrived as ~670us, i.e. the true symbol period is
// ~167us rather than the datasheet-derived 100us. Use the measured
// value so 400us and 1200us land either side of the 700us threshold.
// The TRUE symbol period at MDMCFG4=0x88/MDMCFG3=0x22, measured on hardware:
// a nominal 400us pulse (4 symbols at the datasheet-derived 100us) arrived as
// ~670us, i.e. ~167us per symbol. Using 100 here inflated every duration by
// ~30% — the hub's 890us long pulse went out as ~1205us and its 930us long gap
// as ~1170us, blurring the two symbol shapes into each other. push() divides
// by this value, so it must be the REAL period for the requested microsecond
// durations to survive quantisation.
// Bracketed empirically against the hub's measured 890us long pulse:
//   kSymbolUs=100 -> arrived ~1205us (1.35x too long)
//   kSymbolUs=167 -> arrived  ~640us (0.72x too short)
// Both bracket 1.0x at ~125-135us, so use 125 and verify against the hub's
// numbers rather than trusting any datasheet-derived figure. push() divides
// requested microseconds by this, so it sets the scale of the whole frame.
// Halved alongside MDMCFG4 0x88 -> 0x89 (double data rate) to get ~62us
// quantisation steps instead of ~125us. See the note at the MDMCFG4 write.
static uint32_t kSymbolUs = 62;
// The receiver splits bits at 700us, but both nominal pulse widths were
// landing above it. Exaggerate the ratio for the FIFO path so the two
// populations sit clearly either side of the threshold; the sensor's own
// 400/1200us values are what the DECODER expects, not what the PA delivers.
// Measured: whatever ratio is requested, pulses arrive ~500us wide, so the
// demodulator is resolving roughly one symbol. Push the long pulse far out
// (25 symbols vs 2) so even heavy normalisation leaves them distinguishable.
// The width probe proved the FIFO reproduces widths faithfully (2000us
// transmitted -> 2042/2046/2036us received) when pulses are separated by a
// generous gap. With only a 400us gap consecutive pulses merged into a
// uniform ~490us stream, which is why every bit decoded as 1.
// Bracketed empirically: gap 400us merged everything to ~490us (all bits 1),
// gap 900us pushed everything to ~1200us (all bits 0). The received width
// tracks the GAP more than the pulse, so keep the gap short and separate the
// two pulse widths widely instead.
// The AGC needs recovery time between pulses: after the delimiter only the
// FIRST bit came through correctly (2723us = a real 0) before every
// subsequent pulse flattened to ~640us. A long inter-bit gap gives the
// demodulator time to re-level before each bit.
static uint32_t kFifoShortUs = 200;
static uint32_t kFifoLongUs  = 2400;
static uint32_t kFifoGapUs   = 1500;

// The per-packet [build] dump is useful when developing the frame, but during
// a multi-candidate sweep it buries the markers that say which candidate is
// on air. Off during sweeps.
static bool gVerboseBuild = true;

// PATABLE index-1 value = the carrier-ON power level. 0xC0 is ~+10dBm (max).
// Made a variable so sweepPower() can back it off: the panel drives the siren
// at ~-40dBm while we measure -18dBm, and OOK receivers can saturate on a
// signal that is too strong, decoding nothing.
static uint8_t gPaLevel = 0xC0;

// Time-base scale in per-mille. 1000 = the timings measured from this panel
// (~1200us cell). sweepTimeBase() varies it; every width in evFifoSend scales.
static uint32_t gTimeBase = 1000;

// When set, evFifoSend uses the zoogara timings proven to pair this OEM siren
// family (sync 13100 / high 1250 / low 420) instead of the panel-matched clock.
static bool gZoogara = false;

// rtl_433's own Kerui flex params: s=333, l=972, r=11000 (see case '.').
static bool     gRtl433     = false;
static uint16_t gRtl433Sync = 11000;

// When gSeqLen > 0, evFifoSend streams this SEQUENCE of codes as one
// continuous transmission (see the comment at its frame-building loop).
static const uint32_t* gSeqCodes = nullptr;
static const int*      gSeqReps  = nullptr;
static int             gSeqLen   = 0;

// fifoSendCode writes FREQ2/1/0 itself on every call, so the frequency sweep
// needs an override here rather than a one-off register write before sending.
static bool    gFreqOverride = false;
static uint8_t gF2 = 0x10, gF1 = 0xB0, gF0 = 0x71;

static void fifoSendCode(uint32_t code) {
  // Build the on/off symbol stream for one packet repetition.
  static uint8_t bits[2048];
  int nb = 0;
  auto push = [&](bool on, uint32_t us) {
    int count = (int)(us / kSymbolUs);
    for (int i = 0; i < count && nb < (int)sizeof(bits) * 8; i++) {
      bits[nb >> 3] = (uint8_t)((bits[nb >> 3] & ~(1 << (7 - (nb & 7)))) |
                                ((on ? 1 : 0) << (7 - (nb & 7))));
      nb++;
    }
  };

  memset(bits, 0, sizeof(bits));
  // MEASURED FROM THE REAL HUB (2026-08-28, spike_packet_log waveform dump,
  // during an SOS that actually sounded the siren):
  //
  //   delimiter=9281us
  //   gap/on -> 314/857  954/291  930/311  287/890 ...
  //
  // The hub uses a CONSTANT ~1200us bit period and encodes the bit in WHICH
  // half is long — classic self-clocking PWM OOK:
  //     bit 0 -> short gap (~310us) + long pulse (~890us)
  //     bit 1 -> long gap (~930us)  + short pulse (~300us)
  //
  // An earlier version instead VARIED the bit period (constant ~470us gap,
  // ~490us pulse for 1 vs ~1620us for 0). Our own receiver decoded that
  // correctly — its rule is just "is the LOW under 700us?" — which is
  // precisely why the mismatch went unnoticed for so long: every replay read
  // back as the right code at strong RSSI while the siren ignored it. The
  // siren's decoder expects a fixed bit period and rejects a variable one.
  // Do not "simplify" this back to a variable-length encoding.
  // Delimiter. The hub's measures 9281us and is followed IMMEDIATELY by a
  // clean first bit (314/857). Ours measured 11466us with a deformed first
  // bit, because the delimiter's trailing edge and the first bit's gap merge
  // into a single long OFF period — so a decoder that starts its bit clock at
  // the delimiter edge mis-samples from bit one onward. Shorten the commanded
  // delimiter so the MEASURED total (delimiter + first gap) lands on the
  // hub's 9281us rather than overshooting it.
  push(true, 9281);
  for (int b = kBits - 1; b >= 0; b--) {
    bool one = (code >> b) & 1;
    // Each bit is (gap, pulse) — the same order the receiver reports it in,
    // and the same ~1200us total either way.
    // EV1527 requires EVERY bit to occupy the same 4 base periods (~1200us):
    // bit 1 = 3 high + 1 low, bit 0 = 1 high + 3 low. The hub complies — its
    // two symbols measure 314/857 and 954/291, both totalling ~1200us.
    //
    // Ours did NOT. Measured at the receiver: 330/230 (~560us) and 1025/910
    // (~1935us) — one bit 3.5x longer than the other. A strict EV1527 decoder
    // rejects that outright, which is exactly the binary accept/reject the
    // siren has been showing. (An earlier comparison checked gap and pulse
    // widths individually against the hub's and called it a match; the
    // invariant that actually matters is the TOTAL PER BIT.)
    //
    // The commanded frame was already equal-length (both 1125us after
    // quantisation) — the distortion happens in transmission, where OOK decay
    // clips short pulses and stretches gaps. So pre-distort: shrink the long
    // gap that arrives ~95us wide, and grow the short gap so its bit total
    // rises toward the hub's ~1200us.
    // Iteration 2. The 750us long gap still ARRIVED at ~1010-1030us — it is
    // stretched by the demodulator regardless of what is commanded — leaving
    // the long bit at ~1803us against the hub's ~1245us, while the short bit
    // already lands well (1111us vs 1171us). Cut the long gap further so the
    // stretch lands it near the hub's 954us, and trim the pulse that follows
    // it toward the hub's 291us.
    // With ~62us quantisation these can be the hub's MEASURED values directly
    // (314/857 and 954/291) rather than the pre-distorted approximations the
    // coarser 125us steps forced.
    // INVERTED 2026-08-28, same complement bug fixed in evFifoSend: the hub's
    // measured bit 0 is the LONG carrier-ON (~857us) and bit 1 the short one.
    // push(false,x) radiates as carrier-ON, so the long push(false) belongs on
    // bit 0, not bit 1.
    if (one) { push(false, 291); push(true, 954); }   // short ON, long gap  => 1
    else     { push(false, 857); push(true, 314); }   // long ON,  short gap => 0
  }
  push(false, 2000);                   // tail

  int nBytes = (nb + 7) / 8;

  // Verify the symbol stream actually encodes the code: measure the run
  // lengths of carrier-ON regions we just built. 24 bits of 0x622374 should
  // give a MIX of short and long runs, not a uniform one.
  {
    int runs[40]; int nRuns = 0;
    int i = 0;
    while (i < nb && nRuns < 40) {
      int bit = (bits[i >> 3] >> (7 - (i & 7))) & 1;
      int len = 0;
      while (i < nb && (((bits[i >> 3] >> (7 - (i & 7))) & 1) == bit)) { len++; i++; }
      if (bit) runs[nRuns++] = len;
    }
    if (gVerboseBuild) {
      Serial.printf("    [build] %d bits, %d ON-runs, lengths:", nb, nRuns);
      for (int k = 0; k < nRuns && k < 28; k++) Serial.printf(" %d", runs[k]);
      Serial.println();
    }
  }

  // Configure normal FIFO packet mode, OOK, fixed length.
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36);
  delay(2);
  spiWrite(0x02, 0x06);
  spiWrite(0x08, 0x00);  // PKTCTRL0: fixed length, no CRC, no whitening
  spiWrite(0x07, 0x00);
  // Carrier frequency. Normally 433.92MHz; the frequency sweep overrides this
  // to test whether the siren's narrow SAW receiver is centred elsewhere.
  if (gFreqOverride) { spiWrite(0x0D, gF2); spiWrite(0x0E, gF1); spiWrite(0x0F, gF0); }
  else               { spiWrite(0x0D, 0x10); spiWrite(0x0E, 0xB0); spiWrite(0x0F, 0x71); }
  // MDMCFG2 = 0x30: OOK, Manchester OFF (bit3), no sync word. Manchester
  // would re-encode every bit and destroy the pulse-width information.
  spiWrite(0x12, 0x30);
  // Symbol rate. MDMCFG4's low nibble is the data-rate exponent, so 0x89 is
  // DOUBLE the rate of 0x88 — each FIFO bit becomes half as long.
  //
  // Raised from 0x88 because at ~125us per symbol the quantisation was too
  // coarse for the precision now required: commanded long gaps of 930, 750
  // and 375us ALL arrived at ~1030us, so the hub's 954/291 shape was
  // unreachable by adjusting the requested durations. Halving the symbol
  // period gives ~62us steps and twice the resolution on both gap and pulse.
  // kSymbolUs must move with this — push() divides by it to pick symbol
  // counts, so the two are a matched pair.
  spiWrite(0x10, 0x89);
  spiWrite(0x11, 0x22);
  // MDMCFG1: NUM_PREAMBLE = 0. This was never set, so it sat at its reset
  // default 0x22 = FOUR preamble bytes, meaning the CC1101 prepended 32 bits
  // of alternating 0xAA carrier before every frame we sent. MDMCFG2=0x30
  // disables the SYNC WORD but not the preamble - they are separate fields.
  //
  // Our own receiver is blind to this: it locates a frame by hunting for the
  // long gap and decodes what follows, so leading garbage never showed up in
  // any capture. A strict receiver would see 32 bits of noise immediately
  // before the frame, which can also drag its AGC to the wrong operating point
  // right when the real data arrives. The panel tolerates it; the siren may not.
  spiWrite(0x13, 0x02);       // NUM_PREAMBLE=0, keep CHANSPC_E=2
  spiWrite(0x21, 0x56);
  spiWrite(0x22, 0x11);
  spiWrite(0x17, 0x00);
  spiWrite(0x18, 0x18);
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40);
  SPI.transfer(0x00);
  SPI.transfer(0xC0);
  digitalWrite(kCsPin, HIGH);

  // The FIFO is 64 bytes; send in chunks with infinite-length mode.
  for (int rep = 0; rep < kRepeats; rep++) {
    int sent = 0;
    strobe(0x3B);  // SFTX
    spiWrite(0x08, 0x02);  // infinite length while streaming
    int firstChunk = nBytes < 60 ? nBytes : 60;
    digitalWrite(kCsPin, LOW);
    SPI.transfer(0x3F | 0x40);
    for (int i = 0; i < firstChunk; i++) SPI.transfer(bits[i]);
    digitalWrite(kCsPin, HIGH);
    sent = firstChunk;
    strobe(0x35);  // STX

    while (sent < nBytes) {
      uint8_t txBytes = spiReadStatus(0x3A) & 0x7F;  // TXBYTES
      if (txBytes < 40) {
        int chunk = nBytes - sent;
        if (chunk > 20) chunk = 20;
        digitalWrite(kCsPin, LOW);
        SPI.transfer(0x3F | 0x40);
        for (int i = 0; i < chunk; i++) SPI.transfer(bits[sent + i]);
        digitalWrite(kCsPin, HIGH);
        sent += chunk;
      }
      delayMicroseconds(200);
    }
    // Let the FIFO drain, then stop.
    while ((spiReadStatus(0x3A) & 0x7F) > 0) delayMicroseconds(200);
    strobe(0x36);
    delay(5);
  }
  enterRxMode();
}

// --- CANONICAL EV1527 via the FIFO -----------------------------------------
//
// GPIO keying does NOT radiate on this module (-92dBm, proven — see the
// keying RSSI probe). The FIFO is the only path that reaches the air (-18dBm).
// So the canonical EV1527 frame (ref: foxel/arduino-ev1527-tx) is emitted as
// FIFO OOK symbols, NOT bit-banged. Each FIFO bit = one symbol period of
// carrier on (1) or off (0).
//
// Canonical frame, base period T = 330us:
//   sync:  HIGH 1T (330us),  then LOW 31T (10230us)   <- long carrier-OFF gap
//   bit 1: HIGH 3T (990us),  then LOW 1T (330us)
//   bit 0: HIGH 1T (330us),  then LOW 3T (990us)
//   24 bits MSB-first, 5 repeats.
//
// Departures from our OLD FIFO frame — this is why it may finally work:
//   1. sync = short HIGH + long LOW silence, not a 9ms carrier block
//   2. each bit is (HIGH)(LOW) — carrier ON FIRST — not (gap)(pulse)
//   3. strict equal 4T period per bit (the EV1527 invariant we violated)
//
// Symbol rate: the ON-AIR bit period must match the hub's MEASURED ~1200us
// (the waveform that actually sounds the siren — captured 2026-08-28 burst 15:
// ON pulses ~290/900us, gaps ~280/950us, period ~1206us, delimiter ~9300us).
//
// MECHANISM (measured, do not re-litigate): push(on,us) emits us/kEvSymUs
// FIFO *chip-bits*; each chip-bit clocks out at the MDMCFG4 baud rate. So
// on-air symbol time = (us/kEvSymUs) * baud_period. kEvSymUs and MDMCFG4 are
// therefore NOT independent knobs — scaling BOTH inversely cancels out.
// That is the trap the previous edit fell into: kEvSymUs 55->110 halved the
// chip count while 0x8A->0x89 doubled baud_period, so the on-air period
// stayed 836us (verified on RX 2026-08-28). To LENGTHEN the on-air period,
// move ONE knob. Here MDMCFG4 stays fixed at the calibrated 0x8A and only
// kEvSymUs shrinks: at 0x8A, kEvSymUs=55 rendered 820us; 820us/chip = 34.2us,
// target 1206us needs ~35 chip-bits/period => kEvSymUs ~= 37 (T=330 -> 9
// chips, 3T -> 27 chips, clean 1:3 short/long). VERIFY the on-air period on
// the RX monitor before firing at the siren.
static uint32_t kEvSymUs   = 37;    // MDMCFG4 fixed; 37 stretches 820->~1200us
static uint8_t  kEvMdmcfg4 = 0x8A;  // calibrated baud; do NOT co-vary w/ kEvSymUs

static void evFifoSend(uint32_t code, int repeats) {
  // Build `repeats` frames into ONE contiguous bitstream and stream it as a
  // SINGLE FIFO transmission — no SIDLE, no inter-copy delay. This matches the
  // hub's real burst: the 2026-08-28 capture showed ~27 copies flowing
  // back-to-back, each separated ONLY by the 9.28ms sync-LOW that is part of
  // the frame. The previous version cycled IDLE->TX with a 5ms gap between
  // every copy, breaking frame continuity — an EV1527 receiver that counts
  // consecutive frames (anti-noise debounce) would reset its counter on that
  // idle and never reach its accept threshold. Continuity is the fix.
  static uint8_t bits[8192];
  int nb = 0;
  auto push = [&](bool on, uint32_t us) {
    int count = (int)(us / kSymbolUs);
    for (int i = 0; i < count && nb < (int)sizeof(bits) * 8; i++) {
      if (on) bits[nb >> 3] |= (uint8_t)(1 << (7 - (nb & 7)));
      nb++;
    }
  };
  memset(bits, 0, sizeof(bits));

  // HUB-MATCHED WAVEFORM (not canonical EV1527). Measured from the real hub
  // during an SOS that sounded the siren: each bit is a constant ~1200us cell,
  // and the BIT VALUE lives in the carrier-OFF gap duration —
  // bit 1 = short gap (291) + long pulse pairing, bit 0 = long gap (857).
  //
  // POLARITY + ALIGNMENT (measured on THIS tx/rx pair — the trap that produced
  // 0x3BB916 and 0x9DDC8B before this was right):
  //   * The receiver's level is INVERTED vs push(): push(false,x) radiates as
  //     the monitor's "carrier present" (lv==0), push(true,x) as lv==1.
  //   * The decoder detects the delimiter as a >5ms carrier run, then reads 24
  //     pairs of (HI at start+2b, LO at start+2b+1) and takes the bit from the
  //     LO (=push(false)) duration: <700us => 1, else 0.
  //   * So each bit MUST be emitted PULSE-FIRST: push(true,pulse) then
  //     push(false,gap), with the value in the gap. Gap-first merges the first
  //     bit's gap into the delimiter and shifts the whole decode by a symbol.
  //   * bit 1 => short gap 291us (<700), bit 0 => long gap 857us (>700), each in
  //     a ~1200us cell (hub's constant-period PWM-OOK, value in the gap).
  //
  // Uses kSymbolUs/MDMCFG4=0x89 quantisation (62us steps), matching the config
  // block below. The ONLY change vs fifoSendCode is continuity: all `repeats`
  // frames go into ONE buffer streamed as a single STX, so the delimiter is the
  // ONLY separation between copies (no SIDLE/delay that would reset a
  // frame-counting receiver's debounce).
  // gSeqCodes/gSeqReps, when set, stream SEVERAL DIFFERENT codes as ONE
  // continuous transmission instead of `repeats` copies of a single code.
  //
  // This is how the real panel does it, and we had it wrong. Capture of an SOS
  // that sounded the siren (burst 6078): a SINGLE burst carried 17 copies of
  // 0x3F0102 immediately followed by 8 copies of 0x622372 — no idle between
  // them. Our mimicPanelAlarm used delay() between codes, which lets the
  // carrier go idle; an EV1527 receiver with anti-noise debounce counts
  // CONSECUTIVE frames and resets that counter on idle, so it would never
  // reach its accept threshold. Continuity across the code change is the point.
  const uint32_t* seq = gSeqCodes;
  const int*      seqReps = gSeqReps;
  int seqLen = gSeqLen;
  for (int s = 0; s < (seqLen ? seqLen : 1); s++) {
    if (seqLen) { code = seq[s]; repeats = seqReps[s]; }
  for (int rep = 0; rep < repeats; rep++) {
    // Delimiter: TARGET is the hub's measured ~9280us on air. Four clean
    // captures of a real SOS (2026-08-28, -59dBm vs a -109dBm floor) read
    // 9298/9285/9282/9280us across both transmitter ids and both ON and OFF
    // codes — so 9280 is what the siren actually hears, not the 12400us "full
    // spec" gap an earlier iteration guessed at.
    //
    // But it must be PRE-COMPENSATED. The receiver's OOK decay stretches long
    // gaps (the same effect noted in CLAUDE.md: received width tracks the gap):
    // commanding 9280 arrived as ~11200us, an overshoot of ~1920us. Commanding
    // 7400 lands it at ~9280. Verify on the RX board after any change here.
    // Sync. Pre-compensated: our 7400 command arrives at ~9200us (+1800), so
    // hitting zoogara's 13100us on air means commanding about 11300.
    push(false, gRtl433  ? (uint32_t)gRtl433Sync
              : gZoogara ? 10575UL
                         : (7400UL * gTimeBase) / 1000);
    for (int b = kBits - 1; b >= 0; b--) {  // MSB first, pulse-first, value in gap
      // INVERTED 2026-08-28 — this mapping was the complement of the hub's.
      // push(true,x) radiates as carrier-OFF (the gap); push(false,x) as
      // carrier-ON. The hub's measured cells, from an SOS that sounded the
      // siren, are: bit 0 -> gap ~300us + ON ~890us, bit 1 -> gap ~930us +
      // ON ~300us. Decoding that hub burst with "long ON = 0" yields 0x622374
      // exactly, on both captured transmitter ids. The old lines put the long
      // ON on bit 1, so every code went out bitwise-complemented (0x622374 was
      // radiated as 0x9DDC8B) — which is why the siren always ignored it while
      // board-to-board tests "passed": both our boards shared the same error.
      bool one = (code >> b) & 1;
      // Widths scale with gTimeBase so sweepTimeBase() can vary the whole
      // frame's clock. 1000 = the panel's measured ~1200us cell (our default,
      // pre-compensated); higher values stretch every element proportionally.
      // Chinese EV1527 references stress that the time base is set by the
      // encoder's oscillator resistor and differs between units, so a siren
      // factory-matched to some other transmitter may decode on a different
      // clock than the panel's.
      // zoogara: high 1250 / low 420 as commanded. Those are the widths a
      // working pairing used, and they quantise to within 18us on our 62us
      // grid, so no pre-compensation is applied to the bit cells themselves.
      // Commands are trimmed ~7% below the targets because the OOK path
      // stretches everything: commanding 1250/420 measured 1343/460 on air.
      // 1163/383 lands on zoogara's actual 1250/420. Verify on the RX dump
      // after any change - these are on-air targets, not literal widths.
      // rtl_433 Kerui: s=333, l=972. Commanded as-is; they are close enough to
      // our existing values that the OOK stretch lands them in the right place.
      uint32_t lo  = gRtl433 ? 972UL : gZoogara ? 1163UL : (900UL * gTimeBase) / 1000;
      uint32_t hi  = gRtl433 ? 333UL : gZoogara ?  383UL : (350UL * gTimeBase) / 1000;
      uint32_t lo0 = gRtl433 ? 333UL : gZoogara ?  383UL : (291UL * gTimeBase) / 1000;
      uint32_t hi0 = gRtl433 ? 972UL : gZoogara ? 1163UL : (857UL * gTimeBase) / 1000;
      if (one) { push(true, lo);  push(false, hi);  }   // long gap, short ON => 1
      else     { push(true, lo0); push(false, hi0); }   // short gap, long ON => 0
    }
  }
  }  // end code-sequence loop

  // TRAILING DELIMITER. The stream previously ended on the last bit's keying
  // pulse, so the carrier cut dead with no terminating gap. Every frame except
  // the last was followed by the ~9.2ms inter-frame gap that tells a receiver
  // "frame complete"; the final one was not, so a receiver counting whole
  // frames can discard it. Our own decoder never noticed, because it locates
  // frames by the gap that PRECEDES them.
  push(false, (7400UL * gTimeBase) / 1000);

  int nBytes = (nb + 7) / 8;

  if (gVerboseBuild)
    Serial.printf("    [ev] 0x%06lX x%d -> %d symbols, %d bytes @ %luus/sym\n",
                  (unsigned long)code, repeats, nb, nBytes, (unsigned long)kSymbolUs);

  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36);
  delay(2);
  spiWrite(0x02, 0x06);
  spiWrite(0x08, 0x00);  // fixed length, no CRC/whitening
  spiWrite(0x07, 0x00);
  if (gFreqOverride) { spiWrite(0x0D, gF2); spiWrite(0x0E, gF1); spiWrite(0x0F, gF0); }
  else               { spiWrite(0x0D, 0x10); spiWrite(0x0E, 0xB0); spiWrite(0x0F, 0x71); }
  spiWrite(0x12, 0x30);        // OOK, no sync, Manchester off
  spiWrite(0x10, 0x89);        // symbol rate: 0x89 => ~62us/chip, matches kSymbolUs
  spiWrite(0x11, 0x22);
  // MDMCFG1: NUM_PREAMBLE = 0. Left unset, this register sits at its reset
  // default 0x22 = FOUR preamble bytes, so the CC1101 prepends 32 bits of
  // alternating 0xAA carrier before every frame. MDMCFG2=0x30 disables the sync
  // WORD but preamble length is a separate field in a separate register.
  //
  // Invisible to our own receiver, which finds a frame by hunting for the long
  // inter-frame gap and decodes what follows - leading garbage never appears in
  // any capture we take. But a strict receiver sees 32 bits of noise right
  // before the data, which can also drag its AGC off-point as the frame lands.
  spiWrite(0x13, 0x02);        // NUM_PREAMBLE=0, keep CHANSPC_E=2
  spiWrite(0x21, 0x56);
  spiWrite(0x22, 0x11);
  spiWrite(0x17, 0x00);
  spiWrite(0x18, 0x18);
  // Write the FULL 8-byte PATABLE, not just the first two.
  //
  // PATABLE contents are volatile across IDLE/SLEEP - byte 0 in particular is
  // documented as being lost. If byte 0 is not 0x00 then the "off" half of each
  // OOK bit still radiates carrier: modulation depth collapses, and a cheap
  // receiver's AGC is pinned so it decodes nothing, while a more tolerant
  // panel still manages to decode. That is exactly our asymmetry (the panel
  // accepts our codes, the siren ignores them), and evFifoSend ends with
  // strobe(0x36) SIDLE, so every call after the first writes PATABLE having
  // just passed through idle.
  //
  // Note CS must go HIGH to reset PATABLE's index counter before any read.
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40);
  SPI.transfer(0x00);          // index 0 = carrier OFF - must be 0x00
  SPI.transfer(gPaLevel);      // index 1 = carrier ON
  for (int i = 2; i < 8; i++) SPI.transfer(0x00);
  digitalWrite(kCsPin, HIGH);

  if (gVerboseBuild) {         // read it back; index counter reset by CS above
    digitalWrite(kCsPin, LOW);
    SPI.transfer(0x3E | 0xC0);
    uint8_t pa[8];
    for (int i = 0; i < 8; i++) pa[i] = SPI.transfer(0);
    digitalWrite(kCsPin, HIGH);
    Serial.printf("    [PATABLE] %02X %02X %02X %02X %02X %02X %02X %02X%s\n",
                  pa[0], pa[1], pa[2], pa[3], pa[4], pa[5], pa[6], pa[7],
                  pa[0] == 0x00 ? "" : "   <<< byte0 NOT 0 - carrier leaks!");
  }

  // ONE continuous transmission of the whole multi-frame stream.
  int sent = 0;
  strobe(0x3B);          // SFTX
  spiWrite(0x08, 0x02);  // infinite length while streaming
  int firstChunk = nBytes < 60 ? nBytes : 60;
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3F | 0x40);
  for (int i = 0; i < firstChunk; i++) SPI.transfer(bits[i]);
  digitalWrite(kCsPin, HIGH);
  sent = firstChunk;
  strobe(0x35);          // STX
  while (sent < nBytes) {
    if ((spiReadStatus(0x3A) & 0x7F) < 40) {
      int chunk = nBytes - sent;
      if (chunk > 20) chunk = 20;
      digitalWrite(kCsPin, LOW);
      SPI.transfer(0x3F | 0x40);
      for (int i = 0; i < chunk; i++) SPI.transfer(bits[sent + i]);
      digitalWrite(kCsPin, HIGH);
      sent += chunk;
    }
    delayMicroseconds(200);
  }
  while ((spiReadStatus(0x3A) & 0x7F) > 0) delayMicroseconds(200);
  // TXBYTES reaching 0 means the last byte left the FIFO, NOT that it finished
  // radiating - the modulator still has those bits in flight. Strobing SIDLE
  // immediately truncates the tail, which now clips the trailing delimiter
  // added above. Wait out the bits still on air before going idle.
  delayMicroseconds(kSymbolUs * 8 * 4);
  strobe(0x36);
  enterRxMode();
}

// ---------------------------------------------------------------------------
// LEARN-MODE PAIRING (2026-08-28) — teach the J008 a code WE invent.
//
// This abandons the replay premise entirely. Every attempt to impersonate the
// hub/F8 failed (see the project memory: value, shape, RSSI, cadence and both
// 9ms and 12.4ms guard gaps all matched, siren still silent). The J008 is a
// LEARNING receiver: in study mode it binds whatever EV1527 code it hears, so
// we do not need to know which of 0x62237/0x3F010 drives it, or match the F8's
// waveform at all. That unknown simply stops mattering.
//
// CANONICAL EV1527 (not the hub-matched PWM-OOK shape used by evFifoSend):
//   sync  : short HIGH pulse then ~9750us gap (~31x short)
//   bit 1 : HIGH 960us (3T) then LOW 320us (1T)
//   bit 0 : HIGH 320us (1T) then LOW 960us (3T)
//   every bit cell is an equal 4T ~1280us period, pulse-first.
//
// POLARITY: identical to evFifoSend — push(true,us) radiates as carrier-OFF at
// the receiver and push(false,us) as carrier-present, so the HIGH/LOW above map
// to push(true,...)/push(false,...) respectively. Do not "fix" this; it is
// measured on this tx/rx pair and is what makes the decode come out unshifted.
// TIMINGS: measured from THIS installation's hub, not taken from the spec.
//
// The EV1527 clock is set by an oscillator resistor and varies per batch —
// published sources disagree, one reporting a 1.2ms bit period (sync 400us +
// 9ms) and another a 1.6ms period (0.4/1.2ms halves, 12ms gap). Guessing the
// wrong one is a silent pairing failure, so use what the hardware actually
// emits: our 2026-08-28 capture of a real SOS at -57dBm measured a ~9280us
// delimiter and a constant ~1200us cell (~300/~890 and ~930/~300). That is
// the 1.2ms family, so this receiver's clock is the short one.
//
// kPairSyncUs is PRE-COMPENSATED: the OOK decay stretches long gaps, so 7400
// commanded arrives at ~9120-9160us against the hub's ~9280us. Do not "correct"
// it to 9280 — that transmits as ~11200us and no longer matches the hub.
static const uint32_t kPairSyncUs  = 7400;
static const uint32_t kPairShortUs = 300;
static const uint32_t kPairLongUs  = 890;

// One 20-bit id we invented, with distinct low nibbles so the siren can bind
// each function separately (mirrors how a real fob's buttons differ).
static const uint32_t kPairIdBase  = 0xA1B2C0;
static const uint32_t kPairCodeOn  = kPairIdBase | 0x4;  // arm / trigger
static const uint32_t kPairCodeOff = kPairIdBase | 0x2;  // disarm

// A SEPARATE id used only for the "pair as a plain sensor" control experiment.
// Distinct from kPairIdBase so a success there can never be confused with the
// siren-slot attempt. Nibble 0xE mimics a door sensor's "open" event.
static const uint32_t kPairCodeSensor = 0xB3C4DE;

// Canonical-EV1527 sender. Same proven FIFO transport as evFifoSend (the only
// path that radiates — GPIO keying measures -92dBm and is dead), streaming all
// copies as ONE continuous transmission so a frame-counting receiver's
// debounce never resets between copies.
static void pairFifoSend(uint32_t code, int repeats) {
  static uint8_t bits[8192];
  int nb = 0;
  auto push = [&](bool on, uint32_t us) {
    int count = (int)(us / kSymbolUs);
    for (int i = 0; i < count && nb < (int)sizeof(bits) * 8; i++) {
      if (on) bits[nb >> 3] |= (uint8_t)(1 << (7 - (nb & 7)));
      nb++;
    }
  };
  memset(bits, 0, sizeof(bits));

  for (int rep = 0; rep < repeats; rep++) {
    // Frame built EXACTLY like evFifoSend, which is verified on air against the
    // real hub (delimiter ~9120us, cells ~347/854 and ~1010/287, decoding under
    // the hub's "long ON = 0" rule). The previous shape here — a leading sync
    // PULSE plus a gap, with the bit mapping written the other way round — put
    // the delimiter at 8204us and made the code read back inverted
    // (0xA1B2C4 decoding as longOn=1 instead of longOn=0). Sharing one proven
    // frame shape removes a whole class of that error.
    push(false, kPairSyncUs);   // delimiter, pre-compensated (see kPairSyncUs)
    // BIT MAPPING — INVERTED on 2026-08-28 to match the real hub.
    //
    // This was backwards, and it is the whole reason RF replay "never worked":
    // board-to-board tests passed because BOTH our boards shared the same wrong
    // convention, so they agreed with each other and disagreed with the world.
    // We were actually radiating the bitwise COMPLEMENT — a commanded 0x622374
    // went out as 0x9DDC8B — which is why the siren correctly ignored it.
    //
    // Measured from a real SOS that DID sound the siren (RSSI -51dBm, clean):
    //   hub cell for bit 0 -> gap ~300us, carrier ON ~890us   (long ON)
    //   hub cell for bit 1 -> gap ~930us, carrier ON ~300us   (short ON)
    // decoding the hub's burst with "long ON = 0" returns 0x622374 exactly.
    //
    // push(true,...) radiates as carrier-OFF (the gap), push(false,...) as
    // carrier-ON. Identical to evFifoSend: gap first, then the keying pulse.
    for (int b = kBits - 1; b >= 0; b--) {   // MSB first, gap-then-pulse
      if ((code >> b) & 1) { push(true, kPairLongUs);  push(false, kPairShortUs); }
      else                 { push(true, kPairShortUs); push(false, kPairLongUs);  }
    }
  }
  int nBytes = (nb + 7) / 8;

  if (gVerboseBuild)
    Serial.printf("    [pair] 0x%06lX x%d -> %d symbols, %d bytes\n",
                  (unsigned long)code, repeats, nb, nBytes);

  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36);
  delay(2);
  spiWrite(0x02, 0x06);
  spiWrite(0x08, 0x00);
  spiWrite(0x07, 0x00);
  if (gFreqOverride) { spiWrite(0x0D, gF2); spiWrite(0x0E, gF1); spiWrite(0x0F, gF0); }
  else               { spiWrite(0x0D, 0x10); spiWrite(0x0E, 0xB0); spiWrite(0x0F, 0x71); }
  spiWrite(0x12, 0x30);        // OOK, no sync, Manchester off
  spiWrite(0x10, 0x89);        // ~62us/chip, matches kSymbolUs
  spiWrite(0x11, 0x22);
  spiWrite(0x21, 0x56);
  spiWrite(0x22, 0x11);        // FREND0: PA_POWER=1 so OOK has an "off" entry
  spiWrite(0x17, 0x00);
  spiWrite(0x18, 0x18);
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40);
  SPI.transfer(0x00);
  SPI.transfer(0xC0);
  digitalWrite(kCsPin, HIGH);

  int sent = 0;
  strobe(0x3B);          // SFTX
  spiWrite(0x08, 0x02);  // infinite length while streaming
  int firstChunk = nBytes < 60 ? nBytes : 60;
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3F | 0x40);
  for (int i = 0; i < firstChunk; i++) SPI.transfer(bits[i]);
  digitalWrite(kCsPin, HIGH);
  sent = firstChunk;
  strobe(0x35);          // STX
  while (sent < nBytes) {
    if ((spiReadStatus(0x3A) & 0x7F) < 40) {
      int chunk = nBytes - sent;
      if (chunk > 20) chunk = 20;
      digitalWrite(kCsPin, LOW);
      SPI.transfer(0x3F | 0x40);
      for (int i = 0; i < chunk; i++) SPI.transfer(bits[sent + i]);
      digitalWrite(kCsPin, HIGH);
      sent += chunk;
    }
    delayMicroseconds(200);
  }
  while ((spiReadStatus(0x3A) & 0x7F) > 0) delayMicroseconds(200);
  strobe(0x36);
  enterRxMode();
}

// 'P' — TEACH the siren our ON code. Hold the siren's SET button until it
// beeps and the light ring comes on, THEN press P. The study window is only
// ~20s, so this streams repeatedly across ~15s to be certain it lands.
// A long confirmation beep means it bound the code.
// 'P' — announce ourselves to the W184 as a GHOST SIREN.
//
// DIRECTION (confirmed 2026-08-28 on the real panel): the W184's "Add smart
// accessory -> siren" flow makes the panel LISTEN and count down, waiting for
// the accessory to transmit. Pressing OK emits nothing — that is why the
// earlier receive-only capture during pairing was silent. So we play the part
// of the siren announcing itself: stream our EV1527 code into the panel's
// learn window and it stores US as its siren.
//
// This writes NOTHING to the real siren — its own pairing is untouched and it
// keeps working exactly as before. We are only adding an accessory to the hub.
//
// A real accessory announces in short repeated bursts rather than one solid
// block, so we send 12 copies then pause, repeatedly, across ~15s to cover the
// countdown wherever it starts.
// Runs LONG (~90s) on purpose. The J008's SET control is a momentary push
// button that opens a TIMED study window — it beeps and lights up, then the
// lights go out when the window closes. Coordinating "press now" against a
// 15s burst loses the race: by the time the operator presses and the announce
// starts, the window has often already expired. Inverting it removes the race
// entirely — start this FIRST, then press the button while the code is already
// on air, so a frame lands in the first moments of the window whenever it opens.
static void pairTeachOn() {
  Serial.println();
  Serial.println(">>> ANNOUNCING CONTINUOUSLY — press the siren's SET button NOW");
  Serial.printf("    announcing 0x%06lX for ~90s (press any key to stop early)\n",
                (unsigned long)kPairCodeOn);
  Serial.println("    the code is already on air, so press whenever you are ready");
  for (int round = 0; round < 90 && !Serial.available(); round++) {
    pairFifoSend(kPairCodeOn, 12);
    if (round % 5 == 0) Serial.printf("    round %d/90 — still announcing\n", round + 1);
    delay(600);
  }
  Serial.println("    done — a CONFIRMATION BEEP from the SIREN = paired.");
}

// 'S' — CONTROL EXPERIMENT: announce as a plain SENSOR, not a siren.
//
// Purpose is diagnostic, to isolate one variable. The siren-slot announce
// produced no confirmation, and there are two possible reasons:
//   (a) our RF frame is wrong / not being heard by the panel at all, or
//   (b) the frame is fine, but the panel's SIREN slot validates device type
//       and rejects an unknown accessory claiming to be a siren.
// A plain sensor slot on these panels accepts any EV1527 code. So:
//   panel accepts this  -> our TX is provably correct, (b) is true
//   panel rejects this  -> the fault is in our transmission, (a) is true
// Either outcome is informative, which is what makes this worth running.
static void pairAnnounceSensor() {
  Serial.println();
  Serial.println(">>> ANNOUNCE AS PLAIN SENSOR (control test) — panel in 'add accessory -> sensor' countdown NOW");
  Serial.printf("    announcing 0x%06lX, streaming ~15s\n",
                (unsigned long)kPairCodeSensor);
  for (int round = 0; round < 15 && !Serial.available(); round++) {
    pairFifoSend(kPairCodeSensor, 12);
    Serial.printf("    round %d/15 sent\n", round + 1);
    delay(600);
  }
  Serial.println("    done — panel confirmation = OUR TRANSMISSION IS CORRECT.");
}

// 'T' — re-fire the sensor code after pairing, to confirm the panel reacts to
// it (should show the zone / trigger whatever that sensor slot is bound to).
static void pairFireSensor() {
  Serial.println();
  Serial.printf(">>> FIRE sensor code 0x%06lX\n", (unsigned long)kPairCodeSensor);
  pairFifoSend(kPairCodeSensor, 20);
  Serial.println("    sent — panel should react if it paired.");
}

// 'O' — fire the learned ON code, exactly as a bound fob would.
static void pairFireOn() {
  Serial.println();
  Serial.printf(">>> FIRE learned ON 0x%06lX\n", (unsigned long)kPairCodeOn);
  pairFifoSend(kPairCodeOn, 20);
  Serial.println("    sent.");
}

// 'F' — fire the OFF/disarm nibble.
static void pairFireOff() {
  Serial.println();
  Serial.printf(">>> FIRE OFF 0x%06lX\n", (unsigned long)kPairCodeOff);
  pairFifoSend(kPairCodeOff, 20);
  Serial.println("    sent.");
}

// 'W' — board-to-board sanity check of the CANONICAL waveform before we ever
// point it at the siren. Watch the RX monitor: equal ~1280us bit cells,
// ~9.75ms sync gap, and a clean unshifted decode of the code below.
static void pairVerify() {
  Serial.println();
  Serial.printf(">>> PAIR WAVEFORM VERIFY — 0x%06lX x20, watch the RX monitor board\n",
                (unsigned long)kPairCodeOn);
  Serial.println("    want: ~9.75ms sync gap, equal ~1280us cells, unbroken burst");
  pairFifoSend(kPairCodeOn, 20);
  Serial.println("    sent — check the other board's census + decode.");
}

// Verify the frame lands with the HUB-MATCHED timing BEFORE firing at the
// siren. Sends 0x622374 x27 continuous; watch the RX monitor board for a
// ~9.3ms delimiter (reported as carrier-ON) between EVERY copy and per-bit
// (gap,pulse) cells reading ~314/857 (bit 0) and ~954/291 (bit 1). The whole
// burst must be one unbroken stream (no idle gap between copies) and MUST
// decode as 0x622374 — not a shifted value. Adjust kSymbolUs/MDMCFG4 if wrong.
static void evVerify() {
  Serial.println();
  Serial.println(">>> EV1527 HUB-MATCHED VERIFY — 0x622374 x27 continuous, watch RX monitor");
  Serial.println("    want: ~9.3ms delimiter between EVERY copy, unbroken, decode=0x622374");
  evFifoSend(0x622374, 27);
  Serial.println("    sent — check the other board's pulse-width census + copy count.");
}

// Fire the canonical EV1527 ON at the real siren, matching the HUB'S captured
// burst structure: primary id x27 continuous, then secondary id x8, one
// unbroken stream each (the 2026-08-28 capture: 0x622374 x27 then 0x3F0108 x7).
static void evSirenOn() {
  Serial.println();
  Serial.println(">>> EV1527 CANONICAL ON: 0x622374 x27 then 0x3F0108 x8 (hub-exact), x2 rounds");
  for (int round = 0; round < 2; round++) {
    Serial.printf("    round %d/2\n", round + 1);
    evFifoSend(0x622374, 27);
    evFifoSend(0x3F0108, 8);
    if (round == 0) { Serial.println("    ...5s gap"); listenFor(5000, "between rounds"); }
  }
  Serial.println("    sent. DID THE SIREN SOUND?");
}

static void evSirenOff() {
  Serial.println();
  Serial.println(">>> EV1527 CANONICAL OFF: 0x3F0102 x27 then 0x622372 x8 (hub-exact), x2 rounds");
  for (int round = 0; round < 2; round++) {
    evFifoSend(0x3F0102, 27);
    evFifoSend(0x622372, 8);
    if (round == 0) { listenFor(3000, "between rounds"); }
  }
  Serial.println("    sent. Did the siren stop?");
}

// Sweep the assumed symbol period. The FIFO path works and delimiters and
// ~400us pulses arrive, but the 1200us pulses have not yet landed above the
// receiver's 700us threshold, so every bit decodes as 1. Find the value
// where the census shows BOTH ~400us and ~1200us populations.
// Send WIDELY different pulse widths with no framing at all, so the receiver
// reports raw widths. Every attempt so far has come back as uniform ~490us
// pulses regardless of the ratio transmitted; this establishes whether the
// FIFO path can produce ANY width variation.
static void widthProbe() {
  Serial.println();
  Serial.println(">>> WIDTH PROBE — 5 pulses: 500us, 2000us, 500us, 4000us, 500us");
  static uint8_t bits[1024];
  memset(bits, 0, sizeof(bits));
  int nb = 0;
  auto push = [&](bool on, uint32_t us) {
    int count = (int)(us / 100);
    for (int i = 0; i < count && nb < (int)sizeof(bits) * 8; i++) {
      if (on) bits[nb >> 3] |= (1 << (7 - (nb & 7)));
      nb++;
    }
  };
  const uint32_t widths[] = {500, 2000, 500, 4000, 500};
  for (uint32_t w : widths) { push(true, w); push(false, 1500); }

  int nBytes = (nb + 7) / 8;
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36); delay(2);
  spiWrite(0x02, 0x06);
  spiWrite(0x08, 0x00);
  spiWrite(0x07, 0x00);
  spiWrite(0x06, (uint8_t)(nBytes > 255 ? 255 : nBytes));
  spiWrite(0x0D, 0x10); spiWrite(0x0E, 0xB0); spiWrite(0x0F, 0x71);
  spiWrite(0x12, 0x30);
  spiWrite(0x10, 0x88); spiWrite(0x11, 0x22);
  spiWrite(0x21, 0x56); spiWrite(0x22, 0x11);
  spiWrite(0x17, 0x00); spiWrite(0x18, 0x18);
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40); SPI.transfer(0x00); SPI.transfer(0xC0);
  digitalWrite(kCsPin, HIGH);

  for (int rep = 0; rep < 4; rep++) {
    strobe(0x3B);
    spiWrite(0x08, 0x02);
    int sent = 0;
    int first = nBytes < 60 ? nBytes : 60;
    digitalWrite(kCsPin, LOW);
    SPI.transfer(0x3F | 0x40);
    for (int i = 0; i < first; i++) SPI.transfer(bits[i]);
    digitalWrite(kCsPin, HIGH);
    sent = first;
    strobe(0x35);
    while (sent < nBytes) {
      if ((spiReadStatus(0x3A) & 0x7F) < 40) {
        int chunk = nBytes - sent; if (chunk > 20) chunk = 20;
        digitalWrite(kCsPin, LOW);
        SPI.transfer(0x3F | 0x40);
        for (int i = 0; i < chunk; i++) SPI.transfer(bits[sent + i]);
        digitalWrite(kCsPin, HIGH);
        sent += chunk;
      }
      delayMicroseconds(200);
    }
    while ((spiReadStatus(0x3A) & 0x7F) > 0) delayMicroseconds(200);
    strobe(0x36);
    delay(300);
  }
  enterRxMode();
  Serial.println("    sent.");
}

static void sweepSymbol() {
  const uint32_t cands[] = {110, 125, 140, 155, 167, 180, 200};
  uint32_t save = kSymbolUs;
  Serial.println();
  Serial.println(">>> SYMBOL SWEEP — want the other board to report BOTH ~400us and ~1200us");
  for (uint32_t c : cands) {
    kSymbolUs = c;
    Serial.printf("    symbol=%luus\n", (unsigned long)c);
    fifoSendCode(0x622374);
    delay(1500);
  }
  kSymbolUs = save;
  Serial.println("    sweep done.");
}

static void fifoTxTest() {
  Serial.println();
  Serial.println(">>> FIFO TX TEST (no GDO0) — 20 packets, watch RSSI on other board");
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36);
  delay(2);
  // Normal packet mode (not async), fixed length, no CRC/whitening.
  spiWrite(0x02, 0x06);  // IOCFG0: sync word / packet-sent indicator
  spiWrite(0x08, 0x00);  // PKTCTRL0: normal FIFO mode, fixed length, no CRC
  spiWrite(0x07, 0x00);  // PKTCTRL1: no address check, no append status
  spiWrite(0x06, 0x10);  // PKTLEN = 16 bytes
  spiWrite(0x0D, 0x10); spiWrite(0x0E, 0xB0); spiWrite(0x0F, 0x71);
  spiWrite(0x12, 0x30);  // OOK, no sync
  spiWrite(0x10, 0x87); spiWrite(0x11, 0x32);
  spiWrite(0x21, 0x56);  // FREND1 TX
  spiWrite(0x22, 0x11);  // FREND0 PA_POWER=1
  spiWrite(0x17, 0x00);  // MCSM1: TXOFF -> IDLE
  spiWrite(0x18, 0x18);  // MCSM0: autocal
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40);
  SPI.transfer(0x00);
  SPI.transfer(0xC0);
  digitalWrite(kCsPin, HIGH);

  for (int p = 0; p < 20; p++) {
    strobe(0x3B);  // SFTX: flush TX FIFO
    digitalWrite(kCsPin, LOW);
    SPI.transfer(0x3F | 0x40);          // burst write TX FIFO
    for (int i = 0; i < 16; i++) SPI.transfer(0xAA);  // alternating bits
    digitalWrite(kCsPin, HIGH);
    strobe(0x35);  // STX
    delay(30);
    strobe(0x36);
    delay(20);
  }
  uint8_t st = spiReadStatus(0x35) & 0x1F;
  Serial.printf("    done, MARCSTATE=0x%02X\n", st);
  enterRxMode();
}

static void carrierOnTest() {
  Serial.println();
  Serial.println(">>> CONTINUOUS CARRIER, 3s (read RSSI on the other board)");
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36);
  spiWrite(0x02, 0x2D);
  spiWrite(0x21, 0x56);
  spiWrite(0x17, 0x00);
  writeCommonConfig();
  spiWrite(0x22, 0x11);
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40);
  SPI.transfer(0x00);
  SPI.transfer(0xC0);
  digitalWrite(kCsPin, HIGH);
  pinMode(kGdo0Pin, OUTPUT);
  digitalWrite(kGdo0Pin, gTxCarrierHigh ? HIGH : LOW);   // carrier ON, held
  strobe(0x35);
  delay(50);
  uint8_t st = spiReadStatus(0x35) & 0x1F;
  int8_t r = (int8_t)spiReadStatus(0x34);
  Serial.printf("    MARCSTATE=0x%02X (0x13=TX)  own RSSI reg=0x%02X\n", st, (uint8_t)r);
  // Read PATABLE back. A PA that is in TX yet radiating nothing usually
  // means the power table is zero — a burst write can be silently dropped
  // if it is not addressed correctly.
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0xC0);   // PATABLE burst READ
  uint8_t pa0 = SPI.transfer(0), pa1 = SPI.transfer(0);
  digitalWrite(kCsPin, HIGH);
  uint8_t frend0 = 0, iocfg0 = 0;
  digitalWrite(kCsPin, LOW); SPI.transfer(0x22 | 0x80); frend0 = SPI.transfer(0); digitalWrite(kCsPin, HIGH);
  digitalWrite(kCsPin, LOW); SPI.transfer(0x02 | 0x80); iocfg0 = SPI.transfer(0); digitalWrite(kCsPin, HIGH);
  Serial.printf("    PATABLE[0]=0x%02X PATABLE[1]=0x%02X  FREND0=0x%02X IOCFG0=0x%02X\n",
                pa0, pa1, frend0, iocfg0);
  Serial.printf("    GDO0 pin currently reads %d\n", digitalRead(kGdo0Pin));
  delay(3000);
  digitalWrite(kGdo0Pin, gTxCarrierHigh ? LOW : HIGH);
  strobe(0x36);
  enterRxMode();
  Serial.println("    carrier off.");
}

static void timingSelfCheck() {
  Serial.println();
  Serial.println(">>> TIMING SELF-CHECK (no RF — measures the pin path only)");
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  pinMode(kGdo0Pin, OUTPUT);

  const uint32_t targets[] = {400, 1200, 12400};
  for (uint32_t t : targets) {
    uint32_t t0 = micros();
    for (int i = 0; i < 10; i++) { carrier(true, t); carrier(false, t); }
    uint32_t el = micros() - t0;
    Serial.printf("    target %5luus x20 -> %luus total, avg %luus %s\n",
                  (unsigned long)t, (unsigned long)el, (unsigned long)(el / 20),
                  (el / 20 > t * 8 / 10 && el / 20 < t * 12 / 10) ? "OK" : "*** WRONG ***");
  }
  enterRxMode();
}

// Replay the hub's ACTUAL observed pattern (measured 2026-08-28 with
// spike_packet_log, during a real app-triggered SOS that DID sound the siren):
//
//   t=125-127s  0x622374 x~25   |  t=144-145s  0x3F0102 x~24
//   t=127-128s  0x3F0108 x~35   |  t=145s      0x622372 x~8
//   t=131-132s  BOTH again      |  t=149-151s  BOTH again
//
// Two things here that a single-code replay never reproduced:
//   1. the hub sends BOTH ids for one command, back to back
//   2. it repeats the whole sequence ~5s later
// Our replay sent 3 copies of ONE id — that is the leading explanation for
// the siren ignoring a transmission we have PROVEN decodes correctly
// (0x622374 read back at -61dBm on an independent board, 5/5).
static void sendHubSequence(uint32_t codeA, uint32_t codeB, const char* label) {
  Serial.printf(">>> hub-style %s: %06lX then %06lX, x2 rounds\n",
                label, (unsigned long)codeA, (unsigned long)codeB);
  for (int round = 0; round < 2; round++) {
    Serial.printf("    round %d/2: %06lX\n", round + 1, (unsigned long)codeA);
    for (int i = 0; i < 8; i++) fifoSendCode(codeA);
    delay(200);
    Serial.printf("    round %d/2: %06lX\n", round + 1, (unsigned long)codeB);
    for (int i = 0; i < 8; i++) fifoSendCode(codeB);
    if (round == 0) {
      Serial.println("    ...5s gap, as the hub does");
      listenFor(5000, "between rounds");
    }
  }
  Serial.println("    sequence sent.");
}

// Send one code repeatedly. Board-to-board decode needs only a few copies,
// but a real siren may want a longer burst before it acts — and if a hub
// ACKNOWLEDGES the command, the gaps between bursts are where that reply
// would land, so we listen in between rather than transmitting solidly.
static void hammer(uint32_t code) {
  Serial.println();
  Serial.printf(">>> HAMMER 0x%06X — 6 bursts, listening between each\n", code);
  Serial.println("    IS THE SIREN SOUNDING? Press 'x' after to send all off codes.");
  for (int i = 0; i < 6; i++) {
    Serial.printf("    burst %d/6\n", i + 1);
    fifoSendCode(code);
    listenFor(1200, "between bursts");
  }
  Serial.println("    done — listening 8s for any reply.");
  listenFor(8000, "after hammer");
}

// --- CANDIDATE SWEEP -------------------------------------------------------
//
// Premise (2026-08-28): our decoder and encoder are mutually CONSISTENT but
// may be jointly WRONG. We decode the hub's waveform to 0x622374 and can
// transmit something that decodes back to 0x622374 — a closed loop that
// proves consistency, not correctness. A systematic framing error (bit order,
// start offset, frame length) would yield a stable, repeatable WRONG value,
// and every test judged by our own receiver would still pass.
//
// The siren is the only CORRECT decoder we have access to, so let it judge.
// These candidates are all re-interpretations of the SAME captured hub
// waveform under different framing assumptions.
//
// Reference capture (hub, SOS ON, measured):
//   delimiter=9281us
//   gap/on -> 314/857 954/291 930/311 287/890 304/881 314/900 916/279 ...
//   long pulse = bit 0, short pulse = bit 1  ->  0x622374
static uint32_t reverseBits24(uint32_t v) {
  uint32_t r = 0;
  for (int i = 0; i < 24; i++) { r = (r << 1) | (v & 1); v >>= 1; }
  return r;
}

struct Candidate { uint32_t code; const char* note; };

// 'N' — sweep all 16 low nibbles of an identity.
//
// Motivated by a 2026-08-28 capture: during the panel's ADD-SIREN pairing flow
// the panel transmitted 0x3F0102 at -41dBm, the strongest reading seen from it.
// So 0x3F010 is the panel's siren-linkage identity, not merely an "off" code —
// which means the siren is bound to THAT id and the trigger is very likely a
// different command nibble of it. Only 16 exist, so enumerate them rather than
// guess. Nibble 2 (pair/off) and 8 (seen during SOS) are already known.
// 'L' — send the alarm trigger at DESCENDING power levels.
//
// Hypothesis (2026-08-28): we may be transmitting too STRONG, not too weak.
// The panel triggers the siren at -39..-42dBm measured at our receiver; we
// transmit the identical frame at -18dBm, ~100x the power. An OOK envelope
// detector that saturates on a very strong nearby signal flattens every pulse
// to a uniform width and decodes nothing — which looks exactly like "correct
// code, no response". We already SAW this effect on our own receiver, where a
// 12.4ms delimiter saturated the AGC and flattened following pulses.
//
// CC1101 PATABLE values, descending (datasheet, 433MHz):
//   0xC0 ~ +10dBm, 0x84 ~ +5, 0x60 ~ 0, 0x34 ~ -6, 0x1D ~ -10, 0x0E ~ -20
// 'A' — reproduce the panel's ALARM sequence exactly as captured.
//
// Every previous attempt sent one code as a single long stream. The panel does
// something structurally different, measured from a real SOS on 2026-08-28
// (the siren sounded, so this pattern demonstrably works):
//
//   t+0ms     0x622374   -39dBm
//   t+490ms   0x622374   -39dBm
//   t+2040ms  0x622374   -74dBm   <- 35dB weaker: a SECOND, more distant TX
//   t+5750ms  0x3F0102   -42dBm
//
// Two things here we have never reproduced: the inter-burst GAPS, and the fact
// that separate bursts come from separate transmitters. A siren built to resist
// false triggers may require repeated bursts separated in time rather than one
// continuous stream — a single burst, however many frames, is what a noise hit
// looks like. Per-frame shape is already correct (24 cells + ~9.3ms delimiter,
// confirmed against the capture), so the burst pattern is what is left.
//
// The weak third burst is emitted at reduced PA to imitate the distant unit.
// PT2262 fixed-code transmitter, sharing evFifoSend's proven FIFO transport.
//
// Waveform (alpha = base clock, set by the encoder's oscillator resistor):
//   bit 0 : (1a hi, 3a lo)(1a hi, 3a lo)
//   bit 1 : (3a hi, 1a lo)(3a hi, 1a lo)
//   bit F : (1a hi, 3a lo)(3a hi, 1a lo)     tri-state, the DIP "middle"
//   sync  : 1a hi, 31a lo
//
// POLARITY: identical to evFifoSend on this hardware - push(false,x) radiates
// as carrier-ON and push(true,x) as the gap. Do not copy the HIGH/LOW naming
// above literally; "hi" here means carrier present, i.e. push(false,...).
//
// alpha is pre-compensated the same way as the EV1527 path: the OOK stretch
// adds roughly 7%, so commanding ~370 lands near a 400us alpha on air.
static void pt2262Send(const char* addr12, uint8_t dataNibble, int repeats) {
  static uint8_t bits[8192];
  int nb = 0;
  auto push = [&](bool on, uint32_t us) {
    int count = (int)(us / kSymbolUs);
    for (int i = 0; i < count && nb < (int)sizeof(bits) * 8; i++) {
      if (on) bits[nb >> 3] |= (uint8_t)(1 << (7 - (nb & 7)));
      nb++;
    }
  };
  memset(bits, 0, sizeof(bits));

  const uint32_t a = 370;          // alpha, pre-compensated toward ~400us
  auto shortHi = [&]() { push(false, a);     push(true, 3 * a); };
  auto longHi  = [&]() { push(false, 3 * a); push(true, a);     };

  for (int rep = 0; rep < repeats; rep++) {
    for (int i = 0; i < 12 && addr12[i]; i++) {
      char c = addr12[i];
      if (c == '0')      { shortHi(); shortHi(); }
      else if (c == '1') { longHi();  longHi();  }
      else               { shortHi(); longHi();  }   // 'F' tri-state
    }
    for (int b = 3; b >= 0; b--) {                   // 4 data bits, same rule
      if ((dataNibble >> b) & 1) { longHi();  longHi();  }
      else                       { shortHi(); shortHi(); }
    }
    push(false, a);                                  // sync pulse
    push(true, 31 * a);                              // sync gap
  }

  int nBytes = (nb + 7) / 8;
  if (gVerboseBuild)
    Serial.printf("    [pt2262] %s data %X x%d -> %d bytes\n",
                  addr12, dataNibble, repeats, nBytes);

  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36);
  delay(2);
  spiWrite(0x02, 0x06);
  spiWrite(0x08, 0x00);
  spiWrite(0x07, 0x00);
  spiWrite(0x0D, 0x10); spiWrite(0x0E, 0xB0); spiWrite(0x0F, 0x71);
  spiWrite(0x12, 0x30);
  spiWrite(0x10, 0x89);
  spiWrite(0x11, 0x22);
  spiWrite(0x13, 0x02);        // NUM_PREAMBLE = 0
  spiWrite(0x21, 0x56);
  spiWrite(0x22, 0x11);        // FREND0: PA_POWER=1 so OOK has an "off" entry
  spiWrite(0x17, 0x00);
  spiWrite(0x18, 0x18);
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40);
  SPI.transfer(0x00);
  SPI.transfer(gPaLevel);
  for (int i = 2; i < 8; i++) SPI.transfer(0x00);
  digitalWrite(kCsPin, HIGH);

  int sent = 0;
  strobe(0x3B);
  spiWrite(0x08, 0x02);
  int firstChunk = nBytes < 60 ? nBytes : 60;
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3F | 0x40);
  for (int i = 0; i < firstChunk; i++) SPI.transfer(bits[i]);
  digitalWrite(kCsPin, HIGH);
  sent = firstChunk;
  strobe(0x35);
  while (sent < nBytes) {
    if ((spiReadStatus(0x3A) & 0x7F) < 40) {
      int chunk = nBytes - sent;
      if (chunk > 20) chunk = 20;
      digitalWrite(kCsPin, LOW);
      SPI.transfer(0x3F | 0x40);
      for (int i = 0; i < chunk; i++) SPI.transfer(bits[sent + i]);
      digitalWrite(kCsPin, HIGH);
      sent += chunk;
    }
    delayMicroseconds(200);
  }
  while ((spiReadStatus(0x3A) & 0x7F) > 0) delayMicroseconds(200);
  delayMicroseconds(kSymbolUs * 8 * 4);
  strobe(0x36);
  enterRxMode();
}

static void mimicPanelAlarm() {
  Serial.println();
  Serial.println(">>> MIMIC PANEL ALARM — codes CONCATENATED, no idle between");
  gVerboseBuild = false;

  // Burst 6078 from the SOS capture, reproduced exactly: 17 copies of 0x3F0102
  // followed immediately by 8 copies of 0x622372, all in ONE transmission.
  // The previous version put delay() between codes; that idle resets a
  // frame-counting receiver's debounce, which is likely why it never took.
  static const uint32_t codes[] = { 0x622374, 0x3F0108 };
  static const int      reps[]  = { 17,       8        };
  gSeqCodes = codes; gSeqReps = reps; gSeqLen = 2;
  Serial.println("    ON: 0x622374 x17 + 0x3F0108 x8, continuous");
  evFifoSend(0, 0);
  gSeqLen = 0;

  gVerboseBuild = true;
  Serial.println("    sequence complete — DID THE SIREN SOUND?");
}

// 'B' — the OFF sequence, concatenated the same way. Captured burst 6078 was
// literally 0x3F0102 x17 + 0x622372 x8 in one stream, so this is the exact
// shape the panel used while the siren was responding.
static void mimicPanelOff() {
  Serial.println();
  Serial.println(">>> MIMIC PANEL OFF — 0x3F0102 x17 + 0x622372 x8, continuous");
  gVerboseBuild = false;
  static const uint32_t codes[] = { 0x3F0102, 0x622372 };
  static const int      reps[]  = { 17,       8        };
  gSeqCodes = codes; gSeqReps = reps; gSeqLen = 2;
  evFifoSend(0, 0);
  gSeqLen = 0;
  gVerboseBuild = true;
  Serial.println("    sent — 3 beeps from the siren = it acted on this.");
}

// 'C' — sweep the TIME BASE, the one axis never varied.
//
// EV1527's bit period is set by the encoder's external oscillator resistor
// (commonly 200K/270K/300K/470K), so it differs between units: Chinese
// references measure ~1.2ms on one remote and ~1.6ms on another, and warn that
// a decoder written for one resistor simply will not see the other. This
// panel's cell measures ~1200us; the canonical spec is 1600us. If the siren
// was factory-matched to a transmitter with a different resistor, its decode
// window may be centred somewhere we have never transmitted.
//
// Everything else (value, framing, ratio, sync, power, frequency) is already
// confirmed to match the panel, so this is the remaining measurable dimension.
static void sweepTimeBase(uint32_t code) {
  const uint32_t scales[] = { 700, 830, 1000, 1170, 1330, 1500 };
  const int n = sizeof(scales) / sizeof(scales[0]);
  Serial.println();
  Serial.println("=========================================================");
  Serial.printf(">>> TIME-BASE SWEEP — 0x%06lX at %d clocks\n",
                (unsigned long)code, n);
  Serial.println("    panel measures ~1200us/cell; spec is 1600us.");
  Serial.println("    LISTEN for the clock where the siren reacts.");
  Serial.println("=========================================================");
  gVerboseBuild = false;
  for (int i = 0; i < n; i++) {
    gTimeBase = scales[i];
    Serial.printf("\n>>> [%d/%d] scale %lu%%  -> cell ~%luus\n",
                  i + 1, n, (unsigned long)(scales[i] / 10),
                  (unsigned long)((1200UL * scales[i]) / 1000));
    for (int r = 0; r < 3; r++) evFifoSend(code, 12);
    Serial.printf("    [%d/%d] sent — listening 4s\n", i + 1, n);
    listenFor(4000, "after timebase");
  }
  gTimeBase = 1000;
  gVerboseBuild = true;
  Serial.println("\n>>> time-base sweep done. Which clock (if any) reacted?");
}

static void sweepPower(uint32_t code) {
  const uint8_t levels[] = { 0xC0, 0x84, 0x60, 0x34, 0x1D, 0x0E };
  const char*   notes[]  = { "+10dBm", "+5dBm", "0dBm", "-6dBm", "-10dBm", "-20dBm" };
  const int n = sizeof(levels) / sizeof(levels[0]);
  Serial.println();
  Serial.println("=========================================================");
  Serial.printf(">>> POWER SWEEP — 0x%06lX at %d levels, strongest first\n",
                (unsigned long)code, n);
  Serial.println("    The panel triggers the siren at ~-40dBm; we run at -18dBm.");
  Serial.println("    LISTEN for the level where the siren reacts.");
  Serial.println("=========================================================");
  gVerboseBuild = false;
  for (int i = 0; i < n; i++) {
    gPaLevel = levels[i];
    Serial.printf("\n>>> [%d/%d] PATABLE=0x%02X (%s)\n", i + 1, n, levels[i], notes[i]);
    for (int r = 0; r < 3; r++) evFifoSend(code, 20);
    Serial.printf("    [%d/%d] sent — listening 4s\n", i + 1, n);
    listenFor(4000, "after power");
  }
  gPaLevel = 0xC0;
  gVerboseBuild = true;
  Serial.println("\n>>> power sweep done. Which level (if any) fired the siren?");
}

static void sweepNibbles(uint32_t id20) {
  Serial.println();
  Serial.println("=========================================================");
  Serial.printf(">>> NIBBLE SWEEP on id 0x%05lX — all 16 commands\n",
                (unsigned long)id20);
  Serial.println("    LISTEN. Note which nibble makes the siren react.");
  Serial.println("=========================================================");
  gVerboseBuild = false;
  for (uint32_t nib = 0; nib < 16; nib++) {
    uint32_t code = (id20 << 4) | nib;
    Serial.printf("\n>>> nibble %lX -> 0x%06lX\n",
                  (unsigned long)nib, (unsigned long)code);
    for (int r = 0; r < 4; r++) evFifoSend(code, 12);
    Serial.printf("    sent — listening 3s\n");
    listenFor(3000, "after nibble");
  }
  gVerboseBuild = true;
  Serial.println("\n>>> nibble sweep done. Which nibble (if any) reacted?");
}

static void sweepCandidates() {
  const uint32_t base = 0x622374;   // our reading of the hub's ON command
  const uint32_t alt  = 0x3F0108;   // the second transmitter's ON command

  Candidate cands[] = {
    { base,                        "0x622374 as decoded (baseline)" },
    { reverseBits24(base),         "bit-reversed (LSB-first)" },
    { (base >> 1) & 0xFFFFFF,      "shifted right 1 (start offset -1)" },
    { (base << 1) & 0xFFFFFF,      "shifted left 1  (start offset +1)" },
    { ~base & 0xFFFFFF,            "inverted (polarity flip)" },
    { alt,                         "0x3F0108 as decoded" },
    { reverseBits24(alt),          "0x3F0108 bit-reversed" },
    { (alt >> 1) & 0xFFFFFF,       "0x3F0108 shifted right 1" },
    { (alt << 1) & 0xFFFFFF,       "0x3F0108 shifted left 1" },
    { ~alt & 0xFFFFFF,             "0x3F0108 inverted" },
  };
  const int n = sizeof(cands) / sizeof(cands[0]);

  gVerboseBuild = false;
  Serial.println();
  Serial.println("=========================================================");
  Serial.printf(">>> CANDIDATE SWEEP — %d candidates, 4s apart\n", n);
  Serial.println("    WATCH THE SIREN. Note the index that makes it sound.");
  Serial.println("    (send OFF from the app once it fires)");
  Serial.println("=========================================================");

  for (int i = 0; i < n; i++) {
    Serial.printf("\n>>> [%d/%d] 0x%06lX  — %s\n", i + 1, n,
                  (unsigned long)cands[i].code, cands[i].note);
    // Several copies each: a real receiver wants repetition before acting.
    for (int r = 0; r < 6; r++) fifoSendCode(cands[i].code);
    Serial.printf("    [%d/%d] sent — listening 4s\n", i + 1, n);
    listenFor(4000, "after candidate");
  }
  gVerboseBuild = true;
  Serial.println("\n>>> sweep done. Which index (if any) fired the siren?");
}

// --- FREQUENCY SWEEP -------------------------------------------------------
//
// The one dimension never tested. We set 433.92MHz from the DOOR SENSOR
// config and assumed the hub->siren link matches. Our CC1101's RX filter is
// wide enough to receive a transmitter tens of kHz off-centre, so we would
// decode the hub perfectly even if it sits at, say, 433.85 — while the
// siren's cheap fixed-frequency SAW receiver, which is far narrower, would
// simply not hear us transmitting at 433.92.
//
// This fits the central asymmetry that nothing else explains: we reach our
// own receiver at -18dBm against the hub's -49dBm — 30dB LOUDER — and the
// siren still obeys only the hub. Being off-frequency is invisible to us
// precisely because our receiver is tolerant.
//
// Non-destructive: transmitting on a nearby frequency cannot alter the
// siren's existing pairing with the W184 hub.
struct FreqOpt { uint8_t f2, f1, f0; const char* note; };
static const FreqOpt kFreqs[] = {
  { 0x10, 0xB0, 0x71, "433.92 MHz (current, baseline)" },
  { 0x10, 0xB0, 0x3F, "433.90 MHz" },
  { 0x10, 0xAF, 0xC1, "433.85 MHz" },
  { 0x10, 0xAF, 0x43, "433.80 MHz" },
  { 0x10, 0xAE, 0x47, "433.70 MHz" },
  { 0x10, 0xAD, 0x4B, "433.60 MHz" },
  { 0x10, 0xB0, 0xBD, "433.95 MHz" },
  { 0x10, 0xB1, 0x3B, "434.00 MHz" },
  { 0x10, 0xB2, 0x37, "434.10 MHz" },
  { 0x10, 0xB3, 0x33, "434.20 MHz" },
  { 0x10, 0xB4, 0x2F, "434.30 MHz" },
};

static void sweepFrequency(uint32_t code) {
  const int n = sizeof(kFreqs) / sizeof(kFreqs[0]);
  Serial.println();
  Serial.println("=========================================================");
  Serial.printf(">>> FREQUENCY SWEEP — 0x%06lX at %d frequencies\n",
                (unsigned long)code, n);
  Serial.println("    WATCH THE SIREN. Note the index that makes it sound.");
  Serial.println("=========================================================");

  gVerboseBuild = false;
  gFreqOverride = true;
  for (int i = 0; i < n; i++) {
    gF2 = kFreqs[i].f2; gF1 = kFreqs[i].f1; gF0 = kFreqs[i].f0;
    Serial.printf("\n>>> [%d/%d] %s\n", i + 1, n, kFreqs[i].note);
    for (int r = 0; r < 6; r++) fifoSendCode(code);
    Serial.printf("    [%d/%d] sent — listening 4s\n", i + 1, n);
    listenFor(4000, "after freq");
  }
  gFreqOverride = false;
  gF2 = 0x10; gF1 = 0xB0; gF0 = 0x71;
  gVerboseBuild = true;
  Serial.println("\n>>> sweep done. Which index (if any) fired the siren?");
}

// --- CANONICAL EV1527 BIT-BANG ---------------------------------------------
//
// Every prior TX built the frame from FIFO OOK symbols and fought quantisation
// + demod decay (5+ coupled tuning attempts, never converged). This path
// abandons the FIFO entirely and keys the PA directly with delayMicroseconds,
// to the CANONICAL EV1527 spec (ref: foxel/arduino-ev1527-tx):
//
//   base period T = 330us
//   sync:   HIGH 1T (330us), then LOW 31T (10230us)   <- long LOW, carrier OFF
//   bit 1:  HIGH 3T (990us),  then LOW 1T (330us)
//   bit 0:  HIGH 1T (330us),  then LOW 3T (990us)
//   24 bits MSB-first (20 addr + 4 data), 5 repeats, no inter-repeat gap
//
// Two departures from our old frame this encodes (both from the reference):
//   1. sync is a SHORT high pulse + LONG LOW silence, not a 9ms carrier block
//   2. each bit is (HIGH)(LOW) — carrier ON first — not (gap)(pulse)
//
// PA keying: continuous-carrier TX (STX, stay in TX), carrier gated by the
// GDO0 pin driven as a plain GPIO. FREND0=0x11 + PATABLE={0x00,0xC0} give the
// PA an OFF entry so a LOW pin actually kills the carrier (without FREND0 it
// holds continuous carrier — see CLAUDE.md).
static const uint32_t kEvT = 330;  // EV1527 base period, us

// Put the radio in TX with the carrier gated by GDO0, and return with the pin
// an OUTPUT held LOW (carrier off). Shared by the RSSI probe and the replay.
static void enterKeyedTxMode() {
  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  strobe(0x36);  // SIDLE
  delay(1);
  spiWrite(0x02, 0x2D);  // IOCFG0: GDO0 = async serial data INPUT (gates carrier)
  spiWrite(0x21, 0x56);  // FREND1: TX
  spiWrite(0x17, 0x00);  // MCSM1: TXOFF -> IDLE, no CCA
  writeCommonConfig();
  spiWrite(0x22, 0x11);  // FREND0: PA_POWER=1 -> PATABLE[1] for carrier ON
  digitalWrite(kCsPin, LOW);
  SPI.transfer(0x3E | 0x40);  // PATABLE burst
  SPI.transfer(0x00);         // index 0 = OFF
  SPI.transfer(0xC0);         // index 1 = ON (~+10dBm)
  digitalWrite(kCsPin, HIGH);
  pinMode(kGdo0Pin, OUTPUT);
  digitalWrite(kGdo0Pin, LOW);  // carrier off
  strobe(0x35);                 // STX
  for (int i = 0; i < 100; i++) {
    if ((spiReadStatus(0x35) & 0x1F) == 0x13) break;
    delayMicroseconds(200);
  }
}

// Bit-bang one carrier pulse: HIGH=carrier on for the polarity in effect.
static inline void key(bool on, uint32_t us) {
  digitalWrite(kGdo0Pin, (on == gTxCarrierHigh) ? HIGH : LOW);
  while (us > 16000) { delayMicroseconds(16000); us -= 16000; }  // delayMicroseconds cap
  delayMicroseconds(us);
}

// TASK 1: prove GPIO keying RADIATES. Slow, unambiguous 300us-on/900us-off
// pulses (Kerui scale) driven by the pin. The other board must report BOTH
// strong RSSI (near -18dBm, NOT the -86dBm noise floor) and clean widths.
// If this is -86dBm, bit-bang replay is dead — fall back to an ASK module.
static void keyingRssiProbe() {
  Serial.println();
  Serial.println(">>> KEYING RSSI PROBE — 40 pulses of 300us ON / 900us OFF via GPIO");
  Serial.println("    WATCH THE OTHER BOARD: RSSI near -18dBm = keying radiates;");
  Serial.println("    -86dBm = noise floor, keying does NOT radiate.");
  enterKeyedTxMode();
  uint8_t st = spiReadStatus(0x35) & 0x1F;
  Serial.printf("    MARCSTATE=0x%02X (0x13=TX)\n", st);
  for (int i = 0; i < 40; i++) { key(true, 300); key(false, 900); }
  key(false, 200);
  strobe(0x36);
  enterRxMode();
  Serial.println("    sent. Read the RSSI the other board reported.");
}

// Emit one 24-bit code to the canonical EV1527 frame, `repeats` times.
static void evEmit(uint32_t code, int repeats) {
  for (int r = 0; r < repeats; r++) {
    key(true, kEvT);       // sync: short HIGH
    key(false, kEvT * 31); // sync: long LOW (carrier off ~10.2ms)
    for (int b = kBits - 1; b >= 0; b--) {  // MSB first
      if ((code >> b) & 1) { key(true, kEvT * 3); key(false, kEvT);     }  // bit 1
      else                 { key(true, kEvT);     key(false, kEvT * 3); }  // bit 0
    }
  }
}

// TASK 2: canonical EV1527 replay at the siren. Sends codeA then codeB (both
// on-ids, as the hub does), 5 repeats each, two rounds with a 5s listen gap.
static void evSendSequence(uint32_t codeA, uint32_t codeB, const char* label) {
  Serial.printf(">>> EV1527 canonical %s: %06lX then %06lX, x2 rounds\n",
                label, (unsigned long)codeA, (unsigned long)codeB);
  enterKeyedTxMode();
  for (int round = 0; round < 2; round++) {
    Serial.printf("    round %d/2\n", round + 1);
    evEmit(codeA, 5);
    delay(20);
    evEmit(codeB, 5);
    if (round == 0) {
      strobe(0x36); enterRxMode();
      Serial.println("    ...5s gap");
      listenFor(5000, "between rounds");
      enterKeyedTxMode();
    }
  }
  key(false, 200);
  strobe(0x36);
  enterRxMode();
  Serial.println("    sequence sent. DID THE SIREN SOUND?");
}

static void printMenu() {
  Serial.println();
  Serial.println("--- commands ---------------------------------------------");
  Serial.println("  l  LOOPBACK TEST — verify TX is well-formed (run this first)");
  Serial.printf("  p  flip TX polarity (now: carrier ON = GDO0 %s)\n",
                gTxCarrierHigh ? "HIGH" : "LOW");
  Serial.println("  1  test pair 0x62237: send nibble 4 (on), wait 8s, nibble 2 (off)");
  Serial.println("  2  test pair 0x3F010: send nibble 8 (on), wait 8s, nibble 2 (off)");
  Serial.println("  3  HAMMER 0x622374 (on) — 6 bursts back to back");
  Serial.println("  4  HAMMER 0x3F0108 (on) — 6 bursts back to back");
  Serial.println("  5  HUB-STYLE ON  — both ids, 8 copies each, 2 rounds");
  Serial.println("  6  HUB-STYLE OFF — both ids, 8 copies each, 2 rounds");
  Serial.println("  7  CANDIDATE SWEEP — 10 framings, 4s apart (siren judges)");
  Serial.println("  8  FREQ SWEEP 0x622374 — 11 frequencies, 433.6-434.3MHz");
  Serial.println("  9  FREQ SWEEP 0x3F0108 — same, other transmitter id");
  Serial.println("  b  KEYING RSSI PROBE — GPIO bit-bang (PROVEN dead: -92dBm)");
  Serial.println("  V  EV1527 VERIFY — canonical frame x4, check widths on RX monitor");
  Serial.println("  n  EV1527 CANONICAL ON  — FIFO, both ids, hub-style (FIRE AT SIREN)");
  Serial.println("  m  EV1527 CANONICAL OFF — FIFO, both off ids");
  Serial.println("  --- LEARN-MODE PAIRING (teach the siren OUR code) ---");
  Serial.println("  W  pair WAVEFORM VERIFY — canonical EV1527, check on RX monitor first");
  Serial.printf("  S  ANNOUNCE AS SENSOR 0x%06lX — control test: is our TX correct?\n",
                (unsigned long)kPairCodeSensor);
  Serial.printf("  T  re-fire sensor code 0x%06lX (panel should react)\n",
                (unsigned long)kPairCodeSensor);
  Serial.printf("  P  TEACH ON 0x%06lX — siren MUST be in study mode (hold SET till beep)\n",
                (unsigned long)kPairCodeOn);
  Serial.printf("  O  FIRE learned ON 0x%06lX\n", (unsigned long)kPairCodeOn);
  Serial.printf("  F  FIRE OFF 0x%06lX\n", (unsigned long)kPairCodeOff);
  Serial.println("  x  send ALL off codes (panic stop)");
  Serial.println("  r  receive-only: just listen for 30s");
  Serial.println("----------------------------------------------------------");
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);
  delay(100);
  Serial.println();
  Serial.println("=== spike_siren_tx ===");

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

  enterRxMode();
  uint8_t ms = spiReadStatus(0x35) & 0x1F;
  Serial.printf("MARCSTATE=0x%02X (%s)\n", ms, ms == 0x0D ? "RX" : "unexpected");

  Serial.println();
  Serial.println("WARNING: this transmits on 433MHz and may sound your siren.");
  Serial.println("Press 'x' at any time to send every known off code.");
  printMenu();
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    switch (c) {
      case 'l': loopbackTest(); printMenu(); break;
      case 's': sweepRates(); printMenu(); break;
      case 'w': slowPulseTest(); printMenu(); break;
      case 'c': sweepTxConfigs(); printMenu(); break;
      case 'd': pinDriveTest(); printMenu(); break;
      case 'y': sweepTiming(); printMenu(); break;
      case 'a': sweepPa(); printMenu(); break;
      case 'z': timingSelfCheck(); printMenu(); break;
      case 'e': sweepEnvelope(); printMenu(); break;
      case 'o': carrierOnTest(); printMenu(); break;
      case 'f': fifoTxTest(); printMenu(); break;
      case 'q': sweepSymbol(); printMenu(); break;
      case 'v': widthProbe(); printMenu(); break;
      case 'g':
        Serial.println(">>> FIFO Kerui TX of 0x622374");
        fifoSendCode(0x622374);
        Serial.println("    sent.");
        printMenu();
        break;
      case 'k':
        gPktctrl0 = (gPktctrl0 == 0x30) ? 0x32 : 0x30;
        Serial.printf(">>> PKTCTRL0 = 0x%02X (%s)\n", gPktctrl0,
                      gPktctrl0 == 0x30 ? "async + fixed length"
                                        : "async + infinite length");
        printMenu();
        break;
      case 't':
        Serial.println(">>> single TX of 0x622374 (watch the other board)");
        transmitCode(0x622374);
        printMenu();
        break;
      case 'p':
        gTxCarrierHigh = !gTxCarrierHigh;
        Serial.printf(">>> TX polarity flipped: carrier ON = GDO0 %s\n",
                      gTxCarrierHigh ? "HIGH" : "LOW");
        printMenu();
        break;
      case '1': runPair(0); printMenu(); break;
      case '2': runPair(1); printMenu(); break;
      case '3': hammer(0x622374); printMenu(); break;
      case '4': hammer(0x3F0108); printMenu(); break;
      case '5': sendHubSequence(0x622374, 0x3F0108, "ON");  printMenu(); break;
      case '6': sendHubSequence(0x3F0102, 0x622372, "OFF"); printMenu(); break;
      case '7': sweepCandidates(); printMenu(); break;
      case '8': sweepFrequency(0x622374); printMenu(); break;
      case '9': sweepFrequency(0x3F0108); printMenu(); break;
      // Sweep with the OFF codes. Preferred over the ON sweep for diagnosis:
      // the siren answers a valid off command with 3 short beeps instead of
      // sounding fully, so a hit is audible without waking the neighbourhood.
      case 'G': sweepFrequency(0x3F0102); printMenu(); break;
      case 'H': sweepFrequency(0x622372); printMenu(); break;
      case 'N': sweepNibbles(0x3F010); printMenu(); break;
      case 'M': sweepNibbles(0x62237); printMenu(); break;
      case 'L': sweepPower(0x622374); printMenu(); break;
      case 'A': mimicPanelAlarm(); printMenu(); break;
      case 'B': mimicPanelOff();   printMenu(); break;
      // '=' — PAIR at panel-parity power, looped.
      //
      // Every previous pairing attempt transmitted at -18dBm measured at the
      // siren, 47dB above the -65dBm the panel uses. If the siren's front end
      // is being overdriven, pairing would fail for exactly the same reason
      // triggering does - so no pairing attempt to date has been a fair test.
      //
      // PATABLE 0x84 lands at -62dBm from the board's present position, which
      // is parity with the panel. Runs long so it is already on air when SET is
      // pressed; the learn window is only 4-5s.
      case '=': {
        Serial.println();
        Serial.println(">>> PAIR AT PANEL POWER — 0xA1B2C4, PATABLE 0x84, ~60s");
        Serial.println("    click SET on the siren while this is running");
        gVerboseBuild = false;
        gPaLevel = 0x84;
        for (int i = 0; i < 60 && !Serial.available(); i++) {
          evFifoSend(kPairCodeOn, 8);
          if (i % 10 == 0) Serial.printf("    round %d/60\n", i + 1);
          delay(400);
        }
        gPaLevel = 0xC0;
        gVerboseBuild = true;
        Serial.println("    done — beep = it heard us; long beep = paired.");
        printMenu(); break;
      }
      // ']' — minimum power, looped, for the "we are too LOUD" hypothesis.
      //
      // Measured at the siren's own location: the panel drives it at -65dBm
      // while we arrive at -18dBm - 47dB hotter, ~50,000x the power, decoding
      // identically. So our signal certainly reaches it. But a
      // super-regenerative front end can be desensitised or blocked by a signal
      // that far above its normal operating point, and that would fit every
      // observation including the dead-silent 3-second carrier.
      //
      // Earlier power sweeps bottomed out at -29dBm measured, still +36dB over
      // the panel. PATABLE 0x0E (~-20dBm output) is the lowest table entry, so
      // reaching parity needs PHYSICAL attenuation too: move the board away or
      // detach the antenna until the RX board beside the siren reads ~-65dBm.
      case ']': {
        Serial.println();
        // PATABLE 0x84 (~+5dBm). Calibrated against a measurement rather than
        // guessed: from the board's current position 0x0E arrived at -90dBm,
        // and the panel drives the siren at -65dBm, so +25dB of output is
        // needed. Re-measure and re-pick this if the board moves.
        Serial.println(">>> PANEL-PARITY POWER LOOP (PATABLE 0x84, target ~-65dBm at RX)");
        gVerboseBuild = false;
        gPaLevel = 0x84;
        for (int i = 0; i < 40 && !Serial.available(); i++) {
          evFifoSend(0x622374, 8);
          if (i % 8 == 0) Serial.printf("    round %d/40\n", i + 1);
          delay(500);
        }
        gPaLevel = 0xC0;
        gVerboseBuild = true;
        Serial.println("    done.");
        printMenu(); break;
      }
      // '[' — rtl_433 Kerui params, LOOPED for ~60s.
      //
      // The learn window is only 4-5s, far shorter than a sweep, so the signal
      // has to already be on air when SET is pressed rather than being fired
      // after it. Same reason pairTeachOn runs long.
      case '[': {
        Serial.println();
        Serial.println(">>> LOOPING rtl_433 params (s=333 l=972 r=11000) — click SET NOW");
        gVerboseBuild = false;
        gRtl433 = true; gRtl433Sync = 11000;
        for (int i = 0; i < 60 && !Serial.available(); i++) {
          evFifoSend(0x622374, 6);
          if (i % 10 == 0) Serial.printf("    round %d/60\n", i + 1);
          delay(400);
        }
        gRtl433 = false;
        gVerboseBuild = true;
        Serial.println("    done — did the window extend?");
        printMenu(); break;
      }
      // ';' — rtl_433 timings AND its 'invert' flag.
      //
      // The Kerui flex spec ends with 'invert', meaning the on-air bits are the
      // complement of the logical value. We fixed a complement bug earlier by
      // matching the PANEL, which is correct for reading the panel's sensor
      // traffic - but if the siren expects the inverted convention, matching
      // the panel put us exactly one inversion away from it.
      //
      // 0x622374 ^ 0xFFFFFF = 0x9DDC8B, 0x3F0108 ^ 0xFFFFFF = 0xC0FEF7. We have
      // transmitted those VALUES before, but only through the old buggy encoder
      // - never as a deliberate inversion with the framing otherwise correct
      // and the rtl_433 timings in place.
      case ';': {
        Serial.println();
        Serial.println(">>> rtl_433 TIMINGS + INVERT — 0x9DDC8B / 0xC0FEF7");
        gVerboseBuild = false;
        gRtl433 = true; gRtl433Sync = 11000;
        for (int r = 0; r < 3; r++) {
          evFifoSend(0x622374u ^ 0xFFFFFFu, 10);
          delay(300);
          evFifoSend(0x3F0108u ^ 0xFFFFFFu, 10);
          delay(700);
        }
        gRtl433 = false;
        gVerboseBuild = true;
        Serial.println("    done — any reaction?");
        printMenu(); break;
      }
      // '.' — rtl_433's OWN Kerui decoder parameters.
      //
      // From conf/rtl_433.example.conf, the flex spec for this exact brand:
      //   m=OOK_PWM, s=333, l=972, r=11000, g=1100, bits=25, invert
      //
      // Two differences from what we have been sending, both meaningful:
      //   * r=11000, not the 9280us we measured off the panel and copied. The
      //     inter-packet gap is what a receiver keys on to find frame start,
      //     and 1800us is a large miss on that parameter.
      //   * bits=25 - rtl_433 counts the leading sync as a 25th data bit,
      //     described as "a leading sync bit having a wide gap that runs into
      //     the preceding packet".
      // The pulse ratio agrees (972/333 = 2.92 vs our 2.97), so the SHAPE was
      // right all along; the framing gap was not.
      //
      // Sweeps the sync gap around rtl_433's value since ours is
      // pre-compensated for the OOK stretch and the two need reconciling.
      case '.': {
        Serial.println();
        Serial.println(">>> rtl_433 KERUI PARAMS — s=333 l=972, sync swept around r=11000");
        gVerboseBuild = false;
        const uint16_t syncs[] = { 8200, 9200, 10200, 11000, 12000 };
        for (int i = 0; i < 5; i++) {
          Serial.printf("    sync command %uus\n", syncs[i]);
          gRtl433Sync = syncs[i];
          gRtl433 = true;
          evFifoSend(0x622374, 10);
          delay(300);
          evFifoSend(0x3F0108, 10);
          gRtl433 = false;
          delay(700);
        }
        gVerboseBuild = true;
        Serial.println("    done — any reaction?");
        printMenu(); break;
      }
      // ',' — one frame per transmission, with real IDLE between frames.
      //
      // Cheap sirens use SUPER-REGENERATIVE receivers (the superheterodyne
      // modules like RXB6/SRX882 are the upgrade part). A super-regenerative
      // front end quenches and re-settles continuously, and its AGC recovery is
      // slow - it needs genuine carrier-off dead time between bursts to
      // re-acquire. Every frame we have ever sent went out as ONE continuous
      // FIFO stream with no idle, separated only by the ~9.2ms sync gap.
      //
      // Note this is NOT what mimicPanelAlarm tested: that put delay() between
      // CODE CHANGES, but each evFifoSend still streamed all its repeats
      // back-to-back. This puts real idle between every individual frame, with
      // the radio dropping to IDLE and the PA fully off in between.
      //
      // Sweeps several idle lengths since the right value depends on the
      // receiver's quench rate, which we cannot measure.
      case ',': {
        Serial.println();
        Serial.println(">>> IDLE-GAP SWEEP — one frame per burst, PA off between");
        gVerboseBuild = false;
        const uint16_t gaps[] = { 10, 25, 50, 100, 200 };
        for (int g = 0; g < 5; g++) {
          Serial.printf("    gap %ums, 10 frames\n", gaps[g]);
          for (int i = 0; i < 10; i++) {
            evFifoSend(0x622374, 1);   // ONE frame, then the radio idles
            delay(gaps[g]);
          }
          delay(800);
        }
        gVerboseBuild = true;
        Serial.println("    done — any reaction?");
        printMenu(); break;
      }
      // '/' — sweep the 315MHz BAND, never tested.
      //
      // Motivated by a control that came back negative in a surprising way: a
      // 3-second CONTINUOUS CARRIER at -18dBm, a metre away, produced no
      // reaction at all from the siren - not even a disturbance. Combined with
      // it rejecting every format we send, that raises the possibility it is
      // simply not listening on 433MHz. These sirens ship in 315MHz variants
      // too, and the two are physically incompatible.
      //
      // Our earlier frequency sweep covered 433.6-434.3MHz, which would not
      // touch 315MHz at all. The CC1101 supports 300-348MHz, so this is
      // reachable - though the antenna is cut for 433MHz and will be badly
      // mismatched, which at 1 metre should still be far more than enough.
      case '/': {
        Serial.println();
        Serial.println(">>> 315MHz BAND SWEEP — a band we have never transmitted on");
        gVerboseBuild = false;
        struct { uint8_t f2, f1, f0; const char* note; } freqs[] = {
          { 0x0C, 0x1D, 0x8A, "315.00 MHz" },
          { 0x0C, 0x1A, 0x00, "314.35 MHz" },
          { 0x0C, 0x21, 0x00, "315.65 MHz" },
          { 0x0C, 0x14, 0x00, "313.00 MHz" },
          { 0x0C, 0x28, 0x00, "317.30 MHz" },
        };
        gFreqOverride = true;
        for (int i = 0; i < 5; i++) {
          gF2 = freqs[i].f2; gF1 = freqs[i].f1; gF0 = freqs[i].f0;
          Serial.printf("    %s\n", freqs[i].note);
          evFifoSend(0x622374, 10);
          delay(400);
          evFifoSend(0x3F0108, 10);
          delay(600);
        }
        gFreqOverride = false;
        gF2 = 0x10; gF1 = 0xB0; gF0 = 0x71;
        gVerboseBuild = true;
        Serial.println("    done — any reaction at all?");
        printMenu(); break;
      }
      // 'p' — PT2262 FIXED-CODE, a format we have never transmitted.
      //
      // Chinese sources note that a siren may be PT2262 fixed-code while the
      // panel is EV1527 learning-code, in which case they simply cannot pair
      // directly. That fits every observation here: the panel (EV1527) accepts
      // us, the siren rejects everything we send, and a REAL EV1527 door sensor
      // also failed to complete pairing with it.
      //
      // PT2262 is structurally different - each bit is TWO pulse-pairs, not one:
      //   0 = (short-hi, long-lo)(short-hi, long-lo)
      //   1 = (long-hi, short-lo)(long-hi, short-lo)
      //   F = (short-hi, long-lo)(long-hi, short-lo)      <- tri-state
      //   sync = short-hi + 31*alpha low
      // 12 tri-state bits x 4 transitions = 48 slots. Note that is the same
      // transition COUNT as our 24-bit EV1527 frame, so our own decoder reads a
      // PT2262 frame as 24 plausible-looking bits - which is exactly why this
      // would never have shown up in any capture.
      //
      // Address is set by DIP switches / solder links on these units, so sweep
      // the common patterns: all-0, all-1, all-F, and a few mixed ones.
      case '\'': {
        Serial.println();
        Serial.println(">>> PT2262 FIXED-CODE SWEEP — a format we have never sent");
        gVerboseBuild = false;
        // Each entry is 12 tri-state digits, '0'/'1'/'F', then a 4-bit data
        // nibble appended as PT2262 data bits (D0-D3 use the same encoding).
        const char* addrs[] = {
          "000000000000", "111111111111", "FFFFFFFFFFFF",
          "0000FFFFFFFF", "FFFF00000000", "0F0F0F0F0F0F",
        };
        for (int a = 0; a < 6; a++) {
          Serial.printf("    addr %s\n", addrs[a]);
          pt2262Send(addrs[a], 0x8, 6);
          delay(600);
        }
        gVerboseBuild = true;
        Serial.println("    done — did the window extend on any?");
        printMenu(); break;
      }
      // 'U' — sweep the four ONE-HOT key nibbles on one address, panel clock.
      //
      // The EV1527 datasheet (sc-tech.cn/ev1527.pdf) defines the 4-bit key code
      // as one-hot: K0-K3 map to D0-D3 and a pressed button sets its bit, so
      // standard values are 1, 2, 4, 8. Our ghost-sensor code 0xB3C4DE used
      // nibble 0xE (1110) - three bits set, not a valid key - and that is what
      // most pairing attempts sent.
      //
      // Caveat, measured here: the real door sensor uses nibbles 3 and 9, also
      // not one-hot, and it DOES extend the siren's learn window. So the siren
      // is not strictly validating and this is unlikely to be the whole story -
      // but 0xE was still wrong and costs nothing to eliminate.
      //
      // Run against the window-extension test: click SET, then press U.
      case 'U': {
        Serial.println();
        Serial.println(">>> ONE-HOT KEY SWEEP on 0xA1B2C - nibbles 1,2,4,8");
        gVerboseBuild = false;
        const uint8_t nibs[] = { 1, 2, 4, 8 };
        for (int i = 0; i < 4; i++) {
          uint32_t code = (0xA1B2CUL << 4) | nibs[i];
          Serial.printf("    nibble %X -> 0x%06lX\n", nibs[i], (unsigned long)code);
          evFifoSend(code, 10);
          delay(700);
        }
        gVerboseBuild = true;
        Serial.println("    done — did the window extend on any of them?");
        printMenu(); break;
      }
      // 'Z' — zoogara timings, from a WORKING pairing on this OEM siren family
      // (HA community thread, Digoo DG-ROSA, confirmed again on an EARYKONG):
      //   RfSync 13100, RfHigh 1250, RfLow 420
      //
      // Materially different from the panel's clock, which is what we have been
      // copying: cell 1670us vs our 1200us, a 40% slower time base. Our
      // time-base sweep topped out at 1800us but held the panel's shape, so it
      // never actually sat on these numbers. The ratio matches (1250/420 =
      // 2.98:1, panel 2.88:1), so it is the CLOCK that differs, not the shape.
      //
      // Recipe: put the siren in learn mode and send #xxxx88; the siren then
      // recognises xxxx84 / xxxx81 / xxxx82 as the other commands for free.
      case 'Z': {
        Serial.println();
        Serial.println(">>> ZOOGARA TIMINGS — sync 13100, high 1250, low 420");
        Serial.println("    siren must be in LEARN MODE now; sending 0xABCD88");
        gVerboseBuild = false;
        gZoogara = true;
        for (int round = 0; round < 40 && !Serial.available(); round++) {
          evFifoSend(0xABCD88, 8);
          if (round % 5 == 0) Serial.printf("    round %d/40\n", round + 1);
          delay(300);
        }
        gZoogara = false;
        gVerboseBuild = true;
        Serial.println("    done — long beep = paired. Then press 'Q' to trigger.");
        printMenu(); break;
      }
      // 'Q' — trigger using the codes the siren learns from the pairing above.
      case 'Q': {
        Serial.println(">>> ZOOGARA TRIGGER: 0xABCD84 (arm home), then 0xABCD88 (SOS)");
        gVerboseBuild = false;
        gZoogara = true;
        evFifoSend(0xABCD84, 12);
        delay(600);
        evFifoSend(0xABCD88, 12);
        gZoogara = false;
        gVerboseBuild = true;
        Serial.println("    sent.");
        printMenu(); break;
      }
      // 'X'/'Y' — replay the REAL door sensor's codes from our radio.
      //
      // Decisive test. In learn mode the siren EXTENDS its window for a real
      // door sensor but not for our invented codes, so it is distinguishing
      // them somehow. Two candidates: (a) our RF differs in a way the siren
      // can detect, or (b) it validates the 20-bit address and rejects our
      // made-up values (0xA1B2C4 / 0xB3C4DE are patterned, not factory-burned).
      //
      // Sending the sensor's OWN address from OUR transmitter separates them:
      //   window extends -> our RF is fine, invented addresses were the problem
      //   no reaction    -> the address is fine, our RF is the problem
      // 0x2E5B73 = door closed, 0x2E5B79 = door opened (captured from the
      // real sensor; same 20-bit id 0x2E5B7, different event nibble).
      case 'X': Serial.println(">>> real sensor code 0x2E5B79 (opened) x12");
                evFifoSend(0x2E5B79, 12); Serial.println("    sent.");
                printMenu(); break;
      case 'Y': Serial.println(">>> real sensor code 0x2E5B73 (closed) x12");
                evFifoSend(0x2E5B73, 12); Serial.println("    sent.");
                printMenu(); break;
      // 'R' — pair as an ON/OFF PAIR, not a single code.
      //
      // Observed 2026-08-28: pressing SET opens a ~5s window; if a code
      // arrives at ~4s the window EXTENDS by another 5-6s. That is not the
      // behaviour of a receiver waiting for one code - it looks like it takes
      // the trigger code, then keeps listening for the matching OFF code
      // before committing the binding. A siren needs both ("sound" and
      // "stop"), so this fits its job exactly.
      //
      // It also explains every failure so far: single-code attempts (ours AND
      // a real factory door sensor) got the acknowledgement beep and then
      // nothing, because the second half never came. A door sensor only ever
      // sends one code, so it can never complete this pairing. And the one
      // case that DID work - pairing from the panel - sends both halves.
      case 'R': {
        Serial.println();
        Serial.println(">>> PAIR AS ON/OFF PAIR — click SET first, then run this");
        gVerboseBuild = false;
        Serial.println("    phase 1: ON  0xA1B2C4 x12");
        evFifoSend(kPairCodeOn, 12);
        Serial.println("    ...2s gap (siren should extend its window)");
        delay(2000);
        Serial.println("    phase 2: OFF 0xA1B2C2 x12");
        evFifoSend(kPairCodeOff, 12);
        gVerboseBuild = true;
        Serial.println("    done — a LONG beep = bound. Then press O to test.");
        printMenu(); break;
      }
      case 'C': sweepTimeBase(0x622374); printMenu(); break;
      // 'E' — imitate BOTH transmitters. The SOS capture shows the same codes
      // arriving at -39dBm and again at -74/-82dBm: two physically distinct
      // transmitters, not fading (a 35-40dB spread). We have only ever replayed
      // at one strength. If the siren is bound to the WEAK unit, a strong-only
      // replay would never match what it expects to hear.
      case 'E': {
        Serial.println();
        Serial.println(">>> DUAL-TRANSMITTER MIMIC — strong burst then weak burst");
        gVerboseBuild = false;
        gPaLevel = 0xC0;  Serial.println("    strong 0x622374 x12");
        evFifoSend(0x622374, 12);
        delay(490);
        gPaLevel = 0x1D;  Serial.println("    weak   0x622374 x12 (-10dBm)");
        evFifoSend(0x622374, 12);
        delay(1550);
        gPaLevel = 0x0E;  Serial.println("    weaker 0x622374 x12 (-20dBm)");
        evFifoSend(0x622374, 12);
        gPaLevel = 0xC0;
        gVerboseBuild = true;
        Serial.println("    done.");
        printMenu(); break;
      }
      case 'D': sweepTimeBase(0x3F0108); printMenu(); break;
      // Send ONE code via the verified evFifoSend path. The 3/4 'hammer'
      // commands use fifoSendCode, which still emits a ~7.9ms delimiter and
      // frames our own counter reads as 1 cell — malformed. These two are the
      // single-code equivalents that actually go out well-formed.
      case 'J': Serial.println(">>> 0x3F0108 x27 (pairing identity, ON nibble)");
                evFifoSend(0x3F0108, 27); Serial.println("    sent.");
                printMenu(); break;
      case 'K': Serial.println(">>> 0x622374 x27 (alarm trigger)");
                evFifoSend(0x622374, 27); Serial.println("    sent.");
                printMenu(); break;
      case 'x': sendAllOff(); printMenu(); break;
      case 'b': keyingRssiProbe(); printMenu(); break;
      case 'W': pairVerify();  printMenu(); break;
      case 'S': pairAnnounceSensor(); printMenu(); break;
      case 'T': pairFireSensor();     printMenu(); break;
      case 'P': pairTeachOn(); printMenu(); break;
      case 'O': pairFireOn();  printMenu(); break;
      // '-' — trigger the paired code at PANEL-PARITY power.
      //
      // 'O' routes through pairFifoSend, which hardcodes PATABLE 0xC0 (full
      // power). If pairing succeeded at the reduced level, the trigger has to
      // match it - firing 47dB hotter than the code was learned at is not a
      // like-for-like test.
      case '-': {
        Serial.println();
        Serial.println(">>> TRIGGER 0xA1B2C4 at panel power (PATABLE 0x84)");
        gVerboseBuild = false;
        gPaLevel = 0x84;
        evFifoSend(kPairCodeOn, 12);
        delay(500);
        evFifoSend(kPairCodeOn, 12);
        gPaLevel = 0xC0;
        gVerboseBuild = true;
        Serial.println("    sent.");
        printMenu(); break;
      }
      case 'F': pairFireOff(); printMenu(); break;
      case 'V': evVerify();  printMenu(); break;
      case 'n': evSirenOn();  printMenu(); break;
      case 'm': evSirenOff(); printMenu(); break;
      case 'r':
        Serial.println(">>> receive-only, 30s...");
        listenFor(30000, "passive");
        Serial.println("    done.");
        printMenu();
        break;
      default: break;
    }
  }
  drainAndReport("idle");
}
