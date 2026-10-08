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
  // count_in_window minimum separation, seconds: two triggers closer together
  // than this count as ONE witness. 0 = no minimum, which is both the
  // historical behaviour and what a config written before this field existed
  // decodes to — so no migration is needed, exactly like `q` above.
  //
  // Why: a PIR re-triggering on its own stimulus is one physical event, and a
  // bare count_in_window counts that echo as corroboration. Measured on
  // sensor 0x009BFA (992 events): median gap between the 1st and 2nd trigger
  // of a burst is 10s, and 51% of multi-trigger bursts are <=10s.
  //
  // Mirrored by min_gap_sec in functions/src/alarmLogic.ts; the two
  // evaluators must agree.
  //
  // uint8_t, not uint16_t: a min gap is tens of seconds (it must be well
  // under `w` to leave a satisfiable slot at all), so 255s is ample, and the
  // narrower type packs into Condition's existing padding instead of costing
  // 2 bytes x 4 conditions x 16 sensors = 128 in the EEPROM record.
  // config_parser clamps anything larger.
  uint8_t g = 0;
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
  // Which NVR channels to snapshot when this sensor trips: channel N is
  // bit N-1, so channel 1 is 0x01 and channel 8 is 0x80.
  //
  // 0 means capture NOTHING for this sensor — it is the authoritative "no
  // cameras" state, not a fall-back to "all channels". That is why this one
  // byte replaced the earlier `bool outOfSight` + `uint8_t cameraChannel`
  // pair: the pair could express only none-or-one and needed two fields to
  // say "none", while a mask says none / one / several in a byte. Net effect
  // on sizeof(SensorConfig) is -1 byte before padding, so the struct did not
  // grow and EepromStore's magic does NOT need a bump — asserted in
  // eeprom_store.h.
  uint8_t cameraMask = 0;
  // Does a trigger from this sensor mean a confirmed break-in, or does it
  // need camera confirmation?
  //
  // DEFAULTS TRUE, which is the fail-loud direction and matches the single
  // source of that default in the cloud (functions/src/breachCertainty.ts,
  // where an absent `definiteBreach` means definite). A sensor the config
  // never mentions therefore sounds the siren immediately, exactly as before
  // this field existed.
  //
  // The only thing it gates on-device is the SIREN HOLD below. Certainty also
  // picks the notification tier, but that stays entirely cloud-side — the
  // device has no notion of Pushover priorities.
  bool definiteBreach = true;
};

struct Config {
  bool armed = false;
  uint16_t sirenDurationSec = 0;
  bool sirenEnabled = true; // false = never sound the siren
  // Seconds to DELAY the siren for a non-definite sensor, giving the cloud's
  // AI judge time to rule the trigger a false positive. 0 = fire immediately,
  // which is the behaviour before this field and what an older config (or no
  // config at all) decodes to.
  //
  // THE HOLD EXPIRES AND FIRES. If no false-positive advisory arrives — the
  // device is offline, the NVR is down, the judge errored, the cloud never
  // answered — the siren still sounds, just `sirenHoldSec` late. This is
  // deliberate and is the whole reason the hold lives here rather than being
  // "wait for the cloud to say go": alarm logic must never DEPEND on the
  // cloud (see CLAUDE.md), and a break-in during a WiFi outage must still
  // sound the siren.
  uint16_t sirenHoldSec = 0;
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

  // NVR integration: capture a snapshot on trigger, optionally judged by the
  // NVR's own motion/AI detection before alerting. nvrMode: 0=off,
  // 1=capture, 2=capture+judge.
  char nvrHost[32] = {};
  uint16_t nvrPort = 34567;
  char nvrUser[24] = {};
  char nvrPassword[24] = {};
  uint8_t nvrMode = 0;
  // false = trigger snapshots only while ARMED (or when the trigger itself
  // raised an alarm, e.g. an `always` rule). true — the default, and what a
  // config without `cd` decodes to — captures on every trigger, which is the
  // behaviour before this field. Manual capture ignores it.
  bool captureWhenDisarmed = true;
  uint16_t captureCooldownSec = 45;
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
// 2548 -> 2664 when NVR fields (host/port/user/password/mode + cooldown;
// SensorConfig out-of-sight + channel) were added. Measured via a temporary
// template-instantiation probe, not predicted. kMagic bumped to 0xA1A2B3BA.
// 2664 -> 2632 when SensorConfig's `bool outOfSight` + `uint8_t cameraChannel`
// became a single `uint8_t cameraMask` (per-sensor multi-camera selection).
// MEASURED, not predicted — the initial guess was "unchanged", and it was
// wrong: the struct SHRANK 2 bytes x 16 sensors = 32. A shrink is just as
// unreadable as a growth, so kMagic was bumped to 0xA1A2B3BB.
// 2632 -> 2664 when SensorConfig gained `bool definiteBreach` and Config
// gained `uint16_t sirenHoldSec` (the siren hold for non-definite sensors).
// MEASURED: the bool costs 2 bytes x 16 sensors = 32 after padding, while
// sirenHoldSec fits in Config's existing padding and costs nothing. kMagic
// bumped to 0xA1A2B3BC.
//
// Condition::g (count_in_window min gap) was added in the same release and is
// deliberately a uint8_t for this reason: it packs into Condition's padding,
// so it cost 0 bytes where a uint16_t would have cost 128 (2 x 4 conditions
// x 16 sensors) and forced its own bump.
//
// The siren address rides in this record, and a magic bump discards the whole
// record. It is recovered from RtdbConfig.s, which applyPendingConfigUpdate()
// re-adopts when EEPROM has none — proven across seven bumps now. The one
// documented loss (docs/history/siren-hub-free.md) predates that path.
// `npm run check:sirenAddress` confirms it in one read-only command; see
// eeprom_store.h's kMagic note for why that is the whole procedure.
static_assert(sizeof(Config) == 2664, "EEPROM layout changed - bump kMagic");

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
  // True while any entry-delay countdown is running. The countdown lives only
  // in RAM, so a reboot during it silently drops the alarm it would have
  // raised — the OTA path checks this before restarting the board.
  bool isEntryDelayPending() const;
  void disarm();
  // Whether this family is in the config at all — i.e. a PAIRED sensor with
  // at least one rule. Used by the tamper path, which sirens outside rule
  // evaluation entirely and so has no other way to ask. Independent of arm
  // state, because a tamper fires while disarmed.
  bool isPairedFamily(const char* familyId) const;
  // Whether a trigger from this family is a DEFINITE breach, i.e. whether the
  // siren should sound immediately rather than be held for the AI judge.
  //
  // Returns TRUE for an unknown family, which is the fail-loud direction and
  // matches the cloud's single source of that default
  // (functions/src/breachCertainty.ts: absent definiteBreach means definite).
  // An unpaired sensor cannot reach the siren through the rules anyway; the
  // tamper path can, and a tamper must never be held.
  bool isDefiniteBreachFamily(const char* familyId) const;

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
