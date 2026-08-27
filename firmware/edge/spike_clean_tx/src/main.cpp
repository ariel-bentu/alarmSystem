// spike_clean_tx — EV1527 transmitter written from the protocol spec alone.
//
// Deliberately a CLEAN-ROOM implementation. spike_siren_tx has accumulated many
// rounds of patches and pre-compensation constants, each justified by a
// measurement made at the time, and any one of them could now be wrong in a way
// that is invisible when reading the code. This derives everything from first
// principles so the two can be diffed.
//
// PROTOCOL (EV1527, as specified, not as previously measured here):
//   frame = sync + 24 bits, MSB first
//   sync  = 1 short carrier pulse, then 31 short-periods of silence
//   bit 1 = 3 periods carrier ON,  1 period OFF
//   bit 0 = 1 period carrier ON,   3 periods OFF
//   every bit cell is 4 periods long; frames repeat back to back
//
// One base period T is the only timing knob. At T=320us: bit cell 1280us,
// sync gap 9920us. The panel here measures a ~1200us cell, so T=300 is the
// closer match; both are selectable below.
//
// CC1101 SETUP, from the datasheet:
//   OOK is PATABLE[0] (off) vs PATABLE[1] (on), selected by FREND0's PA_POWER.
//   Asynchronous transparent TX (PKTCTRL0=0x32) lets us key the PA directly by
//   driving GDO0 as an input to the modulator... except GDO0 is wired as an
//   OUTPUT on this board and GDO2 is not connected at all, so that path cannot
//   work here. Therefore: normal packet mode, streaming a pre-rendered bit
//   pattern through the TX FIFO, one FIFO bit per T/8.
//
// Wiring: GPIO10=CS, GPIO12=SCK, GPIO11=MOSI, GPIO13=MISO, GPIO4=GDO0

#include <Arduino.h>
#include <SPI.h>

static const uint8_t kCsPin   = 10;
static const uint8_t kGdo0Pin = 4;

// ---------------------------------------------------------------------------
// SPI primitives
// ---------------------------------------------------------------------------

static void csLow()  { digitalWrite(kCsPin, LOW); }
static void csHigh() { digitalWrite(kCsPin, HIGH); }

static void writeReg(uint8_t addr, uint8_t val) {
  csLow(); SPI.transfer(addr); SPI.transfer(val); csHigh();
}

static uint8_t readStatus(uint8_t addr) {
  csLow(); SPI.transfer(addr | 0xC0);
  uint8_t v = SPI.transfer(0);
  csHigh();
  return v;
}

static void strobe(uint8_t cmd) { csLow(); SPI.transfer(cmd); csHigh(); }

// ---------------------------------------------------------------------------
// Frame rendering
//
// The FIFO is clocked at a fixed chip rate. We render the waveform as a bit
// pattern where a 1 bit means "carrier on for one chip". With CHIPS_PER_T chips
// per base period, one bit cell is 4*CHIPS_PER_T chips.
//
// POLARITY: deliberately a compile-time constant rather than something derived
// from prior measurements, so it can be flipped and re-tested independently.
// kCarrierBit is the FIFO bit value that produces carrier ON.
// ---------------------------------------------------------------------------

// FIFO chips per base period T. Was 8 (37.5us chips at T=300), which measured
// 18dB weaker on air than spike_siren_tx at the same PA level, frequency and a
// near-identical duty cycle (37% vs 38%) - so the loss was real, not an
// averaging artifact. The working sender renders T with FEWER, LONGER chips
// (~62-70us), and fewer transitions per bit means less modulator filtering.
// 4 chips per T puts us in that range while still resolving 1T and 3T exactly.
static const int kChipsPerT = 4;
static bool kCarrierBit = 1;          // toggled by 'i'
static uint16_t gPeriodUs = 300;      // base period T

static uint8_t gBits[4096];
static int gNumBits;

static void emit(bool carrier, int periods) {
  int chips = periods * kChipsPerT;
  for (int i = 0; i < chips && gNumBits < (int)sizeof(gBits) * 8; i++) {
    bool v = carrier ? kCarrierBit : !kCarrierBit;
    if (v) gBits[gNumBits >> 3] |= (uint8_t)(1 << (7 - (gNumBits & 7)));
    gNumBits++;
  }
}

// One frame: sync, then 24 bits MSB first.
static void renderFrame(uint32_t code) {
  emit(true, 1);          // sync pulse: 1 period of carrier
  emit(false, 31);        // sync gap:  31 periods of silence
  for (int b = 23; b >= 0; b--) {
    if ((code >> b) & 1) { emit(true, 3); emit(false, 1); }   // bit 1
    else                 { emit(true, 1); emit(false, 3); }   // bit 0
  }
}

static void renderBurst(uint32_t code, int repeats) {
  memset(gBits, 0, sizeof(gBits));
  gNumBits = 0;
  for (int r = 0; r < repeats; r++) renderFrame(code);
}

// ---------------------------------------------------------------------------
// Radio configuration
//
// DRATE is chosen so one chip lasts T/kChipsPerT. The CC1101 data rate is
//   R = (256 + DRATE_M) * 2^DRATE_E * Fxosc / 2^28,  Fxosc = 26MHz
// We solve for the (E,M) pair closest to the wanted rate.
// ---------------------------------------------------------------------------

static void computeDrate(uint32_t chipUs, uint8_t* e, uint8_t* m) {
  double want = 1e6 / (double)chipUs;                 // chips per second
  double best = 1e18;
  for (int E = 0; E < 16; E++) {
    for (int M = 0; M < 256; M++) {
      double r = (256.0 + M) * pow(2.0, E) * 26e6 / pow(2.0, 28);
      double err = fabs(r - want);
      if (err < best) { best = err; *e = (uint8_t)E; *m = (uint8_t)M; }
    }
  }
}

static uint8_t gPaLevel = 0xC0;

static void configureRadio() {
  strobe(0x36);                       // SIDLE
  delay(2);

  writeReg(0x02, 0x06);               // IOCFG0: packet-status (unused in TX)
  writeReg(0x08, 0x00);               // PKTCTRL0: fixed length, no CRC/whitening
  writeReg(0x07, 0x00);               // PKTCTRL1: no address check
  writeReg(0x0D, 0x10);               // FREQ2 \
  writeReg(0x0E, 0xB0);               // FREQ1  > 433.92MHz
  writeReg(0x0F, 0x71);               // FREQ0 /
  writeReg(0x12, 0x30);               // MDMCFG2: OOK, no Manchester, no sync word
  writeReg(0x13, 0x02);               // MDMCFG1: NUM_PREAMBLE = 0
  writeReg(0x14, 0x00);               // MDMCFG0: channel spacing (unused, 1 chan)

  uint8_t e, m;
  computeDrate(gPeriodUs / kChipsPerT, &e, &m);
  writeReg(0x10, (uint8_t)(0x80 | e));   // MDMCFG4: RX BW high nibble + DRATE_E
  writeReg(0x11, m);                     // MDMCFG3: DRATE_M

  writeReg(0x22, 0x11);               // FREND0: PA_POWER=1 -> PATABLE[1] is "on"
  writeReg(0x17, 0x30);               // MCSM1: stay put after TX
  writeReg(0x18, 0x18);               // MCSM0: auto-calibrate on IDLE->TX

  csLow();                            // PATABLE: [0]=off, [1]=on, rest 0
  SPI.transfer(0x3E | 0x40);
  SPI.transfer(0x00);
  SPI.transfer(gPaLevel);
  for (int i = 2; i < 8; i++) SPI.transfer(0x00);
  csHigh();
}

static void transmit() {
  int nBytes = (gNumBits + 7) / 8;
  configureRadio();
  strobe(0x3B);                       // SFTX: flush TX FIFO
  writeReg(0x08, 0x02);               // infinite packet length while streaming

  int sent = 0;
  int first = nBytes < 60 ? nBytes : 60;
  csLow();
  SPI.transfer(0x3F | 0x40);
  for (int i = 0; i < first; i++) SPI.transfer(gBits[i]);
  csHigh();
  sent = first;

  strobe(0x35);                       // STX
  while (sent < nBytes) {
    if ((readStatus(0x3A) & 0x7F) < 40) {
      int chunk = nBytes - sent;
      if (chunk > 20) chunk = 20;
      csLow();
      SPI.transfer(0x3F | 0x40);
      for (int i = 0; i < chunk; i++) SPI.transfer(gBits[sent + i]);
      csHigh();
      sent += chunk;
    }
    delayMicroseconds(100);
  }
  while ((readStatus(0x3A) & 0x7F) > 0) delayMicroseconds(100);
  delayMicroseconds(gPeriodUs * 4);   // let the modulator drain
  strobe(0x36);                       // SIDLE
}

static void send(uint32_t code, int repeats) {
  renderBurst(code, repeats);
  Serial.printf("    T=%uus  polarity=%d  %d chips (%d bytes)  code=0x%06lX\n",
                gPeriodUs, (int)kCarrierBit, gNumBits, (gNumBits + 7) / 8,
                (unsigned long)code);
  transmit();
}

// ---------------------------------------------------------------------------

static void printMenu() {
  Serial.println();
  Serial.println("--- spike_clean_tx (from-spec EV1527) -----------------");
  Serial.printf("  T = %uus   polarity bit = %d   PA = 0x%02X\n",
                gPeriodUs, (int)kCarrierBit, gPaLevel);
  Serial.println("  T  cycle base period: 250/300/320/400/420us");
  Serial.println("  i  invert carrier polarity");
  Serial.println("  a  cycle PA level: C0 / 84 / 60 / 1D");
  Serial.println("  1  send 0x622374 x8   (panel alarm trigger)");
  Serial.println("  2  send 0x3F0108 x8   (panel, second id)");
  Serial.println("  3  send 0xA1B2C4 x8   (our pairing code)");
  Serial.println("  L  LOOP 0xA1B2C4 for 60s (click SET to pair)");
  Serial.println("-------------------------------------------------------");
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);
  delay(100);
  Serial.println();
  Serial.println("=== spike_clean_tx — EV1527 from spec, clean room ===");

  pinMode(kCsPin, OUTPUT); csHigh();
  pinMode(kGdo0Pin, INPUT);
  SPI.begin(12, 13, 11, kCsPin);

  strobe(0x30); delay(10);            // SRES
  uint8_t pn = readStatus(0x30), ver = readStatus(0x31);
  Serial.printf("PARTNUM=0x%02X VERSION=0x%02X %s\n", pn, ver,
                (pn == 0 && ver == 0x14) ? "OK" : "UNEXPECTED");
  if (pn != 0 || ver != 0x14) { Serial.println("Halting."); while (1) delay(1000); }

  uint8_t e, m;
  computeDrate(gPeriodUs / kChipsPerT, &e, &m);
  Serial.printf("chip=%uus -> DRATE_E=%u DRATE_M=%u\n",
                gPeriodUs / kChipsPerT, e, m);
  printMenu();
}

void loop() {
  if (!Serial.available()) { delay(20); return; }
  char c = Serial.read();
  switch (c) {
    case 'T': {
      const uint16_t opts[] = { 250, 300, 320, 400, 420 };
      for (int i = 0; i < 5; i++)
        if (gPeriodUs == opts[i]) { gPeriodUs = opts[(i + 1) % 5]; break; }
      printMenu();
      break;
    }
    case 'i': kCarrierBit = !kCarrierBit; printMenu(); break;
    case 'a': {
      const uint8_t opts[] = { 0xC0, 0x84, 0x60, 0x1D };
      for (int i = 0; i < 4; i++)
        if (gPaLevel == opts[i]) { gPaLevel = opts[(i + 1) % 4]; break; }
      printMenu();
      break;
    }
    // Nibble variants of the paired base address 0xA1B2C. The siren binds one
    // code and then recognises the whole one-hot family, per the zoogara
    // recipe: 8 = SOS, 4 = arm home, 1 = arm away, 2 = disarm. We paired
    // 0xA1B2C4, i.e. ARM HOME - which would explain a short acknowledgement
    // beep rather than the alarm sounding.
    // 's' — SAFE test: sound the siren, wait 5s, then stop it. Always prefer
    // this over a bare '8'; a plain SOS leaves the siren sounding until it is
    // switched off by hand.
    case 's': {
      Serial.println(">>> SAFE CYCLE: SOS, 5s, then disarm");
      send(0xA1B2C8, 10);
      Serial.println("    sounding — 5s");
      delay(5000);
      Serial.println("    sending disarm 0xA1B2C2");
      send(0xA1B2C2, 12);
      delay(400);
      send(0xA1B2C2, 12);            // twice, in case one burst is missed
      Serial.println("    done.");
      break;
    }
    case '8': Serial.println(">>> 0xA1B2C8 (SOS)");      send(0xA1B2C8, 10); break;
    case '4': Serial.println(">>> 0xA1B2C4 (arm home)"); send(0xA1B2C4, 10); break;
    case '5': Serial.println(">>> 0xA1B2C1 (arm away)"); send(0xA1B2C1, 10); break;
    case '6': Serial.println(">>> 0xA1B2C2 (disarm)");   send(0xA1B2C2, 10); break;
    case '1': Serial.println(">>> 0x622374"); send(0x622374, 8); break;
    case '2': Serial.println(">>> 0x3F0108"); send(0x3F0108, 8); break;
    case '3': Serial.println(">>> 0xA1B2C4"); send(0xA1B2C4, 8); break;
    case 'L':
      Serial.println(">>> LOOPING 0xA1B2C4 — click SET on the siren now");
      for (int i = 0; i < 80 && !Serial.available(); i++) {
        send(0xA1B2C4, 6);
        delay(300);
      }
      Serial.println("    done.");
      break;
    default: return;
  }
}
