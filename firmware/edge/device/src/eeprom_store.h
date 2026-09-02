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
  // Bumped from 0xA1A2B3B6 — adding Config::remotes/remoteCount changed
  // sizeof(Config) (2416 -> 2452), so records written by earlier firmware
  // must be rejected rather than misread. A magic mismatch is decode()'s
  // rejection mechanism. (The previous bump, 0xA1A2B3B5 -> 0xA1A2B3B6, was
  // for Config::sirenBaseAddress.)
  //
  // Cost: on the first boot after flashing, stored config is discarded and
  // the device starts disarmed with an empty config, then re-pulls from the
  // cloud. Paired remotes survive because they are re-pushed from Firestore;
  // a device with no WiFi at that moment has none until it reconnects once.
  static constexpr uint32_t kMagic = 0xA1A2B3B7;

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
