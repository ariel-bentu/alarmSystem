#include <unity.h>
#include "alarm_state.h"

void test_immediate_condition_fires_on_first_event() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;
  config.sensors[0].conditions[0].always = true;
  strcpy(config.sensors[1].familyId, "D4E5F6");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "AA11BB");
  strcpy(config.sensors[1].familyId, "CC22DD");

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

// --- Multi-sensor quorum ("2 of 3") ---
// cond.q = how many participants must reach their own count inside the shared
// window. 0 means "all", so every rule predating the field keeps its AND
// behaviour. Mirrored by quorumOf() in functions/src/alarmLogic.ts — the two
// evaluators MUST agree, or the device and the server disagree about whether
// the house is in alarm.

// Build a 3-sensor multi_sensor condition; each sensor needs `perSensor`
// triggers and `quorum` of the three must reach it.
static Config makeQuorumConfig(uint8_t quorum, uint16_t perSensorA = 1) {
  Config config;
  config.armed = true;
  config.sensorCount = 3;
  strcpy(config.sensors[0].familyId, "AA0001");
  strcpy(config.sensors[1].familyId, "BB0002");
  strcpy(config.sensors[2].familyId, "CC0003");

  Condition cond;
  cond.t = 3; // multi_sensor
  cond.w = 60;
  cond.q = quorum;
  cond.kLen = 3;
  cond.kIndex[0] = 0; cond.kCount[0] = perSensorA;
  cond.kIndex[1] = 1; cond.kCount[1] = 1;
  cond.kIndex[2] = 2; cond.kCount[2] = 1;

  // Every participant carries an identical copy — see buildConfig pass 2.
  for (uint8_t i = 0; i < 3; i++) {
    config.sensors[i].conditionCount = 1;
    config.sensors[i].conditions[0] = cond;
  }
  return config;
}

void test_quorum_fires_when_two_of_three_are_satisfied() {
  AlarmState state;
  state.setConfig(makeQuorumConfig(2));

  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 1000)); // 1 of 2 satisfied
  TEST_ASSERT_TRUE(state.onSensorEvent("BB0002", 2000));  // 2 of 2 -> fires
}

void test_quorum_does_not_fire_with_only_one_satisfied() {
  AlarmState state;
  state.setConfig(makeQuorumConfig(2));

  // Repeat triggers on ONE sensor: a quorum counts distinct satisfied
  // sensors, so piling onto a single one must never reach 2 of 3.
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 1000));
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 2000));
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 3000));
}

void test_quorum_respects_per_sensor_counts() {
  // A needs 2 triggers; one trigger leaves it UNsatisfied, so A(1) + B(1) is
  // only one satisfied sensor, not two.
  AlarmState state;
  state.setConfig(makeQuorumConfig(2, /*perSensorA=*/2));

  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 1000)); // A 1/2 — not satisfied
  TEST_ASSERT_FALSE(state.onSensorEvent("BB0002", 2000)); // B 1/1 — only 1 satisfied
  TEST_ASSERT_TRUE(state.onSensorEvent("AA0001", 3000));  // A 2/2 -> 2 satisfied
}

void test_quorum_zero_means_all_participants() {
  // q = 0 is what a config written before this field looked like.
  AlarmState state;
  state.setConfig(makeQuorumConfig(0));

  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 1000));
  TEST_ASSERT_FALSE(state.onSensorEvent("BB0002", 2000));
  TEST_ASSERT_TRUE(state.onSensorEvent("CC0003", 3000)); // all three -> fires
}

void test_quorum_ignores_participants_outside_the_window() {
  AlarmState state;
  state.setConfig(makeQuorumConfig(2));

  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 1000));
  // 61s later: A has aged out of the 60s window, so B alone is 1 of 2.
  TEST_ASSERT_FALSE(state.onSensorEvent("BB0002", 62000));
}

// Reported from hardware 2026-09-07: a 10s-window rule fired on triggers
// 15-20s apart. The window must bound the SPREAD between participants, not
// just each participant's own history.
void test_quorum_does_not_fire_when_participants_are_outside_the_window() {
  Config config;
  config.armed = true;
  config.sensorCount = 3;
  strcpy(config.sensors[0].familyId, "AA0001");
  strcpy(config.sensors[1].familyId, "BB0002");
  strcpy(config.sensors[2].familyId, "CC0003");

  Condition cond;
  cond.t = 3;
  cond.w = 10;  // 10 second window
  cond.q = 2;   // 2 of 3
  cond.kLen = 3;
  cond.kIndex[0] = 0; cond.kCount[0] = 1;
  cond.kIndex[1] = 1; cond.kCount[1] = 1;
  cond.kIndex[2] = 2; cond.kCount[2] = 1;
  for (uint8_t i = 0; i < 3; i++) {
    config.sensors[i].conditionCount = 1;
    config.sensors[i].conditions[0] = cond;
  }

  AlarmState state;
  state.setConfig(config);

  // A at t=0, B at t=18s. 18s apart with a 10s window: must NOT fire.
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 1000));
  TEST_ASSERT_FALSE(state.onSensorEvent("BB0002", 19000));
}

// w=0 is what the device sees when the rule carries no window_sec: RTDB drops
// the undefined `w`, and the parser defaults it to 0. With a 0 window each
// sensor still satisfies ITSELF at the instant it fires (nowMs - nowMs == 0,
// which is <= 0), so a quorum of 2 trips on any two triggers however far
// apart — the exact "window not respected" symptom seen on hardware.
void test_zero_window_does_not_mean_unbounded() {
  Config config;
  config.armed = true;
  config.sensorCount = 3;
  strcpy(config.sensors[0].familyId, "AA0001");
  strcpy(config.sensors[1].familyId, "BB0002");
  strcpy(config.sensors[2].familyId, "CC0003");

  Condition cond;
  cond.t = 3;
  cond.w = 0;  // no window delivered
  cond.q = 2;
  cond.kLen = 3;
  cond.kIndex[0] = 0; cond.kCount[0] = 1;
  cond.kIndex[1] = 1; cond.kCount[1] = 1;
  cond.kIndex[2] = 2; cond.kCount[2] = 1;
  for (uint8_t i = 0; i < 3; i++) {
    config.sensors[i].conditionCount = 1;
    config.sensors[i].conditions[0] = cond;
  }

  AlarmState state;
  state.setConfig(config);

  // Two triggers 18s apart with NO window must not corroborate each other.
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 1000));
  TEST_ASSERT_FALSE(state.onSensorEvent("BB0002", 19000));
}

// The device does not start at millis()==0: by the time a rule is armed and
// tested, millis() is minutes-to-hours large. Guards against any arithmetic
// that only holds for small timestamps.
void test_quorum_window_holds_at_realistic_uptime() {
  Config config;
  config.armed = true;
  config.sensorCount = 3;
  strcpy(config.sensors[0].familyId, "AA0001");
  strcpy(config.sensors[1].familyId, "BB0002");
  strcpy(config.sensors[2].familyId, "CC0003");

  Condition cond;
  cond.t = 3;
  cond.w = 10;
  cond.q = 2;
  cond.kLen = 3;
  cond.kIndex[0] = 0; cond.kCount[0] = 1;
  cond.kIndex[1] = 1; cond.kCount[1] = 1;
  cond.kIndex[2] = 2; cond.kCount[2] = 1;
  for (uint8_t i = 0; i < 3; i++) {
    config.sensors[i].conditionCount = 1;
    config.sensors[i].conditions[0] = cond;
  }

  AlarmState state;
  state.setConfig(config);

  const unsigned long base = 3600000UL;  // 1 hour uptime
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", base));
  TEST_ASSERT_FALSE(state.onSensorEvent("BB0002", base + 18000));
}

// --- Trigger history overflow ---
// The history buffer holds 8 timestamps. When it is full AND nothing is stale
// (every entry still inside the window), the append used to be skipped
// outright — silently discarding the NEWEST trigger, which is the one a
// window check actually cares about. Evicting the OLDEST instead keeps the
// most recent 8, which is what both condition types need.

void test_count_in_window_keeps_newest_when_history_is_full() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].familyId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1;  // count_in_window
  config.sensors[0].conditions[0].n = 8;  // exactly the buffer size
  config.sensors[0].conditions[0].w = 300;

  AlarmState state;
  state.setConfig(config);

  // 7 triggers: not yet enough for n=8.
  for (int i = 0; i < 7; i++) {
    TEST_ASSERT_FALSE(state.onSensorEvent("A1B2C3", 1000 + i * 1000));
  }
  // 8th fills the buffer and meets the count.
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 8000));

  // 9th arrives with the buffer full and NOTHING stale (all within 300s).
  // The old guard dropped it; the count must still hold at 8 and fire.
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 9000));
}

// The damaging shape: with the buffer full of in-window entries, a trigger
// arriving LATER must still be recorded, so that once the older entries age
// out the sensor is not left with a history that stopped updating.
void test_full_history_still_records_later_triggers() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].familyId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 1;
  config.sensors[0].conditions[0].n = 2;
  config.sensors[0].conditions[0].w = 100;  // 100s window

  AlarmState state;
  state.setConfig(config);

  // Fill all 8 slots early in the window (t = 1s..8s).
  for (int i = 0; i < 8; i++) {
    state.onSensorEvent("A1B2C3", 1000 + i * 1000);
  }
  // A trigger at t=95s: buffer is full and all 8 entries are still inside
  // the 100s window, so nothing is pruned. It MUST still be recorded.
  state.onSensorEvent("A1B2C3", 95000);

  // Now jump past the original 8 (t=150s): only the t=95s entry should
  // remain in window, plus this new one -> exactly n=2 -> fires.
  // If t=95s had been dropped, this would be the only entry and NOT fire.
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 150000));
}

void test_multi_sensor_keeps_newest_when_history_is_full() {
  Config config;
  config.armed = true;
  config.sensorCount = 2;
  strcpy(config.sensors[0].familyId, "AA0001");
  strcpy(config.sensors[1].familyId, "BB0002");

  Condition cond;
  cond.t = 3;
  cond.w = 100;  // long window, so early entries stay valid
  cond.q = 0;    // all participants
  cond.kLen = 2;
  cond.kIndex[0] = 0; cond.kCount[0] = 1;
  cond.kIndex[1] = 1; cond.kCount[1] = 1;
  for (uint8_t i = 0; i < 2; i++) {
    config.sensors[i].conditionCount = 1;
    config.sensors[i].conditions[0] = cond;
  }

  AlarmState state;
  state.setConfig(config);

  // Fill A's 8 slots early (t = 1s..8s), B silent so nothing fires.
  for (int i = 0; i < 8; i++) {
    TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 1000 + i * 1000));
  }
  // A triggers again at t=95s with a full, all-in-window buffer.
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 95000));

  // At t=150s the original 8 have aged out; only the t=95s entry can keep A
  // satisfied. B now triggers -> both satisfied -> fires. If A's t=95s
  // trigger had been dropped, A would have no in-window entry and this
  // would not fire.
  TEST_ASSERT_TRUE(state.onSensorEvent("BB0002", 150000));
}

// Hardware 2026-09-07, exact timings from serial:
//   t=43.1s  0x1520FE  fire=0
//   t=43.7s  0x170D09  fire=1   <- correct: 0.6s apart, inside the 10s window
//   t=54.4s  0x170D09  fire=1   <- WRONG: both prior triggers are >10s old
// The second fire had no second sensor inside the window. 0x170D09 alone
// cannot satisfy a 2-of-3 quorum, so this must not fire.
void test_quorum_does_not_refire_once_the_partner_ages_out() {
  Config config;
  config.armed = true;
  config.sensorCount = 3;
  strcpy(config.sensors[0].familyId, "AA0001");  // 0x170D09
  strcpy(config.sensors[1].familyId, "BB0002");  // 0x1520FE
  strcpy(config.sensors[2].familyId, "CC0003");

  Condition cond;
  cond.t = 3;
  cond.w = 10;
  cond.q = 2;
  cond.kLen = 3;
  cond.kIndex[0] = 0; cond.kCount[0] = 1;
  cond.kIndex[1] = 1; cond.kCount[1] = 1;
  cond.kIndex[2] = 2; cond.kCount[2] = 1;
  for (uint8_t i = 0; i < 3; i++) {
    config.sensors[i].conditionCount = 1;
    config.sensors[i].conditions[0] = cond;
  }

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 5393));   // t=0
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 29393));  // t=24s
  TEST_ASSERT_FALSE(state.onSensorEvent("BB0002", 48517));  // t=43.1s
  TEST_ASSERT_TRUE(state.onSensorEvent("AA0001", 49110));   // t=43.7s -> fires
  // t=54.4s: BB0002 is 11.3s old, the previous AA0001 10.7s old. Nothing
  // else is inside the window, so AA0001 is alone -> must NOT fire.
  TEST_ASSERT_FALSE(state.onSensorEvent("AA0001", 59813));
}

// --- Trigger cause reporting ---
// The cause travels to the cloud as /{projectId}/state/alarm_cause so the
// Telegram alert can name what fired. See functions/src/alarmCause.ts.

void test_cause_reports_rfid_and_condition_type_on_immediate() {
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "AA11BB");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
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
  strcpy(config.sensors[0].familyId, "A1B2C3");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  // Existing callers pass no cause at all; that must keep working.
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 1000, nullptr));
  TEST_ASSERT_TRUE(state.onSensorEvent("A1B2C3", 2000));
}

// --- Family matching -------------------------------------------------
// The config now holds 20-bit FAMILIES ("0x0061D"), not full 24-bit rfIds.
// The caller does the split; these pin down that AlarmState matches on
// exactly what it is given and nothing looser.

void test_matches_a_family_whatever_event_code_arrived() {
  // The whole point: a sensor paired on its motion code (0x0061DA) must also
  // match its tamper (0x0061DB), because both reduce to family 0x0061D.
  // Callers pass the family, so this is the assertion that the config is
  // keyed by it.
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].familyId, "0x0061D");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.onSensorEvent("0x0061D", 1000));
}

void test_full_rfid_no_longer_matches_a_family_entry() {
  // Guards against a caller that forgets to split: passing the whole 24-bit
  // code must NOT match, rather than matching by accident on a prefix.
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].familyId, "0x0061D");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_FALSE(state.onSensorEvent("0x0061DA", 1000));
}

void test_is_paired_family_ignores_arm_state() {
  // The tamper path sirens while DISARMED and never goes through rule
  // evaluation, so its only question is "is this a paired sensor?" — which
  // must answer the same either way.
  Config config;
  config.armed = false;
  config.sensorCount = 1;
  strcpy(config.sensors[0].familyId, "0x0061D");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TEST_ASSERT_TRUE(state.isPairedFamily("0x0061D"));
  TEST_ASSERT_FALSE(state.isPairedFamily("0x3F010"));

  config.armed = true;
  state.setConfig(config);
  TEST_ASSERT_TRUE(state.isPairedFamily("0x0061D"));
}

void test_is_paired_family_on_an_empty_config() {
  // A device with no config yet (fresh boot, no cloud) must not siren on a
  // tamper from a sensor it has never heard of.
  Config config;
  config.sensorCount = 0;
  AlarmState state;
  state.setConfig(config);
  TEST_ASSERT_FALSE(state.isPairedFamily("0x0061D"));
}

void test_cause_reports_the_family_that_fired() {
  // TriggerCause travels to the cloud as "rfId" but now carries a FAMILY.
  // onAlarm indexes sensors under both forms so either resolves to a name.
  Config config;
  config.armed = true;
  config.sensorCount = 1;
  strcpy(config.sensors[0].familyId, "0x2E5B7");
  config.sensors[0].conditionCount = 1;
  config.sensors[0].conditions[0].t = 0;

  AlarmState state;
  state.setConfig(config);

  TriggerCause cause;
  TEST_ASSERT_TRUE(state.onSensorEvent("0x2E5B7", 1000, &cause));
  TEST_ASSERT_EQUAL_STRING("0x2E5B7", cause.rfId);
}

void setup() {
  UNITY_BEGIN();
  RUN_TEST(test_matches_a_family_whatever_event_code_arrived);
  RUN_TEST(test_full_rfid_no_longer_matches_a_family_entry);
  RUN_TEST(test_is_paired_family_ignores_arm_state);
  RUN_TEST(test_is_paired_family_on_an_empty_config);
  RUN_TEST(test_cause_reports_the_family_that_fired);
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
  RUN_TEST(test_quorum_fires_when_two_of_three_are_satisfied);
  RUN_TEST(test_quorum_does_not_fire_with_only_one_satisfied);
  RUN_TEST(test_quorum_respects_per_sensor_counts);
  RUN_TEST(test_quorum_zero_means_all_participants);
  RUN_TEST(test_quorum_ignores_participants_outside_the_window);
  RUN_TEST(test_quorum_does_not_fire_when_participants_are_outside_the_window);
  RUN_TEST(test_zero_window_does_not_mean_unbounded);
  RUN_TEST(test_quorum_window_holds_at_realistic_uptime);
  RUN_TEST(test_quorum_does_not_refire_once_the_partner_ages_out);
  RUN_TEST(test_count_in_window_keeps_newest_when_history_is_full);
  RUN_TEST(test_full_history_still_records_later_triggers);
  RUN_TEST(test_multi_sensor_keeps_newest_when_history_is_full);
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
