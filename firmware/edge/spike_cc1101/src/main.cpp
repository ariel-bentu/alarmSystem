// spike_cc1101: interrupt-based edge capture, decodes Kerui 433MHz packets.
// Wiring: GPIO10=CS, GPIO12=SCK, GPIO11=MOSI, GPIO13=MISO, GPIO4=GDO0.
//
// Kerui timing (measured from real hardware):
//   DELIMITER: long LOW ~12,400µs between packet repetitions
//   After delimiter: (HIGH ~400µs)(LOW encodes bit) × 24
//   SHORT LOW ~400µs = bit 1,  LONG LOW ~1200µs = bit 0

#include <Arduino.h>
#include <SPI.h>

static const uint8_t kCsPin   = 10;
static const uint8_t kGdo0Pin = 4;

static const int kBufSize = 512;
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

// Decode all Kerui packets in the captured edge buffer.
// Returns true if at least 2 identical IDs were found (noise rejection).
// votes = how many packet copies matched; total = how many were decoded.
static bool decodePacket(const uint32_t* ts, const uint8_t* lv, int n,
                         uint32_t& sensorId, int& votes, int& total) {
  const uint32_t kDelimiterUs  = 5000;
  const uint32_t kBitThreshold = 700;
  const int      kBits         = 24;

  uint32_t candidates[16];
  int nCandidates = 0;
  for (int i = 0; i < n - 1 && nCandidates < 16; i++) {
    uint32_t dur = ts[i + 1] - ts[i];
    // Delimiter: a LOW phase lasting > 5ms marks the start of a packet.
    // After the delimiter LOW, the packet is: (HIGH ~400µs)(LOW ~400 or ~1200µs) × 24
    // LOW duration encodes the bit: SHORT ~400µs = bit 1, LONG ~1200µs = bit 0
    if (lv[i] == 0 && dur > kDelimiterUs) {
      int start = i + 1;  // first HIGH edge after delimiter
      if (start + kBits * 2 > n) break;
      uint32_t id = 0;
      bool valid = true;
      for (int b = 0; b < kBits; b++) {
        int hi = start + b * 2;      // HIGH edge (~400µs)
        int lo = hi + 1;             // LOW edge (encodes bit)
        if (lo + 1 >= n) { valid = false; break; }
        if (lv[hi] != 1) { valid = false; break; }  // must be HIGH
        if (lv[lo] != 0) { valid = false; break; }  // must be LOW
        uint32_t lowDur = ts[lo + 1] - ts[lo];
        // SHORT LOW ~400µs = bit 1, LONG LOW ~1200µs = bit 0
        id = (id << 1) | (lowDur < kBitThreshold ? 1u : 0u);
      }
      if (valid) candidates[nCandidates++] = id;
    }
  }

  total = nCandidates;
  if (nCandidates == 0) return false;

  // Majority vote.
  uint32_t bestId = 0;
  int bestCount = 0;
  for (int i = 0; i < nCandidates; i++) {
    int count = 0;
    for (int j = 0; j < nCandidates; j++)
      if (candidates[j] == candidates[i]) count++;
    if (count > bestCount) { bestCount = count; bestId = candidates[i]; }
  }

  // Require at least 1 copy (lower threshold for diagnosis — we print count for confidence).
  if (bestCount < 1) return false;
  sensorId = bestId;
  votes = bestCount;
  return true;
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);
  delay(100);
  Serial.println("spike_cc1101 booting...");

  pinMode(kCsPin, OUTPUT);
  digitalWrite(kCsPin, HIGH);
  pinMode(kGdo0Pin, INPUT);
  SPI.begin(/*sck=*/12, /*miso=*/13, /*mosi=*/11, /*ss=*/kCsPin);

  strobe(0x30); delay(10);  // SRES

  uint8_t pn  = spiReadStatus(0x30);
  uint8_t ver = spiReadStatus(0x31);
  Serial.printf("PARTNUM=0x%02X VERSION=0x%02X %s\n", pn, ver,
                (pn == 0 && ver == 0x14) ? "OK" : "UNEXPECTED — check wiring");
  if (pn != 0 || ver != 0x14) { Serial.println("Halting."); while(1) delay(1000); }

  spiWrite(0x02, 0x0D);  // IOCFG0: async serial
  spiWrite(0x08, 0x32);  // PKTCTRL0: async, infinite
  spiWrite(0x0D, 0x10);  // FREQ2
  spiWrite(0x0E, 0xB0);  // FREQ1
  spiWrite(0x0F, 0x71);  // FREQ0 -> 433.92MHz
  spiWrite(0x12, 0x30);  // MDMCFG2: OOK, no sync
  spiWrite(0x10, 0x87);  // MDMCFG4: CHANBW ~406kHz
  spiWrite(0x11, 0x32);  // MDMCFG3
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
  Serial.println("Ready. Trigger a Kerui sensor...");
}

void loop() {
  if (gCount > 0 && (esp_timer_get_time() / 1000) - gLastEdgeMs > 600) {
    detachInterrupt(digitalPinToInterrupt(kGdo0Pin));

    int n = gCount;
    static uint32_t ts[kBufSize];
    static uint8_t  lv[kBufSize];
    memcpy(ts, (void*)gTs, n * sizeof(uint32_t));
    memcpy(lv, (void*)gLv, n * sizeof(uint8_t));
    gCount = 0;

    attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);

    uint32_t sensorId = 0;
    int votes = 0, total = 0;
    if (decodePacket(ts, lv, n, sensorId, votes, total)) {
      Serial.printf("SENSOR: 0x%06X  (%d/%d copies agree)\n", sensorId, votes, total);
    } else if (total > 0) {
      Serial.printf("DECODE FAIL: %d copies, no majority (noise?)\n", total);
    } else {
      // No delimiter found at all — dump first 20 edges for diagnosis.
      Serial.printf("NO DELIMITER in %d edges. First 20:\n", n);
      for (int i = 0; i < 20 && i < n; i++) {
        uint32_t dur = (i == 0) ? 0 : ts[i] - ts[i-1];
        Serial.printf("  %3d %s dur=%luus\n", i, lv[i] ? "HIGH" : "LOW ", (unsigned long)dur);
      }
    }
  }
}
