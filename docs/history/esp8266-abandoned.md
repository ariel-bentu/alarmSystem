# ESP8266 (D1 Mini) — abandoned 2026-08-29

Historical. The D1 Mini is **not a target** — do not spend time making it
build. Kept because the root causes are non-obvious and the measurement
traps are easy to fall into again. See [ESP32-S3 port](esp32-s3-port.md).


**The D1 Mini is no longer a target — do not spend time making it build.**
It is too small for this workload: 2 simultaneous TLS connections max, and
heap fragmentation made cloud event writes impossible (details preserved
below, since the measurements are worth keeping). `[env:d1_mini]` remains
in `platformio.ini` but **does not compile** — `cc1101_receiver.cpp` uses
ESP32-only `esp_timer_get_time`/`GPIO`, and porting it behind
`platform_compat.h` is deliberately not being done.

Everything from here to the "ESP32-S3 port" heading is ESP8266 history.
It is kept because the root causes are non-obvious and the measurement
traps are easy to fall into again — not because any of it is current.

**RESOLVED (2026-08-20): the mint/WDT crash is fixed.** The device now
boots, mints its custom token, and stays up. Kept here because the root
cause is non-obvious and easy to reintroduce.

**Root cause: cont-stack exhaustion, not heap.** `loop()` runs on the
ESP8266's 4KB cont stack and is entered with ~1568 bytes left. GCC gives a
function ONE frame, sized for its worst-case path and allocated in full on
entry — so when `main.cpp`'s `loop()` inlined its helpers (a ~2.4KB
`Config`, `KeruiPacket` + decoder buffers, `String` temporaries), all those
locals merged into a single frame. By the time `CloudClient::loop()` ran the
mint, BearSSL's TLS handshake had **992 bytes** to work with. It could not
proceed, so it never yielded, so the ~3s software watchdog fired. That
presented as a *hang* inside `_run_until` rather than a clean allocation
failure, which is what made it look like a network or heap bug for so long.

**The fix** (`firmware/edge/device/src/main.cpp`):
- `handleSensorEvent`, `applyArmedCommand`, `pollCc1101`, and
  `applyPendingConfigUpdate` are marked `__attribute__((noinline))`. This is
  load-bearing, not a hint — it keeps each frame alive only while its call
  is on the stack.
- `cloudClient.loop()` is called FIRST in `loop()`, so the mint runs at the
  shallowest depth available.
- Handshake headroom went **992 → 3440 bytes**; `connect()` now succeeds in
  ~1.5s, and a 4596ms handshake was observed completing with no reset.

A second, independent bug was hiding behind it: `mintCustomToken()` parsed
its response with a `StaticJsonDocument<2048>` — a 2KB **stack** object in a
function with ~3.4KB total. HTTP 200s were being discarded as parse
failures. Now a heap-backed `JsonDocument`, parsed in place at the body
offset (no `substring()` copy).

**Measured facts — do not re-litigate without new evidence:**
- *Heap is not the constraint.* Fails at 22,008 free / 22,136 max block,
  succeeds at 23,192. A ~1KB delta cannot explain an 8.2KB allocation.
  Fragmentation was 1-2% in every run, good and bad. (An older note claimed
  the device crashed with MORE free heap than `spike_mint`. That was a
  mismeasurement — the spike runs at ~36,360 free, not ~20KB. The device
  always had less.)
- *A slow handshake is not fatal.* `spike_mint` completed one in **4093ms**,
  past the watchdog window, with no reset. BearSSL yields correctly while it
  is making progress. Being *stuck* is what kills it.
- *Not the board.* A second D1 Mini reproduced the crash identically.
- Also ruled out: TLS buffer size (1024/1024 still hung), LittleFS staying
  mounted, `cc1101.poll()` and its floating GDO0, the local web server,
  Cloud Function latency (<1s, warm), `CloudClient`'s object shape, and the
  device binary's statics (the mint succeeds in that same binary when
  `loop()` is shallow).

**Two measurement traps, recorded so nobody repeats them:**
- `ESP.getFreeContStack()` is a high-water mark, not live headroom — it
  reads 0 at the top of a perfectly healthy `loop()`. Measure live headroom
  as `(&local - g_pcont->stack)`; `cloud_client.cpp` keeps a probe that
  prints it on every mint as a regression guard.
- Adding a diagnostic `WiFi.hostByName()` before `connect()` warms lwIP's
  DNS cache and masks the failure, making it look like a DNS bug.

`-DCONT_STACKSIZE=8192` boot-loops this board — do not re-enable
(see `platformio.ini`). The `noinline` fix makes it unnecessary.

**Hardware bring-up commands** (ESP32-S3, native USB — check `ls /dev/cu.*`,
macOS reassigns the `usbmodem` suffix per port/session):

```bash
cd firmware/edge/device && pio run -e esp32s3 -t upload --upload-port /dev/cu.usbmodem101
# NOTE: bare `pio run` also builds [env:native], which fails to link
# (no _main outside a test run). Always pass -e esp32s3. Tests: pio test -e native

# Readable serial capture. --port is REQUIRED: the script still defaults to
# the retired D1 Mini's CH340 path and errors out without it.
python3 firmware/edge/read_serial.py 40 --port /dev/cu.usbmodem101
```

`--reset` is a no-op here and says so: the S3's native USB-Serial/JTAG
re-enumerates on reset, dropping the handle. To recapture boot output,
power-cycle or start the reader immediately after an upload.

The LAN web server is at **`alarm.local`** — the firmware calls
`MDNS.begin("alarm")`. (Earlier docs said `local.alarm.local`; that never
resolved.) Useful for bench testing without touching a physical sensor:

```bash
curl -s http://alarm.local/status
curl -s -X POST "http://alarm.local/trigger?rfId=0x2E5B73"   # simulate a sensor
```

**Decoding crash addresses:**

```bash
~/.platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-addr2line \
  -pfiaC -e .pio/build/esp32s3/firmware.elf 0x42000abc
```

`firmware/edge/spike_mint/` remains as a known-good minimal control (mint +
RTDB write/read). `spike_mint/src/local_secrets.h` is gitignored but present
on this machine. `device/data/provision.json` (gitignored) can pre-seed
LittleFS via `pio run -t uploadfs`, but note it landed at an offset the
firmware did not read on the second board — the setup portal is the reliable
path.

**Cloud sync works, but only with TWO TLS connections — not four.** The
original design used four `WiFiClientSecure` objects (auth, write, commands
SSE, config SSE). That does NOT fit: constructing them costs ~11.8KB,
dropping the heap from 21,568 to 9,808, after which BearSSL fails a
3424-byte allocation per handshake and the firmware dies with
`Unhandled C++ exception: OOM` in `_connectSSL`. `setBufferSizes(512,512)`
on all four did not save it — the number of *simultaneous* TLS connections
is the constraint, not their buffer size.

`spike_mint` was the clue: it does mint + RTDB auth + write + read on this
same board using only **two** clients and no SSE. `CloudClient` now matches
that shape — one auth client, one shared data client — and polls `/config`
and `/commands` alternately every 3s instead of streaming. Verified on
hardware: `app.ready() -> true`, `config updated (19 bytes, 0 sensors)`
polled from RTDB, stable for 70s+ with no resets, LAN web server still
serving throughout.

Trade-off: remote arm/disarm now has up to ~6s latency (two poll slots)
instead of being pushed. Acceptable for now; SSE becomes viable again on
hardware with more RAM.

**RESOLVED on ESP32-S3 (2026-08-27) — see "ESP32-S3 port" below. The rest
of this section describes the ESP8266, where it is still true.**

**Cloud event writes DO NOT work on ESP8266 hardware — heap fragmentation.**
This was the blocker that prompted the ESP32 order
(2026-08-20). Everything else on the cloud path works: mint, RTDB auth, and
polling `/config` and `/commands`. Only `reportEvent()`'s TLS write is
disabled, behind the `kMinBlockForEventWrite` floor, because attempting it
below ~5KB contiguous **resets the board** (Exception 29) instead of failing
cleanly.

Measured with `umm_info()` (the tool that finally settled this —
`getFreeHeap()` cannot see the problem):

| point | free | largest block | frag metric |
|---|---|---|---|
| at `app.ready()` | 15,072 | 10,568 | 54 |
| after 1st poll | 4,824 | 3,400 | 32 |
| after close | 10,648 | 3,472 | 50 |

After the first TLS cycle the largest contiguous block settles at ~3.4KB and
never recovers, even with ~10KB free. Small polls (51- and 14-byte reads)
fit; an event write does not. `umm_malloc` has no compaction.

Tried, measured, insufficient: eager client allocation at auth time (helps
polling — kept), `stop()` between operations to free BearSSL's buffers (frees
them, but reconnecting re-cuts from a fragmented heap: frag 32 -> 50 per
close), destroy-and-recreate (crashes — dangling entry in `FirebaseApp`'s
global client vector), and smaller `setBufferSizes`.

**Consequence on ESP8266:** a real sensor trigger fires the local siren and
updates LAN state, but produces no Firestore timeline entry and no Telegram
alert. Local alarm logic, EEPROM persistence and LAN arm/disarm are
unaffected and work offline.
