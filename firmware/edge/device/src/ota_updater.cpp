#include "ota_updater.h"

#include <Update.h>
#include <esp_ota_ops.h>

#include "platform_compat.h"

// Arduino's initArduino() blesses a PENDING_VERIFY image as soon as it boots
// unless this returns true — which would make rollback a no-op. Returning
// true hands that decision to OtaUpdater::verifyTick(). Declared weak, with C
// linkage, in esp32-hal-misc.c.
//
// Safe for a USB-flashed image: esptool leaves it in an undefined (not
// pending) state, which the bootloader never rolls back.
extern "C" bool verifyRollbackLater() { return true; }

namespace {
constexpr const char* kNvsNamespace = "ota";
constexpr const char* kKeyPending = "pending";
constexpr const char* kKeyNonce = "nonce";
constexpr const char* kStorageHost = "firebasestorage.googleapis.com";

// Path segment -> Storage REST object name: everything but unreserved
// characters is percent-encoded, which turns '/' into %2F as the API needs.
String encodeObjectName(const char* path) {
  static const char* kHex = "0123456789ABCDEF";
  String out;
  for (const char* p = path; *p; ++p) {
    const char c = *p;
    if (isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out += c;
    } else {
      out += '%';
      out += kHex[(c >> 4) & 0xF];
      out += kHex[c & 0xF];
    }
  }
  return out;
}
}  // namespace

void OtaUpdater::beginBoot(const char* runningVersion) {
  prefs_.begin(kNvsNamespace, /*readOnly=*/false);
  String pending = prefs_.getString(kKeyPending, "");
  strncpy(pendingVersion_, pending.c_str(), sizeof(pendingVersion_) - 1);
  hasLastNonce_ = prefs_.isKey(kKeyNonce);
  lastNonce_ = prefs_.getUInt(kKeyNonce, 0);

  bootKind_ = classifyOtaBoot(pendingVersion_, runningVersion);

  // The bootloader's own state is the stronger signal: an image it considers
  // unverified MUST be verified, or it is rolled back on the next reset no
  // matter what NVS says (e.g. the NVS write before the restart failed).
  esp_ota_img_states_t state;
  const esp_partition_t* running = esp_ota_get_running_partition();
  const bool pendingVerify =
      esp_ota_get_state_partition(running, &state) == ESP_OK &&
      state == ESP_OTA_IMG_PENDING_VERIFY;
  if (pendingVerify) bootKind_ = OtaBootKind::Verifying;
  verifying_ = bootKind_ == OtaBootKind::Verifying;

  Serial.printf("[ota] running %s on %s, pending='%s', boot=%s%s\n",
                runningVersion, running ? running->label : "?", pendingVersion_,
                bootKind_ == OtaBootKind::Normal      ? "normal"
                : bootKind_ == OtaBootKind::Verifying ? "verifying"
                                                      : "rolled_back",
                pendingVerify ? " (bootloader: pending verify)" : "");
}

void OtaUpdater::markHandled(uint32_t nonce) {
  prefs_.putUInt(kKeyNonce, nonce);
  hasLastNonce_ = true;
  lastNonce_ = nonce;
}

void OtaUpdater::clearPending() {
  prefs_.remove(kKeyPending);
  pendingVersion_[0] = '\0';
}

OtaUpdater::VerifyResult OtaUpdater::verifyTick(uint32_t uptimeMs, bool healthy) {
  if (!verifying_) return VerifyResult::NotVerifying;
  switch (otaVerifyStep(uptimeMs, healthy)) {
    case OtaVerifyAction::Wait:
      return VerifyResult::Waiting;
    case OtaVerifyAction::MarkValid: {
      esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
      Serial.printf("[ota] image verified healthy, marked valid (%s)\n",
                    esp_err_to_name(err));
      verifying_ = false;
      return VerifyResult::MarkedValid;
    }
    case OtaVerifyAction::RollBack: {
      Serial.println("[ota] image never reached the cloud — rolling back");
      Serial.flush();
      // Leaves the pending record in NVS: the previous image reads it, sees a
      // version that is not its own, and reports the rollback.
      esp_err_t err = esp_ota_mark_app_invalid_rollback_and_reboot();
      // Only returns if there is nothing valid to go back to. Keeping a
      // possibly-broken image beats bricking, so bless it and carry on.
      Serial.printf("[ota] rollback impossible (%s) — keeping this image\n",
                    esp_err_to_name(err));
      esp_ota_mark_app_valid_cancel_rollback();
      verifying_ = false;
      return VerifyResult::MarkedValid;
    }
  }
  return VerifyResult::Waiting;
}

void OtaUpdater::closeClient() {
  if (client_) {
    client_->stop();
    delete client_;
    client_ = nullptr;
  }
}

void OtaUpdater::fail(String* err, const String& why) {
  if (Update.isRunning()) Update.abort();
  closeClient();
  Serial.printf("[ota] FAILED: %s\n", why.c_str());
  if (err) *err = why;
}

bool OtaUpdater::start(const OtaRequest& req, const char* bucket,
                       const String& idToken, String* err) {
  if (active() || installed_) {
    if (err) *err = "busy";
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (err) *err = "wifi down";
    return false;
  }
  if (idToken.length() == 0) {
    if (err) *err = "no auth token";
    return false;
  }
  req_ = req;
  received_ = 0;

  client_ = new WiFiClientSecure();
  // TODO(security): pin Google's root CA instead of setInsecure(), as the
  // mint path's TODO also says. The image's integrity does not rest on this —
  // Update.setMD5() rejects any byte that differs from the published md5 —
  // but the md5 itself arrives over an equally unpinned RTDB connection.
  client_->setInsecure();
  // Both SECONDS on ESP32 — see cloud_client.cpp's note on the units.
  client_->setHandshakeTimeout(10);
  client_->setTimeout(10);

  platformFeedWatchdog();
  Serial.printf("[ota] connecting for %s (%u bytes)\n", req_.version,
                (unsigned)req_.size);
  if (!client_->connect(kStorageHost, 443)) {
    fail(err, "connect failed");
    return false;
  }
  platformFeedWatchdog();

  // HTTP/1.0 on purpose: it rules out chunked transfer encoding, so the body
  // is exactly the image bytes and nothing here needs to de-chunk.
  String request = String("GET /v0/b/") + bucket + "/o/" +
                   encodeObjectName(req_.path) +
                   "?alt=media HTTP/1.0\r\n"
                   "Host: " + kStorageHost + "\r\n"
                   "Authorization: Firebase " + idToken + "\r\n"
                   "Connection: close\r\n\r\n";
  client_->print(request);

  // Headers: bounded and fed, like the mint's response loop.
  int status = 0;
  long contentLength = -1;
  bool firstLine = true;
  String line;
  unsigned long start = millis();
  for (;;) {
    if (millis() - start > kHeaderTimeoutMs) {
      fail(err, "header timeout");
      return false;
    }
    if (!client_->available()) {
      if (!client_->connected()) {
        fail(err, "closed before headers");
        return false;
      }
      platformFeedWatchdog();
      delay(5);
      continue;
    }
    char c = (char)client_->read();
    if (c == '\r') continue;
    if (c != '\n') {
      if (line.length() < 512) line += c;
      continue;
    }
    if (line.length() == 0) break;  // end of headers
    if (firstLine) {
      int sp = line.indexOf(' ');
      status = sp > 0 ? line.substring(sp + 1, sp + 4).toInt() : 0;
      firstLine = false;
    } else if (line.substring(0, 15).equalsIgnoreCase("content-length:")) {
      contentLength = line.substring(15).toInt();
    }
    line = "";
  }

  if (status != 200) {
    fail(err, String("http ") + status);
    return false;
  }
  if (contentLength >= 0 && (uint32_t)contentLength != req_.size) {
    fail(err, String("size mismatch: server ") + contentLength + ", manifest " +
                  req_.size);
    return false;
  }

  if (!Update.begin(req_.size, U_FLASH)) {
    fail(err, String("begin: ") + Update.errorString());
    return false;
  }
  if (!Update.setMD5(req_.md5)) {
    fail(err, "bad md5");
    return false;
  }
  lastByteMs_ = millis();
  Serial.printf("[ota] downloading %s\n", req_.version);
  return true;
}

OtaUpdater::TickResult OtaUpdater::tick(String* err) {
  if (!active()) return TickResult::Idle;

  const unsigned long sliceStart = millis();
  while (received_ < req_.size && millis() - sliceStart < kTickBudgetMs) {
    int avail = client_->available();
    if (avail <= 0) break;
    size_t want = (size_t)min<uint32_t>(sizeof(buf_), req_.size - received_);
    if ((size_t)avail < want) want = (size_t)avail;
    int n = client_->read(buf_, want);
    if (n <= 0) break;
    if (Update.write(buf_, (size_t)n) != (size_t)n) {
      fail(err, String("write: ") + Update.errorString());
      return TickResult::Failed;
    }
    received_ += (uint32_t)n;
    lastByteMs_ = millis();
  }

  if (received_ >= req_.size) {
    closeClient();
    // end() checks the md5 and only then switches the boot partition, so a
    // corrupt or substituted image never becomes bootable.
    if (!Update.end()) {
      fail(err, String("verify: ") + Update.errorString());
      return TickResult::Failed;
    }
    installed_ = true;
    Serial.printf("[ota] %s written and verified\n", req_.version);
    return TickResult::Done;
  }

  if (!client_->connected() && client_->available() <= 0) {
    fail(err, String("connection closed at ") + received_ + "/" + req_.size);
    return TickResult::Failed;
  }
  if (millis() - lastByteMs_ > kStallTimeoutMs) {
    fail(err, String("stalled at ") + received_ + "/" + req_.size);
    return TickResult::Failed;
  }
  return TickResult::Running;
}

void OtaUpdater::restartIntoNewImage() {
  prefs_.putString(kKeyPending, req_.version);
  prefs_.end();
  Serial.printf("[ota] restarting into %s\n", req_.version);
  Serial.flush();
  delay(200);
  ESP.restart();
  for (;;) {
  }
}
