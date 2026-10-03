# Camera Snapshots on Sensor Trigger — Design

**Date:** 2026-10-03
**Status:** Design, pending implementation plan
**Author:** Ariel Bentolila

## Goal

On a sensor trigger, capture a still image from the WiFi cameras, store it,
surface it in the web timeline, and — when the system is armed — have an AI
judge decide whether it shows a real threat and push an annotated photo to
Telegram.

The cameras sit behind a **Xiongmai NVR** on the LAN; the ESP32-S3 is the only
project component that can reach it. The cloud does the heavy interpretation.
This keeps the project's existing split: **device = LAN-local I/O, cloud =
brains.**

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
| **Capture when** | **Every sensor trigger** (armed or not), all 3 channels |
| **Capture debounce** | Per-sensor cooldown (config `captureCooldownSec`, default 45s) so a chattering sensor cannot spam captures |
| **Judge when** | **Only while armed** (alarm or not) — gated independently from capture |
| **Judge model** | **Swappable** behind a `SnapshotJudge` interface, selected by config |
| **Storage** | Firebase Storage, timeline-linked, **auto-deleted after N days** (`snapshotRetentionDays`, default 14) via the existing `doSchedule` table |
| **Delivery** | Timeline entry (all captures) + Telegram photo with the judge's reason (armed captures) |

## Architecture — three stages

```
[sensor trigger]
      │  (device already decodes + writes /events)
      ▼
┌─────────────────────────── ESP32-S3 (on the LAN) ───────────────────────────┐
│ 1. Trigger fires → write /events/{rfId}/{ts} (unchanged)                     │
│ 2. If not in cooldown for this family: DVRIP-grab ch 1,2,3 → 3 JPEGs         │
│ 3. Upload each JPEG to Firebase Storage at a deterministic path (below)      │
│    keyed by the SAME {rfId}/{ts} as the event                               │
└──────────────────────────────────────────────────────────────────────────────┘
      │  (Storage object finalized)
      ▼
┌──────────────────── Cloud Function: onSnapshotUploaded ────────────────────┐
│ Storage onObjectFinalized trigger                                          │
│ 1. Parse {projectId, rfId, ts, channel} from the object path               │
│ 2. Write/augment the timeline entry with the image URL                     │
│ 3. If state/armed == true: run SnapshotJudge(image) → {alarm, reason}      │
│    - annotate timeline with the verdict                                    │
│    - send Telegram photo with caption (reason)                             │
└──────────────────────────────────────────────────────────────────────────┘
      │
      ▼
[web timeline shows photos] + [Telegram photo alert when armed]

┌──────────────── doSchedule table (new daily row) ────────────────┐
│ snapshotCleanup: delete Storage objects older than N days        │
└──────────────────────────────────────────────────────────────────┘
```

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

**Cooldown:** a small per-family `lastCaptureMs` map (or a ring of recent
families) gates re-capture within `captureCooldownSec`. Lives in RAM only —
survives nothing, which is correct (a reboot should allow an immediate
capture).

### 2. Firmware: upload path

On a trigger that passes cooldown, after the `/events` write:

1. `CameraClient::grab(ch, buf)` for ch ∈ {1,2,3}.
2. Upload each `buf` to Firebase Storage via the existing authenticated client
   (the device already mints a Firebase token for RTDB; Storage uses the same
   token). Object path:

   ```
   {projectId}/snapshots/{rfId}/{timestamp}/ch{N}.jpg
   ```

   The `{rfId}/{timestamp}` exactly matches the `/events` key, so the cloud can
   correlate image ↔ event with no extra signalling.

**Risk & isolation (called out, not hidden):** this adds a second large-ish
TLS upload to the firmware — the area with the watchdog/socket-death history
(`docs/history/`). Mitigations baked into the plan: uploads run *after* the
event write (never block the alarm path), are best-effort (a failed upload is
logged and dropped, like a dropped event — consistent with "No event
buffering v1"), and are bounded by the cooldown. The implementation plan must
include a hardware soak before this ships, same bar as the liveness work.

### 3. Cloud: `onSnapshotUploaded` (new, `functions/src/`)

`onObjectFinalized` Storage trigger.

1. Parse `{projectId, rfId, timestamp, channel}` from the object path. Ignore
   paths that do not match the snapshot shape.
2. Resolve the sensor by **family** (reuse `familyIdOf` + the in-memory match
   already in `onSensorEvent`) for a human name in the timeline.
3. Write/augment a timeline entry (`projects/{id}/timeline`) with a signed or
   tokened download URL for the image, keyed to the event.
4. Read `/{projectId}/state/armed`. **If armed:** call the configured
   `SnapshotJudge`, annotate the timeline entry with `{alarm, reason}`, and
   send a Telegram photo (`sendPhoto`) with the reason as caption. If not
   armed: store + timeline only, no judge, no Telegram.

Only **one** channel's image needs to drive the judge/alert to avoid 3×
Telegram spam — default: judge `ch1`, attach the others to the timeline.
(Configurable `judgeChannel`, default 1.)

### 4. Cloud: `SnapshotJudge` interface (new, `functions/src/`)

```ts
interface SnapshotJudge {
  judge(jpeg: Buffer, context: JudgeContext): Promise<{ alarm: boolean; reason: string }>;
}
```

- `JudgeContext`: sensor name, channel, armed state, time of day — so the
  prompt can be scene-aware ("ignore the parked white car and moving trees;
  alarm only on a person").
- **Implementations (pick via config `judgeProvider`):**
  - `ClaudeJudge` — Anthropic vision model. Default model id configurable
    (`judgeModel`); recommend `claude-haiku-4-5` for cost/latency (~$0.001/img,
    ~1s). Uses the official `@anthropic-ai/sdk` (TS). API key via Functions
    config / secret, never tracked.
  - `NullJudge` — returns `{alarm:false, reason:"judge disabled"}`; lets the
    feature ship capture+timeline before the AI half is wired.
- The interface keeps the trigger and delivery code independent of the model
  choice (the "decide later / swappable" decision).

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
- **The NVR credential and the Anthropic API key are secrets** — Functions
  secrets / env, never committed. Keep IPs/creds out of tracked files per the
  repo's public-repo rule.

### 7. Web: timeline photos (`web/src/features/...`)

The timeline already renders events. Extend the entry renderer to show a
thumbnail when an entry has snapshot URLs, expandable to full size, with the
judge's verdict/reason when present. Read-only; no new routes.

## Config additions

Device-facing RTDB config is thin and index-based (`{a,d,r,c,...}`). Camera
settings are **device-local operational config**, not alarm rules, so they fit
the same thin shape. New fields (names illustrative; final indices in the
plan):

- NVR host, port, user, password (device needs these to grab) — **secret**,
  delivered to the device the same scoped way siren address is, not in a
  tracked file.
- `captureCooldownSec` (default 45)

Cloud/project config (Firestore `projects/{id}`):

- `snapshotRetentionDays` (default 14)
- `judgeProvider` (`claude` | `null`), `judgeModel`, `judgeChannel` (default 1)
- Judge prompt text (so scene quirks are tunable without a deploy)

## Data layout additions

```
Firebase Storage:
  {projectId}/snapshots/{rfId}/{timestamp}/ch{N}.jpg

Firestore timeline entry (augmented):
  { ...existing event fields,
    snapshots: [{ channel, url }],
    judge?: { alarm, reason, model, at } }
```

## Testing

- **Firmware:** native unit tests for the sofia hash (assert the `""`→
  `tlJwpbo6` vector and the OPSNAP frame bytes) and response parsing (JPEG vs
  `Ret:108`), mirroring the decoder/frame test suites. Socket I/O stays thin
  and is exercised on hardware.
- **Cloud:** vitest for path parsing, the armed-gate branch, the
  `SnapshotJudge` interface with a stub judge, and the cleanup selection
  logic. No real Anthropic/NVR calls in tests.
- **Integration:** emulator smoke — upload a fixture JPEG to the snapshot
  path, assert timeline augmentation and (armed) a stubbed judge + Telegram
  call.
- **Hardware soak:** before shipping the firmware half, a soak run confirming
  the upload path does not regress the watchdog/socket-death baseline — same
  bar as the device-liveness work.

## Security notes

- The Xiongmai NVR is the **least-trusted device on the LAN** (XMEye cloud/P2P
  backdoor history, Mirai lineage). Recommend blocking its outbound internet /
  VLAN now that stills are pullable locally. Add to `SECURITY.md` known issues.
- NVR credential + Anthropic API key are secrets; keep them out of tracked
  files (repo is public).
- Snapshots are images of the premises — Storage rules must scope them per
  project exactly as RTDB/Firestore are scoped.

## Phasing (suggested for the implementation plan)

1. **Storage setup + cloud capture-side** with `NullJudge`: device grabs +
   uploads, `onSnapshotUploaded` writes timeline, web shows photos. Delivers
   the full visual log with zero AI cost.
2. **`ClaudeJudge` + armed-gated Telegram**: wire the vision model and photo
   alerts.
3. **`snapshotCleanup` retention row.**
4. **Hardware soak** of the firmware upload path before declaring the device
   half production-ready.

## Out of scope (v1)

- Live video / streaming (snapshots only).
- Per-sensor → camera mapping (we grab all channels).
- On-device detection.
- Event/image buffering across outages (consistent with "No event buffering
  v1").
```
