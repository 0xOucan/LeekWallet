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
any land inside the NVS partition — `0x10000` on the plain target, `0x12000` on
the secure one. Once flash encryption is on, the whole image should be opaque
and the script comes up empty, which it now does.

## What QEMU covers, and what it does not

| Works | Does not work |
|---|---|
| Boot path, panics, partition table | I²C — no SSD1306/SSD1315 device model |
| NVS read/write, wear levelling | GPIO buttons |
| eFuses, flash encryption, secure boot v2 | Real RNG entropy (see [S6](../AUDIT.md)) |
| Crypto correctness and timing *ratios* | Absolute timing, power draw, brownout |
| Console — **on UART0 only** | USB-Serial-JTAG: no S3 device model, so the console is silent (see below) |

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

---

## Secure target: the whole sequence runs (T11a, T11b)

`./scripts/qemu-secure.sh --fresh` builds and boots the flash-encryption plus
secure-boot target against emulated eFuses, and it goes all the way to the PIN
setup screen.

**Both halves of T11 are emulated, and both work.** Verified end to end:

| | Evidence in the QEMU log |
|---|---|
| ROM-stage secure boot | `Valid secure boot key blocks: 0` / `secure boot verification succeeded` |
| Key digest burn | `Writing EFUSE_BLK_KEY0 with purpose 9`, `Secure boot permanently enabled` |
| RSA-PSS verification | `secure_boot_v2: Signature verified successfully!` |
| AES-256-XTS key burn | `Writing EFUSE_BLK_KEY1 with purpose 2` / `KEY2 with purpose 3` |
| Encrypt-in-place | `Encrypting partition 2 at offset 0x20000` → `Flash encryption completed` |
| Boot under encryption | second reset boots the app; `flash encryption is enabled` |
| **T11a acceptance** | `scripts/qemu-read-flash.sh` on the encrypted image: **PASS**, image entropy ~7.95 bits/byte throughout |
| **T11b acceptance** | one flipped ciphertext bit → `Checksum failed` → `No bootable app partitions`, forever |

## The previous "stall" was a missing UART, not a missing feature

The earlier note in this file said the secure target hung after secure boot
verification and guessed that the S3 flash-encryption path was not emulated.
**That was wrong, and the correction is the most useful thing this session
produced.**

QEMU's `esp32s3` machine has **no USB-Serial-JTAG device model**. `-device help`
lists `misc.esp32c3.usb_serial_jtag` and no S3 equivalent. The firmware sets
`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`, which is correct for the real board, so
every byte printed after the ROM stage went to a peripheral that does not exist.
The ROM banner appeared (the ROM uses UART0) and then silence — indistinguishable
from a hang, and it silenced the *plain* target too.

Routing the console to UART0 for emulation only makes it visible. That is
`sdkconfig.qemu-console`, applied by the `esp32s3-qemu` and `esp32s3-secure-qemu`
environments, which the two scripts now build. Nothing that goes to hardware
includes it.

The lesson generalises: **under emulation, "no output" is a claim about the
console, not about the CPU.** Check the device model before diagnosing a hang.

## Is S3 flash encryption emulated? Yes — verified

Sources, and which are primary:

- **The binary itself.** `hw/misc/esp32s3_xts_aes.c` is compiled into the
  installed `qemu-system-xtensa` (`esp32s3_xts_aes_decrypt`,
  `esp32s3_xts_aes_is_flash_enc_enabled`, `esp32s3_xts_aes_read_ciphertext`, and
  cache integration via `[CACHE] XTS_AES controller must be set!`). eFuse key
  blocks and read protection are modelled in `hw/nvram/esp_efuse.c`
  (`esp_hide_protected_block`). This is the strongest evidence and it is local.
- **[ESP-IDF QEMU guide (esp32s3)](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/tools/qemu.html)** —
  "QEMU supports emulation of eFuses... to test security-related features, such
  as secure boot and flash encryption, without having to perform irreversible
  operations on real hardware", and "QEMU supports emulation of secure boot v2
  scheme".
- **[esp-toolchain-docs `qemu/esp32s3/README.md`](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/esp32s3/README.md)** —
  "supports SHA, AES (including flash encyption), RSA, HMAC, and Digital
  Signature" [sic]. The same file also says *"'Secure Boot' feature is not
  supported yet for ESP32-S3 target"*, which the run above contradicts
  directly; treat that line as stale documentation.

Version matters. [espressif/qemu#132](https://github.com/espressif/qemu/issues/132)
records S3 flash encryption broken in the build ESP-IDF bundles, with the
maintainer advising a manual download of a newer release; the reporter confirmed
9.2.2 works. This machine runs `esp_develop_9.2.2_20260417`.

[espressif/qemu#159](https://github.com/espressif/qemu/issues/159) reports the S3
secure-boot-plus-flash-encryption first boot failing with `Checksum failed` on
that same build. **It did not reproduce here** — but note that `Checksum failed`
is also exactly what a *correctly working* device prints when the ciphertext has
been tampered with, which is the T11b test above. If you ever see it, establish
which of the two you are looking at before believing either.

## What emulation still cannot tell you

Verified above; the rest is in
[BURN-PROCEDURE.md](BURN-PROCEDURE.md#what-still-cannot-be-known-until-a-board-is-burned).
The short list: real eFuse programming (QEMU accepts every write and models no
coding scheme — [#143](https://github.com/espressif/qemu/issues/143)), read
protection holding under a glitch, absolute timing, brownout during
encrypt-in-place, download-mode behaviour in release mode, and the RTC watchdog,
which is not emulated at all.

Timing in particular: encrypting the app took ~7 s of emulated time here. That
number means nothing for hardware — the KDF benchmark runs ~16x fast under QEMU.

## Five configuration faults this exercise caught

Every one built successfully and none produced a warning.

1. **`extends` does not merge `sdkconfig_defaults`.** The secure environment
   inherited `board_build.cmake_extra_args` from the base, which pins the
   defaults file, and that silently won. The build succeeded with *none* of the
   security options set. A "successful" secure build that is not secure is the
   worst possible outcome.
2. **`board_build.partitions` is inherited the same way** and needed its own
   override.
3. **A signed bootloader is 0xB000**, past the default 0x8000 table offset. On
   hardware this is a boot loop with no output.
4. **The signed binaries must be merged, not the plain ones.** Merging
   `bootloader.bin` gives the same silent loop.
5. **A signed partition table is 0x2000, not 0x1000.** With the table at 0xF000
   it spans to 0x11000, and `nvs` was at 0x10000 — the table's own signature
   sector was being written over the first 4 KB of the vault. It boots anyway on
   a blank device, which is what makes it dangerous: it would have started
   corrupting wallet data on a provisioned board. `nvs` now starts at 0x12000.
   Found by `scripts/preflight-secure.sh`, not by any build error.

And one that is not a config fault but behaves like one:

6. **PlatformIO does not regenerate `sdkconfig.<env>` when the defaults change.**
   Verified directly: after editing `sdkconfig.secure` and rebuilding, the
   generated file still held the old console setting. `rm sdkconfig.<env>` before
   building, and let `preflight-secure.sh` confirm it.

PlatformIO's toolchain also needs `cryptography`, `ecdsa` and `reedsolo` in
*its* virtualenv (`~/.local/share/pipx/venvs/platformio/bin/python -m pip
install ...`), not the system Python.

## Before trying this on hardware

Read [BURN-PROCEDURE.md](BURN-PROCEDURE.md) in full and run
`./scripts/preflight-secure.sh`. The first board is sacrificial.
