# CC1101 bring-up (2026-08-27) — RF decode confirmed end-to-end

CC1101 wired to ESP32-S3 (GPIO10=CS, GPIO12=SCK, GPIO11=MOSI, GPIO13=MISO, GPIO4=GDO0).
PARTNUM=0x00, VERSION=0x14 confirmed over SPI. MARCSTATE=0x0D (RX) confirmed.

**Kerui 433MHz protocol — measured from real hardware:**
- IOCFG0=0x0D (async serial): GDO0 idles LOW, pulses for data
- **Delimiter**: long LOW ~12,400µs between packet repetitions (NOT a long HIGH)
- After delimiter: 24 pairs of `(HIGH ~400µs)(LOW encodes bit)`
- **Bit encoding**: SHORT LOW ~400µs = bit 1, LONG LOW ~1200µs = bit 0
- Threshold 700µs cleanly separates short from long
- Packet repeats 5-7 times per sensor trigger (~300ms total burst)
- **24-bit layout**: top 20 bits = sensor identity, bottom 4 bits = event state flags
  - `0x2E5B73` = door closed, `0x2E5B79` = door opened (same sensor, different nibble)
  - Full 24-bit ID kept in RTDB — web UI can pair open and close independently

**`Cc1101Receiver` architecture (interrupt-based, not polling):**
- ISR on GDO0 CHANGE captures `(timestamp, level)` pairs into a 1024-entry ring buffer
- `poll()` drains the buffer after 600ms of silence OR >800 edges accumulated
- `decodeEdges()` finds all `long-LOW` delimiters, decodes 24 bits after each, majority-votes
- Requires ≥2 matching copies for a valid decode (noise rejection)
- 3s debounce on the same sensor ID prevents one physical trigger from counting multiple
  times in `count_in_window` rules

**Capture rate**: ~100% at sensor distance 10cm with antenna connected.
`almostFull` trigger (>800 edges) prevents misses when the 600ms window is tight.

**`spike_cc1101/`**: standalone diagnostic sketch used to develop and validate the
decode logic. Captures raw edges via interrupt, dumps burst timing, decodes packets.
Keep as a known-good minimal control for future RF debugging.
