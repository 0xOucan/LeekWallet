# QR air gap decode-rate spike

Answers one question: **is animated-QR signing fast enough to be usable?**

## What QEMU can and cannot do here

Espressif's QEMU fork emulates the ESP32-S3 CPU, memory and eFuses. It does
**not** emulate LCD_CAM, GDMA into a camera framebuffer, or an OV5640. There is
no image sensor to emulate.

It is also a TCG emulator, not a cycle-accurate simulator, so **wall-clock times
measured inside QEMU mean nothing for performance**. Running this bench under
QEMU proves the code builds and runs on Xtensa and that the memory fits. It
cannot produce a frame rate. Anyone who reports a QEMU millisecond figure as a
decode rate is reporting an artefact.

So the spike splits the question:

| Part of the pipeline | How it is answered here |
|---|---|
| quirc decode cost | **measured**, by `bench.c`, on host now and on hardware later |
| memory footprint | **measured**, quirc needs ~3 bytes per pixel |
| camera capture rate | **not emulated**; must be measured on the board |
| whether it all adds up | **modelled**, by `budget.py`, from the above |

`bench.c` is written so the identical code runs on the host, under QEMU and on
the real board. That is the point: when the board arrives, the same binary
produces the number that replaces the assumption.

## Running it

```sh
make run          # fetches quirc (ISC), builds, generates frames, benches
python3 budget.py --decode-ms <number from bench>
```

## Results so far

Host (x86-64, `-O2`), 12 frames of a QR version 5 payload at 320x240 grayscale,
20 repetitions, clean synthetic renders:

```
decoded       240  (100.0%)
mean          1.67 ms/frame
worst         6.25 ms/frame
```

Two caveats on that number. The frames are clean renders, so they are a
**floor**: a real camera adds blur, glare, perspective and noise, and all of it
lands in `identify.c`. And quirc located 320 codes across 240 frames, meaning
it sometimes proposes a second candidate that fails to decode — harmless, but
it is work the device pays for.

## What the model says

Using the worst-case host frame, and then deliberately pessimistic substitutes:

| Scenario | decode | bound by | time to transfer |
|---|---|---|---|
| host worst frame | 6.25 ms | companion display | **1.9 s** |
| S3 assumed **40x slower** | 250 ms | quirc decode | **3.8 s** |
| 600 B payload, 5 fps companion, 60 ms decode | 60 ms | companion display | **7.0 s** |

The interesting result is the middle row. **Even if the ESP32-S3 turns out to
be forty times slower than this host at quirc, a transaction still crosses the
gap in under four seconds.** For a 250-byte payload the pipeline is bound by
how fast the companion animates its QR codes, not by the device.

That is a provisional go. It is provisional because `--capture-fps 25`,
`--miss-rate 0.30` and `--fountain-overhead 1.75` are assumptions, all marked
ASSUMED in `budget.py`, and because real camera frames are harder than these.
The decode side has a very large margin, which is the part that was in doubt.

## Memory

quirc holds roughly three bytes per pixel. At QVGA that is about **230 KB**,
which does not fit in the 512 KB SRAM alongside a camera framebuffer and the
wallet, so **quirc's working image belongs in PSRAM**. At 640x480 it would be
about 920 KB, still fine in 8 MB PSRAM. This is the second thing the R8 buys,
after Argon2id.

## On hardware

The board cannot run `bench.c` as it stands - `bench.c` reads frames from a
file, and the board has a sensor instead. `src/qr-bench.c` is the same
measurement against the real source: it calls `camera_next_qr()`, the exact
function the Scan screen calls, as fast as it will go, and prints sustained
frames/second and decodes/second once a second over the serial log.

```sh
pio run -e esp32s3cam-bench -t upload
pio device monitor -e esp32s3cam-bench
```

Point the sensor at a phone or laptop animating a `ur:eth-sign-request`. Expect
lines like:

```
I (2145) qr-bench: starting; point the sensor at an animated ur:eth-sign-request
I (2146) qr-bench: internal free 236144, psram free 8386216
I (2450) camera: camera up: 320x240 grayscale
I (2451) qr-bench: after camera_start: internal free 232016, psram free 8078568
I (3455) qr-bench: 11.8 frames/s  7.9 decodes/s  (12 frames, 8 decodes, stack headroom 9216 B)
```

`frames/s` is capture plus decode together, which is what bounds the transfer.
`decodes/s` is how many of those frames yielded a symbol - the miss rate
`budget.py` has been guessing at. The numbers in the sample line above are
illustrative formatting, not measurements; nothing in this repository has run
on the sensor yet.

That build is an instrument and not firmware: `app_main()` hands it the board
and returns, so there is no wallet, no UI and no BLE in it. Flash the ordinary
`esp32s3cam` image afterwards.

## Next, on hardware

1. Run `esp32s3cam-bench` on the board to replace the 40x guess with a fact.
2. Measure real capture fps at QVGA grayscale into PSRAM.
3. Re-run `bench` against **photographed** frames rather than rendered ones,
   which is the honest decode rate.
4. Feed all three into `budget.py`, and delete the assumptions as they fall.
