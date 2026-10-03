#include "camera_client.h"

#include <Arduino.h>
#include <WiFiClient.h>

#include "dvrip_protocol.h"
#include "io_deadline.h"

namespace {

// Same shape as SslClientWithDns's deadline (io_deadline.h): progress-based,
// not a flat timeout, so a slow-but-advancing NVR response is not killed
// mid-transfer, but a genuinely stalled socket is torn down well short of
// the 30s task watchdog. A snapshot grab is a short best-effort side
// path off the main alarm loop, so this is deliberately tighter than the
// 12s used for the primary Firebase socket.
constexpr uint32_t kGrabDeadlineMs = 8000;

// Reads exactly `len` bytes from `tcp` into `buf`, honoring `deadline`.
// Returns false (without having necessarily read everything) on timeout or
// a closed connection.
bool readExact(WiFiClient& tcp, uint8_t* buf, size_t len, IoDeadline& deadline) {
  size_t got = 0;
  while (got < len) {
    if (deadline.expired(millis())) return false;
    if (!tcp.connected() && !tcp.available()) {
      deadline.socketClosed();
      return false;
    }
    int avail = tcp.available();
    if (avail <= 0) {
      delay(1);
      continue;
    }
    int n = tcp.read(buf + got, len - got);
    if (n <= 0) {
      delay(1);
      continue;
    }
    got += (size_t)n;
    deadline.progress(millis());
  }
  return true;
}

} // namespace

bool CameraClient::grab(const Config& cfg, uint8_t channel,
                         std::vector<uint8_t>& out) {
  IoDeadline deadline(kGrabDeadlineMs);
  deadline.arm(millis());

  WiFiClient tcp;
  if (!tcp.connect(cfg.nvrHost, cfg.nvrPort)) {
    Serial.println("camera: connect failed");
    return false;
  }

  char hashedPw[9];
  Dvrip::sofiaHash(cfg.nvrPassword, hashedPw);
  char loginJson[256];
  Dvrip::loginBody(cfg.nvrUser, hashedPw, loginJson, sizeof(loginJson));

  uint8_t frame[320];
  size_t frameLen = Dvrip::buildFrame(Dvrip::kMsgLogin, loginJson, /*session=*/0,
                                       frame, sizeof(frame));
  if (frameLen == 0) {
    Serial.println("camera: login frame too large");
    tcp.stop();
    return false;
  }
  tcp.write(frame, frameLen);
  deadline.progress(millis());

  uint8_t header[20];
  if (!readExact(tcp, header, sizeof(header), deadline)) {
    Serial.println("camera: login header read timed out");
    tcp.stop();
    return false;
  }
  Dvrip::Header loginHeader = Dvrip::parseHeader(header, sizeof(header));
  if (!loginHeader.ok || loginHeader.bodyLen == 0 ||
      loginHeader.bodyLen > 1024) {
    Serial.println("camera: malformed login header");
    tcp.stop();
    return false;
  }

  char loginBodyBuf[1024];
  if (!readExact(tcp, reinterpret_cast<uint8_t*>(loginBodyBuf),
                  loginHeader.bodyLen, deadline)) {
    Serial.println("camera: login body read timed out");
    tcp.stop();
    return false;
  }
  loginBodyBuf[loginHeader.bodyLen < sizeof(loginBodyBuf)
                   ? loginHeader.bodyLen
                   : sizeof(loginBodyBuf) - 1] = '\0';

  if (Dvrip::loginRet(loginBodyBuf) != 100) {
    Serial.println("camera: login rejected");
    tcp.stop();
    return false;
  }

  char sessionIdHex[16];
  if (!Dvrip::sessionIdFromLogin(loginBodyBuf, sessionIdHex)) {
    Serial.println("camera: login response missing SessionID");
    tcp.stop();
    return false;
  }
  uint32_t sessionId = (uint32_t)strtoul(sessionIdHex, nullptr, 16);

  char snapJson[160];
  Dvrip::snapBody(channel, sessionIdHex, snapJson, sizeof(snapJson));
  frameLen = Dvrip::buildFrame(Dvrip::kMsgSnap, snapJson, sessionId, frame,
                                sizeof(frame));
  if (frameLen == 0) {
    Serial.println("camera: snap frame too large");
    tcp.stop();
    return false;
  }
  tcp.write(frame, frameLen);
  deadline.progress(millis());

  uint8_t snapHeader[20];
  if (!readExact(tcp, snapHeader, sizeof(snapHeader), deadline)) {
    Serial.println("camera: snap header read timed out");
    tcp.stop();
    return false;
  }
  Dvrip::Header snapResp = Dvrip::parseHeader(snapHeader, sizeof(snapHeader));
  if (!snapResp.ok || snapResp.bodyLen == 0) {
    Serial.println("camera: malformed snap header");
    tcp.stop();
    return false;
  }

  out.clear();
  out.resize(snapResp.bodyLen);
  if (!readExact(tcp, out.data(), snapResp.bodyLen, deadline)) {
    Serial.println("camera: snap body read timed out");
    out.clear();
    tcp.stop();
    return false;
  }
  tcp.stop();

  if (!Dvrip::isJpeg(out.data(), out.size())) {
    // Non-JPEG body here is the documented OPSNAP failure shape
    // (JSON {"Ret":108,...} — channel has no live picture).
    Serial.println("camera: snap response was not a JPEG (Ret:108?)");
    out.clear();
    return false;
  }

  return true;
}
