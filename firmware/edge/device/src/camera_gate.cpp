#include "camera_gate.h"

bool CameraGate::shouldCapture(const Config& cfg, const SensorConfig& sensor,
                                bool online, uint32_t nowMs,
                                uint32_t lastCaptureMs) {
  return online && cfg.nvrMode != 0 && !sensor.outOfSight &&
         (lastCaptureMs == 0 ||
          nowMs - lastCaptureMs >= cfg.captureCooldownSec * 1000UL);
}

void CameraGate::channelsFor(const SensorConfig& sensor, uint8_t* out,
                              uint8_t& count) {
  if (sensor.cameraChannel != 0) {
    out[0] = sensor.cameraChannel;
    count = 1;
    return;
  }
  out[0] = 1;
  out[1] = 2;
  out[2] = 3;
  count = 3;
}
