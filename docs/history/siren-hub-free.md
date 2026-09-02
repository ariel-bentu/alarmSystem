# Sounding the siren, hub-free (2026-08-28) — SOLVED

**The siren sounds and silences from our own CC1101, with the W184 uninvolved.**
It is paired to BOTH the panel and our transmitter at once — learn mode on this
unit is additive, so the existing hub pairing survived.

Working implementation: **`firmware/edge/spike_clean_tx`**, written from the
EV1527 spec alone. `spike_siren_tx` does NOT drive the siren and its
bit-in-the-gap encoding should not be reused.

**Root cause of the long failure: circular tuning.** `spike_siren_tx`'s bit
shape had been tuned so that OUR RECEIVER decoded our transmissions the same way
it decoded the panel's — but that receiver's decode rule came from those same
captures. The transmitter was optimised to agree with our own decoder's
interpretation: self-consistent, and wrong about the wire. Re-reading the code
could never surface this; only a from-spec rewrite did.

**The frame that works:**

```
sync   : 1T carrier pulse, then 31T silence
bit 1  : 3T carrier ON + 1T off
bit 0  : 1T carrier ON + 3T off
T      = 300us, 4 FIFO chips per T, DRATE solved from the datasheet formula
polarity: kCarrierBit = 1 (measured — the inverse yields malformed frames)
```

**Pairing:** short click on the siren's SET button (lights on) with the code
already looping on air (`L`). Success is **two beeps** — the first
acknowledgement our transmitter ever drew from the siren.

**Commands** — pair once, then the one-hot nibble family works:

| code | function |
|---|---|
| `0xA1B2C8` | **SOS / sound the siren** |
| `0xA1B2C4` | arm home (short ack beep) |
| `0xA1B2C1` | arm away |
| `0xA1B2C2` | **disarm / stop** |

Both directions verified on hardware. Use `s` (SOS, 5s, auto-disarm) for
testing; a bare `8` leaves the siren sounding until switched off by hand.

**Unexplained:** `spike_clean_tx` measures ~24dB weaker on air than
`spike_siren_tx` at the same PA, frequency and duty cycle with identical TX
registers — and the weaker one is the one that works.

**Superseded:** the "RF replay is a dead end" conclusion above, and the
hub-dependent ghost-sensor path. Both were consequences of the encoding bug.

See `todo.txt` for smaller known gaps (delete-project button, Telegram
webhook, RTDB events never cleaned up after Firestore mirroring, old-events
archive).

