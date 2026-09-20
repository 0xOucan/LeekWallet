#!/usr/bin/env python3
"""
Watch the device's camera from the PC, live, while focusing it.

The board can print raw frames over the USB cable (built with
-DCAMERA_AUTODUMP_MS=250 -DCAMERA_FORCE_QVGA=1). This shows them in a window
with two numbers that are what you actually need while turning a lens:

  sharp   variance of the Laplacian. Higher is sharper. Turn the lens barrel
          until this peaks - it is a far better guide than your eyes on a
          small preview, and it is the same measure whatever the scene.
  QR      what a decoder makes of that exact frame, so "is it sharp enough
          yet" stops being a guess.

Run it with the device on the Scan screen:

    python3 research/qr-spike/camera-view.py [/dev/ttyACM0]

Press q or Escape to quit. It only reads; nothing is sent to the device.
"""
import base64
import re
import sys
import tkinter as tk

import serial
from PIL import Image, ImageTk

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyACM0"
BEGIN = re.compile(rb"FRAME_BEGIN (\d+) (\d+)\s*\n")


def sharpness(img: Image.Image) -> float:
    """Variance of a 3x3 Laplacian, the usual focus measure. Pure PIL so this
    needs nothing that is not already installed."""
    from PIL import ImageFilter
    small = img.resize((img.width // 2, img.height // 2))
    lap = small.filter(ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], 1, 128))
    px = list(lap.getdata())
    mean = sum(px) / len(px)
    return sum((p - mean) ** 2 for p in px) / len(px)


def decode(img: Image.Image) -> str:
    """Whatever decoder is to hand. zbarimg is the one this repo already uses
    on the host side; without it the view still works, minus the QR line."""
    import shutil
    import subprocess
    import tempfile
    if not shutil.which("zbarimg"):
        return "(no zbarimg)"
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        img.save(f.name)
        out = subprocess.run(["zbarimg", "-q", "--raw", f.name],
                             capture_output=True, text=True).stdout.strip()
    return out[:38] if out else "-"


def main() -> int:
    try:
        port = serial.Serial()
        port.port = PORT
        port.baudrate = 115200
        port.timeout = 0.05
        port.dtr = False          # raising these resets the S3 over its USB
        port.rts = False
        port.open()
    except serial.SerialException as e:
        print(f"cannot open {PORT}: {e}", file=sys.stderr)
        return 1

    root = tk.Tk()
    root.title(f"LeekWallet camera — {PORT}")
    label = tk.Label(root)
    label.pack()
    status = tk.Label(root, text="waiting for a frame… (open Scan on the device)",
                      font=("monospace", 12))
    status.pack(fill="x")
    root.bind("<Key-q>", lambda _e: root.destroy())
    root.bind("<Escape>", lambda _e: root.destroy())

    state = {"buf": b"", "frames": 0}

    def tick() -> None:
        state["buf"] += port.read(65536)
        buf = state["buf"]
        while True:
            m = BEGIN.search(buf)
            if m is None:
                break
            end = buf.find(b"FRAME_END", m.end())
            if end < 0:
                break
            w, h = int(m.group(1)), int(m.group(2))
            body = bytes(c for c in buf[m.end():end] if not chr(c).isspace())
            buf = buf[end + 9:]
            try:
                raw = base64.b64decode(body + b"=" * (-len(body) % 4))[:w * h]
            except Exception:
                continue
            if len(raw) != w * h:
                continue
            img = Image.frombytes("L", (w, h), raw)
            state["frames"] += 1
            shown = img.resize((w * 2, h * 2), Image.NEAREST)
            photo = ImageTk.PhotoImage(shown)
            label.configure(image=photo)
            label.image = photo
            status.configure(
                text=f"frame {state['frames']}  {w}x{h}   "
                     f"sharp {sharpness(img):7.0f}   QR {decode(img)}")
        # Never let an unterminated frame grow without bound.
        state["buf"] = buf[-2_000_000:]
        root.after(30, tick)

    root.after(30, tick)
    root.mainloop()
    port.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
