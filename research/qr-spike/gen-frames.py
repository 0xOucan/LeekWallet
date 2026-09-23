#!/usr/bin/env python3
"""Render an animated-QR sequence to raw 8-bit grayscale frames.

The frames stand in for what the OV5640 hands the decoder: one QVGA
grayscale buffer per captured frame. They are clean renders, so the decode
times measured from them are a *floor*. A real camera adds blur, glare,
perspective and noise, all of which make identify.c work harder.
"""
import argparse, sys
import qrcode

def render(payload, out, w, h, quiet, invert, margin):
    q = qrcode.QRCode(border=4, error_correction=qrcode.constants.ERROR_CORRECT_L)
    q.add_data(payload)
    q.make(fit=True)
    m = q.get_matrix()
    n = len(m)
    # scale the code to fill `margin` of the shorter side, centred
    scale = max(1, int(min(w, h) * margin / n))
    side = n * scale
    x0, y0 = (w - side) // 2, (h - side) // 2
    buf = bytearray([0xFF]) * 0 or bytearray(b"\xff" * (w * h))
    for y in range(side):
        row = m[y // scale]
        base = (y0 + y) * w + x0
        for x in range(side):
            if row[x // scale]:
                buf[base + x] = 0x00
    if invert:
        buf = bytearray(255 - b for b in buf)
    out.write(bytes(buf))
    return n, q.version

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--parts", type=int, default=12, help="frames in the sequence")
    p.add_argument("--bytes-per-part", type=int, default=90)
    p.add_argument("--width", type=int, default=320)
    p.add_argument("--height", type=int, default=240)
    p.add_argument("--margin", type=float, default=0.90,
                   help="fraction of the short side the code fills")
    p.add_argument("--invert", action="store_true")
    p.add_argument("-o", "--out", default="frames.gray")
    a = p.parse_args()

    # Shaped like a BC-UR multipart payload, which is what EIP-4527 rides on.
    body = "".join("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[i % 32]
                   for i in range(a.bytes_per_part))
    versions = set()
    with open(a.out, "wb") as f:
        for i in range(a.parts):
            payload = f"UR:ETH-SIGN-REQUEST/{i+1}-{a.parts}/{body}"
            n, v = render(payload, f, a.width, a.height, 4, a.invert, a.margin)
            versions.add(v)
    print(f"{a.parts} frames  {a.width}x{a.height} gray  "
          f"QR version {sorted(versions)}  modules {n}x{n}  "
          f"{a.parts * a.width * a.height} bytes -> {a.out}", file=sys.stderr)

main()
