#pragma once

#define KERUI_BITS 24
#define KERUI_MAX_SIGNAL_LENGTH 255
#define KERUI_UPPER_THRESHOLD 100
#define KERUI_LOWER_THRESHOLD 80

#define KERUI_DURATION_BIT 500
#define KERUI_DURATION_DELIMITER 5000

#define KERUI_RESULT_SUCCESS 0
#define KERUI_RESULT_TIMEOUT_LOW 1
#define KERUI_RESULT_TIMEOUT_HIGH 2
#define KERUI_RESULT_MANY_ERRORS 3
#define KERUI_RESULT_DELIMETER_NOT_FOUND 4

#define KERUI_MAX_ERROR_COUNT 50

struct KeruiPacket {
  uint32_t sensorId;   // 24-bit sensor ID (bits 0..23)
  bool batteryLow;     // extracted from protocol once we confirm bit layout
};

// Read one Kerui 433MHz packet from analogPin.
// result: array of KERUI_BITS bytes (each 0 or 1)
// row: optional timing array of size 2*(KERUI_BITS+1), pass NULL to skip
// passes: number of consecutive identical reads required (noise rejection)
// Returns KERUI_RESULT_* code.
int keruiReadRow(int analogPin, int passes, byte result[], int row[]) {
  unsigned long time, time2;
  int counter, low, high;
  time = millis();
  while (analogRead(analogPin) < 1);

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

// Convert raw bit array to KeruiPacket.
// Bit layout TBD — update once first real packet is captured.
KeruiPacket keruiParse(byte bits[]) {
  KeruiPacket pkt;
  pkt.sensorId = 0;
  for (int i = 0; i < 24; i++) {
    pkt.sensorId = (pkt.sensorId << 1) | bits[i];
  }
  // Battery bit position unknown until first capture — placeholder
  pkt.batteryLow = false;
  return pkt;
}
