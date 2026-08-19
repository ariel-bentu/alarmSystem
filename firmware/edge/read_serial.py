#!/usr/bin/env python3
"""Serial reader for D1 Mini bring-up.

Filters the noise that makes `pio device monitor` unreadable during crash
loops: stack-dump hex lines and the 0xfeefeffe fill pattern. Keeps
HEAPPROBE lines, phase timings, and exception headers.

Usage: read_serial.py [seconds] [--reset] [--port PORT]
  --reset toggles DTR/RTS to restart the board without reflashing.
  --port  overrides the default (D1 Mini CH340). For the ESP32-S3 pass
          --port /dev/cu.usbmodem1101 — it enumerates as native
          USB-Serial/JTAG, not a CH340.
"""
import re
import sys
import time

import serial

PORT = "/dev/cu.usbserial-110"
BAUD = 115200

STACK_LINE = re.compile(r"^[0-9a-f]{8}:\s")
FILL = "feefeffe"


def main():
    duration = 30.0
    do_reset = "--reset" in sys.argv
    port = PORT
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--port":
            i += 1
            port = args[i]
        elif arg != "--reset":
            duration = float(arg)
        i += 1

    ser = serial.Serial(port, BAUD, timeout=0.2)

    # The ESP32-S3's native USB-Serial/JTAG re-enumerates on reset, which
    # drops this handle; the CH340 stays put. Skip the manual toggle there
    # and just open the port — the board is already running.
    is_usb_jtag = "usbmodem" in port

    if do_reset and is_usb_jtag:
        print("(--reset skipped: native USB-Serial/JTAG re-enumerates on "
              "reset; power-cycle or re-run to recapture boot output)")
    elif do_reset:
        # Hold EN low long enough to actually reset. A 150ms pulse was NOT
        # reliable on this adapter — it left the board in a state that
        # produced no output at all (not even the 74880-baud ROM banner),
        # which looks exactly like a dead board. 1s hold is dependable.
        # RTS drives EN; DTR must stay deasserted or the board enters the
        # bootloader (GPIO0 low) instead of running the application.
        ser.setDTR(False)
        ser.setRTS(True)
        time.sleep(1.0)
        ser.setRTS(False)
        ser.setDTR(False)
        time.sleep(0.2)

    ser.reset_input_buffer()
    end = time.time() + duration
    suppressed = 0

    while time.time() < end:
        raw = ser.readline()
        if not raw:
            continue
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if STACK_LINE.match(line) or FILL in line:
            suppressed += 1
            continue
        print(line, flush=True)

    ser.close()
    if suppressed:
        print(f"\n[reader: suppressed {suppressed} stack-dump lines]")


if __name__ == "__main__":
    main()
