# Camera Snapshots on Sensor Trigger — Design

**Date:** 2026-10-03
**Status:** Design, pending implementation plan
**Author:** Ariel Bentolila

## Goal

On a sensor trigger, capture a still image from the WiFi cameras, store it,
surface it in the web timeline, and — when the trigger belongs to an armed
profile — have an AI judge decide whether it shows a real intruder. The judge
is a **cloud-side optimization that advises the autonomous device**: a "safe"
verdict tells the device to treat that one trigger as a false positive (and
silence the siren if it already started); a "breach" verdict sends a
"confirmed breach" Telegram naming the sensor and channel.

The cameras sit behind a **Xiongmai NVR** on the LAN; the ESP32-S3 is the only
project component that can reach it. The cloud does the heavy interpretation.

**This never weakens device independence** (CLAUDE.md Key Decision: "alarm
logic never depends on the cloud"). The device evaluates rules and fires the
siren exactly as today, offline or online. The judge can only ever *cancel* a
false alarm the device already raised — and only if the advisory reaches the
device in time. It can never *prevent* or *delay* a real alarm. Cloud down,
WiFi down, judge slow → the alarm stands, unchanged. **Cloud = optimization,
not authority.**

## The camera system (established by spike, 2026-10-03)

> **Secrets** (real NVR IP, MAC, and login) live in the private memory file
> `nvr-icsee-camera-access`, **never in this tracked file** — the repo is
> public. This section describes the protocol shape only.

- 3 cameras behind a Xiongmai NVR: `smar WN1908F` / `NBD90S08N-UW6`, 8-ch.
- On the LAN. Ports: 80 (web), 554 (RTSP), **34567 (DVRIP — used)**.
- A local device account (not the iCSee cloud login) is required.
- **Snapshot path = DVRIP on :34567, not RTSP** (RTSP authenticates but hangs
  on frame grab). Flow: TCP connect → login (sofia-hashed MD5 password,
  success `Ret:100`) → `OPSNAP {Channel:N}` (msgid 1560) → response (msgid
  1561) is a raw JPEG (`\xff\xd8…`) or JSON `Ret:108` if the channel is empty.
- Live channels: **1, 2, 3** (640×720 JPEG, 45–77 KB each). ch0 empty.
- `sofia_hash(pw)`: MD5 digest → 8 chars, `chars[(md5[2i]+md5[2i+1]) % 62]`,
  charset `0-9A-Za-z`. Test vector: `""` → `tlJwpbo6`.

Full connection detail (IP / MAC / credential): memory `nvr-icsee-camera-access`.

## Decisions (locked)

| Decision | Choice |
|---|---|
| **NVR usage level** | Tri-state per project: **off** / **capture-only** / **capture + judge** (`nvrMode`) |
| **Capture when** | **Every sensor trigger** (armed or not), unless the sensor is flagged **out-of-sight** |
| **Which channels** | If the sensor names a channel → **only that channel**; else → **all available channels** |
| **Out-of-sight sensors** | Per-sensor flag → **no capture, no judge, no advisory**; device-only behavior, exactly as today |
| **Capture debounce** | Per-sensor cooldown (config `captureCooldownSec`, default 45s) so a chattering sensor cannot spam captures |
| **Judge when** | Trigger belongs to an **armed profile** AND `nvrMode == capture+judge` AND sensor is in-sight |
| **Judge verdict** | **safe** → false-positive advisory to the device (per-trigger). **breach** (person/intruder visible) → "confirmed breach" Telegram naming sensor + channel |
| **Device independence** | Judge is **advisory only**, over the existing poll path. Alarm never waits on or depends on the cloud. Fail-safe: no advisory → alarm stands |
| **Judge model** | **Swappable** behind a `SnapshotJudge` interface, selected by config |
| **NVR connection config** | **Cloud-level** (Firestore project config): host, port, user, password, mode. Pushed to the device; survives a device re-create / EEPROM wipe (like the siren address) |
| **Storage** | Firebase Storage, timeline-linked, **auto-deleted after N days** (`snapshotRetentionDays`, default 14) via the existing `doSchedule` table |
| **Offline** | Capture needs the cloud (upload + judge), so **skip capture entirely when offline**. Device alarm logic unaffected |

## Architecture

```
[sensor trigger]
      │  (device decodes, evaluates rules, fires siren — ALL unchanged, cloud-independent)
      ▼
┌─────────────────────────── ESP32-S3 (on the LAN) ───────────────────────────┐
│ 1. Trigger fires → write /events/{rfId}/{ts}; run rules; fire siren if armed │
│    (this whole path is untouched and never waits on anything below)          │
│ 2. If online AND nvrMode != off AND sensor NOT out-of-sight AND not in        │
│    cooldown: pick channel(s) → DVRIP-grab JPEG(s)                             │
│ 3. Upload each JPEG to Storage keyed by the SAME {rfId}/{ts} as the event     │
│ 4. (continuously) poll commands/config — including false-positive advisories  │
│    — at 5s, 1s while alarming (EXISTING path, unchanged cadence)              │
└──────────────────────────────────────────────────────────────────────────────┘
      │  (Storage object finalized)                    ▲
      ▼                                                │ advisory: {sensor,ts}=false-positive
┌──────────────────── Cloud Function: onSnapshotUploaded ────────────────────┐ │
│ Storage onObjectFinalized trigger                                          │ │
│ 1. Parse {projectId, rfId, ts, channel}; ignore non-snapshot paths         │ │
│ 2. Augment timeline entry with the image URL (always)                      │ │
│ 3. Judge only if: nvrMode==capture+judge AND the {rfId,ts} trigger         │ │
│    belonged to an ARMED profile. Else stop here (store + timeline only).    │ │
│ 4. SnapshotJudge(image) → { verdict: "safe" | "breach", reason }           │ │
│    ├─ "safe":  write false-positive advisory to /{proj}/commands ──────────┼─┘
│    │           (device polls it; suppresses that trigger / stops siren)
│    │           annotate timeline "false positive (AI)"
│    └─ "breach": Telegram photo "⚠ Confirmed breach — <sensor>, cam <ch>"
│                 annotate timeline "confirmed breach (AI)"
└──────────────────────────────────────────────────────────────────────────┘
      │
      ▼
[web timeline shows photos + verdict]   [Telegram: confirmed-breach photo]

┌──────────────── doSchedule table (new daily row) ────────────────┐
│ snapshotCleanup: delete Storage objects older than N days        │
└──────────────────────────────────────────────────────────────────┘
```

### The judge-as-advisory control flow (safety-critical)

The judge sits **outside** the alarm's critical path. Sequence on an armed
trigger of an in-sight sensor:

1. Device raises the alarm immediately per its own rules (siren on). **No wait.**
2. In parallel: grab → upload → cloud judges.
3. Verdict **"safe"** → cloud writes a per-trigger false-positive advisory to
   the existing command path, keyed `{rfId, ts}` (matching the `/events` key).
4. Device, on its next poll (1s while alarming), sees the advisory. If the
   `{rfId, ts}` matches the trigger that is *currently* sustaining the alarm,
   it **clears that trigger and stops the siren**. If it matches nothing
   current (already timed out, or a later trigger re-raised), it is a **no-op**.

**Failure semantics (all fail-safe):**
- Offline / cloud down / judge timeout / advisory never arrives → siren runs
  its normal course. The judge removed nothing.
- Advisory arrives late, after the alarm already self-cleared → no-op.
- **Per-trigger scope:** the advisory clears exactly one `{rfId, ts}`. A later
  trigger from the same sensor is a new event, captured and judged afresh — a
  real intruder after a benign moment still alarms.
- An **out-of-sight** sensor never produces a capture, so it can never receive
  a suppress advisory. Its alarms are purely device-decided, always.

### Why the device captures (not a cloud puller)

A Cloud Function cannot reach the NVR on the LAN. The two real options
were "device grabs + uploads" and "a new always-on LAN agent." We chose the
device: no new hardware, and the TLS-upload machinery it reuses (event writes,
token mint) is the same path hardened to an 18h clean-run baseline. The grab
itself is plain TCP (no TLS) and ~200 KB total for 3 channels — negligible.

### Why judging is in the cloud, not on-device

On-device person-detection was considered and rejected: the S3 would have to
JPEG-decode a 640×720 image (~450 KB bitmap in slow PSRAM), downscale, and run
a tiny model with weak accuracy on a scene full of known false-positive
sources (parked car, shadows, foliage). It also welds ML tuning onto the
firmware — every false-positive fix becomes a reflash. The cloud judge is
accurate, tunable in plain text, and reflash-free.

## Components

### 1. Firmware: `CameraClient` (new, `firmware/edge/device/src/`)

A self-contained DVRIP client. One public method:

```cpp
// Grabs a JPEG from the given channel into `out`. Returns false on any
// failure (connect, login, empty channel). Never throws; logs one line.
bool CameraClient::grab(uint8_t channel, std::vector<uint8_t>& out);
```

- Implements the sofia hash and the OPSNAP request/response framing from the
  spike. **Plain TCP, no TLS.** Reuses `WiFiClient`, not `WiFiClientSecure`.
- Credentials and NVR IP/port live in config (see Config below), **not**
  hardcoded — and never in a tracked file.
- Pure logic (framing, hashing) is unit-testable natively, mirroring how
  `kerui_decoder` / `ev1527_frame` are tested. The socket I/O is thin.

`grab` takes a single channel; the caller (capture path) decides which
channel(s) to request based on the sensor's mapping.

**Cooldown:** a small per-family `lastCaptureMs` map (or a ring of recent
families) gates re-capture within `captureCooldownSec`. Lives in RAM only —
survives nothing, which is correct (a reboot should allow an immediate
capture).

### 2. Firmware: capture + upload path

After the `/events` write and the rule/siren evaluation (which run first and
unconditionally), the device decides whether to capture. **All of these gates
must pass**, else it does nothing:

- `online` (WiFi + cloud token valid) — capture needs the cloud anyway.
- `nvrMode != off`.
- the triggering sensor is **not** flagged out-of-sight.
- not within `captureCooldownSec` of the last capture for this family.

Then:

1. **Channel selection:** if the sensor's config names a channel → grab that
   one. Else → grab all available channels (the device learns which channels
   are live from an OPSNAP probe / config; `Ret:108` = empty, skip).
2. `CameraClient::grab(ch, buf)` per selected channel.
3. Upload each `buf` to Firebase Storage via the existing authenticated client
   (the device already mints a Firebase token for RTDB; Storage uses the same
   token). Object path:

   ```
   {projectId}/snapshots/{rfId}/{timestamp}/ch{N}.jpg
   ```

   The `{rfId}/{timestamp}` exactly matches the `/events` key, so the cloud can
   correlate image ↔ event — and later match a false-positive advisory back to
   the trigger — with no extra signalling.

**Risk & isolation (called out, not hidden):** this adds a second large-ish
TLS upload to the firmware — the area with the watchdog/socket-death history
(`docs/history/`). Mitigations baked into the plan: capture/upload run *after*
the event write and siren decision (never block or delay the alarm path), are
best-effort (a failed upload is logged and dropped, like a dropped event —
consistent with "No event buffering v1"), and are bounded by the cooldown. The
implementation plan must include a hardware soak before this ships, same bar as
the liveness work.

### 2b. Firmware: acting on a false-positive advisory

The device already polls `/{projectId}/commands` (5s, 1s while alarming). A new
advisory shape carries `{rfId, ts}` of a trigger the cloud judged safe. On
receipt:

- If that `{rfId, ts}` is the trigger **currently sustaining the alarm** →
  clear it and stop the siren (reuse the existing disarm/siren-off code path;
  do not invent a second siren authority).
- Otherwise → **no-op** (trigger already cleared, timed out, or superseded).
- The advisory is consumed once (cleared from `/commands` like other commands).

This is the ONLY new thing the device does with cloud input for alarms, and it
is strictly subtractive — it can silence, never raise. An out-of-sight sensor
never generates the capture that would produce such an advisory.

### 3. Cloud: `onSnapshotUploaded` (new, `functions/src/`)

`onObjectFinalized` Storage trigger.

1. Parse `{projectId, rfId, timestamp, channel}` from the object path. Ignore
   paths that do not match the snapshot shape.
2. Resolve the sensor by **family** (reuse `familyIdOf` + the in-memory match
   already in `onSensorEvent`) for a human name in the timeline.
3. Write/augment a timeline entry (`projects/{id}/timeline`) with a tokened
   download URL for the image, keyed to the event. **Always** — any captured
   image appears in the timeline regardless of mode/armed state.
4. **Judge gate — all must hold**, else stop after step 3:
   - project `nvrMode == capture+judge`.
   - the `{rfId, ts}` trigger **belonged to an armed profile**. (Determine the
     same way the alarm path does: the trigger's `/events` write and server
     alarm evaluation already know arm state; read the recorded arm state for
     that event rather than "is armed *now*", so a disarm after the fact
     doesn't race the judge.)
5. Call the configured `SnapshotJudge(image, context)` → `{verdict, reason}`.
   - **`"safe"`** → write a **false-positive advisory** to
     `/{projectId}/commands` keyed `{rfId, ts}`; annotate the timeline entry
     "false positive (AI): <reason>". No Telegram.
   - **`"breach"`** → send a Telegram **photo** (`sendPhoto`) captioned
     `⚠ Confirmed breach — <sensor name>, camera <ch> — <reason>`; annotate the
     timeline entry "confirmed breach (AI): <reason>".

**Which channel is judged when the sensor had no mapping (all channels
captured):** judge each uploaded channel as it finalizes; the **first
"breach"** wins (sends the breach alert); a "safe" advisory is written only
once **all** that trigger's channels have been judged safe (so one blind angle
doesn't suppress a breach another angle saw). When the sensor named a single
channel, that one image decides.

### 4. Cloud: `SnapshotJudge` interface (new, `functions/src/`)

```ts
type Verdict = "safe" | "breach";

interface SnapshotJudge {
  judge(jpeg: Buffer, context: JudgeContext): Promise<{ verdict: Verdict; reason: string }>;
}
```

- **Breach definition:** `"breach"` iff a person / intruder is visible. An
  empty or ambiguous frame is `"safe"`. This is why the **out-of-sight flag
  matters**: a sensor whose camera view would not reliably show an intruder
  must be flagged out-of-sight, or a real entry the camera missed could be
  judged `"safe"` and suppressed. **Guidance to document in the UI:** only
  flag a sensor in-sight (judge-gated) when its trigger reliably puts the
  intruder in a camera frame; when in doubt, out-of-sight.
- `JudgeContext`: sensor name, channel, recorded arm state, time of day, and
  the per-project **judge prompt** (scene quirks: "ignore the parked white car
  and swaying trees; a person on the path is a breach").
- **Implementations (pick via config `judgeProvider`):**
  - `ClaudeJudge` — Anthropic vision model. Default model id configurable
    (`judgeModel`); recommend `claude-haiku-4-5` for cost/latency (~$0.001/img,
    ~1s). Uses the official `@anthropic-ai/sdk` (TS). API key via Functions
    secret, never tracked. Parse the verdict via structured output, not string
    matching.
  - `NullJudge` — returns `{verdict:"breach", reason:"judge disabled"}`. Note
    the **fail-safe default is breach**: with judging effectively off, nothing
    is ever suppressed. Lets the feature ship capture+timeline first.
- The interface keeps trigger/delivery code independent of the model choice.

### 5. Cloud: `snapshotCleanup` (new row in the `doSchedule` table)

**Not a new `onSchedule()`** — the project allows only 3 scheduled jobs per
billing account and `doSchedule` is the single dispatcher. Add a **daily** row
(alongside dead-sensors + event retention at noon) that lists Storage objects
under `{projectId}/snapshots/` older than `snapshotRetentionDays` and deletes
them. Mirrors the existing `eventRetention` pattern.

### 6. Storage setup (new — does not exist yet)

- Add a `storage` block to `firebase.json` and a `storage.rules` file.
- Rules: scope reads/writes per project the same way `database.rules.json`
  scopes RTDB — the device's minted token may write only under its own
  `{projectId}/snapshots/**`; members may read their project's snapshots.
- **The Anthropic API key is a secret** — Functions secret, never committed.
  (The NVR credential is stored in Firestore project config, see below —
  access-controlled, not committed to the repo.)

### 7. Web: timeline photos + sensor/NVR config (`web/src/features/...`)

- **Timeline:** extend the entry renderer to show a thumbnail when an entry has
  snapshot URLs, expandable to full size, with the judge's verdict/reason when
  present. Read-only.
- **Sensor config (configure feature):** per sensor, an **out-of-sight**
  toggle and an optional **camera channel** selector. Inline guidance: flag
  in-sight only when the camera reliably shows an intruder on trigger.
- **Project/NVR config (setup or operations feature):** `nvrMode`
  (off / capture-only / capture+judge), NVR host/port/user/password, judge
  provider/model, judge prompt, retention days.

## Config additions

### Cloud / project config (Firestore `projects/{id}`) — source of truth

The NVR connection and all judge settings live here, **not** baked into the
device. This is what lets a device re-create / EEPROM wipe restore everything
by re-reading the cloud (the siren-address re-adoption pattern).

- `nvrMode`: `off` | `capture` | `capture+judge` (default `off`)
- `nvrHost`, `nvrPort`, `nvrUser`, `nvrPassword`
- `captureCooldownSec` (default 45)
- `snapshotRetentionDays` (default 14)
- `judgeProvider` (`claude` | `null`), `judgeModel` (default `claude-haiku-4-5`)
- `judgePrompt` (scene quirks, tunable without a deploy)

Per sensor (`projects/{id}/sensors/{id}`):

- `outOfSight: boolean` (default false → in-sight → eligible for capture/judge)
- `cameraChannel?: number` (unset → capture all available channels)

### Device-facing RTDB config (thin, index-based `{a,d,r,c,...}`)

`buildRtdbConfig` already projects Firestore config into the thin device shape.
Extend it with the fields the device needs to **grab** (not the judge settings,
which are cloud-only):

- NVR host, port, user, password, mode (so the device can connect + knows
  whether to capture at all)
- `captureCooldownSec`
- per-family: out-of-sight flag and optional channel (fits the existing `r`
  families list — add the two fields per family entry)

⚠️ Adding fields to the device `Config` struct changes `sizeof(Config)` and
needs an `EepromStore::kMagic` bump (discards stored config on first boot) —
but since the NVR connection is **re-adopted from the cloud** like the siren
address, nothing is permanently lost. The plan must verify re-adoption before
flashing, same checklist as the sensor-families work.

## Data layout additions

```
Firebase Storage:
  {projectId}/snapshots/{rfId}/{timestamp}/ch{N}.jpg

RTDB (new advisory in the existing commands path):
  /{projectId}/commands/falsePositive  → { rfId, ts, at }   (device consumes + clears)

Firestore timeline entry (augmented):
  { ...existing event fields,
    snapshots: [{ channel, url }],
    judge?: { verdict: "safe"|"breach", reason, model, channel, at } }
```

## Testing

- **Firmware:** native unit tests for the sofia hash (assert the `""`→
  `tlJwpbo6` vector and the OPSNAP frame bytes), response parsing (JPEG vs
  `Ret:108`), channel selection (named channel vs all-available), the
  capture-gate logic (mode/out-of-sight/cooldown/online), and **advisory
  handling** (matches current trigger → stop; stale/mismatched → no-op),
  mirroring the decoder/frame test suites. Socket I/O stays thin and is
  exercised on hardware.
- **Cloud:** vitest for path parsing, the judge gate (mode + recorded-arm
  state), the `SnapshotJudge` interface with a stub judge returning each
  verdict, the all-channels "first breach wins / all-safe required" logic, the
  advisory write, and the cleanup selection logic. No real Anthropic/NVR calls.
- **Integration:** emulator smoke — upload a fixture JPEG to the snapshot path,
  assert timeline augmentation; stub a `"safe"` verdict and assert a
  false-positive advisory lands in `/commands`; stub `"breach"` and assert the
  Telegram photo call.
- **Hardware soak + safety check:** before shipping, a soak run confirming the
  capture/upload path does not regress the watchdog/socket-death baseline, plus
  an explicit on-hardware test that (a) a `"safe"` advisory stops a live siren
  for the matching trigger, (b) a mismatched advisory does nothing, and (c)
  with WiFi pulled, the alarm behaves exactly as today. Same bar as the
  device-liveness work.

## Security notes

- The Xiongmai NVR is the **least-trusted device on the LAN** (XMEye cloud/P2P
  backdoor history, Mirai lineage). Recommend blocking its outbound internet /
  VLAN now that stills are pullable locally. Add to `SECURITY.md` known issues.
- NVR credential lives in Firestore project config (access-controlled, pushed
  to the device over the authenticated channel); Anthropic API key is a
  Functions secret. Neither is committed — keep real IPs/creds out of tracked
  files (repo is public).
- Snapshots are images of the premises — Storage rules must scope them per
  project exactly as RTDB/Firestore are scoped.
- **The false-positive advisory is a write to `/commands`** — an attacker who
  could forge it could silence a real alarm. It is already protected by the
  same per-project RTDB rules that protect arm/disarm/siren commands; no new
  surface. Noted here because it is a *subtractive* alarm input and deserves
  the scrutiny.

## Phasing (suggested for the implementation plan)

1. **Storage setup + cloud capture-side** with `NullJudge`: device captures
   (mode/out-of-sight/channel gating) + uploads, `onSnapshotUploaded` writes
   timeline, web shows photos + exposes sensor/NVR config. Full visual log,
   zero AI, zero alarm-behavior change.
2. **`ClaudeJudge` + "confirmed breach" Telegram** (breach path only — still
   no alarm suppression). Proves the vision model and alerting in isolation.
3. **False-positive advisory loop:** cloud writes the advisory, device consumes
   it and stops the siren. This is the safety-critical phase — gets its own
   tests and hardware verification (advisory suppresses the *current* trigger;
   stale/mismatched advisory is a no-op; offline = alarm stands).
4. **`snapshotCleanup` retention row.**
5. **Hardware soak** of the firmware capture/upload/advisory path before
   declaring the device half production-ready.

## Considered and deferred: the NVR's own human detection

Probed 2026-10-03. This NVR *does* support on-box human/vehicle classification
(the `Detect` config carries `PEARule` with `TypeHuman:1`/`TypeVehicle:1`,
plus `PEAInHuman`/`SmartMotionHuman`/`HumanDetect` keys), and its alarm event
stream is subscribable over DVRIP (`OPAlarmManager Start → Ret:100`). It is
currently **disabled** — only pixel `MotionDetect` is on.

**Deferred** because, on a cheap Xiongmai board, on-box human detection is
documented as unreliable outdoors — shadows, distance, night, and cluttered
scenes defeat it; the "98–99% false-alert reduction" is unverified marketing.
Making an unreliable classifier the thing that *suppresses* an alarm risks
silencing a real intrusion. The cloud vision judge reasons about the actual
scene (and your specific false-positive sources) and is the better authority.

If revisited, the intended role is a **free local pre-filter / confidence hint
and correlation signal** (NVR human-event ↔ Kerui trigger by time+channel),
**advisory only** — never the alarm-suppression authority. That stays the
vision judge's job. Enabling it would require a (reversible) `SetConfig` write
to the NVR; untouched for v1.

## Out of scope (v1)

- The NVR's own human/PEA detection (see "Considered and deferred" above).
- Live video / streaming (snapshots only).
- On-device detection.
- Event/image buffering across outages (consistent with "No event buffering
  v1") — including offline capture.
- The judge *raising* an alarm the device did not (judge is strictly
  subtractive; it can only confirm or cancel, never create).
```
