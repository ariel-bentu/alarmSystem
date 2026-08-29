#pragma once

#include <cstdint>
#include <cstring>

struct Condition {
  uint8_t t = 0;
  uint16_t n = 0;
  uint16_t w = 0;
  uint16_t y = 0;
  uint8_t kIndex[8] = {};
  uint16_t kCount[8] = {};
  uint8_t kLen = 0;
};

struct SensorConfig {
  // "0xA1B2C3" = 8 chars + null = 9; sized to 11 for comfortable headroom
  // (matches the 0x-prefixed rfId format used everywhere else in the
  // system — see main.cpp's packet decode and cloud_client.cpp's
  // parseConfigJson strncpy, which uses sizeof(rfId) and picks this up
  // automatically).
  char rfId[11] = {};
  Condition conditions[4];
  uint8_t conditionCount = 0;
};

struct Config {
  bool armed = false;
  uint16_t sirenDurationSec = 0;
  // EV1527 base address this device uses to talk to its siren: top 20 bits
  // are identity, bottom nibble is the command and is always 0 here.
  // 0 means "not yet generated". Randomly generated once on first boot and
  // persisted, so a physical pairing survives reflashing.
  uint32_t sirenBaseAddress = 0;
  SensorConfig sensors[16];
  uint8_t sensorCount = 0;
};

class AlarmState {
 public:
  void setConfig(const Config& config);
  bool onSensorEvent(const char* rfId, unsigned long nowMs);
  bool tickEntryDelay(unsigned long nowMs);
  void disarm();

 private:
  static constexpr uint8_t kMaxSensors = 16;
  static constexpr uint8_t kMaxConditionsPerSensor = 4;
  static constexpr uint8_t kMaxTriggerHistory = 8;

  struct ConditionRuntime {
    unsigned long triggerTimesMs[kMaxTriggerHistory];
    uint8_t triggerCount = 0;
    bool entryDelayPending = false;
    bool entryDelayFired = false;
    unsigned long entryDelayDeadlineMs = 0;
  };

  Config config_;
  // runtime_[sensorIndex][conditionIndex]
  ConditionRuntime runtime_[kMaxSensors][kMaxConditionsPerSensor];

  int findSensorIndex(const char* rfId) const;
  bool evaluateCondition(uint8_t sensorIndex, uint8_t conditionIndex, unsigned long nowMs);
  bool multiSensorSatisfied(const Condition& cond, unsigned long nowMs);
};
