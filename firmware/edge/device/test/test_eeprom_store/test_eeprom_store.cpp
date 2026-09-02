#include <unity.h>
#include "eeprom_store.h"

void test_encode_decode_round_trips_armed_localweb_and_config() {
  Config config;
  config.armed = true; // note: EepromStore tracks armed separately; this
                        // field on Config itself is unused by the store,
                        // included here only for struct completeness
  config.sirenDurationSec = 90;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "0xA1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1;
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 30;

  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(true, false, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = false;
  bool localWebOut = true;
  Config configOut;
  bool ok = EepromStore::decode(buffer, written, &armedOut, &localWebOut, &configOut);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_TRUE(armedOut);
  TEST_ASSERT_FALSE(localWebOut);
  TEST_ASSERT_EQUAL(90, configOut.sirenDurationSec);
  TEST_ASSERT_EQUAL(1, configOut.sensorCount);
  TEST_ASSERT_EQUAL_STRING("0xA1B2C3", configOut.sensors[0].rfId);
  TEST_ASSERT_EQUAL(1, configOut.sensors[0].conditions[0].t);
  TEST_ASSERT_EQUAL(2, configOut.sensors[0].conditions[0].n);
  TEST_ASSERT_EQUAL(30, configOut.sensors[0].conditions[0].w);
}

void test_localweb_enabled_true_round_trips() {
  Config config;
  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(false, true, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = true;
  bool localWebOut = false;
  Config configOut;
  bool ok = EepromStore::decode(buffer, written, &armedOut, &localWebOut, &configOut);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_FALSE(armedOut);
  TEST_ASSERT_TRUE(localWebOut);
}

void test_decode_rejects_garbage_buffer() {
  uint8_t buffer[EepromStore::kReservedBytes];
  memset(buffer, 0xFF, sizeof(buffer)); // erased-flash pattern, no valid magic/header

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  bool ok = EepromStore::decode(buffer, sizeof(buffer), &armedOut, &localWebOut, &configOut);

  TEST_ASSERT_FALSE(ok);
}

void test_decode_rejects_old_pre_localweb_magic() {
  // Simulates a buffer written by the OLD EepromStore format (magic +
  // armed byte + Config, no localWebEnabled byte) — decode() must reject
  // it via the bumped magic number rather than misreading the Config bytes
  // as if the missing localWebEnabled byte were present.
  uint8_t buffer[EepromStore::kReservedBytes] = {};
  uint32_t oldMagic = 0xA1A2B3B4; // the pre-this-plan magic value
  memcpy(buffer, &oldMagic, sizeof(oldMagic));

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  bool ok = EepromStore::decode(buffer, sizeof(buffer), &armedOut, &localWebOut, &configOut);

  TEST_ASSERT_FALSE(ok);
}

void test_siren_base_address_round_trips() {
  Config config;
  config.sirenBaseAddress = 0xA1B2C0;

  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(false, true, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  TEST_ASSERT_TRUE(
      EepromStore::decode(buffer, written, &armedOut, &localWebOut, &configOut));
  TEST_ASSERT_EQUAL_HEX32(0xA1B2C0, configOut.sirenBaseAddress);
}

void test_decode_rejects_pre_siren_address_magic() {
  // Adding sirenBaseAddress changed sizeof(Config), so a record written by
  // the previous firmware must be REJECTED rather than misread as garbage
  // siren state. The magic bump is that mechanism.
  Config config;
  uint8_t buffer[EepromStore::kReservedBytes];
  EepromStore::encode(true, true, config, buffer, sizeof(buffer));
  const uint32_t previousMagic = 0xA1A2B3B5;
  memcpy(buffer, &previousMagic, sizeof(previousMagic));

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  TEST_ASSERT_FALSE(
      EepromStore::decode(buffer, sizeof(buffer), &armedOut, &localWebOut, &configOut));
}

void test_round_trips_paired_remotes() {
  Config config;
  config.remoteCount = 2;
  config.remotes[0] = 0xE45CA;
  config.remotes[1] = 0x1234A;

  uint8_t buffer[EepromStore::kReservedBytes];
  size_t written = EepromStore::encode(false, true, config, buffer, sizeof(buffer));
  TEST_ASSERT_GREATER_THAN(0, written);

  bool armedOut = true;
  bool localWebOut = false;
  Config configOut;
  TEST_ASSERT_TRUE(
      EepromStore::decode(buffer, written, &armedOut, &localWebOut, &configOut));

  TEST_ASSERT_EQUAL(2, configOut.remoteCount);
  TEST_ASSERT_EQUAL_HEX32(0xE45CA, configOut.remotes[0]);
  TEST_ASSERT_EQUAL_HEX32(0x1234A, configOut.remotes[1]);
}

// The whole record must still fit the reserved region. kReservedBytes is
// sized with only 64 bytes of headroom and its sizing has a documented
// heap/stack history — 8 remotes (33 bytes) fit; raising the cap would not.
void test_record_still_fits_reserved_region() {
  TEST_ASSERT_LESS_OR_EQUAL(EepromStore::kReservedBytes,
                            EepromStore::kRecordBytes);
}

// Adding remotes changed sizeof(Config) again, so the previous magic must
// now be rejected too — same reasoning as the pre-siren-address case above.
void test_decode_rejects_pre_remotes_magic() {
  Config config;
  uint8_t buffer[EepromStore::kReservedBytes];
  EepromStore::encode(true, true, config, buffer, sizeof(buffer));
  const uint32_t previousMagic = 0xA1A2B3B6;
  memcpy(buffer, &previousMagic, sizeof(previousMagic));

  bool armedOut = false;
  bool localWebOut = false;
  Config configOut;
  TEST_ASSERT_FALSE(
      EepromStore::decode(buffer, sizeof(buffer), &armedOut, &localWebOut, &configOut));
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_encode_decode_round_trips_armed_localweb_and_config);
  RUN_TEST(test_localweb_enabled_true_round_trips);
  RUN_TEST(test_decode_rejects_garbage_buffer);
  RUN_TEST(test_decode_rejects_old_pre_localweb_magic);
  RUN_TEST(test_siren_base_address_round_trips);
  RUN_TEST(test_decode_rejects_pre_siren_address_magic);
  RUN_TEST(test_round_trips_paired_remotes);
  RUN_TEST(test_record_still_fits_reserved_region);
  RUN_TEST(test_decode_rejects_pre_remotes_magic);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
