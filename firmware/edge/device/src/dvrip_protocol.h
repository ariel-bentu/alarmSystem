#pragma once
#include <cstdint>
#include <cstddef>

namespace Dvrip {
// Message type constants
constexpr uint16_t kMsgLogin = 1000;
constexpr uint16_t kMsgSnap  = 1560;

// Response header parsed from 20-byte DVRIP header.
struct Header {
  uint16_t msgId = 0;
  uint32_t sessionId = 0;
  uint32_t bodyLen = 0;
  bool ok = false;
};

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

// Parses a 20-byte DVRIP response header. Returns a Header with ok=false if len < 20.
Header parseHeader(const uint8_t* buf, size_t len);

// Extracts the "Ret" field from a login JSON response body.
// Returns the Ret value (100 for success), or -1 if not found.
int loginRet(const char* jsonBody);

// Extracts the "SessionID" value from a login JSON response body into out.
// out must be at least 16 bytes. Returns out on success, nullptr if not found.
const char* sessionIdFromLogin(const char* jsonBody, char out[16]);

// Detects if a buffer starts with JPEG magic (0xFF 0xD8).
// Returns true iff len >= 2 && body[0]==0xFF && body[1]==0xD8.
bool isJpeg(const uint8_t* body, size_t len);
}
