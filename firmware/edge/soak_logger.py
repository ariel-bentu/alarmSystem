#!/usr/bin/env python3
"""Unattended raw serial logger for multi-day soaks.

WHY THIS EXISTS: `pio device monitor` needs a TTY for its interactive console
and dies with `termios.error: (19, 'Operation not supported by device')` when
backgrounded (nohup, CI, a detached shell). The 2026-09-08 twdt reboot lost its
serial trace because the monitor left running used `-f time` with no
`-f log2file` and wrote nothing to disk. This writes every line, unfiltered,
timestamped, flushed immediately, and survives the board rebooting or
re-enumerating mid-run.

Unlike read_serial.py (fixed duration, filters stack noise for bring-up), this
runs until killed and keeps EVERYTHING — a stall dump or panic backtrace is the
whole point of the capture.

Usage: soak_logger.py --port /dev/cu.usbmodem1101 [--out FILE]
"""
import argparse
import datetime
import sys
import time

import serial


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", required=True)
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = args.out or "logs/soak-%s.log" % time.strftime("%y%m%d-%H%M%S")
    ser = None
    with open(out, "a", buffering=1, errors="replace") as fh:
        def emit(line):
            stamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
            fh.write("%s > %s\n" % (stamp, line))

        emit("[soak] logging %s at %d into %s" % (args.port, args.baud, out))
        buf = b""
        while True:
            try:
                if ser is None:
                    # The S3's native USB-Serial/JTAG disappears on panic and
                    # comes back on reboot, so reopening is the normal path,
                    # not an error case.
                    ser = serial.Serial(args.port, args.baud, timeout=1)
                    emit("[soak] port opened")
                chunk = ser.read(4096)
                if chunk:
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        emit(line.decode("utf-8", "replace").rstrip("\r"))
            except (OSError, serial.SerialException) as exc:
                emit("[soak] port lost (%s) — reopening" % exc)
                try:
                    if ser:
                        ser.close()
                except Exception:
                    pass
                ser = None
                time.sleep(2)
            except KeyboardInterrupt:
                emit("[soak] stopped")
                return 0


if __name__ == "__main__":
    sys.exit(main())
