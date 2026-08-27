// spike_rmt_tx — EV1527 transmitter driven by the ESP32 RMT peripheral.
//
// WHY THIS EXISTS
//
// The CC1101 FIFO path builds a bitstream from whole ~62us symbols, so every
// pulse width is quantised to that grid by integer division (which truncates
// DOWN). Measured error: the short pulses lose 11-15%, asymmetrically, which
// distorts the ratio a 1527 receiver actually keys on - bit0 was transmitted at
// 3.25:1 against the panel's measured 2.88:1.
//
// That matters because of the central asymmetry in this whole investigation:
// the W184 panel ACCEPTS our transmissions (it paired an invented code and
// fires real alarms on it) while the siren REJECTS them. A tolerant receiver
// forgives approximate widths; a strict one does not. And the distortion is
// invisible to our own CC1101 receiver, which re-quantises everything through
// its own demodulator - the same blind spot that hid four earlier bugs
// (bit-complement mapping, 32-bit preamble, missing trailing delimiter,
// truncated tail).
//
// RMT is hardware-timed with ~1us resolution, no quantisation, and no
// sensitivity to WiFi interrupt jitter. It renders the intended waveform
// exactly.
//
// WIRING — needs a BARE 433MHz ASK MODULE, not the CC1101.
//
//   module VCC  -> 5V   (3.3V works but transmits weaker)
//   module GND  -> GND
//   module DATA -> GPIO6
//
// The CC1101 cannot be keyed this way on this hardware: GDO2, the conventional
// async-serial data input, is NOT CONNECTED on that module, and driving data
// into GDO0 radiates nothing (-86dBm at a receiver 10cm away, vs -19dBm via the
// FIFO). See docs/hardware-wiring.md.
//
// HOW TO TEST — use the siren's learn-window extension as pass/fail.
//
// Click the siren's SET button: the light comes on ~5s. If a transmission it
// ACCEPTS arrives, the window EXTENDS by another 5-6s. A real Kerui door sensor
// extends it; the CC1101 never does, even sending that sensor's own code. So
// "window extends" is the first positive result to look for here.

#include <Arduino.h>
#include <driver/rmt.h>

static const gpio_num_t kTxPin   = GPIO_NUM_6;
static const rmt_channel_t kChan = RMT_CHANNEL_0;

// RMT tick = 1us: APB is 80MHz, so a clock divider of 80 gives 1us per tick.
static const uint8_t kClkDiv = 80;

// EV1527 timings. Defaults are the widths measured from THIS installation's
// panel during an SOS that sounded the siren (-58dBm, clean capture):
//   bit 0 -> ~300us carrier-OFF gap + ~890us carrier ON
//   bit 1 -> ~930us gap + ~300us ON
//   sync  -> short pulse + ~9280us gap
// Unlike the CC1101 path these are rendered exactly, with no pre-compensation,
// because RMT does not quantise and there is no OOK symbol grid to fight.
struct Ev1527Timing {
  uint16_t shortUs;
  uint16_t longUs;
  uint16_t syncUs;
  const char* name;
};

static Ev1527Timing gTimings[] = {
  { 300,  890,  9280, "panel-measured (default)" },
  { 420, 1250, 13100, "zoogara (Digoo DG-ROSA)"  },
  { 320,  960,  9750, "canonical EV1527 spec"    },
  { 400, 1200, 12000, "spec, 1.6ms cell"         },
};
static int gTimingIdx = 0;

// One EV1527 frame: sync pulse + sync gap, then 24 bits MSB first.
// Each bit is a carrier-ON pulse followed by a carrier-OFF gap:
//   bit 1 = short ON + long gap
//   bit 0 = long ON  + short gap
// A plain ASK module transmits carrier while DATA is HIGH, so level1=1 is the
// carrier-ON half. That is the opposite convention from the CC1101 path, where
// push(false,...) meant carrier-ON - do not copy the polarity across.
static int buildFrame(rmt_item32_t* items, int cap, uint32_t code) {
  const Ev1527Timing& t = gTimings[gTimingIdx];
  int n = 0;
  if (cap < 25) return 0;

  items[n].level0 = 1; items[n].duration0 = t.shortUs;   // sync pulse
  items[n].level1 = 0; items[n].duration1 = t.syncUs;    // sync gap
  n++;

  for (int b = 23; b >= 0 && n < cap; b--) {
    bool one = (code >> b) & 1;
    items[n].level0 = 1; items[n].duration0 = one ? t.shortUs : t.longUs;
    items[n].level1 = 0; items[n].duration1 = one ? t.longUs  : t.shortUs;
    n++;
  }
  return n;
}

// Send `repeats` frames back to back. EV1527 transmitters repeat continuously
// while the trigger is asserted, and the sync gap itself is the only frame
// separator - there is no extra idle between copies. Receivers commonly need
// 2-3 consecutive identical frames before accepting, so keep this >= 4.
static void sendCode(uint32_t code, int repeats) {
  static rmt_item32_t items[25 * 12 + 1];
  const int cap = sizeof(items) / sizeof(items[0]);
  int n = 0;
  for (int r = 0; r < repeats && n + 25 <= cap; r++)
    n += buildFrame(items + n, cap - n, code);

  // Terminator: a zero-duration item tells RMT the sequence has ended.
  if (n < cap) { items[n].val = 0; }

  rmt_write_items(kChan, items, n, true /* wait for completion */);
  gpio_set_level(kTxPin, 0);   // leave the module keyed OFF, not radiating
}

static void printMenu() {
  const Ev1527Timing& t = gTimings[gTimingIdx];
  Serial.println();
  Serial.println("--- spike_rmt_tx --------------------------------------");
  Serial.printf("  timing: %s  (short %u, long %u, sync %u)\n",
                t.name, t.shortUs, t.longUs, t.syncUs);
  Serial.println("  t  cycle timing profile");
  Serial.println("  1  send 0x622374  (panel alarm trigger)");
  Serial.println("  2  send 0x3F0108  (panel, other transmitter id)");
  Serial.println("  3  send 0x2E5B79  (REAL door sensor, opened)");
  Serial.println("  4  send 0xABCD88  (zoogara pairing code)");
  Serial.println("  p  PAIR: hammer 0xABCD88 for ~40s (click SET first)");
  Serial.println("  w  waveform check: one frame, verify on the RX board");
  Serial.println("-------------------------------------------------------");
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);
  delay(100);
  Serial.println();
  Serial.println("=== spike_rmt_tx — hardware-timed EV1527 via RMT ===");
  Serial.printf("TX data pin: GPIO%d (bare 433MHz ASK module, not the CC1101)\n",
                (int)kTxPin);

  rmt_config_t cfg = {};
  cfg.rmt_mode      = RMT_MODE_TX;
  cfg.channel       = kChan;
  cfg.gpio_num      = kTxPin;
  cfg.mem_block_num = 4;          // 4 blocks = 256 items, room for long bursts
  cfg.clk_div       = kClkDiv;    // 1us per tick
  cfg.tx_config.loop_en              = false;
  cfg.tx_config.carrier_en           = false;  // OOK: we key DATA, no carrier
  cfg.tx_config.idle_output_en       = true;
  cfg.tx_config.idle_level           = RMT_IDLE_LEVEL_LOW;
  cfg.tx_config.carrier_duty_percent = 50;
  cfg.tx_config.carrier_freq_hz      = 38000;
  cfg.tx_config.carrier_level        = RMT_CARRIER_LEVEL_HIGH;

  esp_err_t e = rmt_config(&cfg);
  Serial.printf("rmt_config: %s\n", e == ESP_OK ? "OK" : esp_err_to_name(e));
  e = rmt_driver_install(kChan, 0, 0);
  Serial.printf("rmt_driver_install: %s\n", e == ESP_OK ? "OK" : esp_err_to_name(e));

  printMenu();
}

void loop() {
  if (!Serial.available()) { delay(20); return; }
  char c = Serial.read();
  switch (c) {
    case 't':
      gTimingIdx = (gTimingIdx + 1) % (sizeof(gTimings) / sizeof(gTimings[0]));
      printMenu();
      break;
    case '1': Serial.println(">>> 0x622374 x8"); sendCode(0x622374, 8);
              Serial.println("    sent."); break;
    case '2': Serial.println(">>> 0x3F0108 x8"); sendCode(0x3F0108, 8);
              Serial.println("    sent."); break;
    case '3': Serial.println(">>> 0x2E5B79 x8 (real sensor)"); sendCode(0x2E5B79, 8);
              Serial.println("    sent."); break;
    case '4': Serial.println(">>> 0xABCD88 x8"); sendCode(0xABCD88, 8);
              Serial.println("    sent."); break;
    case 'w': Serial.println(">>> single frame 0x622374 — check the RX board");
              sendCode(0x622374, 4);
              Serial.println("    sent."); break;
    case 'p':
      Serial.println(">>> PAIRING: hammering 0xABCD88 — click SET on the siren NOW");
      for (int i = 0; i < 60 && !Serial.available(); i++) {
        sendCode(0xABCD88, 6);
        if (i % 10 == 0) Serial.printf("    round %d/60\n", i + 1);
        delay(400);
      }
      Serial.println("    done — long beep = paired.");
      break;
    default: return;
  }
}
