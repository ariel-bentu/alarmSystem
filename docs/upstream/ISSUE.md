<!-- FILED 2026-09-10 as https://github.com/mobizt/FirebaseClient/issues/333
     This is the submitted text, kept for the record. Edit only to keep it in
     sync with the issue; discussion and any maintainer response live there. -->

# Sync read loop cannot time out: `feedTimer()` is called inside the loop it is meant to bound

**Version:** 2.2.13 (`main`, `AsyncClient.h` @ `2a030ef`) · **Board:** ESP32-S3, arduino-esp32 3.20017 · **Mode:** sync `database.get<String>()` with `setSyncReadTimeout(5)`

**Symptom:** after a `-76` on a keep-alive connection, `loopTask` blocks ~41s and the Task WDT reboots the board. Seen at 10.0h and 18.36h of uptime.

**The suggested fix is running on hardware.** An 18.16h soak with the progress-based patch applied absorbed **four** `-76` events with **zero** reboots, each recovering in ~5s (= the configured `setSyncReadTimeout(5)`) instead of hanging 40.8s to the watchdog. Details in [Verification](#verification-the-fix-running-on-hardware) below.

## The defect

`AsyncClient.h:1131-1153`:

```cpp
while (sData->return_type == ret_continue && (httpCode == 0 || stage != finished))
{
    sData->response.feedTimer(... sync_read_timeout_sec ...);  // 1133  re-arms
    sData->return_type = receive(sData);                       // 1134
    handleReadTimeout(sData);                                  // 1136  checks remaining()==0
    if (sData->async || sData->return_type == ret_failure) break;
}
```

`feedTimer()` resets the deadline at the top of every iteration; `handleReadTimeout()` reads it three lines later. **It can never be expired when it is checked.**

This is not about iteration speed. `Timer::feed()` → `setInterval()` → `reset()` sets `end = ts + period` (`Timer.h:24`), re-derived from the *current* `ts`. So `end - ts == period` after every call, and `ready()` (`ts >= end`) is never true — at any rate. Swept at 1 / 50 / 101 / 150 / 1000 ms per iteration (101+ clears `Timer::loop()`'s `> 100` guard, so `ts` really does advance) it never expires.

## Why the loop never ends after a mid-response socket death

1. `WiFiClientSecure::available()` hits `-76`, calls its own `stop()`, sets `_connected = false`; every later call returns **0** (`WiFiClientSecure.cpp:243-245`).
2. `readResponse()` only works `if (tcpAvailable() > 0)` (`AsyncClient.h:452`). With 0 it is a no-op and returns **`true`** (line 539) — `false` happens only when the client pointer is null.
3. `receive()` line 441 returns `ret_continue` (or line 398 if the socket died before the status line).
4. Both loop conjuncts hold forever; `ret_failure` is never set, so the `break` at 1151 is unreachable.
5. Each pass calls `sys_idle()` = `delay(0)` (`Core.h:17`), which yields to FreeRTOS but does **not** feed the TWDT.

**The contrast that isolates it:** the *other* sync wait, `AsyncClient.h:1118-1124`, has no `feedTimer()` inside it. Same `handleReadTimeout()`, same dead socket — and it exits correctly. The only difference is the re-arm.

**Why the existing socket-closed check doesn't save it:** `ResponseHandler.h:263` (`!connected() && available()==0 && totalRead==0`) is reachable only via `readPayload()`, which sits behind the `tcpAvailable() > 0` gate at line 452 — closed by a dead socket. It also requires `totalRead == 0`, false for a death *after* the headers.

## Reproducer

[`timer_repro.cpp`](timer_repro.cpp) — `Timer` copied verbatim from 2.2.13 with a controllable `millis()`. No hardware. `g++ -std=c++17 timer_repro.cpp -o repro && ./repro`:

```
current code  step=   1ms : NEVER EXITED (5000s simulated)
current code  step= 101ms : NEVER EXITED (505000s simulated)
current code  step=1000ms : NEVER EXITED (5000000s simulated)

fix, dead socket    : EXIT at 4s
fix, live transfer  : NEVER EXITED  <- correct, deadline keeps extending

slow receive() : remaining()=0 (timeout fires, as intended)
```

The last two lines matter: the current arrangement is *correct* for slow-but-live transfers, which is why this has never shown up in normal use.

## Field evidence

```
04:17:57 cloud: heartbeat uptime=66101 ok (code 0) heap=179928 min=121488
04:18:00 [E][ssl_client.cpp:37] _handle_error(): [data_to_read():361]: (-76)
04:18:40 *** [stall] loopTask has not progressed for 40802ms — phase='cloud:poll-config' ***
04:18:40 [stall] heap free=220532 min=121488
04:19:00 E task_wdt: Task watchdog got triggered. - loopTask (CPU 1). Aborting.
```

`phase='cloud:poll-config'` is my label around a single synchronous `get()`.

**Not memory exhaustion** (since issue #313 was closed on that basis): free heap was flat across the 18.36h run — 180,512 → 179,928 — min-free never below 121,488, and **220,532 free at the moment of the stall**. It *rose*, consistent with the dead socket's TLS buffers being released.

## Suggested fix: feed only on progress

```cpp
while (...)
{
    const size_t readBefore = sData->response.respCtx.totalRead;
    const auto stageBefore  = sData->response.respCtx.stage;

    sData->return_type = receive(sData);

    if (sData->response.respCtx.totalRead != readBefore ||
        sData->response.respCtx.stage != stageBefore)
        sData->response.feedTimer(... sync_read_timeout_sec ...);

    handleReadTimeout(sData);
    ...
}
```

A live-but-slow transfer keeps extending its deadline; a non-progressing loop expires at `sync_read_timeout_sec`.

**Not** simply hoisting `feedTimer()` out of the loop — that makes it a flat deadline for the whole response and would kill large chunked downloads, and `readPayload()` feeds per chunk at line 582 anyway, so the behaviour would differ between chunked and non-chunked responses.

Worth fixing separately: the `tcpAvailable() > 0` gate at line 452 hides the dead socket from the `-1` path at `ResponseHandler.h:263`, whose `totalRead == 0` condition is also wrong for a mid-response death.

## Verification: the fix running on hardware

The patch above was applied to 2.2.13 and soaked on the same device and workload that produced the failures.

**18.16h, single boot, zero reboots** (uptime 11 → 65,392s), against two prior builds that rebooted on their *first* `-76`, at 10.0h and 18.36h.

| Signal | Before | After |
|---|---|---|
| `-76` events | 1 → reboot | **4 → all recovered** |
| Time from `-76` to next successful request | 40.8s stall → TWDT reboot at 60s | **4.03 / 5.04 / 5.05 / 5.02 s** |
| `[stall]` dumps / `reason=twdt` | 1 / 1 | **0 / 0** |
| Free heap, start → end | — | 180,484 → 180,024 (flat) |

The recovery times are the point: **~5.0s is exactly the configured `setSyncReadTimeout(5)`**. With the patch the timer is no longer re-armed on a non-progressing pass, so it expires and `handleReadTimeout()` fires — which it structurally could not do before. The first event also surfaced `code -3` (`FIREBASE_ERROR_TCP_RECEIVE_TIMEOUT`), i.e. the library reporting its own timeout, previously unreachable on this path.

Sample, one of the four:

```
02:43:33 cloud: heartbeat uptime=40526 ok (code 0) heap=180048
02:43:39 [E][ssl_client.cpp:37] _handle_error(): [data_to_read():361]: (-76)
02:43:44 cloud: heartbeat uptime=40537 ok (code 0) heap=179964     <- 5.04s later, recovered
```

No behavioural regression observed on healthy traffic over the same run: normal polls, config reads and event writes all completed as before, and heap was flat.

## What we have not proven

The timer arithmetic is provable from `Timer.h:24-50` by inspection; the reproducer only demonstrates it, and the soak above confirms the fix end to end.

What is still inferred rather than measured is the *precise* internal state during the original hang: we did not instrument the library to print `remaining()`, `feedCount()`, `stage`, `httpCode`, `totalRead` and `connected()` at that moment, nor establish which `ret_continue` sink (line 398 vs 441) was taken. With the patch in place the hang no longer occurs, so there is nothing left to instrument — happy to run a deliberately unpatched build with tracing if that would help you.

Our soak also carries a second, independent mitigation in a `Client` subclass. It logged **zero** activations across all four events, i.e. the patched timer fired first every time, so it is not confounding these results.

`sData->sse == false` for the affected slot (plain `get()`, no stream).

## Note on WiFiClientSecure

`available()` returning 0 indistinguishably from "no data yet" after it has internally stopped itself is arguably an arduino-esp32 issue. But the loop above is unbounded for *any* peer that stops delivering bytes — a half-open TCP connection or a silent server reaches the same state with a well-behaved client — and `setSyncReadTimeout()` is this library's documented bound for that situation.
