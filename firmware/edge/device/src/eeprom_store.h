#pragma once

#include <cstddef>
#include <cstdint>

#include "alarm_state.h"

class EepromStore {
 public:
  // Sized to the actual record, not a round number. This was 4096, which
  // cost ~4KB of heap for EEPROM.begin()'s RAM mirror AND put a 4096-byte
  // buffer on the stack in load()/save() — the latter overflows loop()'s
  // 4KB cont stack outright. That heap cost was enough to push the free
  // heap at mint time below the ~19KB a BearSSL TLS handshake needs,
  // producing the Soft WDT resets documented in cloud_client.cpp.
  //
  // Derived from the layout below so it cannot drift if Config grows:
  // magic (4) | armed (1) | localWebEnabled (1) | Config.
  static constexpr size_t kRecordBytes =
      sizeof(uint32_t) + sizeof(uint8_t) + sizeof(uint8_t) + sizeof(Config);
  // Small headroom so a modest Config change doesn't require an EEPROM
  // layout migration; still an order of magnitude below the old 4096.
  static constexpr size_t kReservedBytes = kRecordBytes + 64;
  // Bumped from 0xA1A2B3B7 — adding Condition::q (the multi_sensor quorum)
  // changed sizeof(Config) (2452 -> 2580), so records written by earlier
  // firmware must be rejected rather than misread. A magic mismatch is
  // decode()'s rejection mechanism. (Earlier bumps: 0xA1A2B3B6 -> B7 for
  // Config::remotes/remoteCount, 0xA1A2B3B5 -> B6 for sirenBaseAddress.)
  //
  // Cost: on the first boot after flashing, stored config is discarded and
  // the device starts disarmed with an empty config, then re-pulls from the
  // cloud. Paired remotes survive because they are re-pushed from Firestore;
  // a device with no WiFi at that moment has none until it reconnects once.
  //
  // The SIREN ADDRESS is the one thing that is not merely re-pulled: the
  // device→cloud path is write-only, so a wiped EEPROM re-adopts it from the
  // config's `s` field (main.cpp applyPendingConfigUpdate) — and only if the
  // project has already reported one. A device that has never been online
  // with a valid address generates a NEW one and loses the physical siren
  // pairing, which must then be redone by hand. Verify /{projectId}/state
  // carries the siren address before flashing a magic bump to live hardware.
  // Bumped B8 -> B9 when SensorConfig::rfId[11] became familyId[9] (matching
  // moved from the full 24-bit code to the 20-bit family), changing
  // sizeof(Config) 2580 -> 2548. A stale record must be DISCARDED, not
  // misread as the new layout.
  //
  // The siren address is the casualty of any bump here: it lives in this
  // record, is write-only device->cloud, and a discarded record silently
  // breaks the physical siren pairing. RtdbConfig.s is the recovery path —
  // see alarm_state.h's note and verify it on hardware.
  static constexpr uint32_t kMagic = 0xA1A2B3B9;

  bool begin();
  bool load(bool* armed, bool* localWebEnabled, Config* config);
  bool save(bool armed, bool localWebEnabled, const Config& config);

  // Pure encode/decode, exposed for native unit testing. Layout: magic
  // (4 bytes) | armed (1 byte) | localWebEnabled (1 byte) | Config (raw
  // struct bytes, fixed size).
  static size_t encode(bool armed, bool localWebEnabled, const Config& config,
                        uint8_t* buffer, size_t bufferLen);
  static bool decode(const uint8_t* buffer, size_t bufferLen, bool* armed,
                      bool* localWebEnabled, Config* config);
};
