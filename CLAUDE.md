# Alarm System — Project Context

A self-owned home alarm system replacing dependency on the Tuya/Kerui cloud.
The existing Kerui W184 hub and sensors stay in place during the transition —
the new system runs in parallel.

**Detailed history lives in `docs/history/`.** Those files hold measurements
that cost days to establish; read the relevant one before re-investigating
anything it covers. Do not re-litigate their conclusions without new evidence.

## Hardware

| Component | Status | Notes |
|---|---|---|
| ESP32-S3 | **Current edge controller** | 8MB PSRAM, 16MB flash, native USB |
| ESP8266 D1 Mini | **ABANDONED** | Too little RAM — [why](docs/history/esp8266-abandoned.md). Does not compile |
| CC1101 433MHz | Wired, working | RF receive + transmit confirmed |
| Kerui W184 hub | Keep running | on the LAN (see `.local-info`), until decommissioned |
| Kerui sensors | Untouched | 433MHz, 24-bit OOK |
| Siren (YF-SG-081) | Paired over RF | EV1527 via CC1101, hub-free |

Wiring: `docs/hardware-wiring.md` (includes ESP32-S3 pins that must NOT be used).

## Architecture

**Edge** (`firmware/edge/device`, PlatformIO `[env:esp32s3]`) — runs on real
hardware: decodes Kerui packets, evaluates alarm rules, drives the siren over
RF, reports to Firebase.

- Continuous 433MHz receive (`Cc1101Receiver`, interrupt-driven) → `kerui_decoder.h`
  → `kerui_event.h` splits each 24-bit code into a **20-bit family** (the
  sensor) and a **4-bit event nibble** (what it did)
- Arm state + config + siren address persisted to EEPROM (`EepromStore`) —
  survives power loss and WiFi outage
- `AlarmState` evaluates conditions; fires siren via RF (`ev1527_frame.h`)
- WiFi **optional**: when up, `CloudClient` mints a Firebase custom token and
  polls commands/config every 5s, 1s while alarming (polling, not SSE)
- **Local web server** (`http://alarm.local`, LAN-only, no auth): arm/disarm +
  sensor simulator, works fully offline. Toggle persisted in EEPROM
- Task watchdog (30s) reboots on a hang; `state/boot` reports why it last
  restarted — see [watchdog notes](docs/history/watchdog-and-offline-alerts.md)

**Firebase** — project `alarm-system-100`, region `europe-west1`.

- **RTDB**: events, state, config, commands (namespaced per project)
- **Firestore**: users, projects, sensors, profiles, rules, schedules, timeline
- **Functions**: `deviceIngest` (legacy), `mintDeviceToken` (device auth),
  event mirroring, server-side alarm evaluation, config sync, Telegram alerts,
  `doSchedule` (see below)
- **Hosting**: https://alarm-system-100.web.app

**Telegram** — alerts for sensor trigger, alarm, battery low, dead sensor,
device offline/back-online. Commands `/arm /disarm /status /siren off`.
⚠️ **Webhook not registered yet**, so commands do not work (`todo.txt`).

## Scheduled work — ONE function only

`doSchedule` (`functions/src/doSchedule.ts`) is the **only** scheduled
function: it runs every minute and dispatches a declarative cron-style table
(`min`/`hour`/`weekDay`, resolved in Asia/Jerusalem).

**Cloud Scheduler allows only 3 free jobs per BILLING ACCOUNT. Do not add
another `onSchedule()` — add a row to the table instead.** Current tasks:
schedule edges (every minute), device liveness (every minute), dead sensors +
event retention (daily noon).

## Sensor Trigger Conditions

Rules live under a profile; a profile is armed independently on device and
server. Rules are OR'd; a sensor may appear in several rules.

- `immediate` — single trigger fires
- `count_in_window` — N triggers within W seconds
- `entry_delay` — grace period to disarm
- `multi_sensor` — several sensors, each with a required count, all within
  one shared window (AND)
- `always` — single-sensor immediate rules that fire even while disarmed

Only a `trigger` is fed to the rules. The other event types bypass them
entirely and each behaves one deliberate way:

| Event | Siren | Telegram | Rules |
|---|---|---|---|
| `trigger` | via rules | via rules | yes |
| `tamper` | **yes, even while disarmed** (paired sensors only) | always | no |
| `water` | no | once per condition | no |
| `battery_low` | no | once per condition | no |
| `close` | no | no | no — timeline only |

"Once per condition" means a marker on the sensor doc (`waterAlertSentAt`,
`batteryAlertSentAt`) that the next normal trigger clears, the same shape
`deadAlertSentAt` uses. Tamper sirens while disarmed because that is the
threat — sensors are disabled while the house is empty. Accepted cost: a
battery change sounds the siren; silence it with Disarm.

## Firebase Data Layout

```
/{projectId}/events/{rfId}/{timestamp}  → { event, battery_low, rssi }
/{projectId}/state/armed                → bool
/{projectId}/state/siren_active         → bool   (latches — see history doc)
/{projectId}/state/alarm_cause          → { rfId, ct, at } | { label, at }
/{projectId}/state/last_seen            → device UPTIME seconds, NOT epoch
/{projectId}/state/boot                 → { reason, at }
/{projectId}/commands/{armed,siren,pair}
/{projectId}/config                     → { a, d, r, c }  thin, index-based
```

Firestore: `/users/{email}`, `/deviceKeys/{apiKeyHash}`, `/projects/{projectId}`
with `members`, `sensors`, `profiles/{id}/rules`, `schedules`, `events`, and
`secrets/notify` (server-only: Pushover credentials, `read, write: if false`).

**Device auth:** `mintDeviceToken` (API-key → Firebase custom token, scoped
per project by `database.rules.json`). This is the real firmware's path.
`deviceIngest` is legacy, still used by `smoke/`.

## Project Structure

```
firmware/edge/
  kerui_decoder.h        ← Kerui 433MHz decode + KeruiPacket
  device/                ← main firmware (PlatformIO)
    src/                 ← main.cpp, alarm_state, cloud_client, cc1101_receiver,
                           ev1527_frame, eeprom_store, local_web_server,
                           provisioning_portal, platform_compat, siren_address,
                           kerui_event
    test/                ← native Unity tests (169 tests, 14 suites)
  spike_*/               ← throwaway diagnostic sketches, kept as known-good controls
web/                     ← React + TypeScript (Vite), Firebase Hosting
functions/               ← Cloud Functions (TypeScript, gen-2)
smoke/                   ← emulator smoke tests
docs/history/            ← dated investigation records (see below)
docs/superpowers/        ← design specs and implementation plans
```

**Public-facing docs** (this repo is published): `README.md` is the entry
point, `SECURITY.md` holds the threat model AND the known-issues list (the
firmware-review findings that used to sit in `todo.txt` — keep them in sync
when one is fixed), `CONTRIBUTING.md` covers tests and house rules, MIT
`LICENSE`. Keep real IPs, MACs, and project IDs out of tracked files.

## Commands

```bash
# Firmware. ALWAYS pass -e esp32s3: a bare `pio run` also builds [env:native],
# which fails to link. Check `ls /dev/cu.*` — macOS reassigns the suffix.
#
# The esp32s3 build runs `patch_firebase.py` first, which patches FirebaseClient
# in .pio/libdeps (gitignored, so re-applied after every install). If a library
# update moves the code it anchors on, the patch FAILS THE BUILD by design —
# see docs/upstream/ISSUE.md and update the anchors rather than removing it.
cd firmware/edge/device
pio run -e esp32s3 -t upload --upload-port /dev/cu.usbmodem101
pio test -e native
python3 ../read_serial.py 40 --port /dev/cu.usbmodem101   # --port is REQUIRED

# Decode a crash address
~/.platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-addr2line \
  -pfiaC -e .pio/build/esp32s3/firmware.elf 0x42000abc

# Bench testing over LAN
curl -s http://alarm.local/status
curl -s -X POST "http://alarm.local/trigger?rfId=0x2E5B73"

# Web / functions
cd web && npm run lint && npm test && npm run build
cd functions && npx tsc --noEmit && npx vitest run && npm run build
```

## History / investigation records

Read the relevant file before re-investigating. Each records what was
measured, what was ruled out, and the traps that wasted time.

| Doc | Covers |
|---|---|
| [esp8266-abandoned](docs/history/esp8266-abandoned.md) | Why the D1 Mini was dropped: cont-stack exhaustion, TLS budget, heap fragmentation |
| [esp32-s3-port](docs/history/esp32-s3-port.md) | The port that unblocked event writes; ESP32 gotchas (USB CDC, PSRAM, partitions) |
| [cc1101-receive](docs/history/cc1101-receive.md) | Kerui protocol timing, interrupt-based decode |
| [cc1101-transmit](docs/history/cc1101-transmit.md) | TX via FIFO not GDO0, FREND0, the gap-not-pulse finding |
| [siren-hub-free](docs/history/siren-hub-free.md) | Clean-room EV1527 that actually drives the siren; pairing and command codes |
| [alarm-cause-telegram](docs/history/alarm-cause-telegram.md) | Naming what caused an alarm; the `siren_active` latch bug |
| [watchdog-and-offline-alerts](docs/history/watchdog-and-offline-alerts.md) | The 28h silent death, watchdog, boot reporting, offline alerts |
| [cloud-auth-silent-death](docs/history/cloud-auth-silent-death.md) | Dead auth session the watchdog cannot see; why `tokenMinted_` was a one-way latch |
| [tls-handshake-watchdog-reboot](docs/history/tls-handshake-watchdog-reboot.md) | The `twdt` reboots: 120s TLS handshake default vs a 60s watchdog; `vTaskDelay` does not feed the TWDT |
| [firebaseclient-sync-read-timeout](docs/history/firebaseclient-sync-read-timeout.md) | Why `setSyncReadTimeout` could never fire; the local library patch; two wrong fixes first (fd sentinel is 0, not -1) |

**Testing guide:** `docs/testing-device-liveness.md` — what to verify for the
watchdog / offline-alert work (untested on hardware as of 2026-09-02).

## Key Decisions

- **WiFi independence**: alarm logic never depends on the cloud. EEPROM holds
  arm state and config. An offline device still protects the premises — this
  is why the WiFi-loss reboot waits 2h, not minutes.
- **No event buffering v1**: events lost during an outage are acceptable.
- W184 hub stays running in parallel until fully replaced.
- Unknown sensor IDs: logged to RTDB (never dropped — the pairing UI reads
  them from `/events`), ignored for alarm logic until named.
- **A sensor is its 20-bit family, not its 24-bit code.** The bottom nibble
  is an EVENT code, so one physical sensor emits several codes (motion
  `0x0061DA`, tamper `0x0061DB`). Matching is by family everywhere
  (`Sensor.familyId`, `SensorConfig::familyId`, RTDB config `r`); the FULL
  code is still what `/events/{rfId}` is keyed by, because the event code is
  the information the pairing UI needs. The nibble table is duplicated in
  three languages on purpose (`kerui_event.h`, `functions/src/keruiEvent.ts`,
  `web/src/features/configure/keruiEvent.ts`) and a cloud test asserts the
  three agree by value. **No sensor TYPE is derived from it** — `0x9` means
  beam-cut on curtains and door-open on `0x2E5B7`, so it cannot identify a
  device class. See the design doc under `docs/superpowers/specs/`.
- Device-facing RTDB config is thin and index-based (`{a,d,r,c}`) to minimise
  bandwidth, not the verbose named-key shape in early design docs. `r` holds
  families, not full rfIds.
- Local web server (LAN, no auth) is deliberate, toggleable via EEPROM.
- **Most heap/RAM/TLS comments in the firmware describe the ESP8266** and are
  NOT constraints on the S3 (258KB free vs ~5KB). Check which board a comment
  measured before citing it.
- The Kerui decoder and the EV1527 siren encoder are different protocols
  sharing one chip. **Never validate one against the other** — ground truth
  for TX is the siren's physical response, not our own receiver.
- **`web/src/lib/firebase.ts` builds `auth` with `initializeAuth`, never
  `getAuth` — do not "simplify" it back.** `getAuth` eagerly attaches
  `browserPopupRedirectResolver`, whose `_shouldInitProactively` is true on
  mobile browsers, Safari and iOS; on those devices auth initialisation then
  awaits a cross-origin iframe *before* restoring the session, and
  `onAuthStateChanged` — which the whole `Gate()` spinner waits on — cannot
  fire until it finishes. The app uses no redirect sign-in, so the resolver is
  passed as `signInWithPopup`'s third argument instead. The explicit
  `persistence` array must stay, or auth silently drops to in-memory and signs
  everyone out on every reload. Both halves pinned by `lib/firebase.test.ts`.

## Status

**Working on real hardware:** ESP32-S3 boots, provisions WiFi, mints its
Firebase token, decodes real Kerui sensors, evaluates rules, drives the siren
over RF hub-free, serves the LAN web UI, and writes events to Firebase with
Telegram alerts confirmed. 169 native unit tests pass.

**Sensor event families (2026-09-23) — built, not yet on hardware.** Matching
moved from the 24-bit code to the 20-bit family, and tamper / water / close /
battery-low are now distinguished per packet. The cloud + web halves are
deployable on their own and deliver tamper/water/battery alerting without
touching the device. The firmware half is NOT hardware-tested and carries an
**EEPROM magic bump** (`sizeof(Config)` 2580 → 2548) — verify the
`RtdbConfig.s` siren-address re-adoption before flashing, or the physical
siren pairing is lost. Run `npm run check:sirenAddress` (read-only) first: if
Firestore `sirenBaseAddress` or RTDB `config.s` is absent, do NOT flash. The
`familyId` backfill (`cd functions && npm run migrate:familyIds`, dry-run by
default) has not been run; every reader derives the family from `rfId` when
it is absent, so nothing is blocked on it.

⚠️ **RTDB `/{projectId}/config` is derived state.** `buildRtdbConfig` runs only
from triggers: profile / rule / remote / project-config, plus
`onSensorConfigChange` (added 2026-10-04 for per-sensor camera selection, and
guarded by `sensorConfigChanged` so only device-visible sensor fields —
`rfId`, `familyId`, `cameras` — rebuild).

Sensor writes now DO rebuild, so the `familyId`-backfill trap is closed going
forward. It is still worth knowing: that backfill predates the trigger, so if
it was ever run against live data the config may hold stale full-width rfIds.
`npm run touch:project` forces a rebuild; `npm run dump:configInputs` shows
exactly what the builder reads.

**Stability: 18h16m clean run (2026-09-10)** — single boot, zero `twdt` reboots,
zero stall dumps, flat heap, and crucially **four `-76` socket deaths all
recovered in ~5s** where both previous builds rebooted on the first one (at
10.0h and 18.36h). That ~5s is the configured `setSyncReadTimeout(5)` finally
firing. Proves the FirebaseClient read-timeout fix in
[firebaseclient-sync-read-timeout](docs/history/firebaseclient-sync-read-timeout.md),
on top of the TLS-handshake and blocking-DNS fixes in
[tls-handshake-watchdog-reboot](docs/history/tls-handshake-watchdog-reboot.md).

Note the earlier "23h16m clean run (2026-09-07)" did **not** prove the
dead-socket fix as once claimed — it simply never hit a `-76`. Zero `-76` in a
window is inconclusive, not a pass. Still does NOT clear the silent auth death
seen at 28h/31.76h — that needs ~36h.

**Deployed:** full web app (auth, pairing, profiles/rules, operations,
schedules, timeline, simulator), all Cloud Functions, invite-only access,
per-project Telegram config.

**Camera snapshots on trigger (2026-10-03) — deployed; judge VERIFIED on hardware 2026-10-04.**
On every armed trigger the device grabs a JPEG from each live NVR channel via
DVRIP/Sofia OPSNAP (port 34567), uploads to Firebase Storage under
`{projectId}/snapshots/{rfId}/{ts}/ch{N}.jpg`, and the `onSnapshotUploaded`
Cloud Function augments the timeline. The Events page joins timeline docs onto
event rows and shows a Browse button that opens a channel-gallery modal.
In `capture+judge` mode `onSnapshotUploaded` calls a vision model and either
sends a Telegram breach photo or writes a false-positive advisory to
`/{projectId}/commands/fp`; judge code is deployed but has not been exercised
on real hardware yet. See the judge-providers section below for Claude/Gemini
selection and where the API keys live. A **Manual Capture** button in Operations writes
`/{projectId}/commands/capture` (same nonce-change pattern as pair/fp); the
device polls it and grabs all channels immediately, recorded as a standalone
"Manual capture" timeline row (rfId=`"MANUAL"`, no matching events row — the
Events page surfaces these as orphan timeline entries). Auto-dismiss toast
confirms the capture request in the UI. NVR config (host, port, user, password,
mode, cooldown, retention, judge provider/model/prompt) lives in Firestore
`projects/{projectId}` and is picked up by the device via the existing
`onProjectConfigChange` → RTDB rebuild path (NVR fields added to guard).
Sensors in `r[]` are now kept even when disarmed (all profile rules loaded,
not just the active one) so the device always knows its full sensor list.

**Camera names + per-sensor multi-camera (2026-10-04) — built, NOT hardware-tested.**
Each NVR channel can be named (`projects/{projectId}.cameraNames`, a
`{"1":"Front door"}` map); names show in the Events gallery, the Sensors tab,
the Camera tab, the AI judge prompt and the breach Telegram caption, falling
back to `Camera N`. Renaming happens either in the Camera tab (all 8 channels)
or behind the ✏️ in the gallery modal (just the channels in that snapshot set).
Names are display-only — the device captures by NUMBER and never receives
them, which is why `cameraNames` is deliberately excluded from
`onProjectConfigChange`'s rebuild guard.

A sensor now selects **any subset** of channels: `Sensor.cameras: number[]`
replaces `cameraChannel` + `outOfSight`. **The list is authoritative — empty or
absent means capture NOTHING**, not "all channels" as the old unset value did.
There was **no migration**, so every already-paired sensor captures nothing
until its boxes are ticked in the Sensors tab.

Device config carries one `cmask[]` bitmask (channel N = bit N-1), index-aligned
with `r`, replacing `os[]`/`cch[]`; omitted wholesale when every mask is 0.
⚠️ **EEPROM magic bump `0xA1A2B3BA` → `BB`** — `sizeof(Config)` 2664 → 2632
(measured, not predicted). Per
[siren-address-never-restorable-from-cloud](docs/history/siren-hub-free.md),
run `npm run check:sirenAddress` before flashing or the physical siren pairing
is lost. New `onSensorConfigChange` trigger rebuilds RTDB config on a
device-visible sensor write — without it the camera selection would never reach
the device (the derived-state trap below), guarded so renames and alert markers
don't churn the config.

**Judge providers + server-only keys (2026-10-04) — built, not hardware-tested.**
`judgeProvider` is now `claude | gemini | null`, picked per project in the
Camera tab along with `judgeModel` and `judgePrompt`. Gemini uses plain `fetch`
against the REST API (no SDK dependency) and defaults to
**`gemini-3.5-flash-lite`** — pinned deliberately, NOT the
`gemini-flash-lite-latest` alias, which currently resolves to a 2.5-era model
and can be repointed by Google under us.

⚠️ **API keys moved out of Cloud Functions secrets into Firestore
`config/judge`** (`{anthropicApiKey, geminiApiKey}`), a root-level collection
locked to `allow read, write: if false` — only the admin SDK reaches it.
`defineSecret("ANTHROPIC_API_KEY")` is **gone**; set keys with
`cd functions && npm run set:judgeKey -- gemini <key>` (`--show` masks and
lists). **Run that BEFORE deploying** or Claude judging falls back to
`NullJudge` until the key is written (fail-safe: a noisy breach alert, never a
suppressed alarm).

Keys are deliberately NOT fields on `projects/{projectId}`: that doc is
`allow read: if isMember(projectId)` — *any* member, so a key there ships to
every member's browser. Verified under the emulator: admin read 200, client
read/write 403.

Measured on six real frames from this project's own Storage: ~1218 input tokens
**flat regardless of JPEG size** (Gemini tiles images), ~1.4s per call, 6/6
correct including the one frame containing a person. The prompt is shared
across providers via `buildPrompt()` so verdicts cannot drift between models.

**Pushover notification channel (2026-10-04) — built, NOT verified on a muted phone.**
A muted iPhone (ringer switch, not DND) silences every Telegram
notification; only an app holding Apple's Critical Alerts entitlement can
play through it. Pushover has that entitlement and applies it to priority 1
**and** 2, so it is now a per-project channel alongside Telegram.

`notifyChannels?: ("telegram"|"pushover")[]` on `projects/{projectId}` —
**absent means `["telegram"]`** (no migration needed); an **empty array means
send nothing** and is deliberately not coerced. Credentials live in
`projects/{projectId}/secrets/notify`, a subcollection locked to
`allow read, write: if false` — per-project because they identify who gets
woken, but off the member-readable project doc. Set them with
`cd functions && npm run set:notifyKey -- <projectId> <appToken> <userKey>`.

All nine former `sendTelegram` call sites now route through `notify()`
(`functions/src/notify.ts`), which fans out concurrently with per-channel
failure isolation and **never throws** — `deviceLiveness` and
`deadSensorCheck` latch their alert markers only after a successful send.
Severity maps `alarm`→priority 2 (repeats until acknowledged, **the only tier
that breaks through a muted ringer**), `loud`→**0** (normal: respects mute and
DND), `notice`→-1 (silent); the Telegram half reuses the pre-existing `silent`
boolean. ⚠️ `loud` was priority **1** until 2026-10-04 — but Pushover applies
Critical Alerts to priority 1 as well as 2, so it overrode silence too and the
two tiers were indistinguishable by ear. Do not raise it back.
**Which severity an alarm gets is no longer fixed** — since per-sensor breach
certainty (below) it depends on the causing sensor.
`device back online` was reclassified loud→notice, since loud would fire a
Critical Alert through a muted phone to say everything is fine.
`telegramWebhook.ts` is deliberately NOT routed through `notify()`: those are
replies to a typed Telegram command, addressed to the `chatId` from the
incoming webhook, not to the project's configured channels.

Alarm, breach and sensor-alert messages carry `link: true`, which adds
Pushover's `url`/`url_title` pointing at `/explore`. Because the PWA manifest
declares `scope: "/"` and `display: "standalone"`, tapping it opens the
**installed app**, not Safari — no custom URL scheme and no App Store
presence needed. The link is Pushover-only; Telegram already renders URLs in
the message body.

⚠️ **Critical Alerts must be opted into inside the Pushover iOS app** —
Apple requires that consent separately from normal push. Without it,
priority 1 and 2 are ordinary notifications and stay silent on mute, which
is indistinguishable from a broken integration.

Deliberately out of scope: Pushover image attachments (the breach photo
stays Telegram-only; a text alert goes to both), the `device` parameter
(omitted so all the owner's devices alert), acknowledgement callbacks, and
deep-linking to a SPECIFIC event — `/explore` reads no query parameter, so
the link lands on the unfiltered events list.

**Per-sensor breach certainty (2026-10-04) — built, NOT hardware-tested.**
`Sensor.definiteBreach?: boolean` picks the alarm notification tier.
**Absent means DEFINITE** — a newly paired sensor wakes you, matching the
fail-loud stance elsewhere. The default lives in exactly one place,
`functions/src/breachCertainty.ts`.

Only **P2 breaks through a muted ringer.** P0 is a normal notification that
respects mute and Do Not Disturb; P-1 is silent.

| Sensor | Alarm fires | Judge: breach | Judge: safe | No verdict |
|---|---|---|---|---|
| Definite | **P2** repeats, breaks mute | P0 + photo | P-1 all-clear + `fp` | — |
| Non-definite | **P0** respects mute | **P2** repeats (escalation) | P-1 all-clear + `fp` | stays P0 |

A definite sensor's breach confirmation is deliberately P0, not P2: `onAlarm`
already sent a repeating emergency, and two for one event is worse than one.

**The tier comes from the CAUSING SENSOR's own flag — there is no rule
lookup, and reintroducing one is a mistake.** An earlier version derived it
from the covering rule's members (all must be definite, since `multi_sensor`
is an AND). Two things killed that, both found against live data:

1. **Rule membership is not exclusive.** A sensor commonly belongs to several
   rules at once — in this project, `תנועה דלת כניסה` sits in a 1-member
   `count_in_window` *and* a 2-member `multi_sensor`. The code took
   `rules.find(...)`, the FIRST match, so Firestore's arbitrary document
   order decided the priority: the same sensor could alert differently on
   each trigger.
2. **The cause never records which rule fired.** `alarm_cause.ct` is a
   condition TYPE index, not a rule id, so the firing rule cannot be
   identified without a firmware change.

Every genuine unknown (unresolvable `rfId`, tamper's bare label) still fails
loud.

⚠️ **NVR health is load-bearing for night alerting, and now more so.** A
non-definite alarm with no judge verdict — NVR down, `nvrMode` not
`capture+judge`, or no cameras ticked for that sensor — **stays at P0
forever**, which on a muted phone means **silent**. There is no timeout
escalation, by choice, to avoid crying wolf. The siren is the only backstop,
and a sensor deliberately marked non-definite is therefore less likely to
wake you than one nobody configured.

Server-written `alarm_cause` now carries `rfId` alongside `label` (the label
still wins for display). That was required for the certainty lookup and had
a **side effect worth knowing: the AI judge never ran on server-evaluated
alarms before**, because `onSnapshotUploaded`'s armed gate compares the
cause's family to the snapshot's and a label-only cause has none. It now
runs there — which is also what makes escalation reachable for a
non-definite sensor alarming via a server rule. `onAlarm`'s `resolveCause`
(was `resolveLabel`) therefore no longer short-circuits on a label.

`definiteBreach` is **not** a device-visible field and is deliberately
excluded from `sensorConfigChanged`'s guard, like `cameraNames`. No firmware
change, no EEPROM magic bump.

**Pushover sound / repeat / expiry are per-project**, set in Settings →
Notifications (`pushoverSound`, `pushoverRetrySec`, `pushoverExpireSec`).
⚠️ **Only five built-in sounds loop** — `alien`, `climb`, `persistent`,
`echo`, `updown`. Priority 2 **re-sends the notification** every `retry`
seconds rather than sustaining a tone, so a short sound (including Pushover's
default) yields a series of brief blips, not an alarm. This is the whole
explanation for "the emergency alert doesn't keep sounding"; `retry` was
never the problem.

**VERIFIED ON HARDWARE 2026-10-04 — the full breach-escalation path.** An
armed trigger on a non-definite sensor (תנועה דלת מחסן, cameras 1+2) sent a
P0 alert, captured both channels, Gemini judged a person present, and the
alarm escalated to a repeating P2 emergency. First time the AI judge has run
on real hardware, and the first end-to-end confirmation of per-sensor
certainty, judge escalation and the Pushover tiers together.

It took three fixes to get there, all on 2026-10-04:
- `nvrMode` was `capture`, not `capture+judge` (config).
- The armed gate shifted the cause family **twice** for device-written
  causes, so the judge was skipped on every device-evaluated alarm — the
  `causeFamilyOf` fix. This is why it had never worked in the field.
- `loud` was Pushover priority 1, which also breaks through mute, so the
  non-definite tier was indistinguishable from an emergency. Now priority 0.

**Untested:** the watchdog / boot-reporting / offline-alert work (2026-09-02)
is committed but **not deployed and not hardware-tested** — see the testing
guide below. `RelaySiren` is built but unused (the RF path supersedes it).

**RSSI now reports real dBm (flashed 2026-10-04).** `poll()` read the CC1101's
RSSI register (0x34) with `readReg()` instead of `readStatusReg()` — 0x34 is a
STATUS register needing burst access, so every packet from every sensor
reported a constant `31`. Verified after flashing: `-67`/`-70` dBm from one
sensor, and the values reach RTDB. Use this to diagnose the intermittent
`0xD1037` — but note `poll()` drops a repeat of the SAME 24-bit code within
3s (`cc1101_receiver.cpp:141`), so wait 5s+ between test triggers.

## Next

1. Soak to ~36h to probe the silent auth death (28h/31.76h), still unclosed
2. Track [FirebaseClient#333](https://github.com/mobizt/FirebaseClient/issues/333)
   (filed 2026-09-10); if fixed upstream, retire `patch_firebase.py`
3. Test and deploy the watchdog / offline-alert work (`docs/testing-device-liveness.md`)
4. Verify the judge's **safe** path: trigger a non-definite sensor with
   nobody in frame and confirm the silent all-clear plus the `commands/fp`
   advisory. Only the breach path is confirmed so far
5. Flash the RSSI fix, then re-check the intermittent sensor `0xD1037` with
   real dBm (note the 3s per-code dedup window in `poll()` when testing)
6. Set `definiteBreach` on the **7 sensors still unset** (of 17; 2 are
   explicitly definite, 8 explicitly not). Unset defaults to definite, so 9
   sensors currently break through a muted ringer
7. Run in parallel with W184
8. Register the Telegram webhook so bot commands work
9. Decommission W184

See `todo.txt` for smaller known gaps.
