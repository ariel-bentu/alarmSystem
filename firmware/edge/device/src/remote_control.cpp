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
