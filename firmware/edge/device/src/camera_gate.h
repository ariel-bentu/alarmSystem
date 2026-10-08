#pragma once

#include <cstdint>

#include "alarm_state.h"

// Pure capture-gate decision logic for the NVR snapshot-on-trigger feature.
// No Arduino / WiFi / socket types here on purpose: this header (and its
// .cpp) must stay native-compilable so it can live in [env:native]'s
// build_src_filter allowlist in platformio.ini and be unit-tested off
// hardware. The hardware-only DVRIP socket work (CameraClient::grab) lives
// in a separate camera_client.h/.cpp pair that is NOT in that allowlist, so
// it only ever compiles for the esp32s3 env.
namespace CameraGate {

// NVR channel count, and therefore the width of SensorConfig::cameraMask and
// the maximum `count` channelsFor() can return. Mirrors MAX_CHANNEL in
// web/src/features/explore/cameraNames.ts and buildConfig.ts.
constexpr uint8_t kMaxChannels = 8;

// true iff the device should take a snapshot right now for this sensor:
// online, NVR capture enabled, at least one camera selected for the sensor,
// either no prior capture or the cooldown has elapsed, AND the arm state
// allows it — armed, or the project captures while disarmed
// (cfg.captureWhenDisarmed), or this very trigger raised an alarm
// (`alarmRaised`: an `always` rule fires while disarmed, and that is exactly
// the trigger worth a photo).
bool shouldCapture(const Config& cfg, const SensorConfig& sensor, bool online,
                    uint32_t nowMs, uint32_t lastCaptureMs,
                    bool alarmRaised = false);

// Expands the sensor's cameraMask into explicit channel numbers, ascending.
// Channel N is bit N-1, so mask 0b10000101 yields {1, 3, 8}. A zero mask
// yields count 0 — the sensor captures nothing. `out` must have room for at
// least kMaxChannels entries.
void channelsFor(const SensorConfig& sensor, uint8_t* out, uint8_t& count);

} // namespace CameraGate
