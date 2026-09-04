# TLS handshake vs the watchdog (2026-09-04) — fault #1, explained at last

**Status: root cause FOUND, fix flashed, NOT YET PROVEN.** The mechanism is
established from the library sources and plain timeout arithmetic, not from
a guess. What has not happened is a long clean run — the failure is
intermittent, so only silence over hours/days confirms it.

This is **fault #1** from [watchdog-and-offline-alerts](watchdog-and-offline-alerts.md):
the genuinely blocked `loopTask` that trips the TWDT. It is NOT the silent
cloud death in [cloud-auth-silent-death](cloud-auth-silent-death.md), which
leaves `loopTask` healthy and never trips anything.

## The bug

`WiFiClientSecure`'s Arduino-ESP32 defaults:

```
handshake_timeout = 120000 ms   <-- DOUBLE kWatchdogTimeoutSec (60s)
_timeout          =  30000 ms
```

and the handshake wait in `ssl_client.cpp` is:

```c
while ((ret = mbedtls_ssl_handshake(&ssl_client->ssl_ctx)) != 0) {
    if (ret != MBEDTLS_ERR_SSL_WANT_READ && ret != MBEDTLS_ERR_SSL_WANT_WRITE)
        return handle_error(ret);
    if ((millis() - handshake_start_time) > ssl_client->handshake_timeout)
        return -1;
    vTaskDelay(2);          // yields to FreeRTOS, does NOT reset the TWDT
}
```

So a handshake against a silent or packet-dropping peer blocks `loop()` for
up to **two minutes** with nothing feeding the watchdog. The board reboots at
60s with `reason=twdt`, having done nothing wrong.

**This is the same trap as `sys_idle()`/`delay(0)`** already documented on
`kSyncTimeoutSec` — a library-internal idle that looks like yielding but does
not satisfy a task watchdog. Third instance of it in this codebase. When
auditing a blocking call on `loopTask`, the question is never "does it
yield?" but "does it call `esp_task_wdt_reset()`?".

## Why the 2026-09-02 fix did not cover it

That commit capped `setSyncReadTimeout`/`setSyncSendTimeout` at 5s, which was
correct and necessary. But those bound reads and writes on an **established**
socket. They do not cover the **connect** that precedes them:

```
RealtimeDatabase::get()
  -> AsyncClient ... -> SlotManager::connect()      (SlotManager.h:367)
    -> ConnectionHandler::connect()                 (ConnectionHandler.h:81)
      -> client->connect(host, port)                <-- raw, unbounded
```

`kMintSocketTimeoutMs = 2500` was set on the MINT client only — which is
exactly why the mint path was never implicated and the poll path was.

## Evidence

- Two `twdt` reboots **45 minutes apart** (19:19 and 20:04 IDT), on a build
  that already had the 5s sync caps.
- Recovered from the timeline rows written by `onBoot`, NOT from
  `state/boot` — a USB reconnect at 21:12 wrote `power_on` over it. This is
  the second time that node has destroyed its own evidence; the Firestore
  rows are now the durable record and they worked.
- A WiFi association failure was observed on the same board in the same
  session (`disconnect reason=39`, timeout, with the AP at **-48 dBm**).
  That is the trigger condition: `openDataClient()` reconnects per poll
  cycle, so a flaky AP re-exposes the unbounded handshake every few seconds.

**Interval is not a clock.** 45min/68min here vs 10.6h, 28h and 31.76h
earlier. Any theory requiring a fixed period is wrong — this tracks network
conditions, not elapsed time.

## The fix

Both long-lived clients now cap the connect phase:

```cpp
dataSslClient_->setHandshakeTimeout(kHandshakeTimeoutSec);  // 10s
dataSslClient_->setTimeout(kSocketTimeoutSec);              // 10s
```

- **10s** is comfortably above a healthy handshake (~900 ms observed in the
  mint path) and well under the 60s budget, leaving room for the poll's own
  5s read/write timeouts on top.
- **The AUTH client needed it too.** `FirebaseApp` reconnects that socket on
  every hourly token refresh, and `app_.loop()` runs on the same watched
  task. Fixing only the data client would have left an hourly exposure.

**UNITS TRAP:** on ESP32 both `setHandshakeTimeout()` and `setTimeout()` take
**seconds** (`setTimeout` stores `seconds * 1000`), unlike the mint path's
millisecond `kMintSocketTimeoutMs`. Passing milliseconds here yields a
~3-hour timeout and silently restores the bug.

## How to confirm or refute

The device is running the fix. Watch the **Explore** timeline for a
"Recovered from a freeze" row:

- **none over days** -> fixed.
- **one appears** -> not fixed, and the serial console at that moment is the
  next evidence: the new build logs which operation was in flight.

Read `/{projectId}/state/boot` **before** touching the hardware, but prefer
the Firestore timeline rows — they survive the reconnect that overwrites
`state/boot`.
