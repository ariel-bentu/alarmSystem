#include "remote_control.h"

RemoteAction remoteActionFor(uint8_t nibble) {
  switch (nibble) {
    case 0x1: return RemoteAction::ArmHome;
    case 0x2: return RemoteAction::Disarm;
    case 0x4: return RemoteAction::Arm;
    case 0x8: return RemoteAction::Sos;
    // Deliberately no default guess: a multi-bit nibble means the decode is
    // corrupt, and inferring "probably disarm" from noise would unlock the
    // house.
    default:  return RemoteAction::None;
  }
}

bool remoteIsPaired(const Config& config, uint32_t identity) {
  // identity 0 is the empty-slot marker, never a real remote.
  if (identity == 0) return false;
  for (uint8_t i = 0; i < config.remoteCount && i < Config::kMaxRemotes; i++) {
    if (config.remotes[i] == identity) return true;
  }
  return false;
}

RemotePairResult remotePair(Config* config, uint32_t identity, bool armed) {
  if (armed) return RemotePairResult::RefusedArmed;
  if (remoteIsPaired(*config, identity)) return RemotePairResult::AlreadyPaired;
  if (config->remoteCount >= Config::kMaxRemotes) return RemotePairResult::Full;
  config->remotes[config->remoteCount++] = identity;
  return RemotePairResult::Paired;
}
