#include "dvrip_protocol.h"
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <cstdio>
#include <cstdlib>

// RFC 1321 MD5 - Public domain reference implementation
// Compact variant based on RFC 1321

namespace {

typedef struct {
  uint32_t state[4];
  uint32_t count[2];
  uint8_t buffer[64];
} MD5_CTX;

// MD5 constants
static const uint32_t S[64] = {
  7, 12, 17, 22,  7, 12, 17, 22,  7, 12, 17, 22,  7, 12, 17, 22,
  5,  9, 14, 20,  5,  9, 14, 20,  5,  9, 14, 20,  5,  9, 14, 20,
  4, 11, 16, 23,  4, 11, 16, 23,  4, 11, 16, 23,  4, 11, 16, 23,
  6, 10, 15, 21,  6, 10, 15, 21,  6, 10, 15, 21,  6, 10, 15, 21
};

static const uint32_t K[64] = {
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
};

#define ROTL(x, n) (((x) << (n)) | ((x) >> (32 - (n))))

static inline uint32_t F(uint32_t x, uint32_t y, uint32_t z) { return (x & y) | (~x & z); }
static inline uint32_t G(uint32_t x, uint32_t y, uint32_t z) { return (x & z) | (y & ~z); }
static inline uint32_t H(uint32_t x, uint32_t y, uint32_t z) { return x ^ y ^ z; }
static inline uint32_t I(uint32_t x, uint32_t y, uint32_t z) { return y ^ (x | ~z); }

static void md5_transform(uint32_t state[4], const uint8_t block[64]) {
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint32_t x[16];

  for (int i = 0; i < 16; i++) {
    x[i] = (uint32_t)block[4*i] | ((uint32_t)block[4*i+1] << 8) |
           ((uint32_t)block[4*i+2] << 16) | ((uint32_t)block[4*i+3] << 24);
  }

  for (int i = 0; i < 64; i++) {
    uint32_t f, g;
    if (i < 16) {
      f = F(b, c, d);
      g = i;
    } else if (i < 32) {
      f = G(b, c, d);
      g = (5 * i + 1) % 16;
    } else if (i < 48) {
      f = H(b, c, d);
      g = (3 * i + 5) % 16;
    } else {
      f = I(b, c, d);
      g = (7 * i) % 16;
    }

    uint32_t temp = d;
    d = c;
    c = b;
    b = b + ROTL(a + f + K[i] + x[g], S[i]);
    a = temp;
  }

  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
}

static void md5_init(MD5_CTX* ctx) {
  ctx->count[0] = 0;
  ctx->count[1] = 0;
  ctx->state[0] = 0x67452301;
  ctx->state[1] = 0xefcdab89;
  ctx->state[2] = 0x98badcfe;
  ctx->state[3] = 0x10325476;
}

static void md5_update(MD5_CTX* ctx, const uint8_t* data, size_t len) {
  size_t index = (ctx->count[0] >> 3) & 0x3f;
  ctx->count[0] += (uint32_t)len << 3;
  if (ctx->count[0] < ((uint32_t)len << 3)) ctx->count[1]++;
  ctx->count[1] += (uint32_t)len >> 29;

  size_t partLen = 64 - index;
  size_t i = 0;

  if (len >= partLen) {
    std::memcpy(&ctx->buffer[index], data, partLen);
    md5_transform(ctx->state, ctx->buffer);

    for (i = partLen; i + 63 < len; i += 64) {
      md5_transform(ctx->state, &data[i]);
    }
    index = 0;
  }

  std::memcpy(&ctx->buffer[index], &data[i], len - i);
}

static void md5_final(MD5_CTX* ctx, uint8_t digest[16]) {
  uint8_t bits[8];
  for (int i = 0; i < 8; i++) {
    bits[i] = (ctx->count[i >> 2] >> ((i % 4) * 8)) & 0xff;
  }

  size_t index = (ctx->count[0] >> 3) & 0x3f;
  size_t padLen = (index < 56) ? (56 - index) : (120 - index);
  uint8_t padding[64] = {0x80};

  md5_update(ctx, padding, padLen);
  md5_update(ctx, bits, 8);

  for (int i = 0; i < 16; i++) {
    digest[i] = (ctx->state[i >> 2] >> ((i % 4) * 8)) & 0xff;
  }
}

static void md5(const uint8_t* data, size_t len, uint8_t out[16]) {
  MD5_CTX ctx;
  md5_init(&ctx);
  md5_update(&ctx, data, len);
  md5_final(&ctx, out);
}

} // namespace

void Dvrip::sofiaHash(const char* password, char out[9]) {
  uint8_t md[16];
  md5(reinterpret_cast<const uint8_t*>(password),
      password ? std::strlen(password) : 0, md);
  static const char* cs =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  for (int i = 0; i < 8; i++) {
    int n = (md[2 * i] + md[2 * i + 1]) % 62;
    out[i] = cs[n];
  }
  out[8] = '\0';
}

size_t Dvrip::buildFrame(uint16_t msgId, const char* body, uint32_t session,
                         uint8_t* out, size_t cap) {
  size_t bodyLen = std::strlen(body) + 2; // + 0x0a 0x00
  size_t total = 20 + bodyLen;
  if (cap < total) return 0;
  std::memset(out, 0, 20);
  out[0] = 0xFF;
  out[4] = session & 0xFF; out[5] = (session >> 8) & 0xFF;
  out[6] = (session >> 16) & 0xFF; out[7] = (session >> 24) & 0xFF;
  out[14] = msgId & 0xFF; out[15] = (msgId >> 8) & 0xFF;
  out[16] = bodyLen & 0xFF; out[17] = (bodyLen >> 8) & 0xFF;
  out[18] = (bodyLen >> 16) & 0xFF; out[19] = (bodyLen >> 24) & 0xFF;
  std::memcpy(out + 20, body, bodyLen - 2);
  out[20 + bodyLen - 2] = 0x0a;
  out[20 + bodyLen - 1] = 0x00;
  return total;
}

void Dvrip::loginBody(const char* user, const char* pw, char* out, size_t cap) {
  std::snprintf(out, cap,
    "{ \"EncryptType\" : \"MD5\", \"LoginType\" : \"DVRIP-Web\", "
    "\"PassWord\" : \"%s\", \"UserName\" : \"%s\" }", pw, user);
}

void Dvrip::snapBody(uint8_t channel, const char* sid, char* out, size_t cap) {
  std::snprintf(out, cap,
    "{ \"Name\" : \"OPSNAP\", \"SessionID\" : \"%s\", "
    "\"OPSNAP\" : { \"Channel\" : %u } }", sid, (unsigned)channel);
}

Dvrip::Header Dvrip::parseHeader(const uint8_t* b, size_t len) {
  Header h{};
  if (len < 20) {
    h.ok = false;
    return h;
  }
  h.sessionId = (uint32_t)b[4] | ((uint32_t)b[5] << 8) | ((uint32_t)b[6] << 16) | ((uint32_t)b[7] << 24);
  h.msgId = (uint16_t)b[14] | ((uint16_t)b[15] << 8);
  h.bodyLen = (uint32_t)b[16] | ((uint32_t)b[17] << 8) | ((uint32_t)b[18] << 16) | ((uint32_t)b[19] << 24);
  h.ok = true;
  return h;
}

int Dvrip::loginRet(const char* body) {
  const char* p = std::strstr(body, "\"Ret\"");
  if (!p) return -1;
  p = std::strchr(p, ':');
  if (!p) return -1;
  return std::atoi(p + 1);
}

const char* Dvrip::sessionIdFromLogin(const char* body, char out[16]) {
  const char* p = std::strstr(body, "\"SessionID\"");
  if (!p) return nullptr;
  p = std::strchr(p, '"');
  if (!p) return nullptr;      // opening of "SessionID"
  p = std::strchr(p + 1, '"');
  if (!p) return nullptr;  // closing
  p = std::strchr(p + 1, '"');
  if (!p) return nullptr;  // opening of value
  const char* start = p + 1;
  const char* end = std::strchr(start, '"');
  if (!end) return nullptr;
  size_t n = (size_t)(end - start);
  if (n > 15) n = 15;
  std::memcpy(out, start, n);
  out[n] = '\0';
  return out;
}

bool Dvrip::isJpeg(const uint8_t* b, size_t len) {
  return len >= 2 && b[0] == 0xFF && b[1] == 0xD8;
}
