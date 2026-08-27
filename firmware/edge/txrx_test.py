#!/usr/bin/env python3
"""Drive the TX board while an independent RX board listens.

A single CC1101 cannot cleanly receive its own transmission, so TX framing
can only be verified with a second radio. This opens both boards, sends a
command to the transmitter, and prints whatever the receiver reports.

Usage: txrx_test.py [tx_command] [listen_seconds]
"""
import serial, sys, time, threading

TX_PORT = "/dev/cu.usbmodem101"
RX_PORT = "/dev/cu.usbmodem1101"

tx_cmd = sys.argv[1] if len(sys.argv) > 1 else "l"
listen_s = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0

rx_lines = []
stop = threading.Event()


def reader(port, tag, sink):
    try:
        s = serial.Serial(port, 115200, timeout=0.3)
    except Exception as e:
        print(f"[{tag}] open failed: {e}")
        return
    time.sleep(0.2)
    s.reset_input_buffer()
    buf = b""
    while not stop.is_set():
        try:
            d = s.read(512)
        except Exception:
            break
        if d:
            buf += d
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    sink.append(text)
                    print(f"[{tag}] {text}", flush=True)
    try:
        s.close()
    except Exception:
        pass


rx_thread = threading.Thread(target=reader, args=(RX_PORT, "RX", rx_lines), daemon=True)
rx_thread.start()
time.sleep(1.5)  # let the RX board settle into its listening state

print(f"--- sending '{tx_cmd}' to TX board ---", flush=True)
try:
    tx = serial.Serial(TX_PORT, 115200, timeout=0.3)
    time.sleep(0.3)
    tx.reset_input_buffer()
    tx.write(tx_cmd.encode())
    tx.flush()
except Exception as e:
    print(f"[TX] open/write failed: {e}")
    stop.set()
    sys.exit(1)

deadline = time.time() + listen_s
while time.time() < deadline:
    try:
        d = tx.read(512)
        if d:
            for ln in d.decode("utf-8", errors="replace").splitlines():
                if ln.strip():
                    print(f"[TX] {ln.rstrip()}", flush=True)
    except Exception:
        break
    time.sleep(0.05)

stop.set()
time.sleep(0.5)
try:
    tx.close()
except Exception:
    pass

print("\n--- verdict ---")
hits = [l for l in rx_lines if "DECODED" in l]
if hits:
    for h in hits:
        print("RECEIVED:", h.strip())
elif any("BURST" in l for l in rx_lines):
    print("RF detected by the independent receiver, but no valid Kerui framing.")
else:
    print("Nothing received at all.")
