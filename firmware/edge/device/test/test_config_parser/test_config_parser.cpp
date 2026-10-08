#include <unity.h>
#include <string>
#include "config_parser.h"

void test_valid_config_round_trip_with_all_condition_types() {
  const char* json = R"({
    "a": true,
    "d": 120,
    "r": ["0xA1B2C", "0xD4E5F", "0xA1B2D", "0xAA11B", "0xCC22D"],
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

  TEST_ASSERT_EQUAL_STRING("0xA1B2C", config.sensors[0].familyId);
  TEST_ASSERT_EQUAL_UINT8(1, config.sensors[0].conditionCount);
  TEST_ASSERT_EQUAL_UINT8(0, config.sensors[0].conditions[0].t);

  TEST_ASSERT_EQUAL_STRING("0xD4E5F", config.sensors[1].familyId);
  TEST_ASSERT_EQUAL_UINT8(1, config.sensors[1].conditions[0].t);
  TEST_ASSERT_EQUAL_UINT16(2, config.sensors[1].conditions[0].n);
  TEST_ASSERT_EQUAL_UINT16(30, config.sensors[1].conditions[0].w);

  TEST_ASSERT_EQUAL_STRING("0xA1B2D", config.sensors[2].familyId);
  TEST_ASSERT_EQUAL_UINT8(2, config.sensors[2].conditions[0].t);
  TEST_ASSERT_EQUAL_UINT16(30, config.sensors[2].conditions[0].y);

  TEST_ASSERT_EQUAL_STRING("0xAA11B", config.sensors[3].familyId);
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
  const char* json = R"({ "a": true, "d": 60, "r": ["0xA1B2C"] })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_FALSE(ok);
}

void test_r_c_length_mismatch_is_rejected() {
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C", "0xD4E5F"],
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
    "r": ["0xA1B2C"],
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
    "r": ["0xA1B2C"],
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
    "r": ["0xA1B2C", "0xD4E5F", "0x11223"],
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
    "r": ["0xA1B2C", "0xD4E5F", "0x11223"],
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
    "r": ["0xA1B2C", "0xD4E5F"],
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

void test_parses_count_in_window_min_gap() {
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C"],
    "c": [
      [{ "t": 1, "n": 2, "w": 120, "g": 20 }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT8(20, config.sensors[0].conditions[0].g);
}

void test_absent_min_gap_defaults_to_zero_meaning_no_minimum() {
  // The server omits g whenever it is unset or 0, so this is the shape of
  // every count_in_window rule that predates the field — it must decode to
  // "no minimum", which is why no migration is needed.
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C"],
    "c": [
      [{ "t": 1, "n": 2, "w": 120 }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT8(0, config.sensors[0].conditions[0].g);
}

void test_min_gap_above_uint8_is_clamped_not_truncated() {
  // 300 would wrap to 44, a SMALLER gap than configured — a weaker filter
  // than the user asked for. Clamp to 255 instead.
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C"],
    "c": [
      [{ "t": 1, "n": 2, "w": 600, "g": 300 }]
    ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT8(255, config.sensors[0].conditions[0].g);
}

void test_parses_siren_hold_and_non_definite_sensors() {
  const char* json = R"({
    "a": true, "d": 60, "sh": 20, "nd": [1],
    "r": ["0xA1B2C", "0xD4E5F"],
    "c": [ [{ "t": 0 }], [{ "t": 0 }] ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT16(20, config.sirenHoldSec);
  TEST_ASSERT_TRUE(config.sensors[0].definiteBreach);
  TEST_ASSERT_FALSE(config.sensors[1].definiteBreach);
}

void test_absent_hold_fields_mean_fire_immediately() {
  // The shape of every config written before the siren hold existed: no hold,
  // and every sensor definite.
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C"],
    "c": [ [{ "t": 0 }] ]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_EQUAL_UINT16(0, config.sirenHoldSec);
  TEST_ASSERT_TRUE(config.sensors[0].definiteBreach);
}

// `out` is a reused Config. A sensor that was non-definite under the previous
// config must not stay non-definite once the box is unticked, or it would go
// on holding its siren forever.
void test_non_definite_is_cleared_when_config_no_longer_lists_it() {
  Config config;
  const char* withHold = R"({
    "a": true, "d": 60, "sh": 20, "nd": [0],
    "r": ["0xA1B2C"],
    "c": [ [{ "t": 0 }] ]
  })";
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(withHold, &config));
  TEST_ASSERT_FALSE(config.sensors[0].definiteBreach);

  const char* withoutHold = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C"],
    "c": [ [{ "t": 0 }] ]
  })";
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(withoutHold, &config));
  TEST_ASSERT_TRUE(config.sensors[0].definiteBreach);
}

void test_quorum_larger_than_participants_is_clamped_to_all() {
  // A quorum above kLen would be permanently unfireable. Clamped to 0
  // (= all) rather than stored, matching how bad k indices are dropped.
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0xA1B2C", "0xD4E5F"],
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
    "a": true, "d": 120, "r": ["0xA1B2C"], "c": [[{ "t": 0, "x": 1 }]]
  })";

  Config config;
  bool ok = ConfigParser::parseConfigJson(json, &config);

  TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_TRUE(config.sensors[0].conditions[0].always);
}

void test_absent_x_means_not_always() {
  const char* json = R"({
    "a": true, "d": 120, "r": ["0xA1B2C"], "c": [[{ "t": 0 }]]
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

void test_family_ids_fit_exactly_and_longer_values_truncate_safely() {
  // `r` carries 20-bit families ("0x0061D" = 7 chars + null = 8) into a
  // familyId[9] buffer, so a real value fits with a byte to spare.
  //
  // A FULL 24-bit rfId would be 8 chars — it still fits, and that matters:
  // a cloud that has not yet been redeployed sends the old shape, and the
  // device must not corrupt memory or read past the buffer. It simply will
  // not MATCH anything, which is the correct, visible failure.
  const char* json = R"({
    "a": true, "d": 60,
    "r": ["0x0061D", "0xA1B2C3", "0xTOOLONGVALUE"],
    "c": [[{ "t": 0 }], [{ "t": 0 }], [{ "t": 0 }]]
  })";

  Config config;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &config));
  TEST_ASSERT_EQUAL_UINT8(3, config.sensorCount);
  TEST_ASSERT_EQUAL_STRING("0x0061D", config.sensors[0].familyId);
  TEST_ASSERT_EQUAL_STRING("0xA1B2C3", config.sensors[1].familyId);
  // Truncated to 8 chars + NUL, never overrunning.
  TEST_ASSERT_EQUAL_STRING("0xTOOLON", config.sensors[2].familyId);
}

// NVR connection fields (nh/np/nu/nw/nm/cc) are parsed before the r/c early
// return, same as s/m — a config with no sensors must still deliver NVR
// settings. The per-sensor cmask[] rides index-aligned with r/c.
void test_parses_nvr_fields() {
  const char* json =
    "{ \"a\":true, \"d\":30, "
    "\"nh\":\"cam.local\", \"np\":34567, \"nu\":\"u\", \"nw\":\"p\", "
    "\"nm\":2, \"cc\":60, "
    "\"r\":[\"0x0061D\"], \"c\":[[{\"t\":0}]], "
    "\"cmask\":[5] }";
  Config cfg;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &cfg));
  TEST_ASSERT_EQUAL_STRING("cam.local", cfg.nvrHost);
  TEST_ASSERT_EQUAL_UINT16(34567, cfg.nvrPort);
  TEST_ASSERT_EQUAL_STRING("u", cfg.nvrUser);
  TEST_ASSERT_EQUAL_STRING("p", cfg.nvrPassword);
  TEST_ASSERT_EQUAL_UINT8(2, cfg.nvrMode);
  TEST_ASSERT_EQUAL_UINT16(60, cfg.captureCooldownSec);
  // 5 == 0b101 == channels 1 and 3.
  TEST_ASSERT_EQUAL_UINT8(5, cfg.sensors[0].cameraMask);
}

void test_nvr_fields_default_when_absent() {
  const char* json = "{ \"a\":false, \"d\":0, \"r\":[\"0x0061D\"], \"c\":[[{\"t\":0}]] }";
  Config cfg;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &cfg));
  TEST_ASSERT_EQUAL_UINT8(0, cfg.nvrMode);      // off
  TEST_ASSERT_EQUAL_UINT16(45, cfg.captureCooldownSec); // default
  // No `cd`: keep capturing while disarmed, the behaviour before the field.
  TEST_ASSERT_TRUE(cfg.captureWhenDisarmed);
  // No cmask at all: capture nothing, NOT all channels.
  TEST_ASSERT_EQUAL_UINT8(0, cfg.sensors[0].cameraMask);
}

// cmask is index-aligned with r, and buildConfig omits it wholesale when every
// sensor's mask is 0. A SHORT array (shouldn't happen, but RTDB drops trailing
// nulls) must leave the unlisted sensors at 0 rather than read out of bounds.
void test_capture_when_disarmed_off() {
  const char* json =
    "{ \"a\":false, \"d\":0, \"nm\":1, \"cd\":0, "
    "\"r\":[\"0x0061D\"], \"c\":[[{\"t\":0}]] }";
  Config cfg;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &cfg));
  TEST_ASSERT_FALSE(cfg.captureWhenDisarmed);
}

void test_camera_mask_per_sensor_and_short_array() {
  const char* json =
    "{ \"a\":true, \"d\":0, \"nm\":1, "
    "\"r\":[\"0x0061D\",\"0x0072E\",\"0x0083F\"], "
    "\"c\":[[{\"t\":0}],[{\"t\":0}],[{\"t\":0}]], "
    "\"cmask\":[128,0] }";
  Config cfg;
  TEST_ASSERT_TRUE(ConfigParser::parseConfigJson(json, &cfg));
  TEST_ASSERT_EQUAL_UINT8(3, cfg.sensorCount);
  TEST_ASSERT_EQUAL_UINT8(128, cfg.sensors[0].cameraMask); // channel 8
  TEST_ASSERT_EQUAL_UINT8(0, cfg.sensors[1].cameraMask);
  TEST_ASSERT_EQUAL_UINT8(0, cfg.sensors[2].cameraMask);   // beyond the array
}

// The false-positive advisory: /commands.fp = { rfId, ts }, written when the
// cloud judges a snapshot "safe". rfId is the FULL 24-bit code (matches the
// /events key and the snapshot upload path), ts is epoch-MILLISECONDS — the
// same uint64 reportEvent()/uploadSnapshot() use. uint32_t cannot hold a real
// epoch-ms value (current epoch-ms ~1.7e12 is far past uint32_t's ~4.3e9
// ceiling), so this is uint64_t, NOT the uint32_t the original brief sketched.
void test_parse_false_positive() {
  char rf[16] = {};
  uint64_t ts = 0;
  const char* json = "{ \"fp\": { \"rfId\": \"0x2E5B73\", \"ts\": 1696000000123 } }";
  TEST_ASSERT_TRUE(ConfigParser::parseFalsePositive(json, rf, sizeof(rf), &ts));
  TEST_ASSERT_EQUAL_STRING("0x2E5B73", rf);
  TEST_ASSERT_EQUAL_UINT64(1696000000123ULL, ts);
}

// commands/breach is the ADDITIVE mirror of commands/fp: same {rfId, ts}
// shape, same parser, opposite meaning. "fp" says stand down for this
// trigger; "breach" says sound off for it, because the AI judge saw a person
// and the sensor's condition opted into vision evidence
// (Condition.breach_satisfies).
void test_parse_breach() {
  char rf[16] = {};
  uint64_t ts = 0;
  const char* json = "{ \"breach\": { \"rfId\": \"0x009BFA\", \"ts\": 1791209562000 } }";
  TEST_ASSERT_TRUE(ConfigParser::parseAdvisory(json, "breach", rf, sizeof(rf), &ts));
  TEST_ASSERT_EQUAL_STRING("0x009BFA", rf);
  TEST_ASSERT_EQUAL_UINT64(1791209562000ULL, ts);
}

void test_parse_breach_absent() {
  char rf[16] = {};
  uint64_t ts = 0;
  TEST_ASSERT_FALSE(
      ConfigParser::parseAdvisory("{ \"armed\": true }", "breach", rf, sizeof(rf), &ts));
}

// The two keys must not read each other: an fp-only payload must yield no
// breach, or a stand-down would be read as a sound-off.
void test_breach_and_fp_do_not_cross_read() {
  char rf[16] = {};
  uint64_t ts = 0;
  const char* fpOnly = "{ \"fp\": { \"rfId\": \"0x009BFA\", \"ts\": 1791209562000 } }";
  TEST_ASSERT_FALSE(ConfigParser::parseAdvisory(fpOnly, "breach", rf, sizeof(rf), &ts));

  const char* breachOnly = "{ \"breach\": { \"rfId\": \"0x009BFA\", \"ts\": 1791209562000 } }";
  TEST_ASSERT_FALSE(ConfigParser::parseAdvisory(breachOnly, "fp", rf, sizeof(rf), &ts));
}

// Both present is legitimate: /commands is one polled document, so a project
// that had an fp earlier and a breach now carries both keys. Each must parse
// its own.
void test_breach_and_fp_both_present_parse_independently() {
  char rf[16] = {};
  uint64_t ts = 0;
  const char* both =
      "{ \"fp\": { \"rfId\": \"0xAAAAAA\", \"ts\": 111 },"
      "  \"breach\": { \"rfId\": \"0xBBBBBB\", \"ts\": 222 } }";

  TEST_ASSERT_TRUE(ConfigParser::parseAdvisory(both, "fp", rf, sizeof(rf), &ts));
  TEST_ASSERT_EQUAL_STRING("0xAAAAAA", rf);
  TEST_ASSERT_EQUAL_UINT64(111ULL, ts);

  TEST_ASSERT_TRUE(ConfigParser::parseAdvisory(both, "breach", rf, sizeof(rf), &ts));
  TEST_ASSERT_EQUAL_STRING("0xBBBBBB", rf);
  TEST_ASSERT_EQUAL_UINT64(222ULL, ts);
}

void test_parse_false_positive_absent() {
  char rf[16] = {};
  uint64_t ts = 0;
  TEST_ASSERT_FALSE(
      ConfigParser::parseFalsePositive("{ \"armed\": true }", rf, sizeof(rf), &ts));
}

void test_parse_false_positive_malformed_json_is_rejected() {
  char rf[16] = {};
  uint64_t ts = 0;
  TEST_ASSERT_FALSE(
      ConfigParser::parseFalsePositive("{ \"fp\": ", rf, sizeof(rf), &ts));
}

void test_parse_false_positive_missing_rfid_is_rejected() {
  char rf[16] = {};
  uint64_t ts = 0;
  const char* json = "{ \"fp\": { \"ts\": 1696000000123 } }";
  TEST_ASSERT_FALSE(ConfigParser::parseFalsePositive(json, rf, sizeof(rf), &ts));
}

void test_parse_false_positive_missing_ts_is_rejected() {
  char rf[16] = {};
  uint64_t ts = 0;
  const char* json = "{ \"fp\": { \"rfId\": \"0x2E5B73\" } }";
  TEST_ASSERT_FALSE(ConfigParser::parseFalsePositive(json, rf, sizeof(rf), &ts));
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_family_ids_fit_exactly_and_longer_values_truncate_safely);
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
  RUN_TEST(test_parses_siren_hold_and_non_definite_sensors);
  RUN_TEST(test_absent_hold_fields_mean_fire_immediately);
  RUN_TEST(test_non_definite_is_cleared_when_config_no_longer_lists_it);
  RUN_TEST(test_parses_count_in_window_min_gap);
  RUN_TEST(test_absent_min_gap_defaults_to_zero_meaning_no_minimum);
  RUN_TEST(test_min_gap_above_uint8_is_clamped_not_truncated);
  RUN_TEST(test_quorum_larger_than_participants_is_clamped_to_all);
  RUN_TEST(test_parses_always_flag);
  RUN_TEST(test_absent_x_means_not_always);
  RUN_TEST(test_parses_remote_identities);
  RUN_TEST(test_absent_m_means_zero_remotes);
  RUN_TEST(test_clamps_excess_remotes_to_capacity);
  RUN_TEST(test_parses_siren_base_address);
  RUN_TEST(test_absent_s_means_no_siren_address);
  RUN_TEST(test_siren_address_parsed_when_r_and_c_absent);
  RUN_TEST(test_parses_nvr_fields);
  RUN_TEST(test_nvr_fields_default_when_absent);
  RUN_TEST(test_capture_when_disarmed_off);
  RUN_TEST(test_camera_mask_per_sensor_and_short_array);
  RUN_TEST(test_parse_breach);
  RUN_TEST(test_parse_breach_absent);
  RUN_TEST(test_breach_and_fp_do_not_cross_read);
  RUN_TEST(test_breach_and_fp_both_present_parse_independently);
  RUN_TEST(test_parse_false_positive);
  RUN_TEST(test_parse_false_positive_absent);
  RUN_TEST(test_parse_false_positive_malformed_json_is_rejected);
  RUN_TEST(test_parse_false_positive_missing_rfid_is_rejected);
  RUN_TEST(test_parse_false_positive_missing_ts_is_rejected);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
