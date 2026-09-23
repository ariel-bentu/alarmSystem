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
  // The sensor's 20-bit FAMILY as "0x0061D" — 7 chars + null = 8.
  //
  // NOT the full 24-bit rfId any more. A Kerui packet's bottom nibble is an
  // event code, so one physical sensor sends several codes (motion 0x0061DA,
  // tamper 0x0061DB) and matching on the whole value found only the one it
  // happened to be paired on. Matching is a strcmp inside the RF path, so
  // the prefix is stored pre-computed rather than re-derived per packet.
  //
  // Sized 9, not 8: one byte of slack keeps the struct's alignment padding
  // where it was and costs nothing, since Condition[4] dominates the size.
  // cloud_client.cpp's parseConfigJson uses sizeof(familyId) and picks any
  // change up automatically.
  char familyId[9] = {};
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
// 2580 -> 2548 when SensorConfig::rfId[11] became familyId[9]: matching moved
// from the full 24-bit code to the 20-bit family. SensorConfig went 158 -> 156
// (both measured), i.e. 2 bytes x 16 sensors = 32. kMagic was bumped to
// 0xA1A2B3B9 so the old layout is discarded rather than misread.
//
// THE SIREN ADDRESS MUST SURVIVE THAT BUMP. A magic bump discards the whole
// record, and Config::sirenBaseAddress is write-only device->cloud, so losing
// it silently breaks the physical siren pairing — this has happened before
// (docs/history/siren-hub-free.md). The recovery path is RtdbConfig.s, which
// applyPendingConfigUpdate() re-adopts when EEPROM has none. VERIFY THAT ON
// HARDWARE before shipping this: it is the one irreversible failure here.
static_assert(sizeof(Config) == 2548, "EEPROM layout changed - bump kMagic");

// What tripped the alarm, reported to the cloud as state/alarm_cause so the
// Telegram alert can name it. The device knows radio ids, not sensor or rule
// *names* — onAlarm resolves those (see functions/src/alarmCause.ts).
//
// The field still travels to the cloud as "rfId", but now carries a 20-bit
// FAMILY, matching what the config holds. onAlarm indexes its sensors under
// both forms precisely so either firmware generation resolves to a name.
struct TriggerCause {
  char rfId[11] = {};      // family that fired; empty when nothing fired
  uint8_t conditionType = 0;  // Condition::t of the condition that tripped
};

class AlarmState {
 public:
  void setConfig(const Config& config);
  // familyId: the sensor's 20-bit identity as "0x0061D" — NOT a full rfId.
  // cause: optional out-param, written only when the call returns true.
  bool onSensorEvent(const char* familyId, unsigned long nowMs,
                     TriggerCause* cause = nullptr);
  bool tickEntryDelay(unsigned long nowMs, TriggerCause* cause = nullptr);
  void disarm();
  // Whether this family is in the config at all — i.e. a PAIRED sensor with
  // at least one rule. Used by the tamper path, which sirens outside rule
  // evaluation entirely and so has no other way to ask. Independent of arm
  // state, because a tamper fires while disarmed.
  bool isPairedFamily(const char* familyId) const;

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

  int findSensorIndex(const char* familyId) const;
  bool evaluateCondition(uint8_t sensorIndex, uint8_t conditionIndex, unsigned long nowMs);
  bool multiSensorSatisfied(const Condition& cond, unsigned long nowMs);
  // Append a trigger timestamp, evicting the oldest when full rather than
  // dropping the newest. See the definition for why that distinction matters.
  static void recordTrigger(ConditionRuntime& rt, unsigned long nowMs);
};
