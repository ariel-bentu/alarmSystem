#include <unity.h>
#include "alarm_state.h"

void test_immediate_condition_fires_on_first_event() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0; // immediate

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000));
}

void test_unknown_sensor_never_fires() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("FFFFFF", 1000));
}

void test_disarmed_ordinary_condition_never_fires() {
  Config config;
  config.armed = false;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000));
}

void test_disarmed_always_condition_fires() {
  Config config;
  config.armed = false;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;
  config.sensors[0].conditions[0].always = true;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000));
}

void test_armed_always_condition_still_fires() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;
  config.sensors[0].conditions[0].always = true;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000));
}

// An always condition on one sensor must not make an ordinary condition on
// a DIFFERENT sensor fire while disarmed.
void test_disarmed_always_does_not_leak_to_other_sensors() {
  Config config;
  config.armed = false;
  config.sensorCount = 2;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;
  config.sensors[0].conditions[0].always = true;
  strcpy(config.sensors[1].rfId, "D4E5F6");
  config.sensors[1].conditionCount = 1;
  config.sensors[1].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000));
  TEST_ASSERT_FALSE(state.onSensorEvent("D4E5F6", 1000));
}

// Disarmed, an ordinary count_in_window must accumulate NO history, so
// arming later does not inherit a backlog of stale triggers.
void test_disarmed_ordinary_accumulates_no_history() {
  Config config;
  config.armed = false;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1; // count_in_window
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 60;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000));
  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 2000));

  // Arm now: the two disarmed events must not count toward the threshold,
  // so the next single event is the FIRST, not the third.
  config.armed = true;
  state.setConfig(config);
  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 3000));
}

void test_count_in_window_requires_n_triggers_within_w() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1; // count_in_window
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 30;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000));       // 1st, not enough
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 5000));        // 2nd, within 30s window -> fires
}

void test_count_in_window_resets_outside_window() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1;
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 30;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000));
  // 2nd trigger arrives 40s later -> outside the 30s window, window resets
  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 41000));
}

void test_entry_delay_does_not_fire_immediately_but_ticks_true_after_delay() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 2; // entry_delay
  config.sensors[0].conditions[0].y = 30;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000)); // starts countdown, no immediate fire
  TEST_ASSERT_FALSE(state.tickEntryDelay(20000));          // still within delay
  TEST_ASSERT_TRUE(state.tickEntryDelay(31001));           // delay expired -> fires once
  TEST_ASSERT_FALSE(state.tickEntryDelay(40000));          // already fired, no repeat
}

void test_entry_delay_disarm_cancels_pending_fire() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 2;
  config.sensors[0].conditions[0].y = 30;

  AlarmState state;
  state.setConfig(config);

  state.onSensorEvent("A1B2C3", 1000);
  state.disarm();
  TEST_ASSERT_FALSE(state.tickEntryDelay(31001)); // cancelled, never fires
}

void test_multi_sensor_requires_all_participants_within_window() {
  Config config;
  config.armed = true;
  config.sensorCount = 2;
  strcpy(config.sensors[0].rfId, "AA11BB");
  strcpy(config.sensors[1].rfId, "CC22DD");

  Condition cond;
  cond.t = 3; // multi_sensor
  cond.w = 60;
  cond.kLen = 2;
  cond.kIndex[0] = 0; cond.kCount[0] = 2; // AA11BB needs 2 triggers
  cond.kIndex[1] = 1; cond.kCount[1] = 1; // CC22DD needs 1 trigger

  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0] = cond;
  config.sensors[1].conditionCount = 1;
  config.sensors[1].conditions[0] = cond;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("AA11BB", 1000)); // AA11BB: 1/2
  TEST_ASSERT_FALSE(state.onSensorEvent("CC22DD", 2000)); // CC22DD: 1/1, but AA11BB still 1/2
  TEST_ASSERT_TRUE(state.onSensorEvent("AA11BB", 3000));  // AA11BB: 2/2, CC22DD: 1/1 -> fires
}

// --- Trigger cause reporting ---
// The cause travels to the cloud as /{projectId}/state/alarm_cause so the
// Telegram alert can name what fired. See functions/src/alarmCause.ts.

void test_cause_reports_rfid_and_condition_type_on_immediate() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0; // immediate

  AlarmState state;
  state.setConfig(config);

  TriggerCause cause;
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000, &cause));
  TEST_ASSERT_EQUAL_STRING("A1B2C3", cause.rfId);
  TEST_ASSERT_EQUAL_UINT8(0, cause.conditionType);
}

void test_cause_untouched_when_nothing_fires() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1; // count_in_window
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 60;

  AlarmState state;
  state.setConfig(config);

  TriggerCause cause;
  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000, &cause));
  TEST_ASSERT_EQUAL_STRING("", cause.rfId);
}

void test_cause_reports_count_in_window_on_the_firing_event() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "AA11BB");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1; // count_in_window
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 60;

  AlarmState state;
  state.setConfig(config);

  TriggerCause cause;
  TEST_ASSERT_FALSE(state.onSensorEvent("AA11BB", 1000, &cause));
  TEST_ASSERT_TRUE(state.onSensorEvent("AA11BB", 2000, &cause));
  TEST_ASSERT_EQUAL_STRING("AA11BB", cause.rfId);
  TEST_ASSERT_EQUAL_UINT8(1, cause.conditionType);
}

void test_cause_reported_by_entry_delay_tick() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 2; // entry_delay
  config.sensors[0].conditions[0].y = 30;

  AlarmState state;
  state.setConfig(config);

  TriggerCause cause;
  TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000, &cause));
  TEST_ASSERT_FALSE(state.tickEntryDelay(20000, &cause));
  TEST_ASSERT_TRUE(state.tickEntryDelay(31000, &cause));
  TEST_ASSERT_EQUAL_STRING("A1B2C3", cause.rfId);
  TEST_ASSERT_EQUAL_UINT8(2, cause.conditionType);
}

void test_null_cause_pointer_is_safe() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].rfId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  // Existing callers pass no cause at all; that must keep working.
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000, nullptr));
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 2000));
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_immediate_condition_fires_on_first_event);
  RUN_TEST(test_unknown_sensor_never_fires);
  RUN_TEST(test_disarmed_ordinary_condition_never_fires);
  RUN_TEST(test_disarmed_always_condition_fires);
  RUN_TEST(test_armed_always_condition_still_fires);
  RUN_TEST(test_disarmed_always_does_not_leak_to_other_sensors);
  RUN_TEST(test_disarmed_ordinary_accumulates_no_history);
  RUN_TEST(test_count_in_window_requires_n_triggers_within_w);
  RUN_TEST(test_count_in_window_resets_outside_window);
  RUN_TEST(test_entry_delay_does_not_fire_immediately_but_ticks_true_after_delay);
  RUN_TEST(test_entry_delay_disarm_cancels_pending_fire);
  RUN_TEST(test_multi_sensor_requires_all_participants_within_window);
  RUN_TEST(test_cause_reports_rfid_and_condition_type_on_immediate);
  RUN_TEST(test_cause_untouched_when_nothing_fires);
  RUN_TEST(test_cause_reports_count_in_window_on_the_firing_event);
  RUN_TEST(test_cause_reported_by_entry_delay_tick);
  RUN_TEST(test_null_cause_pointer_is_safe);
  UNITY_END();
}

void loop() {}

int main(int argc, char** argv) {
  setup();
  return 0;
}
