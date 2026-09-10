# Sync read loop: `feedTimer()` is called inside the loop, so `handleReadTimeout()` can never fire when the socket dies mid-response

**Library version:** 2.2.13 (`main`, `AsyncClient.h` @ `2a030ef`)
**Board:** ESP32-S3 (arduino-esp32 core 3.20017 / 2.0.17), `WiFiClientSecure`
**Mode:** synchronous (`database.get<String>(...)`), `setSyncReadTimeout(5)`
**Symptom:** `loopTask` blocks ~41s and the Task WDT reboots the board
(`reason=twdt`) after a `-76` on a keep-alive connection.

Related: #313 (closed as a memory fault). Heap data below shows this instance
is not memory exhaustion.

## Summary

In the synchronous read-response loop, `feedTimer()` is called at the **top of
every iteration**, and `handleReadTimeout()` — which exits on
`read_timer.remaining() == 0` — is called a few instructions later in the
**same** iteration. The deadline is therefore reset immediately before it is
checked.

This is not a question of iteration speed. `Timer::feed()` (`Timer.h:42-50`)
calls `setInterval()` → `reset()`, and `reset()` (line 24) is
`end = ts + period`. Every `feed()` re-derives `end` from the *current* `ts`,
so the invariant `end - ts == period` holds after every call, forever. `ready()`
is `ts >= end`, i.e. `ts >= ts + period` — never true. **The timer cannot expire
at any iteration rate.** Swept at 1 / 50 / 101 / 150 / 1000 ms per iteration it
never fires; `end - ts` is 5 in every case (see reproducer output below).

That is correct for bounding **one slow `receive()`** — the timer can expire
*during* the call, which is why this arrangement looks right in ordinary
operation. It cannot bound a loop that **iterates without progressing**, which
is what happens when the peer drops a keep-alive connection mid-response.

## The loop

`src/core/AsyncClient/AsyncClient.h:1131-1153`

```cpp
while (sData->return_type == ret_continue &&
       (sData->response.httpCode == 0 ||
        sData->response.respCtx.stage != res_handler::response_stage_finished))
{
    sData->response.feedTimer(!sData->async && sync_read_timeout_sec > 0
                                  ? sync_read_timeout_sec : -1);   // 1133  re-arms
    sData->return_type = receive(sData);                           // 1134
    handleReadTimeout(sData);                                      // 1136  checks remaining()==0
    ...
    if (sData->async || sData->return_type == ret_failure) break;
}
```

## Why the loop never terminates after the peer drops the connection

1. `WiFiClientSecure::available()` (core, `WiFiClientSecure.cpp:240-252`) hits a
   hard mbedTLS error (`-76`, `MBEDTLS_ERR_NET_RECV_FAILED`), calls its own
   `stop()`, and sets `_connected = false`. Every subsequent call returns **0**
   through `if (!_connected) return peeked;`.
2. `readResponse()` (`AsyncClient.h:446`) only does work
   `if (sData->response.tcpAvailable() > 0)`. With 0 it is a no-op and returns
   **`true`** (line 539) — it returns `false` only when the client pointer is
   null, so this is not treated as an error.
3. `receive()` (`AsyncClient.h:397-398`):
   `if (sData->response.httpCode == 0) return ret_continue;`
4. `return_type` stays `ret_continue` and `stage` never reaches
   `response_stage_finished`, so neither loop condition ends and the `break` at
   line 1151 is never reached.
5. Each pass calls `sys_idle()` (via `receive()` → `readResponse()` and the
   surrounding code), which is `delay(0)` on ESP32. That yields to FreeRTOS but
   does **not** reset the Task WDT.
6. `handleReadTimeout()` cannot break the cycle, because `feedTimer()` on line
   1133 reset the deadline microseconds earlier.

Net effect: an unbounded, non-yielding-to-the-watchdog loop.

## The contrast that isolates the defect

The *other* sync wait, at `AsyncClient.h:1118-1124`, is correct:

```cpp
while (!sData->response.tcpAvailable())
{
    sys_idle();
    if (handleReadTimeout(sData))
        break;
}
```

It has **no `feedTimer()` inside it**. The timer armed once at line 1083 expires
normally and this loop exits. Same `handleReadTimeout()`, same dead socket,
correct behaviour — the only difference is that nothing re-arms the deadline
eight lines earlier.

This also narrows which failure this report is about. A socket dying *before*
any bytes arrive lands in the 1118 loop and terminates fine. The failure here is
a socket dying **mid-response** on a keep-alive connection (headers already
consumed), which lands in the 1131 loop.

## Why the existing socket-closed detection does not fire

`ResponseHandler.h:263` already has the right check:

```cpp
if (!source->connected() && source->available() == 0 && respCtx.totalRead == 0)
    return -1; // Socket closed
```

and `readPayload()` (`ResponseHandler.h:466`) guards on
`if (client->connected() || client->available())`. A negative length becomes
`respCtx.stage = response_stage_finished`, which would end the outer loop
cleanly. Neither runs in this scenario, for two independent reasons:

1. Both live inside `readResponse<TSRC,TSNK>()`, reachable only via
   `readPayload()` / `readMetaData()` — which `AsyncClient.h:452` gates behind
   `tcpAvailable() > 0`. A dead socket returns 0, so the gate closes and the
   detector is never reached.
2. Even if reached, it requires `respCtx.totalRead == 0`. `totalRead` is reset
   per request in `ResponseContext::begin()` (`ResponseHandler.h:91`) and
   incremented at line 348, so a socket that dies **mid-response** has
   `totalRead > 0`. The condition is written for "dead before we read anything",
   not "died after the headers".

So the defenses exist but sit downstream of a gate that a dead socket closes.

## Reproduction of the timer behaviour (no hardware needed)

`Timer` copied verbatim from `src/core/Utils/Timer.h`, driven by a controllable
`millis()`; parameters taken from the field failure (device uptime 66,104 s,
`setSyncReadTimeout(5)`):

```
current code  step=   1ms : NEVER EXITED (5000s simulated)
current code  step=  50ms : NEVER EXITED (250000s simulated)
current code  step= 101ms : NEVER EXITED (505000s simulated)
current code  step= 150ms : NEVER EXITED (750000s simulated)
current code  step=1000ms : NEVER EXITED (5000000s simulated)

fix, dead socket    : EXIT at 4s
fix, live transfer  : NEVER EXITED (250000s simulated) <- correct for a live transfer

slow receive() : remaining()=0 (0 => timeout fires, as intended)
```

The rate sweep is the point: iteration speed is **irrelevant**. 101 ms and above
clear `Timer::loop()`'s `(millis() - now) > 100` guard, so `ts` genuinely
advances — and the timer still never expires, because `feed()` moves `end` by
the same amount. `end - ts` is 5 in every case.

The last two rows are why this has not shown up in normal use: the existing
arrangement is correct for slow-but-live transfers, and the proposed fix keeps
it that way.

Full reproducer: [`timer_repro.cpp`](timer_repro.cpp) — single file, builds with
`g++ -std=c++17 timer_repro.cpp -o timer_repro`, no Arduino or hardware.

## Field evidence

Serial capture from the device (stall monitor is our own task, pinned to core 0,
which dumps at 40 s — 20 s before the 60 s TWDT):

```
04:17:57.398 > cloud: heartbeat uptime=66101 ok (code 0) heap=179928 min=121488 maxblock=122868
04:18:00.418 > [66104957][E][ssl_client.cpp:37] _handle_error(): [data_to_read():361]: (-76) UNKNOWN ERROR CODE (004C)
04:18:40.669 > *** [stall] loopTask has not progressed for 40802ms — phase='cloud:poll-config' ***
04:18:40.670 > [stall] heap free=220532 min=121488 maxblock=122868
04:19:00.802 > E (66164948) task_wdt: Task watchdog got triggered.
04:19:00.803 > E (66164948) task_wdt:  - loopTask (CPU 1)
04:19:00.804 > E (66164948) task_wdt: Aborting.
```

`phase='cloud:poll-config'` is our label for a single synchronous
`database.get<String>()`.

### This instance is not memory exhaustion

Because #313 was closed on that basis, the same run's heap numbers:

- Free heap at uptime 60 s: **180,512** → at 66,101 s (18.36 h later):
  **179,928**. Flat; no leak.
- Minimum free heap over the whole run: **121,488** bytes.
- Free heap **at the moment of the stall: 220,532** — it *rose*, because the
  dead socket's TLS buffers were released.

The device had ~121 KB free at its worst point and ~220 KB when it hung, on a
part with 327 KB of internal SRAM.

## What we have not proven

Stated plainly so it is not taken for more than it is:

- **The timer arithmetic is proven** by inspection of `Timer.h:24-50` and does
  not depend on the simulation: `feed()` → `setInterval()` → `reset()` sets
  `end = ts + period`, and `ready()` is `ts >= end`. The reproducer only
  demonstrates it.
- **That `-76` is what put execution in the 1131 loop is circumstantial** — it
  rests on log correlation (`-76` at 04:18:00, stall dump at 04:18:40,
  `phase='cloud:poll-config'` = one synchronous `get()`), not on a stack trace.
  We have not instrumented the library to print `read_timer.remaining()`,
  `feedCount()`, `respCtx.stage`, `httpCode`, `respCtx.totalRead` or
  `client->connected()` at the moment of the hang.
- We have not determined which `ret_continue` sink is taken — line 398
  (`httpCode == 0`, death before the status line) or line 441 (`httpCode > 0`,
  `stage == payload`, death after the headers). We believe the latter, since the
  connection was keep-alive and previously healthy.
- `sData->sse == false` for the affected slot (a plain `get()`, no stream).

Note that the loop is unbounded for *any* non-progressing condition, so the fix
does not depend on resolving these.

## Frequency

Twice observed, at **10.0 h** and **18.36 h** of continuous uptime, on a device
polling every 15 s. `-76` itself is rare — one occurrence in ~24 h — and every
occurrence so far has led to the stall. Ordinary transient socket errors on the
same build (`code -3`, `FIREBASE_ERROR_TCP_RECEIVE_TIMEOUT`) recover normally,
5-16 per hour, so the failure is specific to the socket dying mid-response
rather than to network flakiness in general.

## Suggested fix

**Feed the timer only on progress.** Keep the in-loop `feedTimer()`, but call it
only when the iteration actually advanced — `respCtx.totalRead` increased or
`respCtx.stage` changed:

```cpp
while (sData->return_type == ret_continue && (...))
{
    const size_t readBefore = sData->response.respCtx.totalRead;
    const auto stageBefore  = sData->response.respCtx.stage;

    sData->return_type = receive(sData);

    if (sData->response.respCtx.totalRead != readBefore ||
        sData->response.respCtx.stage != stageBefore)
        sData->response.feedTimer(!sData->async && sync_read_timeout_sec > 0
                                      ? sync_read_timeout_sec : -1);

    handleReadTimeout(sData);
    ...
}
```

A live-but-slow transfer keeps extending its own deadline, so nothing regresses;
a non-progressing loop expires at `sync_read_timeout_sec`.

**Note on the simpler alternative — hoisting `feedTimer()` out of the loop:
we do not recommend it.** It converts the per-read timeout into a flat deadline
for the whole response, which would kill legitimate large or chunked downloads
that exceed `sync_read_timeout_sec` in total. `readPayload()` also feeds the
timer per chunk at `AsyncClient.h:582`, so hoisting alone would not even produce
a consistent flat deadline — behaviour would differ between chunked and
non-chunked responses. The progress-based form is the correct shape.

Separately, the gating described above is worth addressing on its own merits:
moving the `connected()` check to `AsyncClient.h:452` (so a dead socket reaches
the existing `-1` path rather than being gated out by `tcpAvailable() == 0`),
and relaxing `ResponseHandler.h:263`'s `respCtx.totalRead == 0` condition, which
is wrong for a mid-response death.

## Note on the SSL client

`WiFiClientSecure` returning 0 forever after it has internally stopped itself is
arguably a core issue rather than this library's. Two things make it this
library's concern as well:

- `readResponse()` treats "no bytes available" and "socket is gone" identically,
  so the condition is invisible to the loop.
- The library's own documented bound for this situation
  (`setSyncReadTimeout()`) does not apply, for the timer reason above.

We work around it downstream in a `Client` subclass, but the sync loop is
unbounded for any peer that stops delivering, regardless of the SSL client used.
