// Spike sketch: decode Kerui sensor packets and print to Serial.
// Wire: 433MHz RX module DATA pin → Arduino A0
// Open Serial Monitor at 9600 baud, trigger a sensor to see its 24-bit code.

#include "kerui_decoder.h"

#define RX_PIN A0
#define LED_PIN 13

const int rowSize = 2 * (KERUI_BITS + 1);
int row[rowSize];
byte bits[KERUI_BITS];

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);
  delay(2000);
  digitalWrite(LED_PIN, LOW);
  Serial.println("Kerui decoder ready. Trigger a sensor...");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  int result = keruiReadRow(RX_PIN, 2, bits, row);
  digitalWrite(LED_PIN, LOW);

  if (result == KERUI_RESULT_SUCCESS) {
    KeruiPacket pkt = keruiParse(bits);

    Serial.print("Sensor ID: 0x");
    Serial.println(pkt.sensorId, HEX);

    Serial.print("Raw bits: ");
    for (int i = 0; i < KERUI_BITS; i++) Serial.print(bits[i]);
    Serial.println();

    Serial.print("Timing: ");
    for (int i = 0; i < rowSize; i++) {
      if (i > 0) Serial.print(", ");
      Serial.print(row[i]);
    }
    Serial.println();
    Serial.println("---");
  } else {
    Serial.print("Decode error: ");
    Serial.println(result);
  }
}
