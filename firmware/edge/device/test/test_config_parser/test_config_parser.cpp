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

// Firebase RTDB stores an object whose keys are "0".."n" as a JSON ARRAY.
// buildConfig emits k as {"0":1,"1":1,"2":1}, but the device receives
// [1,1,1] — and reading that as a JsonObject yields null, so kLen stayed 0
// and multiSensorSatisfied() looped over ZERO participants and never fired.
//
// Observed on hardware 2026-09-07: a 3-sensor rule did not trigger even with
// all three sensors. Pre-existing; the old tests all used non-consecutive
// keys ("3","4"), the one shape RTDB does NOT arrayify.
void test_k_as_json_array_is_parsed_like_an_object() {
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0x170D09", "0x4D6A7E", "0x1520FE"],
    "c": [
      [{ "t": 3, "w": 60, "k": [1, 1, 1], "q": 2 }],
      [{ "t": 3, "w": 60, "k": [1, 1, 1], "q": 2 }],
      [{ "t": 3, "w": 60, "k": [1, 1, 1], "q": 2 }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  Condition& cond = config.sensors[0].conditions[0];
  // Array position IS the index into r, exactly as the object key was.
  TEST_ASSERT_EQUAL_UINT8(3, cond.kLen);
  TEST_ASSERT_EQUAL_UINT8(0, cond.kIndex[0]);
  TEST_ASSERT_EQUAL_UINT8(1, cond.kIndex[1]);
  TEST_ASSERT_EQUAL_UINT8(2, cond.kIndex[2]);
  TEST_ASSERT_EQUAL_UINT16(1, cond.kCount[0]);
  TEST_ASSERT_EQUAL_UINT8(2, cond.q);
}

// RTDB arrayifies only when the keys are dense from 0. A sparse object keeps
// its object form, and a HOLE arrives as null — which must be skipped, not
// stored as a participant with count 0.
void test_k_array_with_null_holes_skips_them() {
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C3", "0xD4E5F6", "0x112233"],
    "c": [
      [{ "t": 3, "w": 60, "k": [2, null, 1] }],
      [{ "t": 0 }],
      [{ "t": 3, "w": 60, "k": [2, null, 1] }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  Condition& cond = config.sensors[0].conditions[0];
  TEST_ASSERT_EQUAL_UINT8(2, cond.kLen);
  TEST_ASSERT_EQUAL_UINT8(0, cond.kIndex[0]);
  TEST_ASSERT_EQUAL_UINT16(2, cond.kCount[0]);
  TEST_ASSERT_EQUAL_UINT8(2, cond.kIndex[1]);
  TEST_ASSERT_EQUAL_UINT16(1, cond.kCount[1]);
}

void test_parses_multi_sensor_quorum() {
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C3", "0xD4E5F6", "0x112233"],
    "c": [
      [{ "t": 3, "w": 60, "k": { "0": 1, "1": 1, "2": 1 }, "q": 2 }],
      [{ "t": 3, "w": 60, "k": { "0": 1, "1": 1, "2": 1 }, "q": 2 }],
      [{ "t": 3, "w": 60, "k": { "0": 1, "1": 1, "2": 1 }, "q": 2 }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT8(2, config.sensors[0].conditions[0].q);
}

void test_absent_quorum_defaults_to_zero_meaning_all() {
  // The server omits q whenever it equals the participant count, so this is
  // the shape of every rule that predates the quorum.
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C3", "0xD4E5F6"],
    "c": [
      [{ "t": 3, "w": 60, "k": { "0": 1, "1": 1 } }],
      [{ "t": 3, "w": 60, "k": { "0": 1, "1": 1 } }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT8(0, config.sensors[0].conditions[0].q);
}

void test_quorum_larger_than_participants_is_clamped_to_all() {
  // A quorum above kLen would be permanently unfireable. Clamped to 0
  // (= all) rather than stored, matching how bad k indices are dropped.
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C3", "0xD4E5F6"],
    "c": [
      [{ "t": 3, "w": 60, "k": { "0": 1, "1": 1 }, "q": 9 }],
      [{ "t": 3, "w": 60, "k": { "0": 1, "1": 1 }, "q": 9 }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT8(0, config.sensors[0].conditions[0].q);
}

void test_parses_always_flag() {
  const char* json = R"({
    "a": true, "d": 120, "r": ["0xA1B2C3"], "c": [[{ "t": 0, "x": 1 }]]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_TRUE(config.sensors[0].conditions[0].always);
}

void test_absent_x_means_not_always() {
  const char* json = R"({
    "a": true, "d": 120, "r": ["0xA1B2C3"], "c": [[{ "t": 0 }]]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_FALSE(config.sensors[0].conditions[0].always);
}

// 938442 = 0xE51CA, 74570 = 0x1234A. RTDB numbers arrive as decimal.
void test_parses_remote_identities() {
  const char* json = "{\"a\":false,\"d\":120,\"e\":true,\"m\":[938442,74570]}";
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL(2, out.remoteCount);
  TEST_ASSERT_EQUAL_HEX32(0xE51CA, out.remotes[0]);
  TEST_ASSERT_EQUAL_HEX32(0x1234A, out.remotes[1]);
}

// RTDB drops empty arrays on .set(), so an absent m must mean "no remotes",
// never a parse failure — the same contract r/c already have.
void test_absent_m_means_zero_remotes() {
  const char* json = "{\"a\":false,\"d\":120,\"e\":true}";
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL(0, out.remoteCount);
}

// A malicious or corrupt config must not overflow the fixed array.
void test_clamps_excess_remotes_to_capacity() {
  const char* json =
      "{\"a\":false,\"d\":120,\"e\":true,"
      "\"m\":[1,2,3,4,5,6,7,8,9,10,11,12]}";
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL(Config::kMaxRemotes, out.remoteCount);
}

// The siren address echoed back by the cloud, so a device whose EEPROM was
// wiped can re-adopt the address its physical siren is still paired to.
void test_parses_siren_base_address() {
  const char* json =
      "{\"a\":false,\"d\":120,\"e\":true,\"s\":10597056}";  // 0xA1B2C0
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL_HEX32(0xA1B2C0, out.sirenBaseAddress);
}

// An absent s means "the cloud has no siren address", never a parse failure.
// The device treats 0 as "nothing to adopt" and keeps whatever it has.
void test_absent_s_means_no_siren_address() {
  const char* json = "{\"a\":false,\"d\":120,\"e\":true}";
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL_HEX32(0, out.sirenBaseAddress);
}

// REGRESSION: s is parsed before the r/c early return, exactly as m is. A
// project with no rules must still be able to recover its siren address —
// parsing s after that return would silently strand such a device.
void test_siren_address_parsed_when_r_and_c_absent() {
  const char* json = "{\"a\":true,\"d\":60,\"e\":true,\"s\":10597056}";
  Config out;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &out));
  TEST_ASSERT_EQUAL(0, out.sensorCount);
  TEST_ASSERT_EQUAL_HEX32(0xA1B2C0, out.sirenBaseAddress);
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
  RUN_TEST(test_k_as_json_array_is_parsed_like_an_object);
  RUN_TEST(test_k_array_with_null_holes_skips_them);
  RUN_TEST(test_parses_multi_sensor_quorum);
  RUN_TEST(test_absent_quorum_defaults_to_zero_meaning_all);
  RUN_TEST(test_quorum_larger_than_participants_is_clamped_to_all);
  RUN_TEST(test_parses_always_flag);
  RUN_TEST(test_absent_x_means_not_always);
  RUN_TEST(test_parses_remote_identities);
  RUN_TEST(test_absent_m_means_zero_remotes);
  RUN_TEST(test_clamps_excess_remotes_to_capacity);
  RUN_TEST(test_parses_siren_base_address);
  RUN_TEST(test_absent_s_means_no_siren_address);
  RUN_TEST(test_siren_address_parsed_when_r_and_c_absent);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
