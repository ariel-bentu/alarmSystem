#include <unity.h>
#include "camera_gate.h"

static Config offCfg()  { Config c; c.nvrMode = 0; c.captureCooldownSec = 45; return c; }
static Config onCfg()   { Config c; c.nvrMode = 1; c.captureCooldownSec = 45; return c; }

// A sensor that captures SOMETHING. The mask is what enables capture now
// (0 = capture nothing), so every shouldCapture test that expects a capture
// has to start from a non-zero mask.
static SensorConfig withCameras(uint8_t mask) {
  SensorConfig s;
  s.cameraMask = mask;
  return s;
}

void test_no_capture_when_mode_off() {
  TEST_ASSERT_FALSE(CameraGate::shouldCapture(offCfg(), withCameras(0b1), true, 100000, 0));
}
void test_no_capture_when_offline() {
  TEST_ASSERT_FALSE(CameraGate::shouldCapture(onCfg(), withCameras(0b1), false, 100000, 0));
}
void test_no_capture_when_no_cameras_selected() {
  // Mask 0 is the authoritative "this sensor captures nothing" — it replaces
  // the old outOfSight flag rather than falling back to all channels.
  SensorConfig s; // cameraMask 0 by default
  TEST_ASSERT_FALSE(CameraGate::shouldCapture(onCfg(), s, true, 100000, 0));
}
void test_capture_first_time() {
  TEST_ASSERT_TRUE(CameraGate::shouldCapture(onCfg(), withCameras(0b1), true, 100000, 0));
}
void test_cooldown_blocks_then_allows() {
  // last capture at 100000ms, cooldown 45s: 120000 blocked, 146000 allowed
  TEST_ASSERT_FALSE(CameraGate::shouldCapture(onCfg(), withCameras(0b1), true, 120000, 100000));
  TEST_ASSERT_TRUE(CameraGate::shouldCapture(onCfg(), withCameras(0b1), true, 146000, 100000));
}

void test_channels_single_bit() {
  SensorConfig s = withCameras(0b10); // channel 2
  uint8_t ch[8]; uint8_t n = 0;
  CameraGate::channelsFor(s, ch, n);
  TEST_ASSERT_EQUAL_UINT8(1, n);
  TEST_ASSERT_EQUAL_UINT8(2, ch[0]);
}
void test_channels_multiple_bits_ascending() {
  SensorConfig s = withCameras(0b10000101); // channels 1, 3, 8
  uint8_t ch[8]; uint8_t n = 0;
  CameraGate::channelsFor(s, ch, n);
  TEST_ASSERT_EQUAL_UINT8(3, n);
  TEST_ASSERT_EQUAL_UINT8(1, ch[0]);
  TEST_ASSERT_EQUAL_UINT8(3, ch[1]);
  TEST_ASSERT_EQUAL_UINT8(8, ch[2]);
}
void test_channels_all_eight() {
  SensorConfig s = withCameras(0xFF);
  uint8_t ch[8]; uint8_t n = 0;
  CameraGate::channelsFor(s, ch, n);
  TEST_ASSERT_EQUAL_UINT8(8, n);
  TEST_ASSERT_EQUAL_UINT8(1, ch[0]);
  TEST_ASSERT_EQUAL_UINT8(8, ch[7]);
}
void test_channels_none_when_mask_zero() {
  SensorConfig s; // mask 0
  uint8_t ch[8]; uint8_t n = 0;
  CameraGate::channelsFor(s, ch, n);
  TEST_ASSERT_EQUAL_UINT8(0, n);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_no_capture_when_mode_off);
  RUN_TEST(test_no_capture_when_offline);
  RUN_TEST(test_no_capture_when_no_cameras_selected);
  RUN_TEST(test_capture_first_time);
  RUN_TEST(test_cooldown_blocks_then_allows);
  RUN_TEST(test_channels_single_bit);
  RUN_TEST(test_channels_multiple_bits_ascending);
  RUN_TEST(test_channels_all_eight);
  RUN_TEST(test_channels_none_when_mask_zero);
  UNITY_END();
}
void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
