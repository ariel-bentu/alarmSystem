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

}  // namespace ConfigParser
