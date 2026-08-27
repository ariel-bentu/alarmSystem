# Siren RF Transmit — Firmware Port and Cloud-Initiated Pairing

Date: 2026-08-29
Status: approved design, pending implementation

## Purpose

Move the proven EV1527 siren transmitter from the throwaway spike
(`firmware/edge/spike_clean_tx`) into the device firmware, so the alarm can
sound and silence the siren over the air with no hub and no relay hardware.
Add a pairing flow driven from the cloud web UI, because that is where users
actually operate the system.

This is the last blocker before the W184 hub can be decommissioned.

## Background: two protocols share one radio

The single most important constraint in this design.

The CC1101 carries two *different* framings on 433.92MHz, and the firmware must
keep them apart:

| | Kerui sensors (RX) | Siren (TX) |
|---|---|---|
| bit carried by | LOW gap after a fixed HIGH | carrier ON width |
| bit 1 | short gap ~400us | 3T ON (900us) |
| bit 0 | long gap ~1200us | 1T ON (300us) |
| delimiter | long LOW > 5ms | 1T ON + 31T silence |

`kerui_decoder.h`'s rule reads our own EV1527 transmission as `0x9DDC8B`
rather than `0x622374` — it is not a shared codec and must not be made into
one.

**The decoder and the encoder are deliberately never reconciled.** The
previous transmitter (`spike_siren_tx`) was tuned until *our* receiver decoded
*our* transmissions the same way it decoded the panel's — but that receiver's
decode rule was itself derived from those same captures. The result was
self-consistent and wrong about the wire, and no amount of re-reading the code
could reveal it. Only a from-spec rewrite did.

Rule that follows: **our own receiver is never evidence that our transmitter is
correct.** Ground truth for TX is the siren's physical response (two beeps on
pairing; sounding on SOS) or a capture of a genuine third-party transmitter.

## Scope

In scope:

- `Cc1101Receiver` gains a transmit path and an RX/TX mode switch.
- `RelaySiren` drives RF as its primary output, keeping its existing interface.
- A per-device siren base address, randomly generated and persisted in EEPROM.
- Cloud-initiated pairing: RTDB command, device pairing routine, web UI flow,
  Firestore record on user confirmation.
- A LAN pairing fallback on the local web server.

Out of scope:

- Explaining the 24dB power discrepancy (see Open Questions).
- Multiple sirens per project.
- Relay hardware bring-up (`RelaySiren`'s GPIO path stays untested).

## Design

### 1. `Cc1101Receiver::transmit()` — TX on the existing object

Transmit is a method on the existing receiver rather than a separate class,
because only one owner may hold the radio's mode, CS pin and SPI bus at a time.
Two objects would invite a mode race with no way to detect it.

```
bool transmit(uint32_t code, int repeats);
```

Sequence, blocking, ~384ms at the 10 repeats used for a command (each frame
is 512 chips of 75us; ~38ms per repeat):

1. Detach the GDO0 interrupt; discard any partially captured edge buffer.
2. Write the TX register set and PATABLE.
3. Render the frame and stream it through the TX FIFO.
4. Restore the RX register set, strobe `SRX`, re-attach the ISR.

Ported verbatim from `spike_clean_tx`, all load-bearing and comment-marked as
such: `T = 300us`, `kChipsPerT = 4`, `kCarrierBit = 1`, `FREND0 = 0x11`,
`PATABLE = {0x00, 0xC0}`, `MDMCFG2 = 0x30`, DRATE solved from the datasheet
formula. Frame: `1T` carrier sync, `31T` silence, then 24 bits MSB first with
bit 1 = `3T` ON + `1T` off and bit 0 = `1T` ON + `3T` off.

The registers that genuinely differ between modes, and so must be switched:
`IOCFG0` (0x0D RX / 0x06 TX), `PKTCTRL0` (0x32 RX / 0x00 then 0x02 TX),
`MDMCFG3`/`MDMCFG4` (different data rates), `FREND0`, and PATABLE.

The ~2.4KB rendered-bit buffer is a class member, never a stack local:
`loop()`'s 4KB cont stack on ESP8266 cannot take it.

**RX blackout is accepted.** The radio is deaf for the duration of a burst. A
sensor triggering in that window is missed, mitigated by Kerui sensors
repeating each burst 5-7 times and by the fact that the siren is already
sounding whenever we transmit. A non-blocking chunked FIFO feed was rejected:
an underrun mid-frame produces a malformed frame the siren will not accept,
trading a certain small loss for an intermittent large one.

### 2. `RelaySiren` — RF primary, relay retained

The interface (`turnOn`/`turnOff`/`tick`/`isActive`) is unchanged, so
`alarm_state`, `local_web_server` and `main.cpp` need no edits.

- `turnOn(durationSec, nowMs)` transmits `base | 0x8` (SOS) and raises the GPIO.
- `turnOff()` transmits `base | 0x2` (disarm) and lowers it.
- The auto-off timer in `tick()` **must transmit the disarm code**, not merely
  drop the pin. A siren commanded by RF sounds until told to stop; letting the
  timer expire silently would leave it sounding until switched off by hand.

The relay path stays for when siren hardware is wired.

### 3. Siren address: random, device-generated, EEPROM-persisted

The base address is arbitrary — it is simply whatever we transmit while the
siren is in learn mode. Generating it per device avoids every unit shipping the
same identity, and EEPROM survives reflashing, so a physical pairing stays
valid across firmware updates.

- `Config` gains `uint32_t sirenBaseAddress`.
- `EepromStore::kMagic` bumps `0xA1A2B3B5` -> `0xA1A2B3B6`. A layout change must
  be rejected, not misread; the magic mismatch is the existing mechanism.
- On load, if the field is absent or zero, generate a random 20-bit value,
  mask with `0xFFFFF0`, persist immediately, and log it. The RNG differs per
  platform, so it belongs behind a macro in `platform_compat.h` alongside the
  existing ones: ESP32-S3 uses `esp_random()` (declared in ESP-IDF's
  `esp_random.h`, not in any Arduino core header — it needs an explicit
  include); ESP8266 uses the `RANDOM_REG32` register from `esp8266_peri.h`.
  Both verified present in the installed frameworks.
- Bottom nibble is the command, top 20 bits the identity. Commands follow the
  one-hot family: `8` = SOS, `4` = arm home, `1` = arm away, `2` = disarm.

### 4. Cloud-initiated pairing

**Command wire format.** A new key under the existing commands node, which is
already device-readable and user-writable — no `database.rules.json` change:

```
/{projectId}/commands/pair  ->  { n: <nonce>, until: <epochSec> }
```

A nonce rather than a bool, so a repeated pairing request is distinguishable
from a stale one. `until` makes the request self-expiring: a device ignores a
pair command whose window has passed, so a command left in RTDB cannot make a
device pair itself on reboot days later.

`CloudClient::consumePairCommand(uint32_t* nonce)` mirrors
`consumeArmedCommand`, including the change-detection that stops a re-polled
value being re-applied every cycle.

**Latency is inherent.** The device polls `/commands` every ~30s (15s alternating
with `/config`). That cadence is a heap budget, not a preference — at 5s the
board died with an OOM inside mDNS. The UI must therefore tell the user to hold
the siren in learn mode while the command is delivered, not imply instant
action.

**Device routine.** On a fresh, unexpired nonce: loop the base code for ~60s
(`transmit(base, 6)` every 300ms), then return to RX. The radio is largely deaf
for that minute; acceptable because pairing is a deliberate, user-initiated act,
and the UI says so.

**Reporting the address.** The device cannot write `state/` — `database.rules.json`
sets `".write": false` there, and the device token is scoped to `events` only.
Rather than widen the device's write surface for a cosmetic field, the device
reports its base address through the existing event path and a Cloud Function
mirrors it to `state/siren_base`. Trade-off: one more function and a small delay
before the UI can display the address, in exchange for leaving the security
model untouched.

**Web UI** — a "Pair siren" panel in `ConfigurePage`, three steps:

1. *"Press SET on the siren until the lights come on."*
2. **Send pairing signal** — writes the command; shows *"Waiting for device (up
   to 30s)..."* then *"Transmitting for 60s — the siren should beep twice."*
3. *"Did the siren beep twice?"* -> **Yes** / **No, try again.**

**The user is the oracle.** The device cannot hear the siren's beep, so success
is only ever the user's answer. On **Yes**, write `sirens/{id}` in Firestore with
the base address, timestamp and who paired it. On **No**, offer retry and name
the likely causes: learn mode timed out, or the siren is out of range.

If `state/siren_base` is absent the panel shows "waiting for device" rather than
a blank field.

**LAN fallback.** The same device routine is exposed on the local web server. It
is not a substitute for the cloud flow — it is the only path that works when the
cloud is unreachable, and it costs a few lines on top of the same code.

## Testing

**Native (`[env:native]`, extending the existing 20 tests).** Frame rendering is
pure logic and is tested as such:

- A known code renders the expected chip pattern: `1T` ON + `31T` off sync, bit
  1 as `3T`/`1T`, bit 0 as `1T`/`3T`, MSB first, expected total chip count.
- `computeDrate()` against hand-computed datasheet values.
- EEPROM round-trips `sirenBaseAddress`, and the old magic is rejected.
- Base-address generation masks to 20 bits and never yields zero.

**Hardware — the real gate.** Native tests cannot prove anything about the air:

- Pair from the web UI end to end; the siren answers with two beeps.
- SOS sounds the siren; disarm stops it.
- **Sensor decode still works after a transmit** — this is the regression that
  matters, proving the RX register restore is correct.
- The auto-off timer actually silences the siren.

## Open Questions

**The 24dB gap.** `spike_clean_tx` measures ~24dB weaker on air than
`spike_siren_tx` at the same PA level, frequency and duty cycle with identical
TX registers — and the weaker one is the one that works. Unexplained. The
working configuration is ported verbatim rather than "improved"; changing PA
settings to close the gap risks breaking the thing that works.

**Range is unmeasured.** All siren testing has been at desk distance. The
install distance is unknown, and the 24dB question makes range hard to predict.
Worth measuring on hardware before decommissioning the hub.
