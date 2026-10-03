#pragma once
#include <cstdint>
#include <cstddef>

namespace Dvrip {
// Message type constants
constexpr uint16_t kMsgLogin = 1000;
constexpr uint16_t kMsgSnap  = 1560;

// Writes 8 chars + NUL into out (9 bytes). The Xiongmai "sofia" digest:
// MD5(password) -> 8 chars, out[i] = charset[(md5[2i]+md5[2i+1]) % 62].
void sofiaHash(const char* password, char out[9]);

// Builds a DVRIP frame: 20-byte header + JSON body + 0x0a 0x00 trailer.
// Returns bytes written, or 0 if outCap is too small.
size_t buildFrame(uint16_t msgId, const char* jsonBody, uint32_t sessionId,
                  uint8_t* out, size_t outCap);

// Writes login JSON payload into out.
void loginBody(const char* user, const char* sofiaHashedPw, char* out, size_t outCap);

// Writes OPSNAP (snapshot request) JSON payload into out.
void snapBody(uint8_t channel, const char* sessionIdHex, char* out, size_t outCap);
}
