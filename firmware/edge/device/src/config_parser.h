#pragma once

#include "alarm_state.h"

// Pure JSON-to-Config parsing, extracted from CloudClient so it's testable
// under the native PlatformIO env without any FirebaseClient/network
// dependency (ArduinoJson itself has no Arduino-core dependency and builds
// fine under native, same as alarm_state.h/.cpp avoiding Arduino.h). See
// cloud_client.cpp, which now just forwards to this.
namespace ConfigParser {

// Parses the thin, index-based config JSON (see the design spec's `{a, d,
// r, c}` shape) into `out`. Caps: 16 sensors, 4 conditions per sensor, 8
// multi_sensor participants per condition — extra entries are truncated,
// not treated as an error.
//
// Missing `r`/`c` (both absent) is treated as a valid "zero sensors" config
// — RTDB drops empty arrays on .set(), so onProfileChange.ts's "no active
// profile" write (`{a, d}` with no r/c) round-trips this way. Only an
// array-length mismatch or exactly one of r/c present is a parse failure.
bool parseConfigJson(const char* json, Config* out);

// Parses a polled /commands payload's `fp` (false-positive advisory) key:
// `{ "fp": { "rfId": "0x..", "ts": <epoch-ms> } }`. Returns false (leaving
// the out-params untouched) when `fp` is absent or malformed.
//
// `rfId` is the FULL 24-bit code (e.g. "0x0061DA"), the same width as the
// /events/{rfId}/{ts} key and the snapshot upload path — NOT the 20-bit
// family TriggerCause stores. Matching against the currently-sounding
// siren therefore cannot use AlarmState::TriggerCause directly; see
// main.cpp's activeAlarmRfId_/activeAlarmTs_.
//
// `ts` is epoch MILLISECONDS, the same uint64 unit reportEvent()/
// uploadSnapshot() use (time(nullptr) * 1000). A uint32_t cannot hold a
// real epoch-ms value (current epoch-ms is already ~1.7e12, far past
// uint32_t's ~4.3e9 ceiling) — do not narrow this.
bool parseFalsePositive(const char* json, char* rfIdOut, size_t cap,
                        uint64_t* tsOut);

// Same shape, any advisory key. `commands/breach` is the ADDITIVE mirror of
// `fp`: identical {rfId, ts} payload, opposite meaning — "fp" says stand down
// for this trigger, "breach" says sound off for it because the AI judge saw a
// person and the sensor's condition opted into vision evidence
// (Condition.breach_satisfies in the cloud types).
//
// One parser for both so the two can never drift in how they read an rfId or
// a ts. /commands is a single polled document, so BOTH keys may be present at
// once (an older fp alongside a new breach); each parses independently and
// neither reads the other.
bool parseAdvisory(const char* json, const char* key, char* rfIdOut, size_t cap,
                   uint64_t* tsOut);

}  // namespace ConfigParser
