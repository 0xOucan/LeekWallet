# Burning flash encryption and secure boot v2 on a real ESP32-S3

**Status: rehearsed in QEMU, never executed on hardware.** ([T11c](../ROADMAP.md), [VAULT.md](VAULT.md))

This document is written to be followed by someone who was not present when it
was written. Read all of it before running any of it.

---

## Read this before you touch anything

eFuses are one-time programmable. There is no undo, no reflash, no factory
reset, no JTAG recovery, no Espressif support ticket that gets the board back.
A wrong burn produces a board that is **electronic waste**, and a wrong *scheme*
produces a whole batch of them.

Three specific ways this goes wrong, in decreasing order of how likely they are:

1. **A signed bootloader that outgrows its offset.** Signing pads the bootloader
   and appends a signature sector. If the result reaches the partition-table
   offset, the table is overwritten by the bootloader's own tail. The board
   boot-loops with no output. On a board that has already burned secure boot,
   you cannot fix it, because you cannot flash a corrected bootloader.
2. **Losing the signing key.** The device only ever accepts firmware signed by
   this key. Lose it and the board can never be updated again — not by you, not
   by anyone. Leak it and secure boot protects nothing.
3. **Burning release mode before development mode has been proven on that exact
   board.** Release mode removes the UART downloader's ability to re-encrypt,
   which is the only remaining route back in.

**Use a sacrificial board for the first full run.** Not the one with your funds
on it. Not your only spare.

---

## What this actually buys you

**Not impenetrability.** The honest claim is that a flash dump stops yielding
anything useful — `esptool read_flash` returns ciphertext, and firmware that is
not signed by the right key will not boot. That is a large step up from a chip
anyone can read in a minute.

It is not a secure element. There is no certified tamper resistance here, and
the ESP32 family has a public history of voltage-glitching and fault-injection
work against exactly these protections. An attacker with the device, equipment
and motivation is a different threat from one with a chip reader, and this does
not answer them. Say "a flash dump yields nothing useful", never "impenetrable".


From [VAULT.md](VAULT.md), stated honestly:

| Attacker | After this procedure | Which half stops them |
|---|---|---|
| Finds the device, runs `esptool read_flash` | Ciphertext only | flash encryption |
| Desolders the flash chip and reads it directly | Ciphertext only — the key never leaves the SoC | flash encryption |
| Has the device for five minutes and flashes their own firmware | Refuses to boot | **secure boot** |
| Returns a device carrying backdoored firmware that captures the PIN | Refuses to boot | **secure boot** |
| Brute-forces the PIN through the firmware | Unchanged; this is now the only software route | neither |
| Funded lab: decapping, fault injection, side-channel | **Probably still wins** | neither |

### The two halves answer different attacks

They are usually spoken of together and they are not the same protection.

**Flash encryption stops the device being read.** Without it, anyone holding the
board recovers the vault with `esptool read_flash` and attacks the PIN offline,
where the three-attempt wipe does not apply.

**Secure boot stops the device being rewritten**, and that is the attack the
first half does nothing about. Without it, someone with brief physical access
flashes firmware that looks and behaves exactly like this one but keeps the PIN,
or sends the seed out over BLE the next time it is unlocked, and hands the
device back. Nothing is read at the time, so encryption is irrelevant — the
owner unlocks it later and does the extraction for them. It is the classic evil
maid, and a wallet is the ideal target for it, because the owner is guaranteed
to come back and type the secret in.

That is also why the firmware flasher ([ROADMAP](../ROADMAP.md) T65) is gated on
this and not merely scheduled after it. A companion app that writes firmware to
a device on request, on hardware with no secure boot, is a one-click backdoor
installer wearing a friendly name.

**A caveat worth stating plainly:** secure boot binds the device to whoever holds
the signing key. If that is you, it protects you. If it is somebody else, it
protects *them* — including from you. That is the whole argument for users
burning their own key rather than shipping devices trusting a project key, and
it is recorded under the key-custody discussion in the roadmap.

ESP32-S3 is a general-purpose MCU, not a certified secure element, and the
ESP32 family has a documented history of glitching attacks against eFuse
protections. The claim this procedure supports is *"your seed survives losing
the device"*. It is not *"your seed survives a laboratory"*.

---

## What has been proven, and where

| Claim | Evidence |
|---|---|
| The config builds correctly signed artefacts | `pio run -e esp32s3-secure` |
| Secure boot v2 key digests burn, and the ROM verifies | QEMU, `secure boot verification succeeded` |
| First-boot encrypt-in-place completes | QEMU, `flash_encrypt: Flash encryption completed` |
| The encrypted image contains no plaintext | QEMU, `scripts/qemu-read-flash.sh` |
| The app boots to the PIN screen with both features on | QEMU |
| **The burn works on silicon** | **Nothing. This is the gap.** |

See [QEMU.md](QEMU.md) for what emulation does and does not cover. The short
version: eFuses, XTS-AES and secure boot v2 *are* emulated on the S3 and the
whole sequence runs; timing, glitch resistance, eFuse write errors and the
physical download-mode paths are not.

---

## How many boards this needs

Four, and the reason is that eFuses do not come back. Each of these is a
one-way state, so no single board can hold two of them.

| Board | Role | Why it cannot be shared |
|---|---|---|
| 1 | **Unburned control** | Once fuses burn there is no way back. One device has to keep booting plain firmware, for comparison and for ordinary development |
| 2 | **Development-mode burn** | Secure boot, flash encryption and NVS encryption, still re-flashable with signed images. This is the board that gets `esptool read_flash` run against it to *prove* the vault is ciphertext |
| 3 | **Release-mode burn** | One shot, permanent, and it disables the UART download that board 2 depends on. Verifies the configuration that would actually ship |
| 4 | **Migration** | A device provisioned with a wallet *before* encryption, then encrypted — the path a real user upgrading would take. One-way like the rest, and distinct from board 2, which is provisioned fresh afterwards |
| 5 | **Spare** | A wrong partition table or a wrong key costs a board outright, and finding that out with no spare stops the work |

Four would do if nothing goes wrong. The fifth exists because the two steps most
likely to go wrong are the two that cannot be undone.

QEMU covers the boot path and is why this is four rather than a drawer full:
`scripts/qemu-secure.sh` already proves secure boot and flash encryption end to
end without burning anything.

**Settle the partition table first.** `CONFIG_NVS_ENCRYPTION` is currently `n`,
and ESP-IDF turns it on by default when flash encryption is enabled — the vault
lives in NVS, so as configured a burn would protect the app and leave the
wallet readable. Turning it on needs an `nvs_keys` partition or an HMAC eFuse
key, and **the partition table is one of the things the burn freezes**. Getting
it wrong is exactly the mistake board 4 exists for.

## Before you start

- [ ] A **sacrificial** ESP32-S3 board, 16 MB flash, on a USB port you can
      power-cycle.
- [ ] Nothing valuable on it. This wipes the board.
- [ ] The signing key generated (Step 1) and backed up **before** Step 5.
- [ ] `scripts/preflight-secure.sh` passing.
- [ ] Two hours and no interruptions. The irreversible steps are the ones you
      must not rush.
- [ ] The board's serial port. Every command below writes `$PORT`; set it once
      and check it points at the sacrificial board and not at your working one:

```bash
export PORT=/dev/ttyACM0
esptool.py -p "$PORT" chip_id     # confirm which board answers
```

---

## Step 1 — Generate the signing key  *(reversible)*

```bash
espsecure.py generate-signing-key --version 2 --scheme rsa3072 secure_boot_signing_key.pem
chmod 600 secure_boot_signing_key.pem
```

**What it does.** Creates the RSA-3072 private key that signs every image this
device will ever accept. Secure boot v2 on ESP32-S3 requires RSA-3072
specifically; nothing else is accepted.

**Where this key must live.** Not in this repository — `.gitignore` already
excludes `*.pem`, and `preflight-secure.sh` fails hard if the key is tracked by
git. For a real deployment it belongs on removable offline media (two copies,
separate locations) and comes out only to sign a release. Treat it exactly like
a seed phrase, because in terms of what it controls, it is one.

**Failure looks like.** Nothing yet. This step touches no hardware.

**Reversible?** Yes, entirely — until Step 5 burns the digest of this key's
public half. After that, this file is the only key the board will ever trust.

---

## Step 2 — Build the secure target  *(reversible)*

```bash
pio run -e esp32s3-secure
```

**What it does.** Builds with `sdkconfig.secure`: flash encryption in
development mode, AES-256-XTS, secure boot v2, partition table at `0xF000`. It
also produces `bootloader-signed.bin`, `partitions-signed.bin` and
`firmware-signed.bin` — the `-signed` ones are what you flash. Flashing the
unsigned ones gives a silent boot loop.

**Failure looks like.** A build error, or worse, a build that succeeds without
the security options. The latter has happened four times in this repository.
Step 3 exists for exactly that reason.

---

## Step 3 — Pre-flight  *(reversible; run it before every later step)*

```bash
./scripts/preflight-secure.sh esp32s3-secure
```

**What it does.** Verifies against *generated* artefacts, never hand-written
ones:

- every setting in `sdkconfig.secure` survived into `sdkconfig.esp32s3-secure`;
- the security options are actually set;
- which flash-encryption mode is about to be burned;
- the signed bootloader fits below the partition-table offset;
- the first partition clears the *signed* (8 KB, not 4 KB) partition table;
- a real, RSA-3072, non-placeholder, `chmod 600`, untracked signing key exists;
- the signed artefacts exist and verify against that key.

**If it refuses, stop.** Every check in it corresponds to a fault that has
actually occurred here and that produced no build error.

---

## Step 4 — Flash the board, plaintext, secure boot NOT yet enabled  *(reversible)*

At this point the board still has blank eFuses. Flashing plaintext is fine: the
first boot in Step 5 is what turns everything on.

```bash
esptool.py -p "$PORT" --chip esp32s3 --before default_reset --after no_reset \
    write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB \
    0x0     .pio/build/esp32s3-secure/bootloader-signed.bin \
    0xF000  .pio/build/esp32s3-secure/partitions-signed.bin \
    0x20000 .pio/build/esp32s3-secure/firmware-signed.bin
```

Note the offsets. They are **not** the ones in `partitions.csv` — the signed
bootloader pushes everything out. Copy them from here, not from memory.

**Do not power-cycle yet.** `--after no_reset` is deliberate: attach the monitor
first, because the next reset is the irreversible one and you want to watch it.

**Failure looks like.** `A fatal error occurred: Failed to connect` — wrong
port, or the board is not in download mode. Nothing has been burned; retry
freely.

**Reversible?** Yes. Nothing has been fused. You can reflash the ordinary
`esp32s3` build and walk away.

---

## Step 5 — THE LAST REVERSIBLE MOMENT

> **Stop here.**
>
> The next reset makes the bootloader burn the secure boot key digest and the
> flash encryption key. From then on:
>
> - the board only ever runs firmware signed by `secure_boot_signing_key.pem`;
> - the flash contents are encrypted under a key that never leaves the chip;
> - **JTAG is permanently disabled**;
> - if you lose that `.pem`, the board can never be updated again.
>
> Everything before this point can be undone by reflashing. Nothing after it
> can be undone by anything.
>
> Confirm, out loud, three things:
> 1. This is the **sacrificial** board, not your working one.
> 2. `secure_boot_signing_key.pem` is **backed up to offline media**, and you
>    have verified the backup is readable.
> 3. `preflight-secure.sh` passed on the exact build now on the board.

---

## Step 6 — First boot: burn development-mode encryption + secure boot  *(IRREVERSIBLE)*

```bash
pio device monitor -p "$PORT" -b 115200
# then power-cycle the board
```

**What it does.** The bootloader, on this one boot, performs the whole sequence.
This is the log to expect, taken verbatim from the QEMU rehearsal:

```
I secure_boot_v2: Secure boot V2 is not enabled yet and eFuse digest keys are not set
I secure_boot_v2: Verifying with RSA-PSS...
I secure_boot_v2: Signature verified successfully!
I secure_boot_v2: Secure boot digests absent, generating..
I secure_boot_v2: Burning public key hash to eFuse
I efuse: Writing EFUSE_BLK_KEY0 with purpose 9
I secure_boot_v2: Application key(0) matches with bootloader key(0).
I secure_boot_v2: Revoking empty key digest slot (1)...
I secure_boot_v2: Revoking empty key digest slot (2)...
I secure_boot_v2: blowing secure boot efuse...
W secure_boot: UART ROM Download mode kept enabled - SECURITY COMPROMISED
I secure_boot: Disable hardware & software JTAG...
I secure_boot_v2: Secure boot permanently enabled
I boot: Checking flash encryption...
I flash_encrypt: Generating new flash encryption key...
I efuse: Writing EFUSE_BLK_KEY1 with purpose 2
I efuse: Writing EFUSE_BLK_KEY2 with purpose 3
W flash_encrypt: Not disabling UART bootloader encryption
I flash_encrypt: Disable UART bootloader cache...
I flash_encrypt: Disable JTAG...
I flash_encrypt: bootloader encrypted successfully
I flash_encrypt: partition table encrypted and loaded successfully
I flash_encrypt: Encrypting partition 2 at offset 0x20000 (length 0x121000)...
I flash_encrypt: Done encrypting
I flash_encrypt: Flash encryption completed
I boot: Resetting with flash encryption enabled...
```

It then resets and boots normally, ending with:

```
I flash_encrypt: flash encryption is enabled (1 plaintext flashes left)
W flash_encrypt: Flash encryption mode is DEVELOPMENT (not secure)
```

The two warnings are expected in development mode and are the whole point of
staging it: `UART ROM Download mode kept enabled` and `Not disabling UART
bootloader encryption` are what leave you a route back in. They also mean **this
configuration must never ship** — anyone with the USB port can still write
encrypted data through the ROM downloader.

**AES-256 note.** `CONFIG_SECURE_FLASH_ENCRYPTION_AES256=y` consumes *two* key
blocks (`KEY1` purpose 2, `KEY2` purpose 3) rather than one. Together with
`KEY0` for the secure boot digest, three of the six blocks are gone. If you
later want an HMAC/DS peripheral key or NVS encryption, budget for it now:
those blocks are also one-way.

**Do not interrupt this boot.** Power loss during `Encrypting partition 2` is
the worst moment in the whole procedure — the eFuses are burned but the flash
is half-encrypted. IDF's flash-encryption state machine is designed to resume,
but this is untested here. Use a stable supply.

**Failure looks like.**
- *Boot loop, no output at all* — the bootloader overran the partition table
  (Step 3 checks this) or the unsigned bootloader was flashed. On a
  secure-boot-enabled board this is **unrecoverable**.
- *`E esp_image: Checksum failed` then `No bootable app partitions`* — this is
  [espressif/qemu#159](https://github.com/espressif/qemu/issues/159) if you see
  it in emulation. On hardware it means the flashed image and the offsets
  disagree.
- *`secure_boot_v2: Signature verified failed`* — you flashed images signed by a
  different key than the one whose digest is burned. Unrecoverable.

---

## Step 7 — Verify, on the board, that the flash is actually opaque  *(reversible)*

This is the [S1](../AUDIT.md) acceptance test, and it is the only reason any of
the above was worth doing. Provision a wallet through the UI first — a device
with no seed on it proves nothing.

```bash
esptool.py -p "$PORT" read_flash 0x12000 0x6000 nvs-dump.bin   # the vault
strings -n 4 nvs-dump.bin | grep -owE 'abandon|ability|zoo|zone|wrong' && echo FAIL || echo PASS
```

`read_flash` returns raw flash, i.e. ciphertext — the transparent decryption
happens only on the CPU's read path, not on the SPI download path. Plaintext
BIP39 words here means flash encryption is not in force and you must stop.

Also confirm the fuse state matches expectations:

```bash
espefuse.py -p "$PORT" summary
```

Expect `SPI_BOOT_CRYPT_CNT` non-zero, `SECURE_BOOT_EN` set, `KEY_PURPOSE_0 = 9`
(SECURE_BOOT_DIGEST0), `KEY_PURPOSE_1 = 2` and `KEY_PURPOSE_2 = 3` (XTS_AES_256
halves), and `RD_DIS` covering the key blocks — the key blocks themselves must
read back as zeros. **If a key block reads back with actual key material, read
protection did not take and the device is not secure.**

---

## Step 8 — Reflash while still in development mode  *(reversible, and the point of dev mode)*

```bash
esptool.py -p "$PORT" --chip esp32s3 write_flash --encrypt \
    0x20000 .pio/build/esp32s3-secure/firmware-signed.bin
```

`--encrypt` makes the ROM downloader encrypt on the way in. This is what
development mode preserves and release mode destroys. Iterate here until the
firmware is genuinely finished.

**Budget.** `flash encryption is enabled (N plaintext flashes left)` counts down
`SPI_BOOT_CRYPT_CNT`; on ESP32-S3 you get a small number of plaintext reflashes
before the counter is exhausted. `--encrypt` writes do not consume it.

---

## Step 9 — Release mode  *(IRREVERSIBLE, and the end of the road)*

**Do not do this until Step 8 has been repeated on this board and the firmware
is final.** Release mode permanently disables the UART downloader's encryption
capability. There is no way back in afterwards, at all.

Change `sdkconfig.secure`:

```
# CONFIG_SECURE_FLASH_ENCRYPTION_MODE_DEVELOPMENT is not set
CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE=y
```

and remove `CONFIG_SECURE_INSECURE_ALLOW_DL_MODE`, then:

```bash
pio run -e esp32s3-secure
./scripts/preflight-secure.sh esp32s3-secure     # will WARN about release mode - read it
esptool.py -p "$PORT" --chip esp32s3 write_flash --encrypt \
    0x0     .pio/build/esp32s3-secure/bootloader-signed.bin \
    0xF000  .pio/build/esp32s3-secure/partitions-signed.bin \
    0x20000 .pio/build/esp32s3-secure/firmware-signed.bin
# power-cycle; the bootloader burns DIS_DOWNLOAD_MANUAL_ENCRYPT
```

After this the board accepts only signed firmware, decrypts only under its own
fused key, has no JTAG, and cannot be written to over UART in any useful way.
That is the intended end state, and it is also the end of your ability to fix
anything on it.

---

## If it bricks

There is no recovery for a board past Step 6 with a bad bootloader. Desolder the
flash chip and reflash it externally and you still have a chip whose eFuses
demand a correctly signed, correctly encrypted image; you can rewrite the flash
but you cannot produce content the fused key will accept unless you hold both
the signing key and the (unreadable) encryption key.

Which is the point. It is also why the first board is sacrificial.

---

## What still cannot be known until a board is burned

QEMU proved the sequence and the configuration. It cannot prove:

- **Real eFuse programming.** QEMU accepts every write; it models no coding
  scheme and no error correction
  ([espressif/qemu#143](https://github.com/espressif/qemu/issues/143)). A
  hardware burn that half-takes is invisible in emulation.
- **Read protection actually hiding the key on silicon.** Emulated `RD_DIS`
  zeroes the block on read. Whether the physical fuse holds under a glitch is a
  different question entirely, and the honest answer is in the threat table
  above.
- **Timing.** Encrypting the app took ~7 s in QEMU; the real duration, and
  whether the board survives it on your supply, is a hardware fact.
- **Brownout during encrypt-in-place.** The most dangerous window in the
  procedure and the one emulation is least able to model.
- **Whether download mode is genuinely closed in release mode.** QEMU's ROM
  download paths are not faithfully emulated.
- **The RTC watchdog**, which QEMU does not emulate at all, and which is
  precisely what would fire during a long bootloader operation.
