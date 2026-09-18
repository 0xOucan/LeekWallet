#!/usr/bin/env python3
"""
Ask a running LeekWallet which board it is.

Prints one line on stdout and exits 0:
    LeekWallet-S3 / LeekWallet-S3CAM / LeekWallet-Pixie   the board answered
    none                                                  nothing answered

The chip alone cannot say this. The reference board and the CAM board are
both an ESP32-S3 N16R8, so esptool reports the same chip, the same flash and
the same PSRAM for both - and their pin maps are completely different: the
reference image drives I2C and the buttons on GPIO 5-10, which on the CAM
board are camera data lines. `getFeatures` answers without a session and its
`model` field comes from board.h, so a board already running LeekWallet can
say which one it is.

"none" is not an error. A blank board, a board whose selected transport is
BLE (USB reception is switched off then, PROTOCOL.md section 3b), or the UART
bridge port rather than the native one will all say nothing. The caller
decides what silence permits, and it must not permit a guess.

DTR and RTS are held low before the port opens. On the native USB-Serial/JTAG
port, pyserial's default of raising them resets the S3 - the same fault that
bit the extension's Web Serial path.
"""
import sys
import time

import serial

SYNC = b"LK"


def cbor_text(s):
    b = s.encode()
    return bytes([0x60 | len(b)]) + b if len(b) < 24 else bytes([0x78, len(b)]) + b


def request(method):
    body = bytes([0xA1]) + cbor_text("method") + cbor_text(method)
    frame = bytes([0x01]) + body
    return SYNC + len(frame).to_bytes(2, "big") + frame


def read_frame(port, timeout):
    end = time.time() + timeout
    buf = b""
    while time.time() < end:
        buf += port.read(128)
        i = buf.find(SYNC)
        if i >= 0 and len(buf) >= i + 4:
            n = int.from_bytes(buf[i + 2:i + 4], "big")
            if len(buf) >= i + 4 + n:
                return buf[i + 4], buf[i + 5:i + 4 + n]
    return None, None


def text_after_key(payload, key):
    """The text value following `key` in a CBOR payload. Deliberately narrow:
    it reads one definite-length text string and nothing else, because the
    only thing this script needs from the reply is the model name."""
    k = cbor_text(key)
    i = payload.find(k)
    if i < 0:
        return None
    j = i + len(k)
    if j >= len(payload):
        return None
    ib = payload[j]
    if ib >> 5 != 3:
        return None
    n = ib & 0x1F
    j += 1
    if n == 24:
        n = payload[j]
        j += 1
    elif n > 24:
        return None
    try:
        return payload[j:j + n].decode("ascii")
    except UnicodeDecodeError:
        return None


def probe(path, boot_wait, timeout):
    port = serial.Serial()
    port.port = path
    port.baudrate = 115200
    port.timeout = 0.2
    port.dtr = False
    port.rts = False
    try:
        port.open()
    except serial.SerialException:
        return None
    try:
        time.sleep(boot_wait)
        port.reset_input_buffer()
        port.write(request("getFeatures"))
        port.flush()
        ftype, payload = read_frame(port, timeout)
        if ftype != 0x02 or payload is None:
            return None
        model = text_after_key(payload, "model")
        if model is None or not model.startswith("LeekWallet-"):
            return None
        return model
    finally:
        port.close()


def main():
    if len(sys.argv) < 2:
        print("usage: board-model.py <port> [boot-wait-seconds]", file=sys.stderr)
        return 2
    wait = float(sys.argv[2]) if len(sys.argv) > 2 else 0.3
    print(probe(sys.argv[1], wait, 3.0) or "none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
