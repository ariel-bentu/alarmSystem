#include <unity.h>
#include "dvrip_protocol.h"
#include <cstring>

void test_sofia_hash_empty_password_vector() {
  char out[9] = {};
  Dvrip::sofiaHash("", out);
  // Documented Xiongmai vector: "" -> "tlJwpbo6"
  TEST_ASSERT_EQUAL_STRING("tlJwpbo6", out);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_sofia_hash_empty_password_vector);
  UNITY_END();
}
void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
