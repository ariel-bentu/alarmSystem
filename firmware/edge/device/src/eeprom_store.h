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
  // The SIREN ADDRESS is the one thing not re-pulled from the usual config
  // path, because device->cloud is write-only for it. A wiped EEPROM
  // re-adopts it from the config's `s` field (main.cpp
  // applyPendingConfigUpdate) — provided the project has already reported
  // one. Only a device that has NEVER been online with a valid address mints
  // a new one, losing the physical pairing. `npm run check:sirenAddress`
  // answers that in one read-only command; see the note on kMagic below for
  // the track record.
  // Bumped B8 -> B9 when SensorConfig::rfId[11] became familyId[9] (matching
  // moved from the full 24-bit code to the 20-bit family), changing
  // sizeof(Config) 2580 -> 2548. A stale record must be DISCARDED, not
  // misread as the new layout.
  //
  // Bumped B9 -> BA when the NVR fields (Config::nvrHost/nvrPort/nvrUser/
  // nvrPassword/nvrMode/captureCooldownSec and SensorConfig::outOfSight/
  // cameraChannel) were added, changing sizeof(Config) 2548 -> 2664.
  //
  // Bumped BA -> BB when SensorConfig::outOfSight + cameraChannel became a
  // single cameraMask (per-sensor multi-camera selection), changing
  // sizeof(Config) 2664 -> 2632. A SHRINK, so a stale record is not merely
  // mis-aligned but shorter than the reader expects — discard, never misread.
  //
  // Bumped BB -> BC when SensorConfig gained `definiteBreach` and Config
  // gained `sirenHoldSec` — the siren hold that delays a non-definite
  // sensor's siren while the AI judge looks at the snapshots. sizeof(Config)
  // 2632 -> 2664 (MEASURED: the bool costs 2 bytes x 16 sensors after
  // padding; sirenHoldSec fits in existing padding and costs nothing).
  //
  // A BUMP IS ROUTINE. Seven of them so far (B5->B6->B7->B8->B9->BA->BB->BC)
  // and the siren address has survived every one since RtdbConfig.s became
  // the recovery path. The single documented loss predates that path.
  //
  // So the whole procedure is: run `npm run check:sirenAddress` (read-only).
  // If it prints an address for BOTH Firestore sirenBaseAddress and RTDB
  // config.s, flash. If a line is MISSING, stop — that is the only dangerous
  // case, and it means the device has never reported an address for the
  // wiped record to re-adopt.
  //
  // Resist re-inflating this into a warning. The fear here outlived the bug
  // by five bumps and made every unrelated Config change feel risky.
  static constexpr uint32_t kMagic = 0xA1A2B3BC;

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
