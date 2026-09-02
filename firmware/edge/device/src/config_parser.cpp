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
      sensor.conditionCount++;
    }
    out->sensorCount++;
  }
  return true;
}

}  // namespace ConfigParser
