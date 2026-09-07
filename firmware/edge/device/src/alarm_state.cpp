#include "alarm_state.h"

void AlarmState::setConfig(const Config& config) {
  config_ = config;
  memset(runtime_, 0, sizeof(runtime_));
}

int AlarmState::findSensorIndex(const char* rfId) const {
  for (uint8_t i = 0; i < config_.sensorCount; i++) {
    if (strcmp(config_.sensors[i].rfId, rfId) == 0) return i;
  }
  return -1;
}

bool AlarmState::multiSensorSatisfied(const Condition& cond, unsigned long nowMs) {
  // How many participants must be satisfied. 0 (or a nonsensical value larger
  // than the participant list) means all of them — the original AND.
  uint8_t required_quorum =
      (cond.q == 0 || cond.q > cond.kLen) ? cond.kLen : cond.q;
  uint8_t satisfied = 0;

  for (uint8_t p = 0; p < cond.kLen; p++) {
    uint8_t participantIndex = cond.kIndex[p];
    uint16_t required = cond.kCount[p];

    // Find this participant's own runtime state for the matching
    // multi_sensor condition (same t/w/q/kLen — participants carry identical
    // condition copies per the config format).
    uint8_t matchedConditionIdx = 255;
    for (uint8_t ci = 0; ci < config_.sensors[participantIndex].conditionCount; ci++) {
      const Condition& c = config_.sensors[participantIndex].conditions[ci];
      if (c.t == 3 && c.w == cond.w && c.kLen == cond.kLen && c.q == cond.q) {
        matchedConditionIdx = ci;
        break;
      }
    }
    // A participant with no matching condition simply cannot be satisfied.
    // `continue`, NOT `return false`: under a quorum the remaining sensors
    // can still reach it on their own, and aborting here would let one
    // missing participant veto a rule that does not require it.
    if (matchedConditionIdx == 255) continue;

    ConditionRuntime& rt = runtime_[participantIndex][matchedConditionIdx];
    uint8_t countInWindow = 0;
    for (uint8_t h = 0; h < rt.triggerCount; h++) {
      if (nowMs - rt.triggerTimesMs[h] <= (unsigned long)cond.w * 1000UL) {
        countInWindow++;
      }
    }
    if (countInWindow < required) continue;

    // Counted per PARTICIPANT, not per trigger: repeated triggers on one
    // sensor satisfy that sensor once and never add to the quorum.
    if (++satisfied >= required_quorum) return true;
  }
  return false;
}

// Append a trigger, evicting the OLDEST entry when the buffer is full.
//
// Callers prune stale entries first, so a full buffer here means all 8 are
// still inside the window. The previous code simply skipped the append in
// that case, silently discarding the NEWEST trigger — precisely the one a
// window check cares about, since it is the most recent timestamp that keeps
// a sensor satisfied as older entries age out. A sensor triggering more than
// 8 times inside its window (a chattering reed switch, a long window) would
// stop recording, and could then fail to corroborate a genuine multi-sensor
// alarm.
//
// Dropping the oldest is strictly better: the count is capped at 8 either
// way, and any kCount above 8 is unsatisfiable regardless.
void AlarmState::recordTrigger(ConditionRuntime& rt, unsigned long nowMs) {
  if (rt.triggerCount < kMaxTriggerHistory) {
    rt.triggerTimesMs[rt.triggerCount++] = nowMs;
    return;
  }
  for (uint8_t h = 1; h < kMaxTriggerHistory; h++) {
    rt.triggerTimesMs[h - 1] = rt.triggerTimesMs[h];
  }
  rt.triggerTimesMs[kMaxTriggerHistory - 1] = nowMs;
}

bool AlarmState::evaluateCondition(uint8_t sensorIndex, uint8_t conditionIndex, unsigned long nowMs) {
  const Condition& cond = config_.sensors[sensorIndex].conditions[conditionIndex];
  ConditionRuntime& rt = runtime_[sensorIndex][conditionIndex];

  switch (cond.t) {
    case 0: // immediate
      return true;

    case 1: { // count_in_window
      // Drop history outside the window, then record this trigger.
      unsigned long windowMs = (unsigned long)cond.w * 1000UL;
      uint8_t kept = 0;
      for (uint8_t h = 0; h < rt.triggerCount; h++) {
        if (nowMs - rt.triggerTimesMs[h] <= windowMs) {
          rt.triggerTimesMs[kept++] = rt.triggerTimesMs[h];
        }
      }
      rt.triggerCount = kept;
      recordTrigger(rt, nowMs);
      return rt.triggerCount >= cond.n;
    }

    case 2: // entry_delay
      if (!rt.entryDelayPending && !rt.entryDelayFired) {
        rt.entryDelayPending = true;
        rt.entryDelayDeadlineMs = nowMs + (unsigned long)cond.y * 1000UL;
      }
      return false; // never fires immediately; tickEntryDelay handles expiry

    case 3: { // multi_sensor
      unsigned long windowMs = (unsigned long)cond.w * 1000UL;
      uint8_t kept = 0;
      for (uint8_t h = 0; h < rt.triggerCount; h++) {
        if (nowMs - rt.triggerTimesMs[h] <= windowMs) {
          rt.triggerTimesMs[kept++] = rt.triggerTimesMs[h];
        }
      }
      rt.triggerCount = kept;
      recordTrigger(rt, nowMs);
      return multiSensorSatisfied(cond, nowMs);
    }

    default:
      return false;
  }
}

bool AlarmState::onSensorEvent(const char* rfId, unsigned long nowMs,
                               TriggerCause* cause) {
  int sensorIndex = findSensorIndex(rfId);
  if (sensorIndex < 0) return false;

  const SensorConfig& sensor = config_.sensors[sensorIndex];
  for (uint8_t c = 0; c < sensor.conditionCount; c++) {
    // Disarmed no longer means "evaluate nothing": always-conditions (smoke,
    // gas) fire regardless. `continue` rather than an early return is what
    // keeps ordinary conditions from accumulating trigger history while
    // disarmed — evaluateCondition records history as a side effect of being
    // called, so skipping the call is what preserves today's behaviour.
    if (!config_.armed && !sensor.conditions[c].always) continue;

    if (evaluateCondition((uint8_t)sensorIndex, c, nowMs)) {
      if (cause) {
        strncpy(cause->rfId, sensor.rfId, sizeof(cause->rfId) - 1);
        cause->rfId[sizeof(cause->rfId) - 1] = '\0';
        cause->conditionType = sensor.conditions[c].t;
      }
      return true;
    }
  }
  return false;
}

bool AlarmState::tickEntryDelay(unsigned long nowMs, TriggerCause* cause) {
  for (uint8_t s = 0; s < config_.sensorCount; s++) {
    for (uint8_t c = 0; c < config_.sensors[s].conditionCount; c++) {
      if (config_.sensors[s].conditions[c].t != 2) continue;
      ConditionRuntime& rt = runtime_[s][c];
      if (rt.entryDelayPending && !rt.entryDelayFired && nowMs >= rt.entryDelayDeadlineMs) {
        rt.entryDelayFired = true;
        rt.entryDelayPending = false;
        if (cause) {
          strncpy(cause->rfId, config_.sensors[s].rfId, sizeof(cause->rfId) - 1);
          cause->rfId[sizeof(cause->rfId) - 1] = '\0';
          cause->conditionType = 2;
        }
        return true;
      }
    }
  }
  return false;
}

void AlarmState::disarm() {
  config_.armed = false;
  for (uint8_t s = 0; s < config_.sensorCount; s++) {
    for (uint8_t c = 0; c < config_.sensors[s].conditionCount; c++) {
      runtime_[s][c].entryDelayPending = false;
    }
  }
}
