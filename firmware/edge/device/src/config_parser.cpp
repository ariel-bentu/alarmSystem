#include "config_parser.h"

#include <ArduinoJson.h>
#include <cstdlib>

namespace ConfigParser {

bool parseConfigJson(const char* json, Config* out) {
  StaticJsonDocument<4096> doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) return false;

  out->armed = doc["a"] | false;
  out->sirenDurationSec = doc["d"] | 0;
  out->sirenEnabled = doc["e"] | true;

  // Siren base address, echoed back by the cloud so a device whose EEPROM was
  // wiped can re-adopt its own identity rather than generating a new one the
  // physical siren was never paired to. 0 means "cloud has none"; the caller
  // decides whether to adopt (see main.cpp's applyPendingConfigUpdate — a
  // device with a valid local address ignores this and stays authoritative).
  //
  // Parsed BEFORE the r/c early return below, for the same reason as `m`.
  out->sirenBaseAddress = doc["s"] | 0;

  // Parsed BEFORE the r/c handling below, which has an early return for the
  // no-sensors case — remotes must survive that path or a project with no
  // rules could never use one.
  out->remoteCount = 0;
  JsonArray m = doc["m"];
  if (!m.isNull()) {
    for (JsonVariant v : m) {
      // Clamp rather than overflow: the array is fixed-size and the config
      // is remote input.
      if (out->remoteCount >= Config::kMaxRemotes) break;
      out->remotes[out->remoteCount++] = v.as<uint32_t>();
    }
  }

  JsonArray r = doc["r"];
  JsonArray c = doc["c"];
  // Paired with onProfileChange.ts: RTDB drops empty arrays on .set(), so
  // "no active profile" writes {a, d} with r/c omitted entirely rather than
  // r:[]/c:[]. Missing r/c means zero sensors (arm nothing), NOT a parse
  // failure — only reject if the arrays are present but mismatched in
  // length (genuinely malformed), or if exactly one of the two is present.
  if (r.isNull() && c.isNull()) {
    out->sensorCount = 0;
    return true;
  }
  if (r.isNull() || c.isNull() || r.size() != c.size()) return false;

  out->sensorCount = 0;
  for (size_t i = 0; i < r.size() && i < 16; i++) {
    SensorConfig& sensor = out->sensors[out->sensorCount];
    strncpy(sensor.rfId, r[i].as<const char*>(), sizeof(sensor.rfId) - 1);
    sensor.rfId[sizeof(sensor.rfId) - 1] = '\0';

    JsonArray conditions = c[i];
    sensor.conditionCount = 0;
    for (JsonVariant condJson : conditions) {
      if (sensor.conditionCount >= 4) break;
      Condition& cond = sensor.conditions[sensor.conditionCount];
      cond.t = condJson["t"] | 0;
      cond.n = condJson["n"] | 0;
      cond.w = condJson["w"] | 0;
      cond.y = condJson["y"] | 0;
      // Always-on: fires regardless of arm state. Omitted when false.
      cond.always = (condJson["x"] | 0) == 1;
      cond.kLen = 0;
      // k arrives in EITHER shape. buildConfig emits an object keyed by
      // index-into-r ({"0":1,"1":1}), but Firebase RTDB silently converts an
      // object whose keys are "0".."n" into a JSON ARRAY ([1,1]) — so a rule
      // whose participants happen to start at index 0 is delivered as an
      // array. Reading only the object form left kLen at 0, which made
      // multiSensorSatisfied() iterate zero participants and never fire.
      // Cost a live 3-sensor rule that silently did nothing (2026-09-07).
      JsonArray kArray = condJson["k"];
      if (!kArray.isNull()) {
        uint8_t idx = 0;
        for (JsonVariant v : kArray) {
          if (cond.kLen >= 8) break;
          // Same 16-slot bound the object path below enforces: the position
          // indexes config_.sensors[]/runtime_[], so a longer array would be
          // a genuine out-of-bounds access in multiSensorSatisfied(), not
          // merely stale data.
          if (idx >= 16) break;
          // A hole in a sparse array arrives as null. Skipping keeps the
          // POSITION meaningful — position is the index into r, so counting
          // a null as a participant would shift every later index.
          if (!v.isNull()) {
            cond.kIndex[cond.kLen] = idx;
            cond.kCount[cond.kLen] = v.as<uint16_t>();
            cond.kLen++;
          }
          idx++;
        }
      }
      JsonObject k = condJson["k"];
      if (!k.isNull()) {
        for (JsonPair kv : k) {
          if (cond.kLen >= 8) break;
          // Validate the index-as-string key against the fixed capacity of
          // Config::sensors[]/AlarmState::runtime_[] (16 slots — see
          // alarm_state.h), NOT against r.size(). r.size() is the incoming
          // JSON array's length and can exceed 16; the outer sensor loop
          // above is separately capped at `i < 16`, so any "k" index >= 16
          // would be a genuine out-of-bounds access when
          // AlarmState::multiSensorSatisfied later indexes
          // config_.sensors[participantIndex]/runtime_[participantIndex] —
          // not merely stale data. Drop any entry that doesn't validate
          // rather than storing a bad index.
          int parsedIndex = atoi(kv.key().c_str());
          if (parsedIndex < 0 || parsedIndex >= 16) continue;
          cond.kIndex[cond.kLen] = (uint8_t)parsedIndex;
          cond.kCount[cond.kLen] = kv.value().as<uint16_t>();
          cond.kLen++;
        }
      }
      // multi_sensor quorum: how many participants must be satisfied. Read
      // AFTER k so it can be validated against the participant count that
      // actually survived the loop above. Omitted by the server whenever it
      // equals that count, so 0 is the normal "all of them" case. A value
      // exceeding kLen would make the rule permanently unfireable, so clamp
      // to 0 (= all) rather than trusting it — same drop-don't-store policy
      // as the k indices above.
      int parsedQuorum = condJson["q"] | 0;
      cond.q = (parsedQuorum > 0 && parsedQuorum <= (int)cond.kLen)
                   ? (uint8_t)parsedQuorum
                   : 0;
      sensor.conditionCount++;
    }
    out->sensorCount++;
  }
  return true;
}

}  // namespace ConfigParser
