# Watchdog + boot reporting (2026-09-02) — cause NOT yet identified

**A board was found dead after 9h16m uptime: powered, LED on, off WiFi, off
the LAN web server, and with its USB serial port GONE from the host.** A
power-cycle revived it; by then it had been silent ~28 hours. This section
records what was established and what was built to catch the next one. The
root cause is still open — do not treat the work below as a fix.

**Dating the death, since nothing logged it.** `state/last_seen` is
`millis()/1000` — device UPTIME, not epoch (the header comment on
`reportHeartbeat()` said "epoch seconds" and was wrong). It read `33365`
= 9h16m. The newest RTDB event key was 2026-09-01 05:32:21Z, so boot was
2026-08-31 20:16Z and the `state/alarm_cause` at 20:55Z falls inside that
same session. Reconstructing this from two RTDB nodes is exactly the work
`state/boot` now exists to make unnecessary.

**Two real gaps found, both fixed:**

1. **There was NO watchdog and NO auto-restart anywhere in the firmware.**
   Arduino-ESP32 does not subscribe `loopTask` to the TWDT by default, and
   nothing called `ESP.restart()`. So *any* hang was permanent until a human
   power-cycled the board. `platformWatchdogBegin()` now subscribes
   `loopTask` (30s, panic=true) and `loop()` feeds it first thing.
2. **Nothing re-checked WiFi after `setup()`.** `loop()` trusted
   `setAutoReconnect(true)` with no fallback, so a failed re-association was
   silent and permanent. `superviseWifi()` now escalates: 2min grace ->
   `WiFi.reconnect()` retried every 30s -> reboot only after **2 hours**.

   **The 2h figure is a deliberate design constraint, not a tuning knob.**
   Being offline is NOT an error state: the alarm is cloud-independent by
   design, so a device with no WiFi still decodes RF, evaluates rules, drives
   the siren and keeps its EEPROM arm state. An earlier version of this work
   rebooted at 4min, which was wrong — it would restart a perfectly
   functional alarm every few minutes through a router outage, and every
   reboot is a window where no sensor is watched at all. The restart exists
   only for a wedged radio that repeated nudging cannot fix.

**API trap:** this core ships the OLD TWDT API —
`esp_task_wdt_init(uint32_t seconds, bool panic)`. The IDF v5
`esp_task_wdt_config_t` / `esp_task_wdt_reconfigure()` form does NOT compile
here. Verified by reading the installed header, not assumed.

**The TWDT is already running before we touch it.** The core builds with
`CONFIG_ESP_TASK_WDT=y` and `CONFIG_ESP_TASK_WDT_TIMEOUT_S=5`, so the IDF
initialises it at boot on a **5s** period. This API's documented behaviour is
to *update* the timeout when already initialised (`ESP_ERR_INVALID_STATE` is
NOT among `esp_task_wdt_init`'s returns — only `deinit`/`add`/`reset` return
it, and only when the TWDT is *not* initialised), so our call raises 5s → 30s
rather than being rejected.

That was originally assumed rather than checked, and the return codes were
discarded. Both are now inspected and the effective configuration is printed
once at boot (`[wdt] loopTask watched, timeout 30s…`). If a future core
changes this, the log says so instead of silently leaving the firmware on a
5s budget while every comment claims 30 — which would reboot the board during
the legitimate multi-second boot waits and present as a boot loop.

**`delay()` does NOT feed the TWDT.** On ESP32 it is `vTaskDelay`, which
blocks the task without resetting the watchdog. `connectToWifi()`'s 15s wait
loop and both of its blocking `WiFi.scanNetworks()` calls therefore call
`platformFeedWatchdog()` explicitly. Without that, a slow-but-working AP
would reboot the device mid-association — the watchdog causing exactly the
boot loop it exists to prevent.

**Scope limit, worth knowing:** only `loopTask` is subscribed. A hang inside
FirebaseClient's async task or the WiFi driver would NOT trip this watchdog,
and a wedged network stack is a live suspect for the original death. The
watchdog is still worth having, but it does not cover every failure mode.

Also: `platformFeedWatchdog()` was `yield()` on ESP32, and its comment
claimed the TWDT is satisfied by yielding. That is false once a task is
subscribed — the TWDT tracks an explicit per-task reset, and a task can
yield forever while starved. It now calls `esp_task_wdt_reset()` too.

**Why it looked like dead hardware:** the S3's USB-Serial/JTAG is
software-serviced, so a panicked/halted CPU stops enumerating and the port
disappears from the host. A hardware UART would have kept its handle. Losing
`/dev/cu.*` is therefore evidence of a panic, NOT of a dead board.

**`state/boot` = `{reason, at}`**, written once per boot by
`CloudClient::reportBoot()`. `reason` comes from `esp_reset_reason()`:
`panic` (crash), `twdt` (hang caught by the new watchdog), `brownout`
(power), `power_on` (ordinary unplug). The Operations page banners anything
that is not human-initiated, since a crash-and-recover is otherwise
invisible — the device just reappears. Heartbeats also now print
`heap/min/maxblock`, so a slow leak is visible as a trend BEFORE the next
death.

**A hypothesis that was raised and REJECTED, so it is not re-raised:** that
`kPollIntervalMs = 5000` (changed from 15000 in `32999b0`) caused it. The
OOM-at-5s measurement in `cloud_client.h`'s comment is ESP8266-only —
that board had ~5KB free and mDNS was losing a 540-byte allocation. The S3
has 258KB free / 192KB largest block, where a 5s cadence is not a heap
problem. **The comment above that constant is stale and describes the 8266;
do not read it as an ESP32 constraint.**

**Still unknown:** what actually hung it. The next occurrence will say so in
`state/boot.reason` plus a panic backtrace on the serial console.

### Device offline alerts (2026-09-02)

Nothing watched the CONTROLLER — `deadSensorCheck` watches sensors only, so
the 28-hour outage above produced no alert of any kind. Now:

- `onHeartbeat` (RTDB trigger on `state/last_seen`) stamps
  `projects/{id}.device.lastSeen` with SERVER wall-clock time. Required
  because the value the device writes is **uptime**, not epoch — a reader
  cannot otherwise tell a live device from one that died yesterday.
- `checkDeviceLiveness()` runs from **scheduleTick's existing every-minute
  tick**, not a new scheduled function. Thresholds: **5min while armed**,
  **2h while disarmed** — armed-and-offline means the premises are
  unwatched, whereas disarmed usually means someone is home power-cycling
  things. Disarmed is quieter, never silent.
- `device.offlineAlertSentAt` latches the alert (one outage = one message)
  and records when it was noticed, so the back-online message can report the
  outage length. Set only AFTER a successful send, so a Telegram failure
  retries next minute rather than swallowing the only warning.

**Cloud Scheduler allows 3 free jobs per BILLING ACCOUNT and `scheduleTick`
+ `deadSensorCheck` use two. Do not add a third — fold new periodic work
into one of those two ticks.**
