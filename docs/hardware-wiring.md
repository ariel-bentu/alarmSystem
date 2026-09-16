# Hardware Wiring

Physical wiring for the alarm system edge device. Pin numbers here are the
source of truth for the `#if defined(ARDUINO_ARCH_ESP32)` map in
`firmware/edge/device/src/main.cpp` — keep the two in sync.

## Board: ESP32-S3

Probed with `esptool.py chip_id` / `flash_id`:

- ESP32-S3 (QFN56) rev v0.2, **quad** SPI flash, embedded 8MB PSRAM
- 16MB flash, native USB-Serial/JTAG (`/dev/cu.usbmodem1101`)
- Two boards on hand; `esptool.py chip_id` prints each one's MAC if you need
  to tell them apart

## CC1101 433MHz module (V2.0, 8-pin, SMA antenna)

Listing: "CC1101 wireless module with SMA antenna, 315/433/868/915MHz",
10mW, 380m, **1.9–3.6VDC**.

### Header layout

Odd pins on the top row, even on the bottom — and **pin 1 is at the
RIGHT**, not the left. This is easy to get backwards.

```
component side up, header at top right:

top row:     7        5        3        1
          MISO/GDO1  SCK     GDO0     GND
bottom row:  8        6        4        2
           GDO2     MOSI     CSN      VCC
```

### Connections

The DevKitC silkscreen abbreviates GPIO as `G`, so **GPIO10 is printed
`G10`**, GPIO4 is `G4`, and so on. The "board silkscreen" column below is
what you actually read on the board.

| CC1101 | Label | Wire colour | → ESP32-S3 | Board silkscreen | Notes |
|---|---|---|---|---|---|
| 1 | GND | **black** | GND | `GND` | any GND pin |
| 2 | VCC | **red** | **3V3** | `3V3` | ⚠️ 3.3V ONLY — 5V destroys the chip |
| 3 | GDO0 | **green** | GPIO4 | `G4` | raw OOK bitstream into the decoder |
| 4 | CSN | **yellow** | GPIO10 | `G10` | chip select, active low |
| 5 | SCK | **purple** | GPIO12 | `G12` | FSPI clock |
| 6 | MOSI | **blue** | GPIO11 | `G11` | FSPI MOSI |
| 7 | MISO/GDO1 | **orange** | GPIO13 | `G13` | FSPI MISO |
| 8 | GDO2 | — | *not connected* | — | unused |

The module's silkscreen/listing labels CSN as "CKN" — that is a typo for
CSN (chip select).

### Check BEFORE applying power

This is not optional. A first attempt at this wiring destroyed a CC1101
(visible burn at the pin 1/2 corner) and took an ESP32-S3 off the USB bus,
because power was applied before the connections were read back.

With USB unplugged, confirm all four:

1. **GND is actually connected.** With VCC powered and no ground return,
   current flows through the signal pins' ESD diodes and burns the module.
   A missing black wire is as damaging as a swapped one.
2. **Red is on pin 2 (VCC), not pin 1 (GND).** Pin 1 is at the RIGHT of
   the top row. Counting from the left puts 3.3V straight onto GND.
3. **Red is on the board's `3V3` pin, not `5V`/`VIN`/`VBUS`.**
4. **No wire is on `G19`/`G20`** — those are the native USB console.

Then power up and watch for heat or smell at the module before walking
away.

**Attach the SMA antenna before powering up.** Receive is useless without
it, and transmitting without one can damage the PA stage. A disconnected
antenna on the ESP32 side cost a full day of debugging (the board scanned
and listed APs fine but could not complete a WiFi association) — the same
symptom class applies here: it will look alive but decode nothing.

## Siren relay

| Signal | Wire colour | → ESP32-S3 | Board silkscreen |
|---|---|---|---|
| Relay IN | — | GPIO5 | `G5` |

Not yet wired; `RelaySiren` is untested.

## ESP32-S3 pins that must NOT be used

Picking one of these fails confusingly rather than obviously — usually as
random crashes or a board that will not boot.

| Pins | Why |
|---|---|
| GPIO26–32 | SPI flash / PSRAM bus |
| GPIO33–37 | free on this quad-flash part, but an octal PSRAM bus claims them and this module's PSRAM is embedded; avoided on principle |
| GPIO0 | BOOT strapping pin — already used as `kForcePortalPin` |
| GPIO3, 45, 46 | strapping (JTAG source, VDD_SPI, boot mode) |
| GPIO19, 20 | native USB D-/D+ — this is the serial console |
| GPIO43, 44 | UART0 TX/RX |

Hardware SPI (FSPI) defaults on the `esp32-s3-devkitc-1` variant are
SCK 12 / MISO 13 / MOSI 11. `SPI.begin()` claims them; only CS and GDO0
are configurable in `main.cpp`.

## ESP8266 D1 Mini (fallback target, `[env:d1_mini]`)

Kept buildable. Different numbering entirely:

| Signal | D1 Mini pin | GPIO |
|---|---|---|
| CC1101 CS | D8 | 15 |
| CC1101 GDO0 | D2 | 4 |
| Relay | D1 | 5 |
| SPI SCK / MISO / MOSI | D5 / D6 / D7 | 14 / 12 / 13 |
