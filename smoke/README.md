# Emulator smoke test

End-to-end check of Cloud Function trigger wiring against the Firebase
emulators — the integration the unit tests don't reach.

## Run

```bash
# terminal 1: build functions, start emulators
cd functions && npm run build
firebase emulators:start --only functions,firestore,database --project demo-alarm

# terminal 2: run the smoke test
cd smoke && npm install && npm run smoke
```

## What it asserts

Drives the real data flow via firebase-admin against the emulators and
verifies the function side effects:

1. `onProfileChange` rebuilds RTDB `/config` (sensor keyed by rfId, siren duration)
2. `onSensorEvent` mirrors a raw RTDB event into Firestore with denormalized sensorName
3. `onSensorEvent` updates `sensor.lastSeen`
4. `onArmStateChange` mirrors an armed event onto the Firestore timeline

`deadSensorCheck` (scheduler) is not exercised — the pubsub emulator is not run.
Security-rules verification is out of scope here; use `@firebase/rules-unit-testing`
for that.
