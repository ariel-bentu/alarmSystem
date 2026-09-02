# Alarm cause → Telegram (2026-08-29) — verified on hardware

An alarm now names what caused it. Both sides write
`/{projectId}/state/alarm_cause` **before** setting `state/siren_active`, and
`onAlarm` — the single notifier for siren-firing alarms — reads it.

Two shapes, and the shape identifies the writer:
- device: `{rfId, ct, at}` — it knows only the rfId, having no rule or sensor
  *names*. `onAlarm` resolves the name and the covering rule.
- server: `{label, at}` — `onSensorEvent` already knows the rule name.

`at` is epoch ms from `time(nullptr)`, NOT `millis()`: `onAlarm` ignores a
cause older than 60s so a stale node cannot mislabel a later alarm.

**Three bugs found here, all worth not repeating:**

1. **`state/siren_active` latches.** `onAlarm` fires on the `false -> true`
   edge, and the firmware only ever wrote `true`. The first device alarm
   worked and every one after it was a silent no-op — the feature worked
   exactly once. `main.cpp` now clears the flag on the falling edge of
   `siren.isActive()` (`CloudClient::clearAlarm()`). If alarms stop
   notifying, check this node first — a stuck `true` is the symptom.
2. **Do not gate the alarm report on `sirenEnabled`.** An early version
   skipped `reportAlarm` when the siren was disabled, reasoning a silent
   alarm needs no alert. That produced no siren AND no Telegram — precisely
   when the message matters most. Disabling the siren is a noise preference.
3. **`serverActions.sendTelegram` and `triggerSiren` are independent.**
   With the siren off, `onAlarm` never runs, so `onSensorEvent` keeps a
   direct send for that case only. Routing everything through `onAlarm`
   would silently kill notifications for siren-disabled projects.

Web UI: the Operations page blinks the profile that tripped (red, on the
side that fired — device or server, inferred from the cause's shape) and
banners the cause. Because the cause node persists after the alarm,
"is there an alarm now" is `cause.at` vs. a per-project acknowledgement in
`localStorage`, not the mere presence of a cause. Disarming acknowledges.

The Operations Siren panel reports *configuration* (`Disabled` /
`Sounding` / `Enabled — not sounding`), not a phantom control — it used to
claim "ACTIVE" with a Force Silence button while the siren was disabled.

**Note on protocol separation:** The Kerui decoder (`kerui_decoder.h`) and
the EV1527 siren encoder (`ev1527_frame.h`) are different protocols sharing
the same CC1101 chip. They must never be validated against each other — the
Kerui decoder reads our own EV1527 frames as garbage by design. Ground truth
for TX is the siren's physical response (two beeps on pairing) or a capture
of a genuine third-party transmitter, not our own receiver.
