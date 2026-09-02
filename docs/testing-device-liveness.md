# Testing: watchdog, boot reporting, offline alerts

What to verify for the work on branch `device-liveness-watchdog`
(commits `6de8504`, `0a38799`, `76dcf5a`, `dee6bd8`).

Nothing here has been tested on real hardware or against deployed
functions — it is verified only by unit tests, typecheck and a successful
build. Everything below is untested in production.

## 0. Deploy first

The code and production are **out of sync** until this runs. The commits are
on a branch and the functions are NOT deployed.

```bash
firebase deploy --only functions --project alarm-system-100
```

**The CLI will ask to DELETE `scheduleTick` and `deadSensorCheck`.** That is
expected and correct — their code now lives inside `doSchedule`. Confirm it.

Then flash the device:

```bash
cd firmware/edge/device
pio run -e esp32s3 -t upload --upload-port /dev/cu.usbmodem101   # check ls /dev/cu.*
python3 ../read_serial.py 60 --port /dev/cu.usbmodem101
```

Sanity check after deploying — exactly one scheduled function should remain:

```bash
firebase functions:list --project alarm-system-100 | grep -c scheduled   # expect 1
```

## 1. Boot reason reporting

**Expect on the serial console at boot:**

```
Alarm system device booting... (last reset: power_on)
```

then, once the cloud is up: `cloud: reportBoot reason=power_on ok (code 0)`

**Verify it reached RTDB:**

```bash
firebase database:get /acdc2394-e5c3-4c7e-af07-b920e7b246d6/state/boot \
  --project alarm-system-100
```

Expect `{"reason":"power_on","at":<epoch ms>}`.

⚠️ If `at` is near 0, NTP had not synced when it was written. The `reason` is
still valid; only the timestamp is unusable, and the web banner deliberately
ignores an undatable record.

**Reasons you should see:** `power_on` after an unplug, `external` after the
reset button, `sw_restart` after the 2h WiFi reboot, `panic` after a crash,
`twdt` after the watchdog catches a hang.

## 2. Task watchdog

This is the important one and it needs a deliberate hang, since no known
reproduction of the original fault exists.

**Temporary test code** — add to `loop()` in `main.cpp`, flash, then REMOVE:

```cpp
if (millis() > 60000) { while (true) { } }   // hang after 1 minute
```

**Expect:** at ~60s the board stops responding, and ~30s later it reboots on
its own. The next boot prints `(last reset: twdt)` and a panic backtrace.
Before this change it would have hung forever.

**Regression check (matters more than the positive case):** run the device
normally for 10+ minutes and confirm it does NOT reboot. The watchdog must
never fire during legitimate slow work — a WiFi connect (15s), the mint
response wait (15s), or siren pairing (10s, blocking). Specifically:

- Trigger a siren pairing from the web UI and confirm no reboot during the
  10s window.
- Let a mint fail (e.g. briefly block internet) and confirm the retry path
  does not trip the watchdog.

## 3. WiFi supervision

**Test 1 — recovery (the common case).** With the device online, power off
your router for ~3 minutes, then back on.

Expect on serial:
```
[wifi] link DOWN (status=…) — alarm still armed locally, waiting for auto-reconnect
[wifi] down 2min — nudging reconnect
[wifi] link restored after 190s (IP 192.168.0.x)
```

**It must NOT reboot.** A reboot here is a bug — an offline device still
protects the premises, and restarting it costs unwatched time.

**Test 2 — local alarm survives the outage.** While WiFi is still down,
trigger a real sensor. The siren must fire and the LAN web server must still
serve on the device's IP. This is the property that justifies the 2h delay.

**Test 3 — the 2h reboot.** Only worth testing if you have patience: leave
WiFi off for 2h and confirm one reboot, then `(last reset: sw_restart)`.
Lower `kWifiDownRebootMs` in `main.cpp` temporarily to check it faster.

## 4. Device offline alert (Telegram)

⚠️ **First heartbeat resets everything.** `device.lastSeen` currently holds a
stale value from the retired `deviceIngest` path (~Aug 18), which is why the
first alert said `14d 11h`. That figure is meaningless. Once the device
connects and `onHeartbeat` fires once, all durations become real.

**Test A — armed, 5 minutes.**
1. Arm the device (any profile, device side).
2. Cut its power.
3. Within ~6 minutes expect:
   `📵 Alarm device offline while ARMED — no heartbeat for 5m`
4. Wait another 10 minutes and confirm **no repeat** — the latch should make
   one outage send exactly one message.

**Test B — back online.**
5. Power the device back up.
6. Within ~1 minute expect:
   `✅ Alarm device back online — was offline for 16m`
7. Confirm `device.offlineAlertSentAt` is gone from the project doc.

**Test C — disarmed is quieter.**
8. Disarm, then cut power for ~15 minutes.
9. Expect **no alert** (threshold is 2h while disarmed).
10. Optionally leave it >2h and confirm the alert does arrive — disarmed is
    quieter, not silent.

## 5. Scheduler consolidation

The riskiest change, because it replaces the machinery that arms your house.

**Verify scheduled arming still works** — this is a regression test of
existing behaviour, not of new code:

1. Create a schedule a few minutes ahead (device side).
2. Confirm it arms at the right local time, the Operations UI updates, and
   the Telegram arm notice arrives.
3. Confirm the disarm edge fires too.

**Verify the daily job still runs.** `deadSensorCheck` now fires from the
table at local noon. After a noon passes:

```bash
firebase functions:log --only doSchedule --project alarm-system-100 \
  | grep "Dead sensor"
```

**Verify the dispatcher logs each due task:**

```bash
firebase functions:log --only doSchedule --project alarm-system-100 | tail -20
```

Expect `Scheduled Task Fire due arm/disarm schedule edges` every minute, and
no `doSchedule: N task(s) failed`.

**Timezone check.** Times in the table are Asia/Jerusalem. The daily noon
entry was verified against both DST offsets in a unit test, but confirm the
real run lands at local noon, not 13:00.

## 6. Web UI restart banner

1. Cause an unexpected restart (the section 2 hang test, or pull power while
   it is mid-write to get a `panic`).
2. On Operations expect a warning banner: *"Device restarted — Recovered
   from a freeze"* with a timestamp.
3. Dismiss it and reload — it must stay dismissed.
4. Cause another restart and confirm a NEW banner appears.
5. Confirm an ordinary unplug (`power_on`) shows **no** banner.

## Known gaps

- The original hang has no known reproduction, so the watchdog is verified
  against a synthetic hang only.
- `RelaySiren` remains untested (the RF path supersedes it).
- `commands/armed` is currently `true` while `state/armed` is `false`, so
  the device will arm as soon as it reconnects. Expect an arm notification.
