// spike_packet_log — THROWAWAY DIAGNOSTIC.
//
// Purpose: log EVERY decoded 433MHz packet, with NO debounce and NO dedup,
// so a live trigger can be correlated against what the radio actually hears.
//
// Why this exists: replaying the captured siren codes (0x622374 / 0x3F0108)
// is PROVEN to radiate correctly — a second board decodes them at -61dBm,
// 5/5 — yet the siren ignores them. Meanwhile an assumption-free sniff during
// a real app-triggered SOS (which DID sound the siren) recorded only noise.
// Those two facts together mean we do not yet know what the hub sends to the
// siren. This sketch answers that by logging everything, unfiltered by any
// per-sensor suppression that might hide a repeat or a second transmitter.
//
// Deliberately DIFFERENT from Cc1101Receiver (the real firmware):
//   - no 3s per-id debounce      (we want every repetition)
//   - no ">=2 matching copies"   (a single copy is reported, flagged)
//   - no dedup across bursts     (repeats are the signal, not noise)
// It keeps only the noise rejection, so the output stays readable.
//
// Protocol reference (measured, see CLAUDE.md):
//   delimiter: long LOW >5ms  (carrier present; IOCFG0=0x0D idles LOW)
//   per bit:   (HIGH ~400us gap)(LOW: short ~400us = 1, long ~1200us = 0)
//   threshold: 700us splits short from long
//
// Wiring: GPIO10=CS, GPIO12=SCK, GPIO11=MOSI, GPIO13=MISO, GPIO4=GDO0

#include <Arduino.h>
#include <SPI.h>

static const uint8_t kCsPin   = 10;
static const uint8_t kGdo0Pin = 4;

static const int kBufSize = 2048;
static volatile uint32_t gTs[kBufSize];
static volatile uint8_t  gLv[kBufSize];
static volatile int      gCount = 0;
static volatile uint32_t gLastEdgeMs = 0;

static uint32_t gPacketNo = 0;
static uint32_t gBurstNo  = 0;

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
  Serial.println("=== spike_packet_log — every packet, no debounce ===");

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

  // EXACTLY the config proven to decode real Kerui sensors on this hardware.
  // Do not "improve" these: freezing the AGC (07/00/B2) normalises every
  // pulse to ~550us and destroys the short/long distinction entirely.
  spiWrite(0x02, 0x0D);  // IOCFG0: async serial data output
  spiWrite(0x08, 0x32);  // PKTCTRL0: async, infinite
  spiWrite(0x0D, 0x10);  // FREQ2
  spiWrite(0x0E, 0xB0);  // FREQ1
  spiWrite(0x0F, 0x71);  // FREQ0 -> 433.92MHz
  spiWrite(0x12, 0x30);  // MDMCFG2: OOK, no sync
  spiWrite(0x10, 0x87);  // MDMCFG4
  spiWrite(0x11, 0x32);  // MDMCFG3
  spiWrite(0x03, 0x07);  // FIFOTHR
  spiWrite(0x1B, 0x03);  // AGCCTRL2
  spiWrite(0x1C, 0x00);  // AGCCTRL1
  spiWrite(0x1D, 0x91);  // AGCCTRL0
  spiWrite(0x21, 0xB6);  // FREND1
  spiWrite(0x17, 0x30);  // MCSM1: stay in RX after packet
  spiWrite(0x18, 0x18);  // MCSM0: auto-cal

  strobe(0x34);          // SRX
  for (int i = 0; i < 100; i++) {
    if ((spiReadStatus(0x35) & 0x1F) == 0x0D) break;
    delayMicroseconds(200);
  }
  uint8_t ms = spiReadStatus(0x35) & 0x1F;
  Serial.printf("MARCSTATE=0x%02X (%s)\n", ms, ms == 0x0D ? "RX — good" : "unexpected");

  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);
  Serial.println();
  Serial.println("Listening. Every decoded packet is printed, no debounce.");
  Serial.println("STEP 1: trigger a known door sensor — you should see its id.");
  Serial.println("STEP 2: then trigger the siren ON, wait, then OFF.");
  Serial.println();
}

void loop() {
  uint32_t nowMs = (uint32_t)(esp_timer_get_time() / 1000);
  bool almostFull = gCount > (kBufSize - 200);
  // 120ms of silence closes a burst: longer than any inter-bit gap within a
  // packet, short enough to keep ambient noise from merging with a real one.
  if (gCount == 0 || (!almostFull && (nowMs - gLastEdgeMs) < 120)) return;

  detachInterrupt(digitalPinToInterrupt(kGdo0Pin));
  int n = gCount;
  static uint32_t ts[kBufSize];
  static uint8_t  lv[kBufSize];
  if (n > kBufSize) n = kBufSize;
  memcpy(ts, (void*)gTs, n * sizeof(uint32_t));
  memcpy(lv, (void*)gLv, n * sizeof(uint8_t));
  gCount = 0;
  attachInterrupt(digitalPinToInterrupt(kGdo0Pin), onEdge, CHANGE);

  if (n < 20) return;

  // Noise rejection. The 433MHz band here is busy: with nothing transmitting
  // this board still logs ~1156 edges of ~53us pulses. A real Kerui frame
  // must contain a delimiter (LOW >5ms), so require one before doing anything
  // else. This is the ONLY filtering applied — no dedup, no debounce.
  const uint32_t kDelimUs = 5000, kThresh = 700;
  const int kBits = 24;
  bool hasDelim = false;
  for (int i = 0; i < n - 1; i++) {
    if (lv[i] == 0 && (ts[i + 1] - ts[i]) > kDelimUs) { hasDelim = true; break; }
  }
  // CATCH-ALL for a burst with NO >5ms delimiter.
  //
  // Added 2026-08-28 after the hub's four codes were replayed in its exact
  // convention at -18dBm and the siren still ignored them. That makes it
  // likely the siren's real command is framed differently — and anything
  // without our assumed delimiter was being dropped here, silently, which is
  // exactly the blind spot that would hide it. Gate on RSSI only: a strong
  // burst is real RF regardless of whether we can parse it.
  if (!hasDelim) {
    int8_t rr = (int8_t)spiReadStatus(0x34);
    int dbm = (rr >= 0 ? rr / 2 : (rr + 256) / 2 - 128) - 74;
    // Threshold lowered from -75 to -88: the board now sits BESIDE THE SIREN
    // rather than near the panel, so anything the siren hears is what matters,
    // including bursts too weak to have reached the old position. The noise
    // floor here measures about -109dBm, so -88 still rejects noise.
    if (dbm >= -88) {
      Serial.printf("[burst %lu] t=%lums edges=%d RSSI=%ddBm  "
                    "STRONG, NO DELIMITER — unknown framing\n",
                    (unsigned long)++gBurstNo, (unsigned long)millis(), n, dbm);
      // Longest LOW run present, so a different delimiter length shows up.
      uint32_t maxLow = 0;
      for (int i = 0; i < n - 1; i++)
        if (lv[i] == 0 && (ts[i + 1] - ts[i]) > maxLow) maxLow = ts[i + 1] - ts[i];
      Serial.printf("  longest LOW=%luus; first 40 edges:", (unsigned long)maxLow);
      for (int j = 0; j < n - 1 && j < 40; j++)
        Serial.printf(" %s%lu", lv[j] ? "H" : "L", (unsigned long)(ts[j + 1] - ts[j]));
      Serial.println();
    }
    return;
  }

  int8_t rawRssi = (int8_t)spiReadStatus(0x34);
  int rssiDbm = (rawRssi >= 0 ? rawRssi / 2 : (rawRssi + 256) / 2 - 128) - 74;

  // FRAME LENGTH — measured, never assumed.
  //
  // The decoder below reads exactly kBits(24) cells after a delimiter. If the
  // panel's siren-linkage frame is 25/32/40 bits, that returns a plausible but
  // MISALIGNED slice and reports it as a normal packet — a silent failure that
  // looks identical to success and would be replayed forever with no effect.
  // (rtl_433's Kerui decoder notes a 25th sync bit it discards; sensor traffic
  // comes from an EV1527 encoder chip, but panel->siren traffic is generated in
  // the panel's firmware and is not bound to 24 bits.)
  //
  // So count how many whole (HIGH,LOW) cells actually sit between one delimiter
  // and the next. Anything other than 24 here means the value printed below is
  // fiction, and is the single most useful number in this capture.
  for (int i = 0; i < n - 1; i++) {
    if (lv[i] == 0 && (ts[i + 1] - ts[i]) > kDelimUs) {
      // Count cells until the frame ends. A copy ends either at the next
      // delimiter OR at a cell whose period breaks from the established one —
      // needed because repeats are streamed back-to-back and the inter-copy
      // gap is not always wide enough to trip kDelimUs. Without the period
      // check this runs straight through every repeat: a known 24-bit frame
      // sent x20 counted as 190 cells.
      int cells = 0;
      int j = i + 1;
      uint32_t firstPeriod = 0;
      while (j + 2 < n - 1) {
        if (lv[j] == 0 && (ts[j + 1] - ts[j]) > kDelimUs) break;  // next delimiter
        if (lv[j] != 1 || lv[j + 1] != 0) break;                  // not a clean cell
        uint32_t period = ts[j + 2] - ts[j];
        if (firstPeriod == 0) firstPeriod = period;
        // A real EV1527 cell is a constant period; allow +-50% for jitter and
        // OOK stretch, but treat anything beyond that as the end of the copy.
        else if (period > firstPeriod + firstPeriod / 2 ||
                 period + period / 2 < firstPeriod) break;
        cells++;
        j += 2;
      }
      // Cells BEFORE this delimiter, i.e. trailing the previous frame. rtl_433's
      // Kerui spec is bits=25, with a leading sync bit "that runs into the
      // preceding packet" - so a 25th bit would sit exactly here, and our
      // decoder (which counts 24 forward from a gap) drops it silently.
      int before = 0;
      for (int k = i - 1; k >= 1; k -= 2) {
        if (lv[k] == 0 && (ts[k + 1] - ts[k]) > kDelimUs) break;
        if (lv[k] != 0 || lv[k - 1] != 1) break;
        before++;
        if (before > 30) break;
      }
      int8_t rr2 = (int8_t)spiReadStatus(0x34);
      int dbm2 = (rr2 >= 0 ? rr2 / 2 : (rr2 + 256) / 2 - 128) - 74;
      if (before) Serial.printf("  (%d cells precede this delimiter)\n", before);
      Serial.printf("  FRAME LENGTH: %d cells after delimiter (%luus)  RSSI=%ddBm%s\n",
                    cells, (unsigned long)(ts[i + 1] - ts[i]), dbm2,
                    // Counts the last cell short (the loop needs j+2 in range),
                    // so a true 24-bit frame reads 23. Validated against our own
                    // known-24-bit TX. Accept 23-24; anything else is real.
                    (cells == 23 || cells == 24)
                        ? ""
                        : "   <<< NOT 24 BITS — decoded value is a misaligned slice");
      break;
    }
  }

  // Decode every copy after every delimiter. Each is reported on its own
  // line — repeats included, since repetition is exactly what we want to see.
  uint32_t ids[64];
  int nIds = 0;
  for (int i = 0; i < n - 1 && nIds < 64; i++) {
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
      if (valid) ids[nIds++] = id;
    }
  }

  // EV1527 PULSE-WIDTH DECODE — the rule the sensor decode above gets wrong.
  //
  // Established by transmitting a KNOWN code and decoding the capture four
  // ways (2026-08-28): sending 0x622374 as canonical EV1527 reads back as
  // 0x9DDC8B under the sensor rule ("is the LOW short?") but matches the
  // transmitted value bit-for-bit under "short GAP = 1". EV1527 keeps a
  // CONSTANT ~1280us cell and encodes the bit in which half is long, so a
  // rule that measures only one half misreads it.
  //
  // This matters beyond tidiness: the captured "siren codes" 0x62237/0x3F010
  // were read with the sensor rule, so if the hub frames its siren command as
  // EV1527 those values are misreadings and were never the real payload.
  // Report both decodes for every burst so the two can never be confused.
  for (int i = 0; i < n - 1; i++) {
    if (lv[i] == 0 && (ts[i + 1] - ts[i]) > kDelimUs) {
      int start = i + 1;
      uint32_t longOnIsOne = 0, longOnIsZero = 0;
      int got = 0;
      for (int b = 0; b < kBits; b++) {
        int hi = start + b * 2, lo = hi + 1;
        if (lo + 1 >= n) break;
        // The carrier-ON half of the cell. Verified against ground truth:
        // transmitting 0x622374 and applying this rule returns 0x622374.
        uint32_t onUs = ts[lo + 1] - ts[lo];
        uint32_t bit = (onUs > 600) ? 1u : 0u;
        longOnIsOne  = (longOnIsOne  << 1) | bit;
        longOnIsZero = (longOnIsZero << 1) | (bit ^ 1u);
        got++;
      }
      if (got == kBits)
        Serial.printf("  EV1527 decode: longOn=1 -> 0x%06lX   longOn=0 -> 0x%06lX  RSSI=%ddBm\n",
                      (unsigned long)longOnIsOne,
                      (unsigned long)longOnIsZero, rssiDbm);
      break;
    }
  }

  if (nIds == 0) {
    // A delimiter but no decodable payload: the hub may use different
    // framing. Report it rather than dropping it silently — this is the
    // case that would explain the siren command being invisible to us.
    Serial.printf("[burst %lu] t=%lums edges=%d RSSI=%ddBm  "
                  "DELIMITER BUT NO 24-BIT PAYLOAD\n",
                  (unsigned long)++gBurstNo, (unsigned long)millis(),
                  n, rssiDbm);
    // Raw HIGH/LOW widths after the first delimiter, so an UNRECOGNISED
    // framing (e.g. the canonical EV1527 pulse-then-gap shape our decoder
    // cannot parse) can still be inspected pulse by pulse. Strong bursts only.
    if (rssiDbm >= -88) {
      for (int i = 0; i < n - 1; i++) {
        if (lv[i] == 0 && (ts[i + 1] - ts[i]) > kDelimUs) {
          Serial.printf("  RAW after delim(%luus):",
                        (unsigned long)(ts[i + 1] - ts[i]));
          for (int j = i + 1; j < n - 1 && j < i + 1 + 52; j++)
            Serial.printf(" %s%lu", lv[j] ? "H" : "L",
                          (unsigned long)(ts[j + 1] - ts[j]));
          Serial.println();
          break;
        }
      }
    }
    return;
  }

  gBurstNo++;
  for (int k = 0; k < nIds; k++) {
    Serial.printf("PACKET %lu  0x%06lX  id=0x%05lX nibble=%lX  "
                  "RSSI=%ddBm  t=%lums  [burst %lu, copy %d/%d]\n",
                  (unsigned long)++gPacketNo,
                  (unsigned long)ids[k],
                  (unsigned long)(ids[k] >> 4),
                  (unsigned long)(ids[k] & 0xF),
                  rssiDbm,
                  (unsigned long)millis(),
                  (unsigned long)gBurstNo, k + 1, nIds);
  }

  // WAVEFORM COMPARISON.
  //
  // The payload is proven correct and our signal is proven strong (-18dBm vs
  // the hub's -49dBm), yet the siren obeys the hub and ignores us. So the
  // difference must be in the WAVEFORM, not the value — something our decoder
  // normalises away but the siren's fixed-timing decoder does not.
  //
  // Prime suspect: our TX encodes the bit in the carrier-OFF GAP with a
  // constant 300us keying pulse (a distortion deliberately tuned to our own
  // receiver's OOK decay). A real Kerui transmitter instead sends short/long
  // carrier-ON pulses. Both decode here; only one drives the siren.
  //
  // Dump the actual edge timings for any siren-code burst so the hub's
  // waveform and ours can be diffed pulse by pulse, from the same radio.
  {
    // Dump ANY strong burst, not just recognised siren ids. Once the TX side
    // switched to the hub's encoding our own receiver started reading it as a
    // different value (its rule is just "LOW under 700us = 1", which no longer
    // matches) — filtering on the id would hide exactly the waveform we need
    // to inspect. A -90dBm "decode" is a noise artefact, so gate on RSSI only.
    if (rssiDbm < -75) return;

    // Find the first delimiter and print the bits that follow it, splitting
    // each into its carrier-ON pulse and carrier-OFF gap. A real Kerui frame
    // should show ON pulses of ~400us (bit 1) vs ~1200us (bit 0); ours should
    // show a constant ~300us ON with the variation in the OFF gap instead.
    for (int i = 0; i < n - 1; i++) {
      if (lv[i] == 0 && (ts[i + 1] - ts[i]) > kDelimUs) {
        Serial.printf("  WAVEFORM 0x%06lX  delimiter=%luus\n",
                      (unsigned long)ids[0],
                      (unsigned long)(ts[i + 1] - ts[i]));

        // Decode AGAIN under the HUB's OWN rule.
        //
        // The 24-bit value printed above comes from the sensor rule ("is the
        // LOW under 700us?"). The hub does not encode that way: it uses a
        // CONSTANT ~1200us bit period and encodes the bit in WHICH HALF is
        // long (measured: 314/857 vs 954/291). Applying the sensor rule to
        // the hub's waveform therefore yields a MISREADING — which means the
        // codes we have been replaying may never have been the hub's real
        // payload at all. (Corroborating evidence: once the transmitter
        // switched to the hub's encoding, this same receiver read our own
        // packet back as 0x9DDC8B rather than 0x622374 — one waveform, two
        // rules, two different values.)
        //
        // Print both polarities, since which physical shape means "1" is not
        // yet established.
        {
          uint32_t longIsOne = 0, longIsZero = 0;
          int st2 = i + 1;
          bool ok = true;
          for (int b = 0; b < kBits; b++) {
            int hi = st2 + b * 2, lo = hi + 1;
            if (lo + 1 >= n) { ok = false; break; }
            uint32_t onUs = ts[lo + 1] - ts[lo];
            // Split the two symbol shapes at ~600us: measured populations are
            // ~300us (short) and ~890us (long), so this sits cleanly between.
            uint32_t bit = (onUs > 600) ? 1u : 0u;
            longIsOne  = (longIsOne  << 1) | bit;
            longIsZero = (longIsZero << 1) | (bit ^ 1u);
          }
          if (ok)
            Serial.printf("    HUB-RULE decode: long=1 -> 0x%06lX   long=0 -> 0x%06lX\n",
                          (unsigned long)longIsOne, (unsigned long)longIsZero);
        }
        // Dump every cell up to the NEXT delimiter, not a fixed 24. Capping at
        // kBits would hide the very thing we are looking for: a frame longer
        // than 24 bits would look perfectly normal in this dump.
        Serial.print("    bit: gap/on ->");
        int start = i + 1;
        for (int b = 0; b < 64 && start + b * 2 + 2 < n; b++) {
          int hi = start + b * 2, lo = hi + 1;
          if (lv[hi] == 0 && (ts[hi + 1] - ts[hi]) > kDelimUs) break;  // next frame
          if (b == kBits) Serial.print("  |24|");  // mark where our decoder stops
          Serial.printf(" %lu/%lu",
                        (unsigned long)(ts[lo] - ts[hi]),
                        (unsigned long)(ts[lo + 1] - ts[lo]));
        }
        Serial.println();
        break;
      }
    }
  }
}
