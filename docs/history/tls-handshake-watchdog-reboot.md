# TLS handshake vs the watchdog (2026-09-04) — fault #1, explained at last

**Status: root cause FOUND, fix flashed, PROVEN on hardware 2026-09-07** by a
23h16m clean run — see [Proven: the 23h run](#proven-the-23h-run-2026-09-07) at
the end of this file. The mechanism was established from the library sources and
plain timeout arithmetic, not from a guess; the run supplied the long silence
that an intermittent failure needs to confirm it.

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

---

# Blocking DNS before the connect (2026-09-05) — the SAME fault, one layer up

**Status: PROVEN on hardware 2026-09-07** — 5 DNS resolutions in 23h, where the
old path ran one per connect. See [Proven: the 23h run](#proven-the-23h-run-2026-09-07).
Found by static review of the installed core, not from a fresh reboot. The
mechanism is again plain timeout arithmetic against the 60s budget.

The connect/handshake caps above bound *the connect and the handshake*. They do
NOT bound the **DNS resolution that runs before either**. FirebaseClient issues
every poll and every alarm write through `Client::connect(host, port)`, and the
base `WiFiClientSecure::connect(const char* host, ...)` resolves the hostname
first:

```
WiFiClientSecure.cpp: connect(host) -> WiFi.hostByName(host, ip)
WiFiGeneric.cpp:      waitStatusBits(WIFI_DNS_IDLE_BIT, 16000)   // up to 16s
                      dns_gethostbyname(...)
                      waitStatusBits(WIFI_DNS_DONE_BIT, 15000)   // up to 15s
```

Worst case **~31s inside connect(), before `setTimeout`/`setHandshakeTimeout`
ever apply** — those govern the TCP connect and TLS handshake that come *after*
resolution. And `waitStatusBits` blocks on a FreeRTOS event group: it yields to
the scheduler but does **not** reset the TWDT — the identical trap as
`sys_idle()`/`delay(0)` and the handshake's `vTaskDelay(2)`.

`reportAlarm()` does **two** sequential `set()` calls. Two slow resolves back to
back = up to ~62s *before* the 10s connect/handshake caps even start counting,
which exceeds the 60s watchdog and reboots a healthy device mid-alarm
(`reason=twdt`). Under normal operation DNS is cached and returns instantly,
which is why this only bites occasionally — consistent with the "stuck once in
~10h, recovered by the watchdog" field report.

## Why the lwIP cache is not the fix

lwIP's DNS cache is 4 entries with short, server-set TTLs (Google's frontends
return ~tens of seconds). An expired entry drops the next connect straight back
onto the ~31s blocking path. Warming it on a timer just narrows the window; it
does not close it.

## The fix

`SslClientWithDns` (`src/ssl_client_with_dns.h`) — a thin `WiFiClientSecure`
subclass that overrides `connect(host, port)` to resolve **once per host**,
cache the IP (no TTL), and connect **by IP** thereafter. `connect(host, port)`
is `virtual` in the `Client` base and FirebaseClient calls it through a
`Client*` (`ConnectionHandler.h`), so the override is dispatched.

- **SNI preserved.** It connects via `connect(ip, port, host, ...)`, passing the
  original hostname as the TLS SNI/cert host, so Google's frontend still routes
  correctly under `setInsecure()`.
- **IP rotation self-heals.** A failed connect to the cached IP invalidates the
  cache; the next connect (next poll, ~5s) re-resolves. One ≤10s failed attempt
  against a stale frontend IP, then recovery — strictly better than ~31s of DNS
  on every connect.
- **Both clients.** Auth client too: its token-refresh reconnect (~hourly) runs
  on the same watched task, same as the handshake fix above.
- **Cache policy is native-tested.** The decision layer is split into a pure
  `HostResolver` (`src/host_resolver.h`, no Arduino types) with
  `test/test_host_resolver` — same split as `AuthSupervisor`.

The one blocking resolve that still happens (first connect per host, or after
an invalidation) is fed on both sides with `platformFeedWatchdog()`, the same
guard `connectToWifi()` puts around its synchronous `scanNetworks()`.

## How to confirm or refute

Same as above — watch for a "Recovered from a freeze" timeline row. The new
build logs `[dns] resolved <host> -> <ip> (cached)` once per host and
`[dns] connect to cached <ip> ... failed — invalidating` on a rotation, so the
serial trace shows whether DNS is still on the hot path.

## Seeing WHERE it hangs, before the reboot (2026-09-05)

The fixes above each removed one *known* blocking call from the watched task.
But the fault family is open-ended: any synchronous call that yields to
FreeRTOS without feeding the TWDT (DNS, TLS handshake, `sys_idle()`,
`vTaskDelay`) can wedge `loopTask`, and until now a hang was only ever
diagnosed **after the fact** — by arithmetic on heartbeat gaps, or by
reproducing it on the bench. When the device was actually stuck, it emitted
nothing.

The TWDT is configured `panic=true`, so it *does* print a backtrace on
timeout. The problem is delivery: on the S3 the USB-Serial/JTAG is
CPU-serviced, so the instant the panic halts the core the port stops
enumerating and the host loses the very backtrace that names the hung call.
(Same mechanism as the vanished `/dev/cu.*` in the 28h-silence writeup.)

### The stall monitor

A separate FreeRTOS task, `stallmon` (`src/stall_monitor.h`), **pinned to core
0** while the Arduino `loopTask` runs on core 1. `loop()` bumps a `volatile`
heartbeat + a coarse phase label once per iteration; blocking stretches tag a
finer phase first (`cloud`, `siren-pair`, …). The monitor polls once a second
and, when the loop has not progressed for **40s** — a full **20s before the
60s TWDT** — dumps over serial *while USB is still alive*:

- `*** [stall] loopTask has not progressed for <ms> — phase='<phase>' ***`
- free / min / maxblock heap (so a stall coinciding with exhaustion is visible)
- `esp_backtrace_print()` of the monitor task (liveness proof only)

Then it does **nothing** — the existing TWDT still owns the reboot. The monitor
only makes the hang *observable*.

**The phase label is the load-bearing signal, not the backtrace.** This core
builds without the FreeRTOS trace facility (`CONFIG_FREERTOS_USE_TRACE_FACILITY`
is unset), so a cross-task unwind of `loopTask` means raw TCB access that is
fragile across core versions and prints garbage as often as signal. The phase
string names which synchronous call ate the budget directly and reliably; the
TWDT panic at 60s still carries the full faulting backtrace for the cases where
it survives.

Timing policy is split into a pure, native-tested `StallDetector`
(`src/stall_detector.h`, `test/test_stall_detector`) — same split as
`HostResolver` / `AuthSupervisor`. It fires **once per stall** (the monitor
polls every second; without a one-shot latch a 20s hang would print 20
identical dumps) and re-arms only after a fresh bump.

### Verified on hardware (2026-09-05)

- Healthy operation past 70s uptime with **no false dump** — the detector stays
  silent while the loop bumps.
- A `-DSTALL_TEST` injector (a 50s no-yield spin, gated out of real builds)
  produced exactly:
  `*** [stall] loopTask has not progressed for 40385ms — phase='stall-test-injected' ***`
  emitted from core 0 while `loopTask` spun on core 1 — proving the dump escapes
  over live USB, names the phase, and does not itself reboot.

### How to read it in the field

A real hang will print a `[stall]` block naming the phase (`cloud`, `dns`,
`tls`, `siren-pair`, …) ~20s before the board reboots with `reason=twdt`. That
phase points straight at the blocking call to fix next — no bench repro needed.

## The stall the monitor caught: a socket dying mid-read (2026-09-06)

The monitor earned its keep on the first real hang. A Firebase poll's TLS
socket died mid-read:

```
ssl_client.cpp _handle_error(): [data_to_read()] (-76)
```

`-76` = `-0x004C` = `MBEDTLS_ERR_NET_RECV_FAILED` — the underlying TCP recv
failed, i.e. the peer dropped the connection mid-operation. The loopTask then
spun ~40s in one of FirebaseClient's `while (...) { sys_idle(); }` waits —
`sys_idle()` is `delay(0)` on ESP32, which yields to FreeRTOS **without feeding
the TWDT** — until the 60s watchdog rebooted (`reason=twdt`). Same fault family
as blocking DNS and the 120s handshake above: a synchronous cloud call that
yields without feeding the watchdog. Heap min dipped to ~102KB during the stall
(from ~168K), a symptom of the wedged connection, not the cause.

### What the exact spinning loop was NOT

An early hypothesis blamed FirebaseClient's read-wait
(`AsyncClient.h ~1118`): that its `read_timer` isn't armed on the broken-socket
path, so `handleReadTimeout` never trips. **Disproven.** Base
`WiFiClientSecure::available()` already calls `stop()` and returns `-76` on
`data_to_read() < 0`, so `while (!tcpAvailable())` = `while (!(-76))` *exits*.
Two candidate loops were checked; neither is the culprit, and the panic
backtrace was a dead end (it showed IDLE0 / `task_wdt_isr` — the reporter, not
the hung call). The precise spinning wait was never pinned. That is fine,
because the fix does not depend on knowing it.

> **CORRECTION (2026-09-08).** The reasoning above is right about the *first*
> `available()` call and wrong about every one after it — which is why the
> `IoDeadline` did not close this fault. See
> [The recurrence](#the-recurrence-2026-09-08--why-iodeadline-did-not-cover-it)
> at the end of this file.

### The instrumentation gap this exposed

The dump read `phase='loop'` for a hang that was inside `cloudClient.loop()`.
The single coarse `cloud` tag wrapping the outer call was too blunt. Fixed by
tagging the four synchronous, watchdog-blind sites *inside* `cloud_client.cpp`:
`cloud:mint`, `cloud:app`, `cloud:poll-config` / `cloud:poll-commands`, and
`cloud:report-alarm`. A recurrence now names the exact op.

### The fix: a wall-clock deadline in our own SSL client

Rather than patch a vendored loop we could not even pin, bound **every**
library wait at the one chokepoint they all pass through. FirebaseClient drives
every sync wait through `client->available()` (read/connected cascade from it).
So `SslClientWithDns` (our `WiFiClientSecure` subclass, already the DNS-caching
override) now holds a pure `IoDeadline` (`src/io_deadline.h`,
`test/test_io_deadline`, native-tested — same split as `HostResolver` /
`StallDetector`):

- `arm()` on a successful `connect()`
- `progress()` on every `read()` that returns bytes (so a slow-but-advancing
  transfer runs to completion; only a genuinely stalled socket is torn down)
- once `expired()` (no progress for **12s**), `available()` force-`stop()`s the
  socket and returns `-1`, logging `[io] socket stalled past deadline`

Whichever wait is spinning then sees a closed connection and aborts — no need
to know which one. 12s sits above the 5s sync read timeout (a backstop, not the
primary bound) and well under the 40s stall monitor / 60s TWDT, so the socket
is reclaimed before either fires.

### Validation

24h soak with `pio device monitor -e esp32s3 --port <port> -f time -f log2file`
(started 2026-09-06). Success = zero `reason=twdt` reboots over the window.
`[io] socket stalled past deadline` lines *without* a twdt reboot are the fix
working as designed — bounding the wait the library could not.

---

# Proven: the 23h run (2026-09-07)

The soak above ran **23h 16m** (uptime 13s → 83,770s) on a single `power_on`
boot and came back clean. This is the long silence every fix in this file was
waiting for. Both faults are now hardware-proven.

| Signal | Result |
|---|---|
| Reboots / panics / `reason=twdt` | **none** — one boot, `power_on` |
| `[stall]` dumps | **none** (monitor armed at boot, never fired) |
| DNS resolutions | **5 total**, one per host, all `(cached)` |
| `[io] socket stalled past deadline` | none — no socket ever hit the 12s bound |
| Forced re-mints / `auth dead` | none; one `NOT ready for 0s` at boot (expected) |
| Transient socket errors | 85, all self-recovered |
| Heap | 180,792 @ 2h → 180,784 @ 23h; `min` settled 124,912 → 118,868 |

**The DNS fix is the standout.** Five resolutions across ~8,300 heartbeats,
versus one blocking `hostByName()` per connect before. Each host resolved once
and never again:

```
[dns] resolved alarm-system-100-default-rtdb.europe-west1.firebasedatabase.app -> 34.107.226.223 (cached)   x3
[dns] resolved identitytoolkit.googleapis.com -> 172.217.116.4 (cached)
[dns] resolved securetoken.googleapis.com -> 172.217.117.4 (cached)
```

`securetoken.googleapis.com` is the token-refresh host. One resolution in 23h
means the ~hourly refresh is running and no longer pays a DNS stall each time —
the case flagged in `cloud_client.h` as mattering for the auth client too.

The 85 socket errors are worth reading rather than alarming at: 83 × `-3`
(`FIREBASE_ERROR_TCP_RECEIVE_TIMEOUT`), 1 × `-1`, 1 × `-2`, a steady 5–16/hour
with no burst, **every one recovered on the next cycle**. Each shows the same
signature — the write reports `ok`, heap jumps ~42KB as the dead socket's TLS
buffers are freed, and the next line is back to normal. This is the benign form
of the 2026-09-06 fault: the socket died, the bound fired, the reconnect worked.
Flat heap across 23h confirms no leak in that reconnect path.

## Reading `ok (code -3)` — not a contradiction

`cloud: heartbeat uptime=9326 ok (code -3)` looks self-contradictory and cost a
double-take in review. In `reportHeartbeat()`, `ok` is *this* write's return
value while the code is `dataClient_->lastError().code()` — the **previous**
request's sticky error. A success does clear it, so each `-3` is one real failed
request: `grep -c "code -3"` is an accurate incident count.

## What this does NOT close

The silent auth deaths in [cloud-auth-silent-death](cloud-auth-silent-death.md)
were observed at **28h and 31.76h**. This run ended at 23h16m — short of that
window. It clears the TWDT/handshake/DNS family convincingly and says nothing
either way about the auth-death fault. A ~36h run is what closes that.

If `cloud: auth dead for Ns — forcing re-mint` appears in a longer run, that is
a **pass, not a regression**: it means `AuthSupervisor` caught a dead session
that was previously invisible to every watchdog and rebuilt it, which is exactly
what it was built to do.

---

# The recurrence (2026-09-08) — why `IoDeadline` did not cover it

**Status: root cause PINNED from the library source; fix written and native-tested;
NOT yet hardware-proven.** The `-76` hang above was recorded as fixed by the
`IoDeadline`. It was not. The same fault recurred twice.

## Evidence

Two independent records, agreeing exactly:

- `state/boot` = `{reason:"twdt", at: 2026-09-08 05:09:23}`, and `state/last_seen`
  (uptime 14,051s) back-computes to the *same instant*. A genuine watchdog
  reboot, ~10.0h into the run — not a power blip, and this time nothing
  overwrote `state/boot`.
- The **09-07 19:08 soak log caught the whole sequence live**, which is what
  made the mechanism provable:

```
19:07:51 [E][ssl_client.cpp:37] _handle_error(): [data_to_read():361]: (-76)
19:08:32 *** [stall] loopTask has not progressed for 40968ms — phase='cloud:poll-config' ***
19:08:51 task_wdt: loopTask (CPU 1) ... Rebooting
```

`[io] socket stalled past deadline` appears **zero** times. The socket died, the
loop hung 41s, and the 12s deadline never fired.

## The mechanism

`WiFiClientSecure.cpp:240-252`:

```c
int WiFiClientSecure::available() {
    int peeked = (_peek >= 0);
    if (!_connected) return peeked;                     // <-- 0 forever
    int res = data_to_read(sslclient);
    if (res < 0) { stop(); return peeked?peeked:res; }  // base stop(), NOT our override
    return res+peeked;
}
```

On `-76` the base calls **its own** `stop()`. That is a non-virtual internal
call, so it **bypasses `SslClientWithDns::stop()` and its `deadline_.disarm()`**
— while setting `_connected = false`. The first `available()` does return `-76`,
but every call *after* it takes the `!_connected` early return and yields **`0`
forever**. FirebaseClient re-polls, sees a steady `0`, and spins on `sys_idle()`
(`delay(0)`, no TWDT feed) to the 60s reboot.

The deadline could not rescue it: it is armed only in `connect()`, and on a
reused connection no new `connect()` occurs, so nothing re-arms it.

**Distinguishing signature.** The "clean" 23h run's 85 socket errors were all
`code -3` (sticky `lastError`, benign, self-recovering). A true `-76` in
`ssl_client.cpp _handle_error [data_to_read()]` is **rare — one in ~24h** — and
goes straight to stall + reboot. `grep -c "(-76)"` counts real incidents;
`code -3` does not.

## The fix

`IoDeadline` gains a `socketClosed()` state, distinct from `disarm()` (clean
completion): once the socket is known closed under an armed operation,
`expired()` is true **immediately** rather than after the remaining bound — a
closed socket delivers no more bytes, so waiting only burns watchdog budget.
`arm()` and `disarm()` both clear it, so one dead socket cannot poison later
polls on the reused client.

`SslClientWithDns::available()` detects the state after delegating: base
returned `<= 0` **and** the socket fd is gone.

**RECURSION TRAP — do not use `connected()` here.** `connected()` runs
`read(&dummy, 0)`, and that `read` is **virtual**, so it dispatches into our
`read()` override, whose base `read()` calls `available()` — re-entering the
function. Unbounded recursion, stack overflow. The check reads the **protected**
`sslclient->socket` fd instead, which `stop()` sets to `-1`
(`WiFiClientSecure.cpp:92-97`) — same signal, no re-entry, no side effects.

## How to confirm or refute

The fault is ~1/day, so **a multi-day soak is required** — the 23h "clean run"
above was never long enough to clear it. Capture with

```
pio device monitor -e esp32s3 --port <port> -f time -f log2file
```

`-f log2file` is **mandatory**: the monitor running during this incident was
started with `-f time` only and captured nothing to disk, which is why the 05:09
event has no serial trace and had to be reconstructed from RTDB.

- `grep -c "(-76)"` > 0 with `[io] socket closed under an in-flight read` and
  **no** `reason=twdt` -> **fixed** (the fault occurred and was contained).
- Zero `-76` in the window -> **inconclusive**, not a pass. The fault simply did
  not occur; keep soaking.
- A `reason=twdt` with `phase='cloud:*'` -> not fixed.
