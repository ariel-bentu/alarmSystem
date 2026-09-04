#pragma once

#include <cstdint>

// Decides WHEN a device that has already authenticated must throw its
// credentials away and mint a completely new token.
//
// This exists because of a real field failure: the device went silent for
// 31.76h and 28h on separate occasions, and was caught live on 2026-09-04
// having written nothing to the cloud for 12+ minutes while the task
// watchdog never fired. Nothing was hung. `CloudClient::tokenMinted_` was
// set true on the first successful mint and never reset, so once
// FirebaseApp::ready() went false the re-mint path — guarded by
// `if (!tokenMinted_)` — could never run again. loop() kept feeding the
// watchdog, kept decoding RF and serving the LAN UI, and kept returning
// early from the cloud path forever. Only a power cycle recovered it.
//
// The watchdog is structurally incapable of catching that shape: it watches
// for a BLOCKED loopTask, and this failure leaves loopTask perfectly
// healthy. So the recovery has to be an explicit policy, which is what this
// is. Kept free of Arduino/FirebaseClient types so it is native-testable —
// the same reason config_parser and remote_control are split out.
//
// Time is passed in rather than read, so tests drive it directly.

// How long ready() may stay false before we stop believing it will recover
// on its own.
//
// NOT zero, and not seconds. FirebaseApp drops ready() briefly during every
// ordinary ID-token refresh (~hourly), and re-minting on that edge would
// throw away a perfectly good session once an hour and hammer the mint
// endpoint. The grace period has to outlast a normal refresh by a wide
// margin while still being far shorter than the hours of silence this bug
// produced in the field.
inline constexpr uint32_t kReauthGraceMs = 15UL * 60UL * 1000UL;  // 15 min

// A re-mint attempt can itself fail (that is the normal case when the AP is
// down). Retry on a slow cadence rather than every loop iteration: the mint
// is a full TLS handshake and the most expensive thing the firmware does.
inline constexpr uint32_t kReauthRetryMs = 60UL * 1000UL;  // 1 min

// Tracks how long the app has been un-ready and answers one question:
// should we force a fresh mint right now?
//
// Usage in CloudClient::loop(), once per iteration:
//   supervisor.noteReady(appReady, now);
//   if (supervisor.shouldForceReauth(now, wifiUp)) { ...reset and re-mint... }
class AuthSupervisor {
 public:
  // Report the CURRENT ready state, every iteration.
  //
  // A ready app clears the timer outright: any recovery, however brief,
  // means the session healed itself and the grace period starts over.
  void noteReady(bool ready, uint32_t nowMs) {
    if (ready) {
      notReadySinceMs_ = 0;
      pending_ = false;
      return;
    }
    // First iteration of an outage — start the clock. Guarded so a
    // continuing outage does not keep resetting its own start time.
    if (notReadySinceMs_ == 0) {
      // 0 doubles as "not tracking", so an outage that legitimately begins
      // at millis()==0 is nudged to 1. Costs a millisecond of accuracy once
      // per boot and avoids a sentinel collision that would disable the
      // whole supervisor for the first outage after power-on.
      notReadySinceMs_ = (nowMs == 0) ? 1 : nowMs;
    }
  }

  // True when the caller should discard credentials and mint again.
  //
  // Gated on wifiUp because a re-mint without a network cannot possibly
  // succeed: it would burn a TLS handshake attempt every retry interval
  // through a router outage, on a device whose whole design point is that
  // it keeps working offline. superviseWifi() owns that failure; this owns
  // only the case where the link is fine and the credentials are not.
  bool shouldForceReauth(uint32_t nowMs, bool wifiUp) {
    if (notReadySinceMs_ == 0) return false;  // ready, nothing to do
    if (!wifiUp) return false;
    if (nowMs - notReadySinceMs_ < kReauthGraceMs) return false;
    // Past the grace period. Fire once now, then only every kReauthRetryMs
    // until ready() comes back.
    if (pending_ && nowMs - lastAttemptMs_ < kReauthRetryMs) return false;
    pending_ = true;
    lastAttemptMs_ = nowMs;
    return true;
  }

  // Exposed for the heartbeat log, so a device sliding toward a re-mint is
  // visible in the serial trace BEFORE it happens.
  uint32_t notReadyForMs(uint32_t nowMs) const {
    return notReadySinceMs_ == 0 ? 0 : nowMs - notReadySinceMs_;
  }

 private:
  // millis() when ready() first went false; 0 means "currently ready".
  uint32_t notReadySinceMs_ = 0;
  // True once we have forced at least one re-mint for THIS outage, which
  // switches the decision from the grace period to the retry cadence.
  bool pending_ = false;
  uint32_t lastAttemptMs_ = 0;
};
