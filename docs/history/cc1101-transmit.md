# CC1101 transmit (2026-08-28) — works, via the FIFO (NOT GDO0)

Board-to-board TX confirmed: `0x622374` transmitted from one ESP32-S3+CC1101
and decoded correctly by a second one, **5/5 trials**. Not yet integrated into
the device firmware — that is the next task.

**Captured W184 siren codes** (app-triggered SOS on, then off). Same 20-bit
identity / 4-bit command split as the door sensors:

| code | identity | nibble | reading |
|---|---|---|---|
| `0x622374` | `0x62237` | 4 | activate |
| `0x3F0108` | `0x3F010` | 8 | activate |
| `0x622372` | `0x62237` | 2 | deactivate |
| `0x3F0102` | `0x3F010` | 2 | deactivate |

Static, not rolling — `0x622372` repeated three times byte-identical. Two
distinct transmitters; which one drives the siren is **still unknown** (there
is no SOS remote, so both are mains-side). Untested against the real siren.

**Three findings, all measured — do not re-litigate:**

1. **Async serial TX via GDO0 does not work on this wiring.** RX is fine
   (the chip *drives* GDO0), but the ESP32 driving data *into* it radiates
   nothing. RSSI settles it: continuous carrier via GDO0 reads **-86dBm** at
   a receiver 10cm away (the noise floor); FIFO TX reads **-19dBm**. Every
   register reads back correct (`IOCFG0=0x2D`, `MARCSTATE=0x13`) the whole
   time — the chip claims to transmit and does not. GDO2, the conventional
   async-serial input pin, is **not connected** on this module
   (`docs/hardware-wiring.md`). Use the TX FIFO in normal packet mode.

2. **`FREND0` (0x22) must be `0x11`.** For OOK the PA switches between
   PATABLE[0] (off) and PATABLE[1] (on); FREND0's PA_POWER field selects the
   "on" index. Unset, the PA has no off entry and holds continuous carrier —
   a commanded 50ms pulse arrived as **158ms**. With `FREND0=0x11` and
   `PATABLE = {0x00, 0xC0}`, 50ms arrives as **50.088ms**.

3. **The received pulse width tracks the GAP, not the pulse.** The OOK
   demodulator's decay dominates: gap 500us gave uniform ~640us received
   pulses, gap 1500us gave uniform ~2030us — *independent of the transmitted
   pulse width*, even at a 12.5x ratio. So encode the bit in the carrier-OFF
   gap and keep the keying pulse constant. Working frame:

   ```
   delimiter: 6ms carrier ON, then 1.5ms off
   per bit:   gap (400us = bit 1, 1200us = bit 0), then a 300us keying pulse
   ```

   A full 12.4ms delimiter **saturates the AGC** and flattens every following
   pulse to a uniform width; 6ms still passes the receiver's >5ms delimiter
   test without saturating.

**Measurement trap:** the 433MHz band here is noisy — with the transmitter
silent the receiver still logs ~1156 edges of ~53us pulses. Establish that
baseline BEFORE interpreting a weak capture. Hours were lost tuning registers
against ambient noise that was mistaken for a weak signal.

**Also learned:** a single CC1101 cannot cleanly receive its own transmission,
so loopback cannot verify TX framing. Use two boards.

Diagnostic sketches (throwaway, kept as known-good controls):
- `spike_siren_tx/` — menu-driven transmitter: `g` sends a Kerui packet,
  `f` FIFO test, `o` continuous carrier, `v` raw pulse-width probe,
  `d` GPIO drive test, `z` timing self-check, plus register sweeps
- `spike_rx_monitor/` — independent receiver: per-burst RSSI, pulse-width
  census, ON-run widths, noise filtering
- `spike_siren_sniff/` — assumption-free sniffer (framing-agnostic)
- `txrx_test.py` — drives both boards at once; `python3 txrx_test.py <cmd> <secs>`

Note the boards enumerate as `/dev/cu.usbmodem101` and `/dev/cu.usbmodem1101`;
macOS reassigns those suffixes per port/session, so check `ls /dev/cu.*`.
