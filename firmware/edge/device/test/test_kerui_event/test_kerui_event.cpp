#include <unity.h>

#include "kerui_event.h"

// The nibble->event table, and the 20/4 split of a Kerui code. Every entry
// here is the firmware half of a table duplicated in functions/ and web/;
// the cloud suite asserts the three agree by value.

static void test_trigger_nibbles() {
  // 0xA motion and 0xE door-open are rtl_433's, confirmed by our own census.
  TEST_ASSERT_EQUAL(KeruiEvent::TRIGGER, keruiEventOf(0xA));
  TEST_ASSERT_EQUAL(KeruiEvent::TRIGGER, keruiEventOf(0xE));
  // 0x9 is ours: beam cut on four curtain sensors AND door-open on family
  // 0x2E5B7. Ambiguous as a TYPE, unambiguous as "primary alarm event".
  TEST_ASSERT_EQUAL(KeruiEvent::TRIGGER, keruiEventOf(0x9));
}

static void test_both_close_nibbles() {
  // Two close codes, both real: 0x3 is this house's, 0x7 is rtl_433's. The
  // clearest single proof that no Kerui-wide table exists.
  TEST_ASSERT_EQUAL(KeruiEvent::CLOSE, keruiEventOf(0x3));
  TEST_ASSERT_EQUAL(KeruiEvent::CLOSE, keruiEventOf(0x7));
}

static void test_tamper_water_battery() {
  TEST_ASSERT_EQUAL(KeruiEvent::TAMPER, keruiEventOf(0xB));
  TEST_ASSERT_EQUAL(KeruiEvent::WATER, keruiEventOf(0x5));
  TEST_ASSERT_EQUAL(KeruiEvent::BATTERY_LOW, keruiEventOf(0xF));
}

static void test_unknown_nibbles() {
  // 0x2 is the smoke detector's, which has never fired in 3,089 events, so
  // it is unverified and maps to UNKNOWN. Callers must route UNKNOWN to a
  // trigger — see test_unknown_reports_as_trigger.
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(0x2));
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(0x0));
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(0x1));
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(0x4));
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(0x6));
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(0x8));
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(0xC));
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(0xD));
}

static void test_high_bits_are_masked_off() {
  // Callers pass the low nibble, but a whole byte must not change the
  // answer — a caller that forgets to mask gets the same result.
  TEST_ASSERT_EQUAL(KeruiEvent::TAMPER, keruiEventOf(0x1B));
  TEST_ASSERT_EQUAL(KeruiEvent::TRIGGER, keruiEventOf(0xFA));
}

static void test_unknown_reports_as_trigger() {
  // The smoke detector's always-rule depends on this: 0x2 is unverified, and
  // a silently-dropped smoke alarm is the worst outcome of this refactor.
  TEST_ASSERT_EQUAL_STRING("trigger", keruiEventName(KeruiEvent::UNKNOWN));
  TEST_ASSERT_EQUAL_STRING("trigger", keruiEventName(KeruiEvent::TRIGGER));
}

static void test_event_names() {
  // These strings are the wire format written to /events/{rfId}/{ts}.event
  // and read back by onSensorEvent.ts. Changing one breaks the cloud.
  TEST_ASSERT_EQUAL_STRING("close", keruiEventName(KeruiEvent::CLOSE));
  TEST_ASSERT_EQUAL_STRING("tamper", keruiEventName(KeruiEvent::TAMPER));
  TEST_ASSERT_EQUAL_STRING("water", keruiEventName(KeruiEvent::WATER));
  TEST_ASSERT_EQUAL_STRING("battery_low",
                           keruiEventName(KeruiEvent::BATTERY_LOW));
}

static void test_family_split() {
  // The whole design in one assertion: 0x0061DA (motion) and 0x0061DB
  // (tamper) are ONE sensor. Today 0x0061DB matches nothing and is logged
  // as an unpaired sensor, invisible to rules and alerts.
  TEST_ASSERT_EQUAL_HEX32(0x0061D, keruiFamilyOf(0x0061DA));
  TEST_ASSERT_EQUAL_HEX32(0x0061D, keruiFamilyOf(0x0061DB));
  TEST_ASSERT_EQUAL_HEX8(0xA, keruiNibbleOf(0x0061DA));
  TEST_ASSERT_EQUAL_HEX8(0xB, keruiNibbleOf(0x0061DB));
}

static void test_family_split_real_sensors() {
  // Family 0x2E5B7 sends both codes; today it is paired on the CLOSE one.
  TEST_ASSERT_EQUAL_HEX32(0x2E5B7, keruiFamilyOf(0x2E5B73));
  TEST_ASSERT_EQUAL_HEX32(0x2E5B7, keruiFamilyOf(0x2E5B79));
  TEST_ASSERT_EQUAL(KeruiEvent::CLOSE, keruiEventOf(keruiNibbleOf(0x2E5B73)));
  TEST_ASSERT_EQUAL(KeruiEvent::TRIGGER, keruiEventOf(keruiNibbleOf(0x2E5B79)));
  // The smoke detector.
  TEST_ASSERT_EQUAL_HEX32(0xCC268, keruiFamilyOf(0xCC2682));
  TEST_ASSERT_EQUAL(KeruiEvent::UNKNOWN, keruiEventOf(keruiNibbleOf(0xCC2682)));
}

static void test_family_ignores_bits_above_24() {
  // keruiFamilyOf masks to 20 bits, so a caller that hands it a wider value
  // still gets a family that fits the "0x%05X" format used for storage.
  TEST_ASSERT_EQUAL_HEX32(0xFFFFF, keruiFamilyOf(0xFFFFFFF));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_trigger_nibbles);
  RUN_TEST(test_both_close_nibbles);
  RUN_TEST(test_tamper_water_battery);
  RUN_TEST(test_unknown_nibbles);
  RUN_TEST(test_high_bits_are_masked_off);
  RUN_TEST(test_unknown_reports_as_trigger);
  RUN_TEST(test_event_names);
  RUN_TEST(test_family_split);
  RUN_TEST(test_family_split_real_sensors);
  RUN_TEST(test_family_ignores_bits_above_24);
  return UNITY_END();
}
