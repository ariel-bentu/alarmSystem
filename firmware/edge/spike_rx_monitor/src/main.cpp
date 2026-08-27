// spike_rx_monitor — THROWAWAY DIAGNOSTIC. Runs on the SECOND ESP32-S3.
//
// Purpose: an INDEPENDENT receiver for verifying what spike_siren_tx actually
// transmits. A single CC1101 cannot cleanly receive its own transmission
// (the loopback attempt produced garbage for exactly this reason), so TX
// framing can only be checked with a separate radio.
//
// Reports the pulse timings that matter for Kerui framing:
//   delimiter:  carrier ON ~12400us  (seen here as LOW >5ms)
//   per bit:    ~400us gap, then carrier ON 400us (bit 1) or 1200us (bit 0)
//
// Wiring is identical to the other board:
//   GPIO10=CS, GPIO12=SCK, GPIO11=MOSI, GPIO13=MISO, GPIO4=GDO0

#include <Arduino.h>
#include <SPI.h>

static const uint8_t kCsPin   = 10;
static const uint8_t kGdo0Pin = 4;

static const int kBufSize = 2048;
static volatile uint32_t gTs[kBufSize];
static volatile uint8_t  gLv[kBufSize];
static volatile int      gCount = 0;
static volatile uint32_t gLastEdgeMs = 0;

static int gBurst = 0;

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

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);
  delay(100);
  Serial.println();
  Serial.println("=== spike_rx_monitor (independent receiver) ===");

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

  // Exactly the config that decodes real Kerui sensors on this hardware.
  spiWrite(0x02, 0x0D);  // IOCFG0: async serial data output
  spiWrite(0x08, 0x32);  // PKTCTRL0: async, infinite
  spiWrite(0x0D, 0x10);  // FREQ2
  spiWrite(0x0E, 0xB0);  // FREQ1
  spiWrite(0x0F, 0x71);  // FREQ0 -> 433.92MHz
  spiWrite(0x12, 0x30);  // MDMCFG2: OOK, no sync
  spiWrite(0x10, 0x87);  // MDMCFG4
  spiWrite(0x11, 0x32);  // MDMCFG3
  spiWrite(0x03, 0x07);  // FIFOTHR
  // Back to the exact AGC values that decode REAL Kerui sensors on this
  // hardware. Freezing the gain (07/00/B2) normalised every pulse to ~550us,
  // which destroyed the short/long distinction entirely.
  spiWrite(0x1B, 0x03);  // AGCCTRL2
  spiWrite(0x1C, 0x00);  // AGCCTRL1
  spiWrite(0x1D, 0x91);  // AGCCTRL0
  spiWrite(0x21, 0xB6);  // FREND1
  spiWrite(0x17, 0x30);  // MCSM1: stay in RX
  spiWrite(0x18, 0x18);  // MCSM0: auto-cal

  strobe(0x34);          // SRX
  for (int i = 0; i < 100; i++) {
    if ((spiReadStatus(0x35) & 0x1F) == 0x0D) break;
    delayMicroseconds(200);
  }
  uint8_t ms = spiReadStatus(0x35) & 0x1F;
  Serial.printf("MARCSTATE=0x%02X (%s)\n", ms, ms == 0x0D ? "RX — good" : "unexpected");

  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);
  Serial.println("Listening. Transmit from the other board now.");
  Serial.println();
}

void loop() {
  uint32_t nowMs = (uint32_t)(esp_timer_get_time() / 1000);
  // 700ms: long enough that a slow-pulse train (50ms on/off) stays in ONE
  // burst rather than being split across several captures.
  // Ambient noise keeps this window open for seconds and merges the real
  // packet with background, hiding delimiters. 120ms is longer than the
  // inter-bit gaps within a packet but short enough to isolate one burst.
  bool full = gCount > (kBufSize - 100);
  if (gCount == 0 || (!full && (nowMs - gLastEdgeMs) < 120)) return;

  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  int n = gCount;
  static uint32_t ts[kBufSize];
  static uint8_t  lv[kBufSize];
  memcpy(ts, (void*)gTs, n * sizeof(uint32_t));
  memcpy(lv, (void*)gLv, n * sizeof(uint8_t));
  gCount = 0;
  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);

  if (n < 20) return;

  // The 433MHz band here is noisy: with the transmitter silent this board
  // still sees ~1156 edges of ~53us pulses. Ignore bursts that carry no
  // pulse long enough to be part of a real Kerui frame, so ambient noise
  // is not mistaken for a weak transmission.
  {
    bool hasRealPulse = false;
    for (int i = 0; i < n - 1; i++) {
      uint32_t d = ts[i + 1] - ts[i];
      if (lv[i] == 0 && d > 250) { hasRealPulse = true; break; }
    }
    if (!hasRealPulse) return;
  }

  Serial.println("---------------------------------------------------------");
  // RSSI distinguishes "signal too weak" from "signal present but malformed".
  // Register 0x34, two's complement, half-dB units, -74 dBm offset.
  int8_t rawRssi = (int8_t)spiReadStatus(0x34);
  int rssiDbm = (rawRssi >= 0 ? rawRssi / 2 : (rawRssi + 256) / 2 - 128) - 74;
  Serial.printf("BURST #%d  edges=%d  span=%lums  RSSI=%ddBm\n", ++gBurst, n,
                (unsigned long)((ts[n - 1] - ts[0]) / 1000), rssiDbm);

  // Kerui decode: delimiter = LOW >5ms, then 24x (HIGH gap)(LOW = bit).
  const uint32_t kDelimUs = 5000, kThresh = 700;
  const int kBits = 24;
  int decoded = 0;
  uint32_t first = 0;
  bool allSame = true;
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
        if (decoded == 0) first = id;
        else if (id != first) allSame = false;
        decoded++;
      }
    }
  }

  if (decoded > 0) {
    Serial.printf("  *** DECODED 0x%06X  (%d copies%s) ***\n", first, decoded,
                  allSame ? ", all identical" : ", COPIES DIFFER");
  } else {
    Serial.println("  no Kerui framing found — raw timings below");
  }

  // Pulse-width census: the fastest way to see whether the transmitter is
  // producing the intended 400us / 1200us / 12400us durations at all.
  uint32_t sumShort = 0, sumLong = 0, sumGap = 0;
  int nShort = 0, nLong = 0, nGap = 0, nDelim = 0;
  for (int i = 0; i < n - 1; i++) {
    uint32_t d = ts[i + 1] - ts[i];
    if (lv[i] == 0) {           // carrier present
      if (d > 5000)                    nDelim++;
      else if (d < 700)              { nShort++; sumShort += d; }
      else                           { nLong++;  sumLong  += d; }
    } else {                     // carrier absent
      nGap++; sumGap += d;
    }
  }
  Serial.printf("  carrier-ON short (bit1): %3d  avg %luus  (want ~400)\n",
                nShort, (unsigned long)(nShort ? sumShort / nShort : 0));
  Serial.printf("  carrier-ON long  (bit0): %3d  avg %luus  (want ~1200)\n",
                nLong, (unsigned long)(nLong ? sumLong / nLong : 0));
  Serial.printf("  carrier-OFF gaps:        %3d  avg %luus  (want ~400)\n",
                nGap, (unsigned long)(nGap ? sumGap / nGap : 0));
  Serial.printf("  delimiters (>5ms):       %3d          (want ~8)\n", nDelim);

  // Longest pulse of each polarity — the key number for the slow-pulse test,
  // where the transmitter drives 50ms (50000us) deliberately.
  uint32_t maxOn = 0, maxOff = 0;
  for (int i = 0; i < n - 1; i++) {
    uint32_t d = ts[i + 1] - ts[i];
    if (lv[i] == 0) { if (d > maxOn) maxOn = d; }
    else            { if (d > maxOff) maxOff = d; }
  }
  Serial.printf("  longest carrier-ON: %luus   longest OFF: %luus\n",
                (unsigned long)maxOn, (unsigned long)maxOff);

  // Census restricted to pulses wide enough to be signal, not noise.
  {
    int nSig = 0; uint32_t sumSig = 0;
    int n400 = 0, n1200 = 0;
    for (int i = 0; i < n - 1; i++) {
      uint32_t d = ts[i + 1] - ts[i];
      if (lv[i] != 0 || d < 250) continue;
      nSig++; sumSig += d;
      if (d >= 250 && d < 700)  n400++;
      if (d >= 700 && d < 2000) n1200++;
    }
    Serial.printf("  SIGNAL pulses (>250us): %d  avg %luus   ~400us:%d  ~1200us:%d\n",
                  nSig, (unsigned long)(nSig ? sumSig / nSig : 0), n400, n1200);
  }

  // Print the actual carrier-ON run lengths after the first delimiter — the
  // ground truth for whether short and long bits are distinguishable.
  {
    int di = -1;
    for (int i = 0; i < n - 1; i++) {
      if (lv[i] == 0 && (ts[i + 1] - ts[i]) > 5000) { di = i + 1; break; }
    }
    if (di < 0) {
      // No delimiter (e.g. the raw width probe): dump every ON run instead.
      Serial.print("  ALL ON-run widths:");
      int shown = 0;
      for (int i = 0; i < n - 1 && shown < 26; i++) {
        if (lv[i] == 0 && (ts[i + 1] - ts[i]) > 200) {
          Serial.printf(" %lu", (unsigned long)(ts[i + 1] - ts[i])); shown++;
        }
      }
      Serial.println();
    }
    if (di >= 0) {
      Serial.print("  ON-run widths after delimiter:");
      int shown = 0;
      for (int i = di; i < n - 1 && shown < 26; i++) {
        if (lv[i] == 0) { Serial.printf(" %lu", (unsigned long)(ts[i + 1] - ts[i])); shown++; }
      }
      Serial.println();
    }
  }

  Serial.println("  first 24 edges:");
  for (int i = 0; i < 24 && i < n - 1; i++)
    Serial.printf("    %2d %s %6luus\n", i, lv[i] ? "OFF " : "ON  ",
                  (unsigned long)(ts[i + 1] - ts[i]));
  Serial.println();
}
