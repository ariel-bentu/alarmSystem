# Firebase + Web UI + Telegram — Architecture

_Originally designed 2026-08-18; updated to match the built system._

## Overview

Cloud backend and web UI for the self-owned alarm system. Replaces Kerui/Tuya
cloud dependency on the server side. Multi-tenant, multi-user, invite-only.
Devices authenticate with an API key; users authenticate with Google Sign-In.
Firebase Realtime DB serves the device; Firestore serves the app. Cloud
Functions handle device ingest, alarm logic, Telegram alerts, and config sync.

Deployed to Firebase project `alarm-system-100`. All functions run in
`europe-west1` — the same region as the Realtime Database instance, which RTDB
triggers require.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript (Vite), Firebase Hosting |
| Auth | Firebase Auth — Google Sign-In |
| Structured data | Firestore |
| Device-facing live data | Firebase Realtime DB |
| Backend logic | Firebase Cloud Functions (TypeScript, gen-2) |
| Notifications | Telegram Bot API (one bot per project) |
| Device simulator | Dev-only panel in the web app + scripts in `smoke/` |

---

## Authentication & Access Control

Access is **invite-only**. An uninvited Google account can authenticate but is
rejected, and nothing is written to the database on its behalf.

### Provisioning

All writes to `/users` are owned by the `provisionUser` Cloud Function; clients
cannot write that collection. The web app calls it right after sign-in:

| Condition | Outcome |
|---|---|
| `/users` collection is empty | Caller is bootstrapped as the first **system admin** |
| `/users/{email}` exists | Allowed; profile fields refreshed from the Google account |
| Otherwise | Denied — nothing written, app shows an "Access denied" screen |

The empty-collection check cannot be expressed in security rules, which is why
provisioning lives in a function.

### Roles

- **System admin** (`users.isSystemAdmin`) — may create projects and grant
  access to any project.
- **Project admin** (`members.role == "admin"`) — full control of that project,
  may grant access to it.
- **Project user** (`members.role == "user"`) — may arm/disarm only.

### Granting access

`grantTenantAccess` (callable, system admin or project admin) writes the pair of
records that membership consists of:

- `projects/{projectId}/members/{email}` — the authoritative record that
  security rules check.
- `users/{email}.tenants[projectId]` — a denormalized `{ name, role }` entry so
  the app can resolve a user's projects with a single document read (no
  collection-group query, no composite index).

If the invitee has never signed in, a stub `/users/{email}` doc is created so
the tenant entry has a home; `provisionUser` completes it on their first login.

### Device authentication

- Devices do not use Google SSO and do not need to know their `projectId`.
- On project creation an API key is generated, shown once, and stored **hashed**
  (SHA-256, lowercase hex) on the project document.
- `deviceKeys/{apiKeyHash} → { projectId }` indexes the key so the device can
  present the key alone. The hash is not secret; the raw key never leaves the
  device and the browser that created it.
- The device POSTs events to the `deviceIngest` function, which hashes the
  presented key, resolves the project, re-verifies against the stored hash, and
  writes the event.

---

## Data Model

Human-readable identifiers are used deliberately: member documents and user
documents are keyed by lowercased email, and `ownerId` / `invitedBy` /
`createdBy` store emails rather than UIDs. Firestore timestamp fields are native
`Timestamp` values (readable in the console); the RTDB side stays epoch-ms
numbers, because the firmware writes plain numbers.

### Firestore

```
/users/{email}                       // doc id = lowercased email
  email: string
  displayName: string
  photoURL: string
  isSystemAdmin: bool
  tenants: { [projectId]: { name: string, role: "admin" | "user" } }

/deviceKeys/{apiKeyHash}
  projectId: string

/projects/{projectId}
  name: string
  createdAt: Timestamp
  ownerId: string                    // lowercased email of the creating admin
  telegramBotToken: string           // optional; blank disables Telegram
  telegramChatId: string             // optional
  serverArmed: bool                  // server arm state (independent of the device)
  serverActions:
    sendTelegram: bool               // Telegram alert when the server alarm trips
    triggerSiren: bool               // whether the server writes siren_active to RTDB
  sirenDurationSec: number           // written into RTDB /config
  notifyEverySensorTrigger: bool     // Telegram on every trigger; battery/tamper always notify
  device:
    name: string
    apiKeyHash: string
    lastSeen: Timestamp | null

/projects/{projectId}/members/{email}  // doc id = lowercased email
  role: "admin" | "user"
  email: string
  invitedBy: string                    // inviter's email
  joinedAt: Timestamp

/projects/{projectId}/sensors/{sensorId}
  rfId: string                       // hex e.g. "0xA1B2C3"
  name: string
  pairedAt: Timestamp
  batteryStatus: "ok" | "low"
  lastSeen: Timestamp | null

/projects/{projectId}/profiles/{profileId}
  // profileId is the display name lowercased with spaces stripped, e.g. "athome"
  displayName: string
  createdAt: Timestamp
  enabled: bool                      // available to arm; disabled profiles are hidden in Operations
  isActiveOnDevice: bool             // the profile the device is armed to
  isActiveOnServer: bool             // the profile the server evaluates against

/projects/{projectId}/profiles/{profileId}/rules/{ruleId}
  name: string                       // required when the rule spans several sensors
  sensors: string[]                  // sensorIds; a sensor may appear in several rules
  condition:
    type: "immediate" | "count_in_window" | "entry_delay" | "multi_sensor"
    count?: number                   // count_in_window
    window_sec?: number              // count_in_window, multi_sensor
    delay_sec?: number               // entry_delay
    counts?: { [sensorId]: number }  // multi_sensor: per-sensor required triggers (default 1)

/projects/{projectId}/events/{eventId}
  // Written only by Cloud Functions
  sensorId: string
  rfId: string
  sensorName: string                 // denormalized at write time
  eventType: "trigger" | "tamper" | "battery_low" | "alarm" | "armed" | "disarmed"
  batteryLow: bool
  rssi: number
  timestamp: Timestamp
```

### Realtime Database (device-facing, namespaced per project)

```
/{projectId}/state/armed                 → bool   (device's own echo of its arm state)
/{projectId}/state/siren_active          → bool
/{projectId}/commands/armed              → bool   (arm intent written by the app)
/{projectId}/commands/siren              → bool
/{projectId}/config                      → config object (written by onProfileChange)
/{projectId}/events/{rfId}/{timestamp}   → { event, battery_low, rssi }
```

Config object written to RTDB, keyed by rfId:

```json
{
  "armed": false,
  "siren_duration_sec": 120,
  "sensors": {
    "0xA1B2C3": {
      "name": "Front door",
      "enabled": true,
      "conditions": [{ "type": "immediate" }]
    }
  }
}
```

The device only ever sees rfIds, so `buildRtdbConfig` translates a
`multi_sensor` condition's `counts` map from Firestore sensorIds to rfIds before
writing it, filling in the default of 1 so every participant is explicit and
dropping any sensor that cannot be resolved. Each participating sensor carries an
identical copy of the translated condition. This device-facing shape is the
`RtdbCondition` type; it differs from the stored `Condition` only in that keying.

---

## Rule Evaluation

Rules within a profile are evaluated with **OR** semantics — the first rule that
trips fires the alarm. A sensor may therefore take part in several rules of the
same profile (for example, one `count_in_window` rule of its own and one
`multi_sensor` rule paired with another sensor).

Condition type is coupled to the number of sensors a rule covers:

| Type | Sensors | Meaning |
|---|---|---|
| `immediate` | exactly 1 | Any trigger fires the alarm |
| `count_in_window` | exactly 1 | N triggers from that sensor within W seconds |
| `entry_delay` | exactly 1 | Trips, carrying a delay the device counts down |
| `multi_sensor` | 2 or more | **AND**: every sensor must reach its own required trigger count (`counts`, default 1) within one shared `window_sec` |

The UI enforces this: selecting a second sensor switches the rule to
`multi_sensor` and locks the type selector; dropping back to one sensor reverts
it to `immediate`. A rule spanning several sensors must have a name, because the
alarm message falls back to the sensor name, which would be ambiguous.

`entry_delay` on the server returns the delay but fires immediately — the
countdown belongs to the firmware.

---

## Application Flows

### Setup

1. User signs in with Google; the app calls `provisionUser`.
2. First user ever becomes system admin and is shown the "Create project"
   screen; a known user with no projects is told to ask an admin; an unknown
   user is denied.
3. Creating a project writes the project document, the `deviceKeys` index entry,
   and (via `grantTenantAccess`) the owner's membership. The raw API key is
   displayed once with a copy button and is never retrievable afterwards.
4. Telegram bot token and chat ID are optional at creation and editable later in
   Settings.

### Configure

**Sensors tab**
- Events arriving in RTDB for an rfId that has no sensor document are listed as
  unrecognised, with first seen / last seen / event count. Triggering a physical
  sensor makes its row update, which is how you identify which is which.
- Pairing creates the sensor document with that rfId and a name.
- Unpairing strips the sensor from every profile's rules — rules left with no
  sensors are deleted, a `multi_sensor` rule left with one sensor is downgraded
  to `immediate`, and the sensor's per-sensor count is dropped — then deletes the
  sensor. Timeline history is kept, so the sensor reappears as unrecognised while
  it keeps transmitting.

**Profiles tab**
- Creating a profile auto-generates one `immediate` rule per paired sensor.
- Rules can be added, edited and deleted; per-sensor counts are edited inline for
  `multi_sensor` rules.
- A profile can be enabled or disabled. Disabling hides it from Operations and
  clears any activation it held.

### Operations

- Two independent sections, **Device** and **Server**, each rendered as a button
  grid: one button per enabled profile plus a Disarmed button, with the active
  one highlighted. Arming is selecting a profile; disarming is selecting
  Disarmed. Device and server arm states are orthogonal.
- Arming the device sets `isActiveOnDevice` on the chosen profile (clearing the
  others) and writes `commands/armed` in RTDB. Arming the server sets
  `isActiveOnServer` and `serverArmed` on the project document.
- Siren state is shown; an admin can force-silence it by writing
  `commands/siren = false`.
- Sensors are listed with last seen and battery status.
- Both `user` and `admin` roles may arm/disarm; only `admin` may force-silence.

### Settings (admin)

Project name, Telegram bot token and chat ID (with inline help on how to obtain
them), siren duration, whether the server sends Telegram alerts or triggers the
siren on alarm, and whether every sensor trigger is notified.

### Explore

Unified event timeline from Firestore, newest first, with a day / week / month /
3 months / year range selector. Each row shows timestamp, sensor name, event
type, battery flag and RSSI.

### Device Simulator (dev only)

Visible when `VITE_DEV_SIMULATOR=true`. Injects raw events straight into RTDB as
the firmware would. The scripts in `smoke/` do the same through the real
`deviceIngest` endpoint, which also exercises API-key authentication.

---

## Cloud Functions

All in `europe-west1`.

### `deviceIngest` (HTTPS)
The device write path. `POST { apiKey, rfId, event, battery_low?, rssi? }`.
Hashes the key, resolves the project through `deviceKeys`, re-verifies against
the stored hash, writes `/{projectId}/events/{rfId}/{now}` and stamps
`device.lastSeen`. Returns 401 on an unknown or mismatched key.

### `provisionUser` (callable)
Owns all `/users` writes and gates login. See Authentication above.

### `grantTenantAccess` (callable)
Writes the member document and the `users.tenants` entry for a target email.
Caller must be a system admin or an admin of that project.

### `onSensorEvent`
RTDB `onValueCreated` on `/{projectId}/events/{rfId}/{timestamp}`:
1. Look up the sensor by rfId; unknown rfIds are logged and ignored.
2. Mirror the event into the Firestore timeline with the denormalized name.
3. Update `sensor.lastSeen` and `batteryStatus`.
4. Send a Telegram alert if `notifyEverySensorTrigger` is on; battery-low and
   tamper always notify.
5. If `serverArmed`, evaluate the event against the `isActiveOnServer` profile's
   rules. On a trip, write `siren_active` if `serverActions.triggerSiren`, and
   send an alarm alert if `serverActions.sendTelegram`. The alert names the rule
   that tripped, falling back to the sensor name for unnamed rules.

Recent events are fetched by timestamp only and filtered in memory, so the query
needs no composite index — and multi-sensor rules see other sensors' events.

### `onAlarm`
RTDB write on `/{projectId}/state/siren_active` → sends an urgent alert when it
becomes true.

### `onProfileChange` / `onRuleChange`
Firestore writes on a profile document, or on a rule beneath one. Both rebuild
the RTDB `/config` object from the `isActiveOnDevice` profile.

### `onArmStateChange`
RTDB write on `/{projectId}/commands/armed` — the arm intent the app writes.
Mirrors an `armed`/`disarmed` event to the timeline and notifies Telegram,
naming the device's active profile.

### `onServerArmChange`
Firestore update of a project document, guarded on `serverArmed` changing. Same
mirroring and notification for the server side.

### `deadSensorCheck`
Hourly schedule. For each project and sensor, alerts when `lastSeen` is older
than 24 hours.

### `telegramWebhook` (HTTPS)
Receives Telegram updates. The webhook URL must carry `?projectId=<id>`, and only
messages from the project's configured `telegramChatId` are accepted.
Commands: `/arm`, `/disarm`, `/status`, `/siren off`.

---

## Telegram Bot (per project)

Each project configures its own bot token and chat ID. Messages sent:

- Sensor trigger: `📡 Front door triggered`
- Tamper: `⚠️ Garden PIR tampered`
- Battery low: `🔋 Back door battery low`
- Alarm: `🚨 Alarm triggered — Break-in` (rule name, else sensor name)
- Arm state: `🔒 Device armed — Away`, `🔓 Server disarmed`
- Dead sensor: `💤 Front door has not reported in 24h`

---

## Project Structure

```
/
├── web/                          ← React + TypeScript app
│   ├── src/
│   │   ├── app/                  ← AuthProvider, ProjectProvider, router, layout
│   │   ├── features/
│   │   │   ├── auth/             ← Google sign-in
│   │   │   ├── setup/            ← project creation, members, settings, API key
│   │   │   ├── configure/        ← sensors, profiles, rules
│   │   │   ├── operations/       ← arm/disarm dashboard
│   │   │   ├── explore/          ← event timeline
│   │   │   └── simulator/        ← dev-only event injector
│   │   ├── lib/                  ← firebase.ts, firestore.ts, rtdb.ts
│   │   └── types/                ← shared TypeScript types
│   └── vite.config.ts
├── functions/src/                ← Cloud Functions
│   ├── deviceIngest.ts           ← device auth + event write
│   ├── provisionUser.ts          ← login gate, /users writes
│   ├── grantTenantAccess.ts      ← membership writes
│   ├── onSensorEvent.ts          ← mirroring + server alarm evaluation
│   ├── onAlarm.ts
│   ├── onProfileChange.ts        ← exports onProfileChange + onRuleChange
│   ├── onArmStateChange.ts       ← device arm notifications
│   ├── onServerArmChange.ts      ← server arm notifications
│   ├── deadSensorCheck.ts
│   ├── telegramWebhook.ts
│   ├── alarmLogic.ts             ← pure rule evaluation (unit-tested)
│   ├── buildConfig.ts            ← pure RTDB config builder (unit-tested)
│   ├── provisionLogic.ts         ← pure provisioning decision (unit-tested)
│   ├── parseCommand.ts           ← pure Telegram command parser (unit-tested)
│   ├── apiKey.ts                 ← SHA-256 hashing, matches the web helper
│   └── telegram.ts               ← send + message formatters
├── smoke/                        ← emulator smoke test, event-firing scripts
├── firebase.json, firestore.rules, database.rules.json
└── docs/
```

Business logic lives in pure, unit-tested modules; the trigger wrappers stay
thin. `smoke/smoke.mjs` covers the trigger wiring against the emulators.

---

## Security Rules

**Firestore**
- `/users/{email}` — a user may read only their own document; all writes are
  function-owned.
- `/deviceKeys/{hash}` — no client reads; created by a system admin at project
  creation.
- `/projects/{projectId}` — readable by members; created only by a system admin
  whose email matches `ownerId`; updatable by project admins, with members
  allowed to change `serverArmed` alone.
- `members` — readable by members, function-owned for writes.
- `sensors`, `rules` — admin writes only.
- `profiles` — admin writes; a plain member may change only
  `isActiveOnDevice` / `isActiveOnServer`, which is what arming does.
- `events` — readable by members, written only by functions.

**Realtime DB**
- Devices never authenticate against RTDB; they go through `deviceIngest`, which
  writes with the admin SDK.
- The web app reads state and writes commands with its Firebase Auth token.

Known gap: RTDB rules cannot check Firestore membership, so any authenticated
user could in principle write another project's `commands`. Per-project
namespacing and the auth requirement limit this; routing commands through a
function would close it.

---

## Not Yet Built

- Delete-project flow (purge subcollections, strip from members' `tenants`).
- The Telegram webhook is deployed but not registered with any bot, so commands
  are not yet answered.
- Firmware — the device side of `deviceIngest` and the RTDB config listener.
- Event filtering in Explore by sensor, event type or profile.
- Per-sensor mute/snooze; web push alongside Telegram.
