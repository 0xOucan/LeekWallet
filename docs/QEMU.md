# Running LeekWallet under QEMU

Espressif maintains a QEMU fork with an `esp32s3` machine. It runs the same
binary you would flash, against an emulated flash image, which makes it the
right place to develop everything that is irreversible or hardware-destructive
on a real board.

## Why this matters more than it sounds

QEMU emulates **eFuses**. Flash encryption and secure boot are enforced by
one-time-programmable fuses: burn them wrong on hardware and the board is
scrap, and burn them wrong in the *scheme* and every board you ever ship is
scrap. Being able to iterate on that against emulated fuses is the difference
between a day's work and a drawer of bricks.

That is the whole reason [T11](../ROADMAP.md) is scheduled here first.

## Installed here

```
~/.local/opt/qemu/bin/qemu-system-xtensa   (esp_develop_9.2.2)
```

Add it to PATH, or `./scripts/qemu.sh` will tell you how.

## Install

Upstream QEMU has no `esp32s3` machine — you need Espressif's fork:

```bash
python -m espressif.idf_tools install qemu-xtensa
```

or a release build from https://github.com/espressif/qemu/releases, on PATH as
`qemu-system-xtensa`.

## Run

```bash
./scripts/qemu.sh          # build, merge a flash image, boot it
```

`Ctrl-A X` quits. Extra arguments are passed through to QEMU, so
`./scripts/qemu.sh -s -S` waits for a GDB attach on :1234.

## Proving the S1 fix

```bash
./scripts/qemu-read-flash.sh
```

Scans the flash image for plaintext BIP39 words. This is the
[S1](../AUDIT.md) finding as an executable check rather than an assertion.

Read the output carefully: **the firmware embeds the BIP39 wordlist itself**, so
matches in `.rodata` are expected and are not a finding. What matters is whether
any land inside the NVS partition at `0x9000`. Once flash encryption is on, the
whole image should be opaque and the script comes up empty.

## What QEMU covers, and what it does not

| Works | Does not work |
|---|---|
| Boot path, panics, partition table | I²C — no SSD1306/SSD1315 device model |
| NVS read/write, wear levelling | GPIO buttons |
| eFuses, flash encryption, secure boot | Real RNG entropy (see [S6](../AUDIT.md)) |
| Crypto correctness and timing *ratios* | Absolute timing, power draw, brownout |

Concretely on the timing point: the KDF benchmark reports **31 ms** under QEMU
and **504 ms** on the board, so the emulator runs this workload about sixteen
times faster. Useful for spotting a change that costs ten times more than
expected, useless for choosing an iteration count.

The display and buttons stay a [host-harness](../sim/README.md) concern, and
absolute timing needs the board — so the KDF iteration count ([T9c](../ROADMAP.md))
must be measured on hardware, not here. QEMU gives you a ratio, not a number.

## What running it already caught

Two bugs surfaced the first time the firmware booted under emulation, neither
of which the host suite could see:

- **The flash image and the partition table disagreed.** `qemu.sh` still built a
  4 MB image after the move to 16 MB, and the bootloader refused the partition
  table outright. The same drift existed in `sdkconfig.defaults`, which
  PlatformIO had been warning about into a scrollback nobody was reading.
- **A missing display aborted boot.** `app_main` returned early when the OLED
  did not answer, so a loose I2C wire produced a device that looked dead rather
  than one with a blank screen. The firmware now continues headless and says
  so, which is both more honest on hardware and what makes emulation useful at
  all.

## Known limitations

- **PSRAM is broken** ([espressif/qemu#129](https://github.com/espressif/qemu/issues/129)).
  Keep `CONFIG_SPIRAM=n` for the emulated target even if the physical board is
  an N16R8.
- The ESP32-S3 target reuses the ESP32-C3 timer group implementation, so
  timer-sensitive behaviour may differ from hardware.
