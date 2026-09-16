# Security

This project is a hobbyist alarm system. It is **not** a certified security
product and holds no UL, EN 50131, or equivalent listing. This document is an
honest account of what it does and does not protect against, plus the specific
weaknesses that are known and unfixed.

Read this before deploying it anywhere that matters.

## Threat model

### What it is designed to handle

- **A door or window opened while armed.** The core case. Works with no
  internet connection.
- **Cloud outage.** Arm state, config, and the siren address live in EEPROM.
  A device that cannot reach Firebase still detects intrusion and sounds the
  siren. WiFi loss is treated as normal, not as an error.
- **Device hang.** A 30-second task watchdog reboots on a stall, and the device
  reports why it last restarted.
- **A dead or silent sensor.** A daily check alerts on sensors that have gone
  quiet, catching a flat battery or one that has been removed.
- **An attacker pairing their own remote.** Remote pairing is refused while the
  system is armed, so someone in RF range cannot pair a fob against a live
  system and disarm it. Paired remotes are also routed away from the rule
  engine entirely, so a remote can never trigger an alarm or pose as a sensor.

### What it explicitly does not handle

- **RF jamming.** A continuous 433MHz carrier drowns out every sensor, and the
  device does not currently detect that it has gone deaf. This is the single
  largest gap and it applies to most consumer 433MHz alarms, not just this one.
- **Replay and spoofing.** Kerui sensors transmit a fixed 24-bit code with no
  rolling code or authentication. Anyone who captures one transmission can
  replay it indefinitely. This is a property of the sensor hardware and cannot
  be fixed on the receiving end.
- **Remote-control replay — this one disarms the system.** Key-fob remotes are
  the same fixed-code family, so capturing a single press of the disarm button
  is enough to disarm the alarm from RF range, at any time, forever. If you
  pair a remote you are accepting that risk. It is inherent to every fixed-code
  433MHz fob, not specific to this project, but it is worth being explicit
  about: **a paired remote is the cheapest way to defeat this system.** Pair
  none if your threat model includes a motivated attacker.
- **Tampering.** No enclosure tamper switch on the device, and sensor tamper
  reporting is not implemented.
- **A hostile LAN.** See below — this is deliberate but it is a real exposure.
- **Power loss.** No battery backup. Arm state survives in EEPROM, but a device
  with no power detects nothing.

### The local web server has no authentication

This is a deliberate design decision, not an oversight. `http://alarm.local`
exposes arm, disarm, and a sensor simulator to **anyone on the LAN**, with no
credentials. It exists so the alarm is controllable when the internet is down
and the cloud path is unavailable.

The consequence: anyone who reaches your network — a guest, a compromised IoT
device, an unpatched router — can disarm the alarm. If your LAN is not
trusted, disable the local server (it is toggleable and the setting persists in
EEPROM) and accept losing offline control.

## Known issues

These are real defects found in review and not yet fixed. They are listed here
rather than hidden because anyone deploying this deserves to know.

### Critical

**`count_in_window` with N > 8 can never fire.** `kMaxTriggerHistory` is 8, so
the trigger counter saturates at 8 and a rule requiring 9 or more triggers is
never satisfied. The alarm silently never fires, from a configuration the web
UI accepts without complaint. The same ceiling applies to `multi_sensor`
per-participant counts.
*Files:* `alarm_state.h`, `alarm_state.cpp`
*Workaround:* keep all counts at 8 or below.

### High

**A device can report healthy while unable to write anything.** If the data
client fails to open at the moment auth completes (a transient low-memory
condition), it is never retried, and every event, alarm, and clear for the rest
of that session is a permanent no-op. Heartbeats may still succeed, so the
device shows as online and the operator sees no problem.
*Files:* `cloud_client.cpp`
*Impact:* a silent alarm — the siren still sounds locally, but no alert is sent.

**"Online" does not mean "functional."** Offline alerting keys entirely off
heartbeat freshness. A device that can heartbeat but cannot write events is
indistinguishable from a healthy one.

**Remote pairing blinds the alarm for 10 seconds.** Siren pairing spins for 10s
transmitting, during which the receiver is off and no rules are evaluated. It
can be triggered by a cloud command, the expiry guard is bypassed when NTP has
not synced, and there is no check that the system is disarmed first.
*Files:* `main.cpp`

**Watchdog return codes are ignored, and it only watches one task.** If the
task watchdog was already initialised by the core, the configured timeout is
silently not applied. Only `loopTask` is subscribed — a hang in the network or
Firebase task would not trip it, and a wedged network stack is exactly the
failure class most suspected historically.
*Files:* `platform_compat.h`

### Medium

- **Event key collisions before NTP sync.** Event keys are `time(nullptr)*1000`,
  which has 1-second resolution and returns near-zero before sync. Multiple
  events in the same pre-sync second overwrite each other — a narrow but real
  data-loss window right after a watchdog reboot.
- **A small ISR race** in the receiver's fast-path checks, which read
  `edgeCount_`/`lastEdgeMs_` while the interrupt is still attached. Effect is
  benign (a slightly early or late drain), but `volatile` alone is not a
  critical section on ESP32.
- **Latent TX buffer overflow.** Buffer sizing and the repeat clamp are
  correct today but are held in sync only by convention, with no
  `static_assert` tying them together.

### By design, not bugs

- **No event buffering.** Events occurring during a cloud outage are lost. The
  siren still fires; only the record is lost.
- **The trigger endpoint accepts arbitrary sensor IDs.** Part of the
  unauthenticated LAN simulator described above.
- **Unknown sensor IDs are logged, never dropped.** The pairing UI reads them
  from the event log. They are ignored for alarm logic until you name them.

## Credentials and deployment

- **Never commit secrets.** `platformio.local.ini`, `web/.env.local`, and
  `local_secrets.h` are gitignored and each ships with an `.example` template.
- **The Firebase web API key is not a secret** — it is public by design in any
  browser app. Your actual protection is Firestore and RTDB security rules.
  Review `firestore.rules` and `database.rules.json` before deploying.
- **Device auth** uses an API key exchanged for a scoped Firebase custom token
  via the `mintDeviceToken` function. Device access is restricted per project
  by the database rules. The older `deviceIngest` path is legacy and is only
  used by the emulator smoke tests.
- **Access is invite-only.** There is no open sign-up. Users must be created
  explicitly.

## Reporting a vulnerability

Open a GitHub issue for anything already documented above. For a novel
vulnerability — particularly one that would let an attacker disarm or silence a
deployed system — please use GitHub's private vulnerability reporting
("Report a vulnerability" under the Security tab) rather than a public issue.

This is a personal project maintained in spare time. There is no SLA, and
there may be no fix. Assume the issues above are present unless the code says
otherwise.
