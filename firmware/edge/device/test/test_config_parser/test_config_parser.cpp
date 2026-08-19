#include <unity.h>
#include <string>
#include "config_parser.h"

void test_valid_config_round_trip_with_all_condition_types() {
  const char* json = R"({
    "a": true,
    "d": 120,
    "r": ["0xA1B2C3", "0xD4E5F6", "0xA1B2C4", "0xAA11BB", "0xCC22DD"],
    "c": [
      [{ "t": 0 }],
      [{ "t": 1, "n": 2, "w": 30 }],
      [{ "t": 2, "y": 30 }],
      [{ "t": 3, "w": 60, "k": { "3": 2, "4": 1 } }],
      [{ "t": 3, "w": 60, "k": { "3": 2, "4": 1 } }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_TRUE(config.armed);
  TEST_ASSERT_EQUAL_UINT16(120, config.sirenDurationSec);
  TEST_ASSERT_EQUAL_UINT8(5, config.sensorCount);

  TEST_ASSERT_EQUAL_STRING("0xA1B2C3", config.sensors[0].rfId);
  TEST_ASSERT_EQUAL_UINT8(1, config.sensors[0].conditionCount);
  TEST_ASSERT_EQUAL_UINT8(0, config.sensors[0].conditions[0].t);

  TEST_ASSERT_EQUAL_STRING("0xD4E5F6", config.sensors[1].rfId);
  TEST_ASSERT_EQUAL_UINT8(1, config.sensors[1].conditions[0].t);
  TEST_ASSERT_EQUAL_UINT16(2, config.sensors[1].conditions[0].n);
  TEST_ASSERT_EQUAL_UINT16(30, config.sensors[1].conditions[0].w);

  TEST_ASSERT_EQUAL_STRING("0xA1B2C4", config.sensors[2].rfId);
  TEST_ASSERT_EQUAL_UINT8(2, config.sensors[2].conditions[0].t);
  TEST_ASSERT_EQUAL_UINT16(30, config.sensors[2].conditions[0].y);

  TEST_ASSERT_EQUAL_STRING("0xAA11BB", config.sensors[3].rfId);
  TEST_ASSERT_EQUAL_UINT8(3, config.sensors[3].conditions[0].t);
  TEST_ASSERT_EQUAL_UINT16(60, config.sensors[3].conditions[0].w);
  TEST_ASSERT_EQUAL_UINT8(2, config.sensors[3].conditions[0].kLen);
  TEST_ASSERT_EQUAL_UINT8(3, config.sensors[3].conditions[0].kIndex[0]);
  TEST_ASSERT_EQUAL_UINT16(2, config.sensors[3].conditions[0].kCount[0]);
  TEST_ASSERT_EQUAL_UINT8(4, config.sensors[3].conditions[0].kIndex[1]);
  TEST_ASSERT_EQUAL_UINT16(1, config.sensors[3].conditions[0].kCount[1]);
}

void test_missing_r_and_c_is_valid_zero_sensor_config() {
  // Matches onProfileChange.ts's "no active profile" write: {a, d} with r/c
  // omitted because RTDB drops empty arrays on .set().
  const char* json = R"({ "a": false, "d": 120 })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_FALSE(config.armed);
  TEST_ASSERT_EQUAL_UINT16(120, config.sirenDurationSec);
  TEST_ASSERT_EQUAL_UINT8(0, config.sensorCount);
}

void test_only_r_present_without_c_is_rejected() {
  const char* json = R"({ "a": true, "d": 60, "r": ["0xA1B2C3"] })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_FALSE(ok);
}

void test_r_c_length_mismatch_is_rejected() {
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C3", "0xD4E5F6"],
    "c": [[{ "t": 0 }]]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_FALSE(ok);
}

void test_malformed_json_is_rejected() {
  const char* json = R"({ "a": true, "d": )";  // truncated

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_FALSE(ok);
}

void test_more_than_16_sensors_is_truncated_not_rejected() {
  // Build r/c with 18 entries; only the first 16 should be kept.
  std::string json = "{ \"a\": true, \"d\": 60, \"r\": [";
  for (int i = 0; i < 18; i++) {
    if (i > 0) json += ",";
    char buf[16];
    snprintf(buf, sizeof(buf), "\"0x%06X\"", i);
    json += buf;
  }
  json += "], \"c\": [";
  for (int i = 0; i < 18; i++) {
    if (i > 0) json += ",";
    json += "[{\"t\":0}]";
  }
  json += "] }";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json.c_str(), &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT8(16, config.sensorCount);
}

void test_more_than_4_conditions_on_one_sensor_is_truncated() {
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C3"],
    "c": [[{ "t": 0 }, { "t": 0 }, { "t": 0 }, { "t": 0 }, { "t": 0 }, { "t": 0 }]]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT8(1, config.sensorCount);
  TEST_ASSERT_EQUAL_UINT8(4, config.sensors[0].conditionCount);
}

void test_out_of_range_k_index_is_dropped_not_stored() {
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C3"],
    "c": [[{ "t": 3, "w": 60, "k": { "0": 1, "16": 2, "-1": 3 } }]]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  Condition& cond = config.sensors[0].conditions[0];
  // Only the "0" key is valid (0 <= idx < 16); "16" and "-1" must be dropped.
  TEST_ASSERT_EQUAL_UINT8(1, cond.kLen);
  TEST_ASSERT_EQUAL_UINT8(0, cond.kIndex[0]);
  TEST_ASSERT_EQUAL_UINT16(1, cond.kCount[0]);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_valid_config_round_trip_with_all_condition_types);
  RUN_TEST(test_missing_r_and_c_is_valid_zero_sensor_config);
  RUN_TEST(test_only_r_present_without_c_is_rejected);
  RUN_TEST(test_r_c_length_mismatch_is_rejected);
  RUN_TEST(test_malformed_json_is_rejected);
  RUN_TEST(test_more_than_16_sensors_is_truncated_not_rejected);
  RUN_TEST(test_more_than_4_conditions_on_one_sensor_is_truncated);
  RUN_TEST(test_out_of_range_k_index_is_dropped_not_stored);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
