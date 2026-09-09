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

That is correct for bounding **one slow `receive()`** (the timer can expire
*during* the call), but it cannot bound a loop that **iterates quickly without
progressing**. When the peer drops a keep-alive connection mid-response, that
is exactly what happens, and the loop spins until the hardware watchdog fires.

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

## Reproduction of the timer behaviour (no hardware needed)

`Timer` copied verbatim from `src/core/Utils/Timer.h`, driven by a controllable
`millis()`; parameters taken from the field failure (device uptime 66,104 s,
`setSyncReadTimeout(5)`):

| Scenario | Result |
|---|---|
| `feed()` at the top of every iteration (current code) | **never expires** — 2,000,000 iterations, 2,000 s simulated |
| `feed()` once before the loop | expires after **4 s** |
| One `receive()` call blocking > 5 s | `remaining() == 0` — the timeout **does** fire |

The third row is why this does not show up in normal use: the existing
arrangement is correct for slow-but-live transfers. It only fails when the loop
spins without progressing.

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

## Frequency

Twice observed, at **10.0 h** and **18.36 h** of continuous uptime, on a device
polling every 15 s. `-76` itself is rare — one occurrence in ~24 h — and every
occurrence so far has led to the stall. Ordinary transient socket errors on the
same build (`code -3`, `FIREBASE_ERROR_TCP_RECEIVE_TIMEOUT`) recover normally,
5-16 per hour, so the failure is specific to the socket dying mid-response
rather than to network flakiness in general.

## Suggested fix

Arm the response timer once, before the loop, so a non-progressing loop can
expire:

```cpp
sData->error.code = 0;
sData->response.feedTimer(!sData->async && sync_read_timeout_sec > 0
                              ? sync_read_timeout_sec : -1);
while (sData->return_type == ret_continue && (...))
{
    sData->return_type = receive(sData);
    handleReadTimeout(sData);
    ...
}
```

Alternatively, keep the in-loop `feedTimer()` but call it only when the
iteration made **progress** (bytes read, or `respCtx.stage` advanced). That
preserves the current behaviour for slow-but-live transfers — a long download
keeps extending its own deadline — while letting a stalled loop expire. This is
the distinction between a flat deadline and a progress-based one.

A defensive `if (!sman.client->connected()) { ... ret_failure; }` inside the
loop would also break this specific case, but the timer change covers any
non-progressing condition, not just a closed socket.

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
