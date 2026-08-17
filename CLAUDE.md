# Alarm System — Project Context

## What This Is

A self-owned home alarm system to replace dependency on Tuya/Kerui cloud. Existing Kerui W184 hub and sensors stay in place during transition — new system runs in parallel.

## Hardware

| Component | Status | Notes |
|---|---|---|
| ESP8266 D1 Mini | On hand | Edge controller |
| CC1101 433MHz module | Ordered | RF receive + future transmit |
| Kerui W184 hub | Existing, keep running | 192.168.0.46 on LAN |
| Kerui sensors | Existing, untouched | 433MHz RF, 24-bit OOK packets |
| Arduino Uno | On hand | Backup / spike testing |
| Physical siren | TBD | Wired via relay to D1 Mini GPIO |

## Architecture

**Edge (D1 Mini + CC1101 firmware):**
- Listens to 433MHz Kerui sensor packets continuously
- Decodes using Kerui protocol (24-bit OOK, timing-based)
- Arm state persisted to EEPROM — survives power loss and WiFi outage
- Config held in memory, loaded from EEPROM on boot, refreshed from Firebase when WiFi available
- Alarm logic: if armed + sensor conditions met → fire siren via GPIO relay
- WiFi optional: when connected, publishes all events to Firebase, subscribes to commands/config

**Firebase (backend):**
- Realtime Database for events, state, config, commands (namespaced per project)
- Firestore for structured app data (users, projects, sensors, profiles, rules, timeline)
- Cloud Functions: device ingest, event mirroring, server-side alarm evaluation,
  config sync, Telegram alerts, dead sensor detection
- Hosting: web UI for arm/disarm, sensor pairing, rule config, event timeline

**Telegram bot:**
- Alerts: sensor trigger, alarm, battery low, dead sensor
- Commands: /arm /disarm /status /siren off

## Sensor Trigger Conditions (config-driven)

Rules live under a profile; a profile is armed independently on the device and
on the server. Rules are OR'd — a sensor may appear in several rules of the same
profile. Condition types:
- `immediate` — single trigger fires alarm
- `count_in_window` — N triggers within W seconds
- `entry_delay` — grace period to disarm before alarm fires
- `multi_sensor` — several sensors, each with its own required trigger count
  (default 1), all of which must be met within one shared window (AND)

## Firebase Data Layout

Everything is multi-tenant: RTDB paths are namespaced under `{projectId}`, and
Firestore holds the structured app data.

**Realtime Database (device-facing):**
```
/{projectId}/events/{rfId}/{timestamp}  → { event, battery_low, rssi }
/{projectId}/state/armed                → bool
/{projectId}/state/siren_active         → bool
/{projectId}/commands/armed             → bool
/{projectId}/commands/siren             → bool
/{projectId}/config                     → full config object
```

**Firestore (app data):** `/users/{email}`, `/deviceKeys/{apiKeyHash}`,
`/projects/{projectId}` with `members`, `sensors`, `profiles/{id}/rules`, and
`events` subcollections. See the Firebase design spec for full field lists.

The device never talks to RTDB directly — it POSTs to the `deviceIngest`
Cloud Function with its API key, which resolves the project and writes the
event.

## Siren Control (phased)

- Phase 1: GPIO pin → relay → siren (immediate, wire it)
- Phase 2: Sniff W184 siren RF packet with CC1101, replay it wirelessly

## Project Structure

```
firmware/edge/
  kerui_decoder.h          ← Kerui 433MHz decode logic + KeruiPacket struct
  spike_decode/
    spike_decode.ino       ← Test sketch: prints sensor IDs via Serial Monitor
web/                       ← React + TypeScript app (Vite), Firebase Hosting
  src/app/                 ← providers (auth, project), router, layout
  src/features/            ← auth, setup, configure, operations, explore, simulator
  src/lib/                 ← firebase init, typed Firestore/RTDB helpers
  src/types/               ← shared domain types
functions/                 ← Cloud Functions (TypeScript, gen-2, europe-west1)
smoke/                     ← emulator smoke test + manual event-firing scripts
firestore.rules, database.rules.json, firebase.json
docs/superpowers/specs/
  2026-08-17-alarm-system-design.md            ← Firmware/edge architecture
  2026-08-18-firebase-webui-telegram-design.md ← Cloud + web UI architecture
```

## Current Status / Next Steps

Cloud backend and web UI are built and deployed (project `alarm-system-100`,
region `europe-west1`). Firmware is not started beyond the decode spike.

Done:
- Web app: auth, project setup, sensor pairing, profiles/rules, operations
  (arm/disarm per profile), event timeline, dev simulator
- Cloud Functions: event ingest + mirroring, server-side alarm evaluation,
  config sync, arm/disarm notifications, dead-sensor check, Telegram alerts
- Invite-only access model, per-project Telegram config

Next:
1. CC1101 arrives → run spike_decode sketch, capture sensor IDs, confirm battery bit position in 24-bit packet
2. Build main D1 Mini firmware: RF decode + alarm logic + relay + `deviceIngest` calls
3. Run in parallel with W184
4. Register the Telegram webhook so bot commands work
5. Sniff siren RF packet → Phase 2 siren
6. Decommission W184

## Key Decisions

- WiFi independence: alarm logic never depends on cloud — EEPROM stores arm state
- No event buffering v1: events lost during WiFi outage are acceptable
- W184 hub stays running in parallel until fully replaced
- Unknown sensor IDs: log to Firebase, ignore for alarm logic until named in config
- Kerui protocol: 24-bit OOK, delimiter >5ms, bit timing ~500µs threshold
