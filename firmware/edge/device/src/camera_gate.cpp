#include "camera_gate.h"

bool CameraGate::shouldCapture(const Config& cfg, const SensorConfig& sensor,
                                bool online, uint32_t nowMs,
                                uint32_t lastCaptureMs, bool alarmRaised) {
  if (!cfg.armed && !cfg.captureWhenDisarmed && !alarmRaised) return false;
  // cameraMask == 0 is the authoritative "no cameras for this sensor" and
  // replaces the old outOfSight flag: with an explicit per-sensor channel
  // list there is nothing left for a separate opt-out to say.
  return online && cfg.nvrMode != 0 && sensor.cameraMask != 0 &&
         (lastCaptureMs == 0 ||
          nowMs - lastCaptureMs >= cfg.captureCooldownSec * 1000UL);
}

void CameraGate::channelsFor(const SensorConfig& sensor, uint8_t* out,
                              uint8_t& count) {
  count = 0;
  // Ascending channel order, so the capture loop walks cameras in the order a
  // human would read them and the first-uploaded channel is deterministic.
  for (uint8_t bit = 0; bit < kMaxChannels; bit++) {
    if (sensor.cameraMask & (1u << bit)) {
      out[count++] = static_cast<uint8_t>(bit + 1);
    }
  }
}
