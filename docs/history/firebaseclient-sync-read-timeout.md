# FirebaseClient's read timeout could never fire (2026-09-08 → 09-10)

**Status: root cause PINNED in the library source, fix PROVEN on hardware
2026-09-10** by an 18.16h run that absorbed four `-76` socket deaths with zero
reboots. This is the fault that survived every fix in
[tls-handshake-watchdog-reboot](tls-handshake-watchdog-reboot.md).

## The symptom

A `twdt` reboot roughly once a day, always the same shape:

```
04:18:00 [E][ssl_client.cpp:37] _handle_error(): [data_to_read():361]: (-76)
04:18:40 *** [stall] loopTask has not progressed for 40802ms — phase='cloud:poll-config' ***
04:19:00 E task_wdt: Task watchdog got triggered. - loopTask (CPU 1). Aborting.
```

Observed at 10.0h and 18.36h of uptime. `-76` is `MBEDTLS_ERR_NET_RECV_FAILED`:
the peer dropped a keep-alive connection mid-response.

## Root cause

`AsyncClient.h:1131-1153`, the synchronous read-response loop:

```cpp
while (return_type == ret_continue && (httpCode == 0 || stage != finished))
{
    sData->response.feedTimer(... sync_read_timeout_sec ...);  // 1133  re-arms
    sData->return_type = receive(sData);                       // 1134
    handleReadTimeout(sData);                                  // 1136  checks remaining()==0
    if (sData->async || sData->return_type == ret_failure) break;
}
```

`feedTimer()` resets the deadline at the top of every iteration and
`handleReadTimeout()` reads it three lines later, **so it can never be expired
when checked**.

This is not about iteration speed. `Timer::feed()` → `setInterval()` →
`reset()` sets `end = ts + period` from the *current* `ts` (`Timer.h:24`), so
`end - ts == period` after every call and `ready()` (`ts >= end`) is never true.
Swept at 1/50/101/150/1000 ms per iteration — including rates above
`Timer::loop()`'s `> 100` guard, where `ts` genuinely advances — it never
expires.

The chain that makes the loop unbounded after a mid-response death:

1. `WiFiClientSecure::available()` hits `-76`, calls its **own** `stop()` (a
   non-virtual internal call, so a subclass override is bypassed), sets
   `_connected = false`; every later call returns **0** via the
   `if (!_connected) return peeked;` early return.
2. `readResponse()` only works `if (tcpAvailable() > 0)` (`AsyncClient.h:452`).
   With 0 it is a no-op that still returns **`true`** (line 539).
3. `receive()` returns `ret_continue` (line 441, or 398 if the socket died
   before the status line).
4. Both loop conjuncts hold forever, so the `break` at 1151 is unreachable.
5. Each pass calls `sys_idle()` = `delay(0)`, which yields to FreeRTOS but does
   **not** feed the TWDT.

**The contrast that isolates it:** the *other* sync wait at
`AsyncClient.h:1118-1124` has no `feedTimer()` inside it, and exits correctly —
same `handleReadTimeout()`, same dead socket. The only difference is the re-arm.

**Why the library's own socket-closed check never fires:**
`ResponseHandler.h:263` (`!connected() && available()==0 && totalRead==0`) is
reachable only via `readPayload()`, which sits behind the `tcpAvailable() > 0`
gate — closed by a dead socket. It also requires `totalRead == 0`, false for a
death *after* the headers.

## Two wrong fixes first

Recorded because both looked correct and cost a soak each.

1. **`socketClosed()` gated on `fd < 0`.** `stop_ssl_socket()` sets
   `socket = -1` at `ssl_client.cpp:325` and then **memsets the whole struct to
   zero** at :346, so the fd is **0** after teardown. `< 0` never matched. Ran
   18.36h, rebooted identically. The predicate must be `<= 0`.
2. **Returning a negative from `available()`.** That breaks
   `while (!tcpAvailable())` at line 1118 — but that loop was never the broken
   one. The hanging loop reaches `available()` only through
   `if (tcpAvailable() > 0)`, and a negative fails `> 0` exactly like 0 does.
   Nothing in FirebaseClient treats `available() < 0` specially. We were fixing
   the loop that wasn't failing.

## The fix

**Patch the library** (`patch_firebase.py`, a `pre:` extra_script on
`[env:esp32s3]`): feed the read timer only when the iteration made progress —
`respCtx.totalRead` increased or `respCtx.stage` advanced. A live-but-slow
transfer keeps extending its deadline; a non-progressing loop expires at
`sync_read_timeout_sec`.

**Not** hoisting `feedTimer()` out of the loop: that makes a flat deadline for
the whole response and would kill large chunked downloads, and `readPayload()`
feeds per chunk at line 582 anyway.

`.pio/` is gitignored and `lib_deps` is a caret range, so the patch is
re-applied on every build and **fails the build** if its anchor no longer
matches — a silent no-op after a library update would reintroduce a watchdog
reboot with no signal. Verified: altered anchor → exit 1, no `firmware.bin`.

**Second line of defence:** `SslClientWithDns::available()` returns a *positive*
token once it detects the socket is gone, so the library enters its own teardown
(`readPayload()` → `readResponse<>()` → 5s bound → `stage = finished`). Gated on
`deadline_.armed()`, because an idle client legitimately has no socket and
reporting that produced false `[io]` lines on a healthy boot.

## Proven (2026-09-10)

18.16h, single boot, uptime 11 → 65,392s.

| Signal | Before | After |
|---|---|---|
| `-76` events | 1 → reboot | **4 → all recovered** |
| `-76` to next successful request | 40.8s stall → reboot at 60s | **4.03 / 5.04 / 5.05 / 5.02 s** |
| `[stall]` dumps / `reason=twdt` | 1 / 1 | **0 / 0** |
| Heap start → end | — | 180,484 → 180,024 (flat) |
| DNS resolves | — | 5 in 18h |

~5.0s **is** `setSyncReadTimeout(5)` — the library's own timeout finally firing.
The first event also logged `code -3` (`FIREBASE_ERROR_TCP_RECEIVE_TIMEOUT`),
previously unreachable on this path.

**The library patch is what caught it.** `[io] socket closed under an in-flight
read` fired **zero** times, so the `SslClientWithDns` path was never reached —
the patched timer expired first every time. The override is kept as redundancy
but remains unproven in the field; do not cite this run as evidence for it.

## Correcting the earlier record

The 23h16m run of 2026-09-07 was recorded as proving the dead-socket fix. It did
not — it simply never hit a `-76`. **Zero `-76` in a window is inconclusive, not
a pass.** The distinguishing signature: that run's 85 socket errors were all
`code -3` (sticky `lastError`, benign, self-recovering), while a true `-76` in
`ssl_client.cpp _handle_error [data_to_read()]` is rare — about one per day —
and before this fix went straight to a stall and reboot.

## Upstream

**Filed 2026-09-10 as
[mobizt/FirebaseClient#333](https://github.com/mobizt/FirebaseClient/issues/333)**
— text in `docs/upstream/ISSUE.md`, with a standalone reproducer
(`timer_repro.cpp`, no hardware needed).

[#313](https://github.com/mobizt/FirebaseClient/issues/313) is the same symptom,
closed by the maintainer as a memory fault; our heap data refutes that for this
instance — flat across 18.36h, min-free 121,488, and 220,532 free *at* the stall
(it rose, as the dead socket's TLS buffers were released).

If #333 is accepted and released, `patch_firebase.py` can be retired: bump the
`lib_deps` floor to the fixed version and delete the script and its
`extra_scripts` line. Check the patched loop against the released source first —
if upstream's fix differs from ours, the script's hard-fail will catch the
mismatch on the next build anyway.
