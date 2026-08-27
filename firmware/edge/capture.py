#!/usr/bin/env python3
"""Listen on the RX board for N seconds, optionally poking the TX board first.

Used for the "what does the hub send when the siren fires?" experiment: the
TX board trips a ghost sensor the panel already trusts, and this records
everything the receiver hears while the alarm runs.

Usage: capture.py <listen_seconds> [tx_command]
"""
import serial, sys, time, threading

RX_PORT = "/dev/cu.usbmodem1101"
TX_PORT = "/dev/cu.usbmodem101"

listen_s = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
tx_cmd = sys.argv[2] if len(sys.argv) > 2 else None

stop = threading.Event()
t0 = time.time()


def pump(port, tag):
    try:
        s = serial.Serial(port, 115200, timeout=0.3)
    except Exception as e:
        print(f"[{tag}] open failed: {e}", flush=True)
        return
    time.sleep(0.3)
    s.reset_input_buffer()
    buf = b""
    while not stop.is_set():
        try:
            d = s.read(1024)
        except Exception:
            break
        if d:
            buf += d
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    print(f"[{time.time()-t0:6.2f}s {tag}] {text}", flush=True)
    try:
        s.close()
    except Exception:
        pass


threading.Thread(target=pump, args=(RX_PORT, "RX"), daemon=True).start()
threading.Thread(target=pump, args=(TX_PORT, "TX"), daemon=True).start()
time.sleep(1.5)

if tx_cmd:
    print(f"--- sending '{tx_cmd}' to TX ---", flush=True)
    try:
        tx = serial.Serial(TX_PORT, 115200, timeout=0.3)
        time.sleep(0.2)
        tx.write(tx_cmd.encode())
        tx.flush()
        tx.close()
    except Exception as e:
        print(f"[TX] write failed: {e}", flush=True)

time.sleep(listen_s)
stop.set()
time.sleep(0.4)
print(f"--- {listen_s}s capture done ---", flush=True)
