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

// true iff the device should take a snapshot right now for this sensor:
// online, NVR capture enabled, sensor not marked out-of-sight, and either
// no prior capture or the cooldown has elapsed.
bool shouldCapture(const Config& cfg, const SensorConfig& sensor, bool online,
                    uint32_t nowMs, uint32_t lastCaptureMs);

// Picks which NVR channel(s) to snapshot for a sensor. If the sensor has a
// named channel, that's the only one; otherwise all three known live
// channels (probing can refine this later). `out` must have room for at
// least 3 entries.
void channelsFor(const SensorConfig& sensor, uint8_t* out, uint8_t& count);

} // namespace CameraGate
