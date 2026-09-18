#!/usr/bin/env python3
"""Time-to-signature model for the QR air gap.

Combines the four things that actually set the number:

  1. how fast the companion's screen shows new frames   (market: 5-10 fps)
  2. how fast the device captures frames                (OV5640 + LCD_CAM + GDMA)
  3. how long quirc takes per frame                     (measured by ./bench)
  4. how many frames a fountain needs to converge       (BC-UR overhead)

Every number is an argument, so it can be re-run against measurements
instead of assumptions. Defaults marked ASSUMED are not yet measured here.
"""
import argparse

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--payload", type=int, default=250,
                   help="bytes of the thing being sent (a signed EIP-1559 tx is ~200-300)")
    p.add_argument("--ur-expansion", type=float, default=2.0,
                   help="ASSUMED: UR/bytewords text expansion over raw bytes")
    p.add_argument("--bytes-per-part", type=int, default=90)
    p.add_argument("--fountain-overhead", type=float, default=1.75,
                   help="ASSUMED: frames seen per part needed, for a lossy channel")
    p.add_argument("--display-fps", type=float, default=8.0,
                   help="ASSUMED: companion animation rate; market wallets use 5-10")
    p.add_argument("--capture-fps", type=float, default=25.0,
                   help="ASSUMED: OV5640 QVGA grayscale into PSRAM via GDMA")
    p.add_argument("--decode-ms", type=float, required=True,
                   help="measured: ms per frame from ./bench, on the target")
    p.add_argument("--miss-rate", type=float, default=0.30,
                   help="ASSUMED: fraction of captured frames that decode to nothing")
    a = p.parse_args()

    ur_chars = a.payload * a.ur_expansion
    parts = max(1, -(-int(ur_chars) // a.bytes_per_part))
    frames_needed = parts * a.fountain_overhead

    decode_fps = 1000.0 / a.decode_ms
    # the loop runs no faster than the slowest of the three stages
    pipeline_fps = min(a.display_fps, a.capture_fps, decode_fps)
    useful_fps = pipeline_fps * (1.0 - a.miss_rate)
    seconds = frames_needed / useful_fps if useful_fps > 0 else float("inf")

    bound = min((a.display_fps, "companion display"),
                (a.capture_fps, "camera capture"),
                (decode_fps, "quirc decode"))[1]

    print(f"payload           {a.payload} B -> ~{int(ur_chars)} UR chars")
    print(f"parts             {parts} at {a.bytes_per_part} chars/part")
    print(f"frames needed     {frames_needed:.0f} (fountain overhead {a.fountain_overhead}x)")
    print(f"display           {a.display_fps:.1f} fps")
    print(f"capture           {a.capture_fps:.1f} fps")
    print(f"decode            {decode_fps:.1f} fps ({a.decode_ms:.2f} ms/frame)")
    print(f"pipeline          {pipeline_fps:.1f} fps, bound by {bound}")
    print(f"useful            {useful_fps:.1f} fps after {a.miss_rate:.0%} misses")
    print(f"TIME TO TRANSFER  {seconds:.1f} s")
    verdict = ("comfortable" if seconds < 5 else
               "usable" if seconds < 15 else
               "painful" if seconds < 40 else "unusable")
    print(f"verdict           {verdict}")

main()
