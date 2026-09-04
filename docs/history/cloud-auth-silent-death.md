# Cloud auth silent death (2026-09-04) — the watchdog cannot catch this one

**Status: root cause FOUND and fixed in code; the recovery path is NOT yet
proven on hardware.** The bug itself is not a theory — it is a one-way latch
plainly visible in the source. What has not been observed is the new
recovery actually firing in the field, because reproducing it means waiting
for (or forcing) a dead auth session.

## The bug

`CloudClient::tokenMinted_` was set `true` on the first successful mint and
**never reset anywhere in the codebase** (one write, `cloud_client.cpp:395`,
no reset). The re-mint path at the top of `CloudClient::loop()` is guarded by
`if (!tokenMinted_)`, so once that latch closed it could never open again.

The failure sequence:

1. Mint succeeds at boot → `tokenMinted_ = true`, permanently.
2. Hours later `app_.ready()` goes false — the custom token JWT is minted
   ONCE at boot and stored in `customTokenJwt_`; FirebaseApp refreshes the
   derived ID token for a while, but when that refresh chain finally breaks
   (rejected refresh, lost TLS session, expired credential) nothing renews
   the underlying credential.
3. `loop()` hits `if (!appReady_) return;` and returns.
4. Step 3 repeats forever.

The device then spins happily: **feeding the watchdog, decoding RF,
evaluating alarm rules, driving the siren, serving the LAN web UI** — while
writing nothing to the cloud ever again. Only a power cycle recovers it.

## Why the watchdog is structurally blind to it

The TWDT watches for a **blocked** `loopTask`. This failure leaves
`loopTask` perfectly healthy — it is looping, and `loop()` feeds the
watchdog unconditionally at its very first line (`main.cpp`). There is
nothing to time out. **A watchdog is the wrong instrument for a liveness
failure that is not a hang**, and no amount of tuning `kWatchdogTimeoutSec`
would ever have caught this.

This is the counter-example to the 09-02 conclusion that the hang was "on
`loopTask`". That inference was drawn from one TWDT capture and does not
generalise: these are two different faults.

## How it was caught

Read from RTDB **before** touching the hardware (the trap that destroyed
evidence on 09-02):

```
state/boot      = { reason: "twdt", at: 2026-09-04 03:27:30 IDT }
state/last_seen = 38241        # frozen across 4 polls over ~70s
```

`last_seen` is device **uptime**, and the heartbeat runs every 10s. Frozen
for 12+ minutes with a 60s watchdog that never fired is the whole diagnosis
in one number:

| Observation | What it rules out |
|---|---|
| `last_seen` frozen 12+ min | heartbeat is gated on `isReady()` |
| 60s watchdog never fired | nothing was blocked — not a hang |
| LAN `/status` answered normally | non-cloud paths unaffected |
| "recovered on its own" after 31.76h | that was a reboot, not a recovery |
| silence began after 10.6h uptime | consistent with a refresh cycle failing |

**Note the two faults in one day:** the board rebooted on `twdt` at 03:27
(fault #1, the real `loopTask` hang) and then went silently cloud-dead at
14:04 (fault #2, this one).

## The fix

`AuthSupervisor` (`src/auth_supervisor.h`) — pure logic, no Arduino types,
native-tested in `test/test_auth_supervisor` (9 tests), split out for the
same reason as `config_parser` and `remote_control`.

- `noteReady(ready, now)` every iteration; a ready app clears the timer.
- `shouldForceReauth(now, wifiUp)` returns true once ready() has been false
  for **15 minutes**, then re-fires every **60s** until it recovers.
- `CloudClient::forceReauth()` calls `deinitializeApp(app_)`, clears
  `tokenMinted_`/`appReady_`/`customTokenJwt_`, and clears `mintAttempted_`
  so the existing retry path rebuilds the session on the next iteration.

**The grace period is 15 minutes, not seconds, and that is deliberate.**
FirebaseApp drops `ready()` briefly during every ordinary hourly token
refresh. Re-minting on that edge would throw away a healthy session once an
hour and hammer the mint endpoint. There is a test for exactly this
(`test_brief_refresh_blip_does_not_reauth`).

**Gated on `wifiUp`.** A re-mint with no network cannot succeed, and being
offline is not an error state — the alarm is cloud-independent by design.
`superviseWifi()` owns link failure; this owns "link is fine, credentials
are not."

### Traps found while writing it — do not undo these

- **Do NOT delete `authSslClient_`/`authClient_`/`dataClient_` in
  `forceReauth()`.** `FirebaseApp::loop()` walks a global client vector by
  address; freeing clients under it produced an Exception 29
  (StoreProhibited) reset, measured at 11,424 bytes free, so never a memory
  shortage. `closeDataClient()` is an empty no-op for precisely this reason.
  A recovery routine that crashes the board is worse than the hang it
  recovers from. The clients are reused instead.
- **`deinitializeApp()` is safe to call here** — verified by reading
  `FirebaseApp.h:676`: it only clears `app_token`/`user_auth` and sets two
  event flags. It does not touch `aVec`, `sData`, or the client vector.
- **`startAppAndStreams()` now guards its allocations.** It runs a second
  time after `forceReauth()`, and it used to `new` unconditionally — which
  would have leaked ~7KB of TLS buffers per recovery.
- **Not dropping the data client is harmless.** RTDB auth is a per-REQUEST
  query parameter: `AsyncClient.h:356` substitutes the placeholder with
  `app_token->val[token]` at send time, so the existing connection starts
  sending the new token as soon as the re-mint completes.

## Diagnostics added

`reportHeartbeat()` only prints while `isReady()` — i.e. only when nothing
is wrong. During the outage the console went **completely silent**, which is
indistinguishable from a dead board. `loop()` now prints once a minute while
un-ready:

```
cloud: NOT ready for 120s (re-mint at 900s, wifi up)
cloud: auth dead for 900s — forcing re-mint (heap 184232)
```

## What is verified, and what is not

Verified: 73/73 native tests pass (9 new); firmware builds and was flashed
to the S3 on 2026-09-04; the device boots, mints, authenticates, writes to
RTDB, and the new trace appears correctly during the brief pre-auth window
(`NOT ready for 0s (re-mint at 900s, wifi up)` followed immediately by
`app.ready() -> true`).

**NOT verified: the recovery path itself has never fired.** The healthy path
is proven; the 15-minute escalation and the re-mint are proven only by unit
test. Confirming it on hardware needs a forced dead session — e.g.
temporarily shrinking `kReauthGraceMs`, or revoking the device's credential
mid-session — and until that is done, treat the recovery as untested code.

## Still open

Fault #1 — whatever actually blocked `loopTask` and tripped the TWDT at
03:27 — is **not** addressed by this work and remains unexplained. The
09-02 sync-timeout fix (`setSyncReadTimeout(5s)`, watchdog 30s → 60s) is the
leading candidate but did not eliminate it.
