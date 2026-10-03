#include <unity.h>
#include "camera_gate.h"

static Config offCfg()  { Config c; c.nvrMode = 0; c.captureCooldownSec = 45; return c; }
static Config onCfg()   { Config c; c.nvrMode = 1; c.captureCooldownSec = 45; return c; }

void test_no_capture_when_mode_off() {
  SensorConfig s;
  TEST_ASSERT_FALSE(CameraGate::shouldCapture(offCfg(), s, true, 100000, 0));
}
void test_no_capture_when_offline() {
  SensorConfig s;
  TEST_ASSERT_FALSE(CameraGate::shouldCapture(onCfg(), s, false, 100000, 0));
}
void test_no_capture_when_out_of_sight() {
  SensorConfig s; s.outOfSight = true;
  TEST_ASSERT_FALSE(CameraGate::shouldCapture(onCfg(), s, true, 100000, 0));
}
void test_capture_first_time() {
  SensorConfig s;
  TEST_ASSERT_TRUE(CameraGate::shouldCapture(onCfg(), s, true, 100000, 0));
}
void test_cooldown_blocks_then_allows() {
  SensorConfig s;
  // last capture at 100000ms, cooldown 45s: 120000 blocked, 146000 allowed
  TEST_ASSERT_FALSE(CameraGate::shouldCapture(onCfg(), s, true, 120000, 100000));
  TEST_ASSERT_TRUE(CameraGate::shouldCapture(onCfg(), s, true, 146000, 100000));
}
void test_channels_named_single() {
  SensorConfig s; s.cameraChannel = 2;
  uint8_t ch[3]; uint8_t n = 0;
  CameraGate::channelsFor(s, ch, n);
  TEST_ASSERT_EQUAL_UINT8(1, n);
  TEST_ASSERT_EQUAL_UINT8(2, ch[0]);
}
void test_channels_all_when_unset() {
  SensorConfig s; // cameraChannel 0
  uint8_t ch[3]; uint8_t n = 0;
  CameraGate::channelsFor(s, ch, n);
  TEST_ASSERT_EQUAL_UINT8(3, n);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_no_capture_when_mode_off);
  RUN_TEST(test_no_capture_when_offline);
  RUN_TEST(test_no_capture_when_out_of_sight);
  RUN_TEST(test_capture_first_time);
  RUN_TEST(test_cooldown_blocks_then_allows);
  RUN_TEST(test_channels_named_single);
  RUN_TEST(test_channels_all_when_unset);
  UNITY_END();
}
void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
