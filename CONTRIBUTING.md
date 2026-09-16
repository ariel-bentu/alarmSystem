# Contributing

Contributions are welcome. This is a personal project maintained in spare
time, so responses may be slow — please open an issue before starting anything
large.

## Before you start

**Read [`docs/history/`](docs/history/) first if your change touches the radio,
the watchdog, or the cloud client.** Those files record measurements that took
days to establish and document approaches that were tried and failed. A
surprising amount of the code that looks wrong is deliberate, and the reason is
usually written down a few lines above it.

If you believe one of those conclusions is wrong, that's entirely possible —
but please bring new evidence rather than reasoning alone.

## Running the tests

```bash
# Firmware — 127 native unit tests, no hardware required
cd firmware/edge/device && pio test -e native

# Web
cd web && npm run lint && npm test && npm run build

# Cloud functions
cd functions && npx tsc --noEmit && npx vitest run && npm run build
```

All three must pass. The firmware tests run natively, so you can contribute to
the decoder, the rule engine, the config parser, and the EV1527 encoder without
owning any of the hardware.

## Building the firmware

```bash
cd firmware/edge/device
pio run -e esp32s3 -t upload --upload-port /dev/cu.usbmodem101
```

**Always pass `-e esp32s3`.** A bare `pio run` also builds `[env:native]`,
which fails to link.

The `esp32s3` build runs `patch_firebase.py`, which patches a read-timeout bug
in FirebaseClient. If a library update moves the code it anchors on, the patch
**fails the build deliberately**. Update the anchors; do not remove the script.
Context: [`docs/upstream/ISSUE.md`](docs/upstream/ISSUE.md).

## House rules

**Comments explain why, not what.** The existing code is heavily commented
because the reasons are non-obvious — a register write that looks redundant is
usually load-bearing. Match that density when you touch something subtle.

**Check which board a comment is about.** Most heap, RAM, and TLS comments in
the firmware describe the abandoned ESP8266 and are not constraints on the
ESP32-S3 (258KB free versus ~5KB). Don't cite one without checking.

**Never validate the siren encoder against our own decoder.** The Kerui decoder
and the EV1527 siren encoder are different protocols that happen to share one
chip. Validating one against the other produced a circular bug that cost real
time. Ground truth for transmit is the siren physically responding — nothing
else.

**Do not add a second scheduled function.** Cloud Scheduler allows only 3 free
jobs per *billing account*. `doSchedule` is the only `onSchedule()` in the
project; it dispatches a declarative table. Add a row to that table instead.

**Tests before fixes.** For a bug fix, a test that fails before your change and
passes after is worth more than the fix itself.

## Hardware changes

If you adapt this to different hardware — another sensor family, a different
radio, a different siren — that's a genuinely useful contribution. Please keep
it additive rather than replacing the existing paths, and add a note to
`docs/hardware-wiring.md` describing what you wired and how you verified it.

Include how you confirmed it works on real hardware. For anything RF, "the
tests pass" is not evidence — the siren sounding is.
