#pragma once

// Hardware-only DVRIP snapshot grab. NOT in [env:native]'s build_src_filter
// allowlist (platformio.ini) — it uses WiFiClient / Arduino types, so it
// only ever compiles for [env:esp32s3]. The pure capture-gate decisions
// (shouldCapture / channelsFor) live in camera_gate.h/.cpp instead, which
// IS in the native allowlist and is unit-tested off hardware
// (test/test_camera_gate). Keeping grab() out of that file is what lets the
// gate logic stay native-testable: a single file mixing both would pull
// WiFiClient into the native build and fail to compile there.
#include <cstdint>
#include <vector>

#include "alarm_state.h"

namespace CameraClient {

// Connects to the NVR (cfg.nvrHost:nvrPort), logs in via DVRIP/sofia-hash
// auth, and requests an OPSNAP still from `channel`. On success, copies the
// JPEG bytes into `out` and returns true. Best-effort: returns false and
// logs one line on any failure (connect, login, timeout, non-JPEG
// response) — never throws, never hangs past its internal deadline. Not
// native-tested: this is socket I/O, exercised against the real NVR.
bool grab(const Config& cfg, uint8_t channel, std::vector<uint8_t>& out);

} // namespace CameraClient
