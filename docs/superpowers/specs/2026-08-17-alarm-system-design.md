# Home Alarm System — Architecture Design
_2026-08-17_

## Overview

Replace dependency on Tuya/Kerui W184 cloud with a self-owned alarm system. The existing W184 hub runs in parallel during transition. New system listens to the same 433MHz RF sensors, applies configurable trigger logic locally, fires a siren directly, and reports everything to Firebase for remote control and notifications.

---

## Hardware

| Component | Role |
|---|---|
| ESP8266 D1 Mini | Edge controller — WiFi + logic |
| CC1101 433MHz module | RF receiver (and future transmitter for siren) |
| Relay module | GPIO → siren trigger (until RF siren protocol is sniffed) |
| Physical siren | Output — wired to relay |
| Kerui sensors (existing) | 433MHz RF transmitters, untouched |
| W184 hub (existing) | Runs in parallel, passive, removed when satisfied |

---

## System Components

### 1. Edge Device (D1 Mini firmware)

**RF receive loop:**
- CC1101 listens continuously on 433MHz
- Decodes Kerui protocol packets (protocol 68, as identified by rtl_433)
- Extracts: sensor ID, event type (trigger/tamper/low battery), battery flag
- Unknown sensor IDs → logged to Firebase, ignored for alarm logic

**Local alarm logic:**
- Arm state held in memory + persisted to EEPROM (survives power loss and WiFi outage)
- Config (see below) held in memory, refreshed from EEPROM on startup and from Firebase when WiFi available, and change is detected
- For each sensor event: evaluate trigger conditions from config
- If armed + conditions met → fire siren (GPIO relay, later RF packet)
- Siren auto-off after configurable duration - also allow siren disabled.

**WiFi / Firebase:**
- WiFi is optional — alarm logic runs fully offline
- When connected: publish all sensor events to Firebase Realtime DB
- Subscribe to Firebase for config updates and remote commands (arm/disarm, siren on/off)
- No event buffering — events during WiFi outage are lost (acceptable for v1)

**Config structure (pushed from server):**
```json
{
  "armed": true,
  "siren_duration_sec": 120,
  "sensors": {
    "0xA1B2C3": {
      "name": "Front door",
      "enabled": true,
      "conditions": [
        { "type": "immediate" }
      ]
    },
    "0xD4E5F6": {
      "name": "Garden PIR",
      "enabled": true,
      "conditions": [
        { "type": "count_in_window", "count": 2, "window_sec": 30 }
      ]
    },
    "0xA1B2C4": {
      "name": "Back door",
      "enabled": true,
      "conditions": [
        { "type": "entry_delay", "delay_sec": 30 }
      ]
    },
    "0xAA11BB": {
      "name": "Living room PIR",
      "enabled": true,
      "conditions": [
        {
          "type": "multi_sensor",
          "window_sec": 60,
          "counts": { "0xAA11BB": 2, "0xCC22DD": 1 }
        }
      ]
    },
    "0xCC22DD": {
      "name": "Kitchen PIR",
      "enabled": true,
      "conditions": [
        {
          "type": "multi_sensor",
          "window_sec": 60,
          "counts": { "0xAA11BB": 2, "0xCC22DD": 1 }
        }
      ]
    }
  }
}
```

A sensor that participates in several rules appears once, with all of its
conditions in the `conditions` array (OR semantics — any one firing is enough).

**Condition types (v1):**
- `immediate` — single trigger fires alarm
- `count_in_window` — N triggers within W seconds fires alarm
- `entry_delay` — trigger starts countdown; disarm within delay cancels alarm
- `multi_sensor` — every sensor in the rule must reach its own required trigger
  count within one shared `window_sec` (AND)

**Reading a `multi_sensor` condition:** everything is keyed by rfId, so the
device never needs to know about server-side identifiers. The `counts` map lists
every participating sensor — including the one whose entry you are reading — with
its required trigger count, and each participant carries an identical copy of the
condition. The rule fires when every rfId in `counts` has reached its count
within `window_sec`. Counts are always written explicitly, so a missing entry
never has to be inferred.

**Edge event reporting (via Cloud Function, not a direct RTDB write):**

The cloud side is multi-tenant, so every RTDB path is namespaced under a
`projectId`. The device does not need to know its `projectId` and does not
authenticate against RTDB — it POSTs to the `deviceIngest` HTTPS function with
its API key, and the function resolves the project and writes the event:

```
POST https://europe-west1-alarm-system-100.cloudfunctions.net/deviceIngest
{ "apiKey": "<raw key>", "rfId": "0xA1B2C3",
  "event": "trigger" | "tamper" | "battery_low",
  "battery_low": false, "rssi": -60 }
```

which lands at `/{projectId}/events/{rfId}/{timestamp}` → `{ event, battery_low, rssi }`.

**Edge RTDB writes (device's own state):**
```
/{projectId}/state/armed          → bool
/{projectId}/state/siren_active   → bool
```

**Edge RTDB reads/listens:**
```
/{projectId}/commands/armed       → bool (arm/disarm from app)
/{projectId}/commands/siren       → bool (remote siren trigger)
/{projectId}/config               → full config object above
```

The `projectId` is needed for these RTDB paths; it is shown in the web app
alongside the API key at project creation and flashed with the firmware.

---

### 2. Firebase

**Realtime Database** — sensor events, state, config, commands.

**Firestore** — structured app data (users, projects, sensors, profiles, rules,
event timeline). Added when the cloud side was built; see the Firebase design doc.

**Cloud Functions** (built; full detail in
`2026-08-18-firebase-webui-telegram-design.md`):
- `deviceIngest` — the device's authenticated event write path
- `onSensorEvent` — mirrors events to Firestore, updates sensor state, sends
  Telegram alerts, and runs the server's own alarm evaluation
- `onAlarm` — siren_active → true: sends urgent Telegram alert
- `onProfileChange` / `onRuleChange` — rebuild the RTDB `/config` object
- `onArmStateChange` / `onServerArmChange` — arm/disarm notifications
- `deadSensorCheck` — hourly: alerts when a sensor has been silent 24h
- `telegramWebhook`, `provisionUser`, `grantTenantAccess`

**Telegram bot:**
- Alerts: sensor trigger, alarm fired, battery low, dead sensor, arm/disarm
- Commands: `/arm`, `/disarm`, `/status`, `/siren off`

**Firebase Hosting (web UI)** — built: sensor pairing and status, profile and
rule configuration, arm/disarm per profile, event timeline.

---

### 3. Siren Control (phased)

**Phase 1 (immediate):** GPIO pin → relay → siren. Simple, reliable.

**Phase 2 (after sniffing):** Capture W184 → siren RF packet using CC1101 in RX mode while triggering alarm manually. Replay that packet to trigger siren wirelessly, remove relay wiring.

---

## Data Flow

```
Kerui sensor
    │ 433MHz RF
    ▼
CC1101 (on D1 Mini)
    │ SPI
    ▼
D1 Mini firmware
    ├── evaluate conditions (local, no WiFi needed)
    │       │
    │       └── armed + conditions met
    │               │
    │               ▼
    │           GPIO relay → Siren
    │
    └── WiFi available?
            │ yes
            ▼
        Firebase Realtime DB
            ├── Cloud Functions
            │       ├── Telegram bot alerts
            │       └── Dead sensor / battery checks
            └── Web UI / Telegram commands
                    │
                    ▼
                /commands → D1 Mini (arm/disarm/siren)
```

---

## Transition Plan

Cloud backend, web UI and Telegram integration are built and deployed (steps 4
and 6 below). The remaining work is the edge device itself.

1. CC1101 arrives → spike: decode Kerui sensor packets, confirm sensor IDs
2. Build D1 Mini firmware: RF decode + local alarm logic + relay siren
3. Run in parallel with W184 — verify all sensors detected
4. ~~Add Firebase integration~~ — server side done; firmware still needs to call
   `deviceIngest` and listen to `/{projectId}/config` and `/commands`
5. Sniff W184 siren RF packet → implement RF siren trigger
6. ~~Build web UI~~ — done
7. Decommission W184 when satisfied

---

## Open Questions / Future

- Can CC1101 transmit arm/disarm commands to W184 hub via RF? (investigate after sniffing)
- EEPROM wear on D1 Mini — arm state writes should be infrequent, acceptable
- OTA firmware updates via Arduino OTA library
- Multiple D1 Mini units for larger homes (future)
