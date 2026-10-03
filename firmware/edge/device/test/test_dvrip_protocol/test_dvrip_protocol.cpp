#include <unity.h>
#include "dvrip_protocol.h"
#include <cstring>

void test_sofia_hash_empty_password_vector() {
  char out[9] = {};
  Dvrip::sofiaHash("", out);
  // Documented Xiongmai vector: "" -> "tlJwpbo6"
  TEST_ASSERT_EQUAL_STRING("tlJwpbo6", out);
}

void test_build_frame_header_layout() {
  uint8_t buf[64] = {};
  size_t n = Dvrip::buildFrame(/*msgId=*/1000, "{}", /*session=*/0, buf, sizeof(buf));
  TEST_ASSERT_EQUAL_UINT8(0xFF, buf[0]);
  // msgId at bytes 14..15 little-endian
  TEST_ASSERT_EQUAL_UINT8(0xE8, buf[14]); // 1000 = 0x03E8
  TEST_ASSERT_EQUAL_UINT8(0x03, buf[15]);
  // body len at 16..19 LE = strlen("{}") + 2 (0x0a 0x00) = 4
  TEST_ASSERT_EQUAL_UINT8(0x04, buf[16]);
  // total written = 20 + 4
  TEST_ASSERT_EQUAL_UINT32(24u, n);
  // trailer
  TEST_ASSERT_EQUAL_UINT8(0x0a, buf[22]);
  TEST_ASSERT_EQUAL_UINT8(0x00, buf[23]);
}

void test_build_frame_rejects_small_buffer() {
  uint8_t buf[8] = {};
  TEST_ASSERT_EQUAL_UINT32(0u, Dvrip::buildFrame(1000, "{}", 0, buf, sizeof(buf)));
}

void test_login_body_contains_user_and_hash() {
  char body[256];
  Dvrip::loginBody("someuser", "tlJwpbo6", body, sizeof(body));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"UserName\" : \"someuser\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"PassWord\" : \"tlJwpbo6\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"EncryptType\" : \"MD5\""));
}

void test_snap_body_contains_channel() {
  char body[160];
  Dvrip::snapBody(/*channel=*/2, "0x1", body, sizeof(body));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"Channel\" : 2"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"Name\" : \"OPSNAP\""));
}

void test_parse_header_reads_fields() {
  uint8_t buf[20] = {};
  buf[0] = 0xFF;
  buf[4] = 0x5F; // session 0x5F
  buf[14] = 0x19;
  buf[15] = 0x06; // msgId 1561
  buf[16] = 0x10; // bodyLen 16
  Dvrip::Header h = Dvrip::parseHeader(buf, sizeof(buf));
  TEST_ASSERT_TRUE(h.ok);
  TEST_ASSERT_EQUAL_UINT16(1561, h.msgId);
  TEST_ASSERT_EQUAL_UINT32(0x5F, h.sessionId);
  TEST_ASSERT_EQUAL_UINT32(16, h.bodyLen);
}

void test_parse_header_rejects_short() {
  uint8_t buf[10] = {};
  TEST_ASSERT_FALSE(Dvrip::parseHeader(buf, sizeof(buf)).ok);
}

void test_login_ret_and_session() {
  const char* body =
    "{ \"Ret\" : 100, \"SessionID\" : \"0x0000007B\" }";
  TEST_ASSERT_EQUAL_INT(100, Dvrip::loginRet(body));
  char sid[16] = {};
  TEST_ASSERT_NOT_NULL(Dvrip::sessionIdFromLogin(body, sid));
  TEST_ASSERT_EQUAL_STRING("0x0000007B", sid);
}

void test_is_jpeg_true_and_false() {
  uint8_t jpeg[4] = {0xFF, 0xD8, 0x12, 0x34};
  uint8_t notjpeg[4] = {'{', '"', 'R', 'e'};
  TEST_ASSERT_TRUE(Dvrip::isJpeg(jpeg, 4));
  TEST_ASSERT_FALSE(Dvrip::isJpeg(notjpeg, 4));
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_sofia_hash_empty_password_vector);
  RUN_TEST(test_build_frame_header_layout);
  RUN_TEST(test_build_frame_rejects_small_buffer);
  RUN_TEST(test_login_body_contains_user_and_hash);
  RUN_TEST(test_snap_body_contains_channel);
  RUN_TEST(test_parse_header_reads_fields);
  RUN_TEST(test_parse_header_rejects_short);
  RUN_TEST(test_login_ret_and_session);
  RUN_TEST(test_is_jpeg_true_and_false);
  UNITY_END();
}
void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
