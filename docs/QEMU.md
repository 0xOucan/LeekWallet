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

The display and buttons stay a [host-harness](../sim/README.md) concern, and
absolute timing needs the board — so the KDF iteration count ([T9c](../ROADMAP.md))
must be measured on hardware, not here. QEMU gives you a ratio, not a number.

## Known limitations

- **PSRAM is broken** ([espressif/qemu#129](https://github.com/espressif/qemu/issues/129)).
  Keep `CONFIG_SPIRAM=n` for the emulated target even if the physical board is
  an N16R8.
- The ESP32-S3 target reuses the ESP32-C3 timer group implementation, so
  timer-sensitive behaviour may differ from hardware.
