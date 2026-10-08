#include <unity.h>

#include <string>

#include "ota_command.h"

static const char* kMd5 = "0123456789abcdef0123456789ABCDEF";

static OtaRequest validRequest() {
  OtaRequest r;
  r.nonce = 42;
  r.size = 1100000;
  r.untilEpochSec = 0;
  std::strcpy(r.version, "2026.10.08-1432-abc1234");
  std::strcpy(r.path, "firmware/2026.10.08-1432-abc1234/firmware.bin");
  std::strcpy(r.md5, kMd5);
  return r;
}

static OtaVerdict decide(const OtaRequest& r, const char* running = "2026.10.01-0900-0000000",
                         uint32_t now = 1800000000UL, bool siren = false,
                         bool busy = false) {
  return otaDecide(r, /*hasLastHandled=*/false, 0, running, now, siren, busy);
}

// ---- parsing --------------------------------------------------------------

static void test_parse_full_command() {
  JsonDocument doc;
  deserializeJson(doc,
                  "{\"n\":7,\"version\":\"v1\",\"path\":\"firmware/v1/firmware.bin\","
                  "\"md5\":\"0123456789abcdef0123456789abcdef\",\"size\":1234,"
                  "\"until\":1800000000}");
  OtaRequest r;
  TEST_ASSERT_TRUE(parseOtaRequest(doc.as<JsonVariantConst>(), &r));
  TEST_ASSERT_EQUAL_UINT32(7, r.nonce);
  TEST_ASSERT_EQUAL_UINT32(1234, r.size);
  TEST_ASSERT_EQUAL_UINT32(1800000000UL, r.untilEpochSec);
  TEST_ASSERT_EQUAL_STRING("v1", r.version);
  TEST_ASSERT_EQUAL_STRING("firmware/v1/firmware.bin", r.path);
}

static void test_parse_lowercases_md5() {
  // Update.end() compares md5 hex case-sensitively against lowercase.
  JsonDocument doc;
  deserializeJson(doc,
                  "{\"n\":7,\"version\":\"v1\",\"path\":\"firmware/v1/firmware.bin\","
                  "\"md5\":\"0123456789ABCDEF0123456789ABCDEF\",\"size\":1234}");
  OtaRequest r;
  TEST_ASSERT_TRUE(parseOtaRequest(doc.as<JsonVariantConst>(), &r));
  TEST_ASSERT_EQUAL_STRING("0123456789abcdef0123456789abcdef", r.md5);
}

static void test_parse_rejects_missing_fields() {
  JsonDocument doc;
  deserializeJson(doc, "{\"n\":7,\"version\":\"v1\",\"size\":1234}");
  OtaRequest r;
  TEST_ASSERT_FALSE(parseOtaRequest(doc.as<JsonVariantConst>(), &r));
}

static void test_parse_rejects_overlong_path_instead_of_truncating() {
  // A truncated path would fetch a DIFFERENT object; refuse outright.
  std::string longPath(200, 'a');
  std::string json = "{\"n\":1,\"version\":\"v\",\"md5\":\"x\",\"size\":1,\"path\":\"" +
                     longPath + "\"}";
  JsonDocument doc;
  deserializeJson(doc, json);
  OtaRequest r;
  TEST_ASSERT_FALSE(parseOtaRequest(doc.as<JsonVariantConst>(), &r));
}

static void test_parse_rejects_non_object() {
  JsonDocument doc;
  deserializeJson(doc, "true");
  OtaRequest r;
  TEST_ASSERT_FALSE(parseOtaRequest(doc.as<JsonVariantConst>(), &r));
}

// ---- validation -----------------------------------------------------------

static void test_valid_request_is_accepted() {
  TEST_ASSERT_EQUAL(OtaVerdict::Accept, decide(validRequest()));
}

static void test_path_outside_firmware_prefix_is_rejected() {
  // /commands is writable by any signed-in user; only firmware/ is
  // admin-SDK-only in storage.rules, so nothing else may be fetched.
  OtaRequest r = validRequest();
  std::strcpy(r.path, "proj/snapshots/x.bin");
  TEST_ASSERT_EQUAL(OtaVerdict::BadRequest, decide(r));
}

static void test_path_traversal_is_rejected() {
  OtaRequest r = validRequest();
  std::strcpy(r.path, "firmware/../proj/snapshots/x.bin");
  TEST_ASSERT_EQUAL(OtaVerdict::BadRequest, decide(r));
}

static void test_bad_md5_is_rejected() {
  OtaRequest r = validRequest();
  std::strcpy(r.md5, "not-a-hash");
  TEST_ASSERT_EQUAL(OtaVerdict::BadRequest, decide(r));
  std::strcpy(r.md5, "0123456789abcdef0123456789abcdeg");  // 'g'
  TEST_ASSERT_EQUAL(OtaVerdict::BadRequest, decide(r));
}

static void test_image_larger_than_app_slot_is_rejected() {
  OtaRequest r = validRequest();
  r.size = kOtaMaxImageBytes + 1;
  TEST_ASSERT_EQUAL(OtaVerdict::BadRequest, decide(r));
  r.size = 0;
  TEST_ASSERT_EQUAL(OtaVerdict::BadRequest, decide(r));
}

static void test_unsafe_version_characters_are_rejected() {
  OtaRequest r = validRequest();
  std::strcpy(r.version, "v1/../x");
  TEST_ASSERT_EQUAL(OtaVerdict::BadRequest, decide(r));
}

// ---- decision -------------------------------------------------------------

static void test_already_handled_nonce_is_ignored_even_if_invalid() {
  // After the reboot it caused, the command is still in RTDB. It must be
  // silently skipped, not re-reported under some other verdict.
  OtaRequest r = validRequest();
  r.size = 0;
  TEST_ASSERT_EQUAL(OtaVerdict::AlreadyHandled,
                    otaDecide(r, true, 42, "x", 1800000000UL, false, false));
}

static void test_rolled_back_image_does_not_reinstall_same_command() {
  // The scenario NVS persistence exists for: new image fails, bootloader
  // reverts, the old image polls the SAME command — it must not loop.
  OtaRequest r = validRequest();
  TEST_ASSERT_EQUAL(OtaVerdict::AlreadyHandled,
                    otaDecide(r, true, r.nonce, "2026.10.01-0900-0000000",
                              1800000000UL, false, false));
}

static void test_expired_command_is_refused() {
  OtaRequest r = validRequest();
  r.untilEpochSec = 1700000000UL;
  TEST_ASSERT_EQUAL(OtaVerdict::Expired, decide(r));
}

static void test_deadline_ignored_before_ntp_sync() {
  OtaRequest r = validRequest();
  r.untilEpochSec = 1700000000UL;
  TEST_ASSERT_EQUAL(OtaVerdict::Accept, decide(r, "old", /*now=*/50));
}

static void test_same_version_is_not_reinstalled() {
  OtaRequest r = validRequest();
  TEST_ASSERT_EQUAL(OtaVerdict::SameVersion, decide(r, r.version));
}

static void test_refused_while_siren_busy() {
  TEST_ASSERT_EQUAL(OtaVerdict::SirenActive,
                    decide(validRequest(), "old", 1800000000UL, /*siren=*/true));
}

static void test_refused_while_another_update_runs() {
  TEST_ASSERT_EQUAL(OtaVerdict::Busy,
                    decide(validRequest(), "old", 1800000000UL, false, /*busy=*/true));
}

// ---- boot classification and verification ---------------------------------

static void test_boot_without_pending_update_is_normal() {
  TEST_ASSERT_EQUAL(OtaBootKind::Normal, classifyOtaBoot("", "v2"));
  TEST_ASSERT_EQUAL(OtaBootKind::Normal, classifyOtaBoot(nullptr, "v2"));
}

static void test_boot_into_pending_version_is_verifying() {
  TEST_ASSERT_EQUAL(OtaBootKind::Verifying, classifyOtaBoot("v2", "v2"));
}

static void test_boot_into_other_version_means_rolled_back() {
  TEST_ASSERT_EQUAL(OtaBootKind::RolledBack, classifyOtaBoot("v2", "v1"));
}

static void test_verify_waits_for_min_uptime_even_when_healthy() {
  TEST_ASSERT_EQUAL(OtaVerifyAction::Wait, otaVerifyStep(5000, true));
  TEST_ASSERT_EQUAL(OtaVerifyAction::MarkValid,
                    otaVerifyStep(kOtaVerifyMinUptimeMs, true));
}

static void test_verify_rolls_back_after_timeout_without_health() {
  TEST_ASSERT_EQUAL(OtaVerifyAction::Wait,
                    otaVerifyStep(kOtaVerifyTimeoutMs - 1, false));
  TEST_ASSERT_EQUAL(OtaVerifyAction::RollBack,
                    otaVerifyStep(kOtaVerifyTimeoutMs, false));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_full_command);
  RUN_TEST(test_parse_lowercases_md5);
  RUN_TEST(test_parse_rejects_missing_fields);
  RUN_TEST(test_parse_rejects_overlong_path_instead_of_truncating);
  RUN_TEST(test_parse_rejects_non_object);
  RUN_TEST(test_valid_request_is_accepted);
  RUN_TEST(test_path_outside_firmware_prefix_is_rejected);
  RUN_TEST(test_path_traversal_is_rejected);
  RUN_TEST(test_bad_md5_is_rejected);
  RUN_TEST(test_image_larger_than_app_slot_is_rejected);
  RUN_TEST(test_unsafe_version_characters_are_rejected);
  RUN_TEST(test_already_handled_nonce_is_ignored_even_if_invalid);
  RUN_TEST(test_rolled_back_image_does_not_reinstall_same_command);
  RUN_TEST(test_expired_command_is_refused);
  RUN_TEST(test_deadline_ignored_before_ntp_sync);
  RUN_TEST(test_same_version_is_not_reinstalled);
  RUN_TEST(test_refused_while_siren_busy);
  RUN_TEST(test_refused_while_another_update_runs);
  RUN_TEST(test_boot_without_pending_update_is_normal);
  RUN_TEST(test_boot_into_pending_version_is_verifying);
  RUN_TEST(test_boot_into_other_version_means_rolled_back);
  RUN_TEST(test_verify_waits_for_min_uptime_even_when_healthy);
  RUN_TEST(test_verify_rolls_back_after_timeout_without_health);
  return UNITY_END();
}
