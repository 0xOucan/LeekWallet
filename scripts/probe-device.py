"""Talk to the LeekWallet protocol endpoint over the flashing cable."""
import serial, time, sys

SYNC = b"LK"

def cbor_text(s):
    b = s.encode(); return bytes([0x60 | len(b)]) + b if len(b) < 24 else bytes([0x78, len(b)]) + b

def request(method):
    # {"method": "<method>"}  -- one-pair map, canonical
    body = bytes([0xa1]) + cbor_text("method") + cbor_text(method)
    frame = bytes([0x01]) + body
    return SYNC + len(frame).to_bytes(2, "big") + frame

def read_frame(s, timeout=3.0):
    end = time.time() + timeout
    buf = b""
    while time.time() < end:
        buf += s.read(64)
        i = buf.find(SYNC)
        if i >= 0 and len(buf) >= i + 4:
            n = int.from_bytes(buf[i+2:i+4], "big")
            if len(buf) >= i + 4 + n:
                return buf[i+4], buf[i+5:i+4+n]
    return None, None

port = serial.Serial("/dev/ttyACM0", 115200, timeout=0.2)
time.sleep(0.3)
port.reset_input_buffer()

for method in ["ping", "getFeatures", "getStatus", "getMnemonic"]:
    port.write(request(method))
    port.flush()
    t, payload = read_frame(port)
    label = {1: "REQUEST", 2: "RESPONSE", 0x7f: "ERROR"}.get(t, f"type {t}")
    print(f"{method:14s} -> {label:9s} {payload.hex() if payload else '(no reply)'}")
port.close()
