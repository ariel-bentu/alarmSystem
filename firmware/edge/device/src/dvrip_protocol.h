#pragma once
#include <cstdint>
#include <cstddef>

namespace Dvrip {
// Writes 8 chars + NUL into out (9 bytes). The Xiongmai "sofia" digest:
// MD5(password) -> 8 chars, out[i] = charset[(md5[2i]+md5[2i+1]) % 62].
void sofiaHash(const char* password, char out[9]);
}
