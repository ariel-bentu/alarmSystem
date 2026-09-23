#pragma once

// Arduino .ino sketches (e.g. spike_decode.ino) get this pulled in
// implicitly by the Arduino build system before any other include, so it
// was previously unnecessary here. Plain .cpp/.h translation units (e.g.
// firmware/edge/device/src/cc1101_receiver.*) get no such implicit
// include, so this header needs it explicitly for byte/millis/micros/
// digitalRead/analogRead/HIGH/LOW to be visible. Including it here is a
// no-op for spike_decode.ino (include guards make the repeat harmless).
#include <Arduino.h>

#define KERUI_BITS 24
#define KERUI_MAX_SIGNAL_LENGTH 255
#define KERUI_UPPER_THRESHOLD 100
#define KERUI_LOWER_THRESHOLD 80

#define KERUI_DURATION_BIT 700
#define KERUI_DURATION_DELIMITER 5000

#define KERUI_RESULT_SUCCESS 0
#define KERUI_RESULT_TIMEOUT_LOW 1
#define KERUI_RESULT_TIMEOUT_HIGH 2
#define KERUI_RESULT_MANY_ERRORS 3
#define KERUI_RESULT_DELIMETER_NOT_FOUND 4
#define KERUI_RESULT_SYNC_TIMEOUT 5

#define KERUI_MAX_ERROR_COUNT 50
// Bound on the initial sync-wait loop. For the digital/CC1101 overload this
// loop spins while GDO0 is LOW (inside a delimiter ~10ms); at ESP32-S3
// 240MHz a digitalRead takes ~40ns so 100000 iterations = ~4ms — too short.
// 1000000 gives ~40ms, safely past a 10ms delimiter.
#define KERUI_MAX_SYNC_WAIT 1000000UL

struct KeruiPacket {
  uint32_t sensorId;   // full 24-bit code (bits 0..23) — identity + event
  uint32_t familyId;   // top 20 bits: the SENSOR. This is the matching key.
  uint8_t eventNibble; // bottom 4 bits: what the sensor did (see kerui_event.h)
  bool batteryLow;     // extracted from protocol once we confirm bit layout
};

// Read one Kerui 433MHz packet from analogPin.
// result: array of KERUI_BITS bytes (each 0 or 1)
// row: optional timing array of size 2*(KERUI_BITS+1), pass NULL to skip
// passes: number of consecutive identical reads required (noise rejection)
// Returns KERUI_RESULT_* code.
inline int keruiReadRow(int analogPin, int passes, byte result[], int row[]) {
  unsigned long time, time2;
  int counter, low, high;
  time = millis();
  for (unsigned long syncWait = 0; analogRead(analogPin) < 1; syncWait++) {
    if (syncWait > KERUI_MAX_SYNC_WAIT) return KERUI_RESULT_SYNC_TIMEOUT;
  }

  int successes = 0;
  int bitNumber = -1;
  byte bitValue;
  int errorCount = 0;
  int noDelimiterCounter = 0;

  while (successes < passes) {
    // Read LOW signal
    time = micros();
    counter = 0;
    while (analogRead(analogPin) > KERUI_UPPER_THRESHOLD) {
      counter++;
      if (counter > KERUI_MAX_SIGNAL_LENGTH) return KERUI_RESULT_TIMEOUT_LOW;
    }
    time2 = micros();
    low = time2 - time;

    // Read HIGH signal
    counter = 0;
    while (analogRead(analogPin) < KERUI_LOWER_THRESHOLD) {
      counter++;
      if (counter > KERUI_MAX_SIGNAL_LENGTH) return KERUI_RESULT_TIMEOUT_HIGH;
    }
    high = micros() - time2;

    if (row) {
      row[2 * (bitNumber + 1)] = low;
      row[2 * (bitNumber + 1) + 1] = high;
    }

    if (high > KERUI_DURATION_DELIMITER) {
      bitNumber = 0;
      noDelimiterCounter = 0;
    } else {
      if (bitNumber < 0) {
        if (noDelimiterCounter++ > KERUI_BITS)
          return KERUI_RESULT_DELIMETER_NOT_FOUND;
      } else {
        bitValue = (high < KERUI_DURATION_BIT) ? 1 : 0;

        if (successes > 0 && bitValue != result[bitNumber]) {
          successes = 0;
          if (errorCount++ > KERUI_MAX_ERROR_COUNT)
            return KERUI_RESULT_MANY_ERRORS;
        }

        result[bitNumber] = bitValue;
        bitNumber++;

        if (bitNumber >= KERUI_BITS) {
          bitNumber = -1;
          successes++;
        }
      }
    }
  }

  return KERUI_RESULT_SUCCESS;
}

// Digital overload for CC1101 async serial (IOCFG0=0x0D):
// The CC1101 outputs the demodulated OOK bitstream where:
//   LOW  = carrier present (mark) — duration encodes the bit
//   HIGH = carrier absent (space) — short fixed inter-symbol gap ~400µs
//
// Kerui timing (measured from real hardware):
//   DELIMITER: long LOW ~12,400µs between packet repetitions
//   After delimiter: (HIGH ~400µs)(LOW encodes bit) × 24
//   SHORT LOW ~400µs = bit 1,  LONG LOW ~1200µs = bit 0
//   Threshold 700µs cleanly separates short from long.
//
// result: array of KERUI_BITS bytes (each 0 or 1)
// row: optional timing array of size 2*(KERUI_BITS+1), pass NULL to skip
// passes: number of consecutive identical reads required (noise rejection)
// Returns KERUI_RESULT_* code.
inline int keruiReadRow(int digitalPin, int passes, byte result[], int row[], bool /*useDigitalRead*/) {
  constexpr unsigned long kLowTimeoutUs  = 1000000UL;
  constexpr unsigned long kHighTimeoutUs = 100000UL;
  unsigned long t0, t1, t2;

  // Sync: wait for a LOW (start of signal). Exit into LOW state.
  for (unsigned long syncWait = 0; digitalRead(digitalPin) == HIGH; syncWait++) {
    if (syncWait > KERUI_MAX_SYNC_WAIT) return KERUI_RESULT_SYNC_TIMEOUT;
  }

  int successes = 0;
  int bitNumber = -1;
  byte bitValue;
  int errorCount = 0;
  int noDelimiterCounter = 0;

  while (successes < passes) {
    // Measure LOW duration (carrier present — encodes the bit).
    t0 = micros();
    while (digitalRead(digitalPin) == LOW) {
      if (micros() - t0 > kLowTimeoutUs) return KERUI_RESULT_TIMEOUT_LOW;
    }
    t1 = micros();
    int low = (int)(t1 - t0);

    // Measure HIGH duration (carrier absent — delimiter or inter-bit gap).
    while (digitalRead(digitalPin) == HIGH) {
      if (micros() - t1 > kHighTimeoutUs) return KERUI_RESULT_TIMEOUT_HIGH;
    }
    t2 = micros();
    int high = (int)(t2 - t1);

    if (row) {
      row[2 * (bitNumber + 1)]     = low;
      row[2 * (bitNumber + 1) + 1] = high;
    }

    if (low > KERUI_DURATION_DELIMITER) {
      // Long LOW = inter-packet delimiter. Start (or restart) framing.
      // Next edge will be HIGH (inter-bit gap), then LOW (data bit).
      bitNumber = 0;
      noDelimiterCounter = 0;
    } else {
      if (bitNumber < 0) {
        if (noDelimiterCounter++ > KERUI_BITS)
          return KERUI_RESULT_DELIMETER_NOT_FOUND;
      } else {
        // Bit encoded in LOW duration: short (~400µs)=1, long (~1200µs)=0.
        bitValue = (low < KERUI_DURATION_BIT) ? 1 : 0;

        if (successes > 0 && bitValue != result[bitNumber]) {
          successes = 0;
          if (errorCount++ > KERUI_MAX_ERROR_COUNT)
            return KERUI_RESULT_MANY_ERRORS;
        }

        result[bitNumber] = bitValue;
        bitNumber++;

        if (bitNumber >= KERUI_BITS) {
          bitNumber = -1;
          successes++;
        }
      }
    }
  }

  return KERUI_RESULT_SUCCESS;
}

// Convert raw bit array to KeruiPacket.
// Kerui 24-bit packet layout (measured from real hardware):
//   bits 23-4 (top 20): sensor identity — stable across triggers
//   bits 3-0  (bottom 4): event/state flags (open=0x9, close=0x3 observed)
//
// That open/close note is CORRECT and confirmed: a 3,089-event history shows
// family 0x2E5B7 sending 0x3 (close, x40) and 0x9 (open, x12). Other nibbles
// measured on this house's sensors and cross-checked against rtl_433's
// kerui.c: 0xA motion, 0xE door open, 0xB tamper, 0x5 water, 0xF battery
// low, 0x7 a second close code. See kerui_event.h for the full table.
//
// NOTE 0x9 is ALSO four curtain sensors' beam-cut code, so the same nibble
// appears on two different device classes. It identifies an EVENT, never a
// sensor TYPE — no type is derived from it anywhere in this system.
//
// The full 24-bit value is kept (and is still what gets written to
// /events/{rfId}) so the pairing UI can see which code arrived; familyId is
// what alarm matching uses. batteryLow bit position not yet confirmed.
inline KeruiPacket keruiParse(byte bits[]) {
  KeruiPacket pkt;
  pkt.sensorId = 0;
  for (int i = 0; i < 24; i++) {
    pkt.sensorId = (pkt.sensorId << 1) | bits[i];
  }
  pkt.familyId = (pkt.sensorId >> 4) & 0xFFFFF;
  pkt.eventNibble = (uint8_t)(pkt.sensorId & 0x0F);
  pkt.batteryLow = false;
  return pkt;
}
