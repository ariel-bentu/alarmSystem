#pragma once

// Decides whether RelaySiren::turnOff() should actually transmit.
//
// WHY THIS EXISTS: the siren answers arm/disarm commands with a short ack
// beep (measured on hardware — see docs/history/siren-hub-free.md's command
// table). turnOff() transmits kCmdDisarm unconditionally, so the beep was
// audible in two situations where the user had explicitly asked for silence:
//
//   1. Every power-on. The first /commands poll after boot sees the stored
//      "siren": false and, having no previous value to compare against,
//      treats it as a fresh change -> turnOff() -> beep. Nothing was
//      sounding; the command was pure noise. (Fixed separately, in
//      applyCommandsJson's first-poll adoption.)
//   2. Every disarm while sirenEnabled was false.
//
// The rule: no RF while the siren is disabled, with ONE exception — if the
// siren is CURRENTLY SOUNDING the stop always goes out. That transmission is
// not an ack beep, it is the only thing that silences an RF siren, which
// sounds until told to stop. A sounding siren also proves the siren was
// enabled when it started, so honouring the stop cannot resurrect a beep the
// user disabled.
//
// Pure and header-only so it is native-testable without Arduino — same split
// as config_parser / remote_control / auth_supervisor.

/**
 * @param sirenEnabled  the user's "may this siren make noise" preference
 * @param sirenActive   true while the siren is actually sounding
 */
inline bool shouldTransmitSirenStop(bool sirenEnabled, bool sirenActive) {
  // Always silence a sounding siren, whatever the preference now says.
  if (sirenActive) return true;
  // Otherwise this would only ever be an ack beep, which a disabled siren
  // must not make.
  return sirenEnabled;
}
