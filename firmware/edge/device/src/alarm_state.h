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
  // multi_sensor quorum: how many participants must reach their own kCount
  // inside the shared window. 0 = "all of them", which is both the historical
  // behaviour (a plain AND) and what a config written before this field
  // existed decodes to — so no migration is needed. Mirrored by quorumOf()
  // in functions/src/alarmLogic.ts; the two evaluators must agree.
  uint8_t q = 0;
  // Fires regardless of arm state (smoke, gas). Always implies a
  // single-sensor immediate condition, so it carries no runtime state.
  bool always = false;
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
  bool sirenEnabled = true; // false = never sound the siren
  // EV1527 base address this device uses to talk to its siren: top 20 bits
  // are identity, bottom nibble is the command and is always 0 here.
  // 0 means "not yet generated". Randomly generated once on first boot and
  // persisted, so a physical pairing survives reflashing.
  uint32_t sirenBaseAddress = 0;
  SensorConfig sensors[16];
  uint8_t sensorCount = 0;

  // Paired remote-control identities (TOP 20 BITS of the 24-bit code; the
  // bottom nibble is the button and is never stored). 0 = empty slot.
  //
  // Capped at 8 by the EEPROM budget, not by preference: EepromStore has
  // exactly 64 bytes of headroom and 8 remotes cost 8*4+1 = 33. Sixteen
  // would cost 65 and overflow it — see EepromStore::kReservedBytes, whose
  // size has a documented heap/stack history. Do not raise this cap without
  // reading that comment.
  static constexpr uint8_t kMaxRemotes = 8;
  uint32_t remotes[kMaxRemotes] = {};
  uint8_t remoteCount = 0;
};

// Config is persisted verbatim to EEPROM by EepromStore, so its size is part
// of the on-flash format. `always` was added into the padding that already
// followed Condition::kLen — measured 2416 bytes before and after. If this
// ever fails, bump EepromStore::kMagic so stale config is discarded rather
// than misread as the new layout.
// Was 2416 before `remotes`/`remoteCount` were added (8 * uint32_t + uint8_t
// + 3 bytes trailing padding = 36). Measured, not predicted.
// 2452 -> 2580 when Condition::q (multi_sensor quorum) was added. Unlike
// `always`, q did NOT fit in existing padding: Condition was exactly 34 bytes
// with none spare, so it grew to 36 — times 4 conditions * 16 sensors = 128.
static_assert(sizeof(Config) == 2580, "EEPROM layout changed - bump kMagic");

// What tripped the alarm, reported to the cloud as state/alarm_cause so the
// Telegram alert can name it. The device knows rfIds, not sensor or rule
// *names* — onAlarm resolves those (see functions/src/alarmCause.ts).
struct TriggerCause {
  char rfId[11] = {};      // sensor that fired; empty when nothing fired
  uint8_t conditionType = 0;  // Condition::t of the condition that tripped
};

class AlarmState {
 public:
  void setConfig(const Config& config);
  // cause: optional out-param, written only when the call returns true.
  bool onSensorEvent(const char* rfId, unsigned long nowMs,
                     TriggerCause* cause = nullptr);
  bool tickEntryDelay(unsigned long nowMs, TriggerCause* cause = nullptr);
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
  // Append a trigger timestamp, evicting the oldest when full rather than
  // dropping the newest. See the definition for why that distinction matters.
  static void recordTrigger(ConditionRuntime& rt, unsigned long nowMs);
};
