#include "eeprom_store.h"

#include <cstring>

#if defined(ARDUINO)
#include <EEPROM.h>

#include "platform_compat.h"
#endif

size_t EepromStore::encode(bool armed, bool localWebEnabled, const Config& config,
                            uint8_t* buffer, size_t bufferLen) {
  size_t needed = sizeof(kMagic) + sizeof(uint8_t) + sizeof(uint8_t) + sizeof(Config);
  if (bufferLen < needed) return 0;

  size_t offset = 0;
  // Copied into a local first: memcpy takes kMagic's ADDRESS, and a static
  // constexpr member is only implicitly inline (i.e. has a definition to
  // point at) from C++17 on. The ESP8266 core builds at gnu++17 so this
  // linked there; the ESP32 core builds at gnu++11, where it failed with
  // "undefined reference to EepromStore::kMagic". Using a local keeps the
  // constant usable on both without an out-of-line definition.
  const uint32_t magic = kMagic;
  memcpy(buffer + offset, &magic, sizeof(magic));
  offset += sizeof(magic);

  uint8_t armedByte = armed ? 1 : 0;
  memcpy(buffer + offset, &armedByte, sizeof(armedByte));
  offset += sizeof(armedByte);

  uint8_t localWebByte = localWebEnabled ? 1 : 0;
  memcpy(buffer + offset, &localWebByte, sizeof(localWebByte));
  offset += sizeof(localWebByte);

  memcpy(buffer + offset, &config, sizeof(Config));
  offset += sizeof(Config);

  return offset;
}

bool EepromStore::decode(const uint8_t* buffer, size_t bufferLen, bool* armed,
                          bool* localWebEnabled, Config* config) {
  size_t needed = sizeof(kMagic) + sizeof(uint8_t) + sizeof(uint8_t) + sizeof(Config);
  if (bufferLen < needed) return false;

  uint32_t magic = 0;
  size_t offset = 0;
  memcpy(&magic, buffer + offset, sizeof(magic));
  offset += sizeof(magic);
  if (magic != kMagic) return false;

  uint8_t armedByte = 0;
  memcpy(&armedByte, buffer + offset, sizeof(armedByte));
  offset += sizeof(armedByte);
  *armed = armedByte != 0;

  uint8_t localWebByte = 0;
  memcpy(&localWebByte, buffer + offset, sizeof(localWebByte));
  offset += sizeof(localWebByte);
  *localWebEnabled = localWebByte != 0;

  memcpy(config, buffer + offset, sizeof(Config));
  offset += sizeof(Config);

  return true;
}

#if defined(ARDUINO)

bool EepromStore::begin() {
  EEPROM.begin(kReservedBytes);
  return true;
}

// Both functions operate directly on EEPROM's own RAM mirror via
// getDataPtr() rather than copying into a local array. The previous
// `uint8_t buffer[kReservedBytes]` locals put a full copy on the stack,
// which at the old 4096-byte reservation overflowed loop()'s 4KB cont
// stack. Using the mirror keeps these calls stack-cheap regardless of how
// kReservedBytes evolves.
// PLATFORM_EEPROM_CONST_DATA_PTR: ESP8266 exposes getConstDataPtr(); ESP32's
// EEPROM class only has getDataPtr(). Reading through the non-const pointer
// is equivalent here — load() never writes through it.
bool EepromStore::load(bool* armed, bool* localWebEnabled, Config* config) {
  const uint8_t* data = PLATFORM_EEPROM_CONST_DATA_PTR();
  if (data == nullptr) return false;
  return decode(data, kReservedBytes, armed, localWebEnabled, config);
}

bool EepromStore::save(bool armed, bool localWebEnabled, const Config& config) {
  uint8_t* data = EEPROM.getDataPtr();  // marks the mirror dirty for commit()
  if (data == nullptr) return false;
  if (encode(armed, localWebEnabled, config, data, kReservedBytes) == 0) return false;
  return EEPROM.commit();
}

#endif  // defined(ARDUINO)
