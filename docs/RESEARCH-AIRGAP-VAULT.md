# Research: camera airgap, SD vault, and the low profile device

Branch `research/airgap-vault-cloak`. Nothing here is implemented. This is the
concept, the blockers found before writing code, and the order of the work.

Target board: **ESP32-S3-WROOM-1-N16R8 CAM with OV5640**, 16 MB flash, 8 MB
octal PSRAM, microSD.

## 1. The thesis, stated so it can be defended

The claim is not "commodity hardware beats a secure element". On resistance to
invasive physical key extraction a certified secure element wins, and this
repository has always said so ([VAULT.md](VAULT.md), fourth row of the table).

The defensible claim is narrower and stronger:

> A secure element protects a secret inside a chip. It does not protect the
> identity of the person who bought the chip. LeekWallet optimises a different
> set of axes: cost, privacy of acquisition, compartmentalisation, auditability
> and air gap.

Evidence, not rhetoric:

- Ledger's 2020 breach exposed roughly 272,000 records with names, postal
  addresses and phone numbers. No device or seed was compromised; the customer
  database was ([Bitdefender](https://www.bitdefender.com/en-us/blog/hotforsecurity/hacker-publishes-stolen-email-and-mailing-addresses-of-270000-ledger-cryptocurrency-wallet-users)).
- Tampered "replacement" devices were then mailed to people on that list
  ([Bitcoin Magazine](https://bitcoinmagazine.com/technical/ledger-hack-victim-scam-details)).
- Trezor's 2024 support-system incident exposed names and email addresses, and
  an attacker contacted 40 users directly asking for recovery seeds.

The dangerous datum is not any single field. It is the association
*this person, at this address, owns a hardware wallet*. A generic ESP32-S3
purchase does not carry that association. The marketplace still has a shipping
record; what it does not have is the crypto signal. The correct word is
**semantic unlinkability**, not "untraceable".

What this does **not** buy, and the docs must keep saying so:

- Provenance assurance gets *worse*, not better. Buying anywhere means knowing
  less about the board, the flash and the passive parts. The privacy gain and
  the supply-chain loss come from the same property.
- Open source does not make the binary on the device honest. That is what the
  reproducible build, the signed SHA256SUMS and self-flashing are for.
- The ESP32-S3's eFuse and HMAC blocks are real primitives, but the family has
  a documented history of fault injection against eFuse protections. Invasive
  physical attack stays explicitly out of scope.

## 2. Blocker found first: the camera takes every pin the wallet uses

The OV5640 DVP occupies **GPIO 4,5,6,7,8,9,10,11,12,13,15,16,17,18**.

LeekWallet today (`src/main.c`): OLED I2C on SDA 8 / SCL 9, buttons K1 10,
K2 5, K3 6, K4 7. **All six collide.** There is no partial port: adding the
camera means re-pinning the entire device.

What is left on an N16R8 after camera, USB, straps and memory:

| Range | Status |
|---|---|
| 4-18 | camera |
| 19, 20 | USB (native USB Serial/JTAG, do not reuse) |
| 0, 3, 45, 46 | strapping, avoid |
| 26-32 | SPI0/1 flash |
| 33-37 | **octal PSRAM on an R8 part**, unavailable |
| 1, 2, 14, 21, 38, 39, 40, 41, 42, 43, 44, 47, 48 | candidates |

Thirteen candidates for OLED (2) + buttons (4) + microSD (3 in 1-bit mode) +
the ATECC608B (shares the OLED's I2C) = 9. **It fits, with margin.** Proposed:

```
OLED + ATECC608B I2C   SDA 47   SCL 48
buttons K1..K4          1, 2, 14, 21
microSD 1-bit SDMMC    CLK/CMD/D0 on the board's existing wiring
spare                  41, 42 (43/44 are UART0 by default)
```

**Unverified and must be measured on the board before any layout:** which pins
the microSD is actually wired to, what the two USB-C ports do, whether there is
a USB-UART bridge, and the LED pins. The vendor photos do not settle these.
A continuity check with the multimeter settles them in ten minutes.

## 3. Airgap transport

Direction and mechanism:

```
companion (untrusted)  --animated QR-->  OV5640 --> quirc --> BC-UR decode
                                                              |
                                              device parses calldata itself
                                              device draws it on its own screen
                                                              |
                                            buttons: approve / reject
                                                              |
companion (untrusted)  <--animated QR--  128x64 OLED <-- BC-UR encode
```

- The 128x64 screen caps a single frame near QR version 10-14, far below a
  signed EIP-1559 transaction, so **both directions are animated**. This is
  already the conclusion of [CAMERA-OPTIONS.md](CAMERA-OPTIONS.md).
- **EIP-4527** is the right target for the *payload*: it defines UR types
  `crypto-hdkey`, `eth-sign-request` and `eth-signature` over BC-UR fountain
  codes. Keystone implements it. **SafePal S1 does not** — it uses its own
  format, so "like the S1" and "EIP-4527" are two different decisions. Pick
  4527, because it is the one companions can already talk.
- 4527 covers account export and signing requests. It does not cover the
  mini-app traffic in `app/`, which stays on USB/BLE, opt-in.
- The decisive unknown is **sustained decode rate**: OV5640 frame capture in
  grayscale QVGA, plus quirc, plus fountain assembly, on one LX7 core. If a
  fountain needs 40 frames and the loop runs at 5 fps, that is 8 seconds, which
  is fine. At 1 fps it is unusable. **This is a bench measurement, not a
  search.** It is the first thing the spike measures.
- USB and BLE remain in the firmware, off by default, enabled by the user.

## 4. The vault on SD

**Tomb is the wrong tool.** It is a shell wrapper around Linux LUKS and GnuPG.
There is no LUKS on an ESP32 and no shell. The idea underneath it is right
though: one opaque encrypted file, mounted only when a credential is supplied,
and physically separable from the machine.

What we build instead, on top of the existing [VAULT.md](VAULT.md) design:

```
vault key = HKDF(
      Argon2id(PIN + optional passphrase, salt from the SD header)
    , HMAC_efuse(salt)          <- ESP32-S3 HMAC block, key burned read-protected
)
```

Each part earns its place:

- **Argon2id** makes an offline guess *expensive*. A six-digit PIN is a million
  candidates; against a plain hash that is seconds. The 8 MB PSRAM on an R8
  part is exactly what a memory-hard KDF wants, and this is the single most
  valuable thing the R8 buys us. Parameters get tuned to roughly one second on
  device, which is tolerable once and ruinous a million times.
- **HMAC from eFuse** binds the file to one board. The S3's HMAC peripheral can
  use a key burned into eFuse that software cannot read back. A copied SD card
  is then not enough: the attacker needs *this* ESP32 too.
- The **passphrase is never stored**, as today.

Honest limit: an attacker holding both the SD and the board can flash their own
firmware and call the HMAC block as often as they like. Secure Boot plus Flash
Encryption closes that, and Argon2id is what makes it slow meanwhile. So the
three modes below are a genuine spectrum, not marketing.

| Mode | What it adds | Irreversible? |
|---|---|---|
| **OPEN** | SD vault, Argon2id, PIN and optional passphrase | no |
| **BOUND** | + eFuse HMAC binding: the SD opens on this board only | yes, one eFuse key |
| **HARDENED** | + Secure Boot V2, Flash Encryption, debug restrictions | yes |

Same source, same board, the owner chooses what to make permanent. QEMU
emulates eFuses, which is why [QEMU.md](QEMU.md) exists and why every mode gets
exercised there before any fuse is burned on hardware.

Device with no SD inserted holds no seed, no xpub, no address list and no
history. That separation — **device / storage / recovery / knowledge** — is the
real architectural claim, and it is worth more than the disguise below.

## 5. The low profile shell

With no SD card present the device is a small gadget with a camera, a screen
and four buttons: a clock, a Pomodoro timer, a dice roller, a QR tool, Snake.
Those are real apps, not a facade, and they are what the device *is* when no
vault is mounted.

Transition to wallet mode requires: the right SD card, the right entry action,
and the vault credential. All three.

State it accurately or not at all:

- This is **operational**, not cryptographic. The claim is *do not advertise
  the existence of a seed*, never *obscurity protects the seed*.
- An encrypted vault file on an SD card is **high entropy and detectable**. Any
  examiner who looks will see it. Deniability that depends on nobody looking is
  not deniability.
- A hidden wallet can make coercion **worse**, not better: an attacker who
  believes a second wallet exists has no reason to stop. Whatever we ship here
  has to be documented alongside that risk, and no user should be told it
  protects them under duress.

## 6. Order of work

1. **Measure the board.** SD pins, the two USB-C ports, LEDs, continuity. Ten
   minutes with a multimeter, and everything after depends on it.
2. **Camera spike.** `esp32-camera` at grayscale QVGA, quirc decode, print the
   sustained decode rate. One number decides whether any of this is viable.
3. **BC-UR / EIP-4527 codec**, tested natively on the host first, against
   Keystone's published vectors.
4. **Re-pin the firmware** behind a board profile, so the S3-mini build and the
   CAM build come from one tree.
5. **Vault v2 on SD**: Argon2id tuning, header format, OPEN mode only.
6. **BOUND and HARDENED under QEMU**, with emulated fuses, before hardware.
7. **Cloak shell**, last, once there is something worth hiding.

## 7. Where the ATECC608B fits after all this

It is not cancelled by the argument in section 1. eFuse HMAC binding gives
device binding but **cannot count attempts** — a reflashed board resets nothing
because nothing was ever counted. The secure element's monotonic counter is the
one primitive neither the ESP32 nor Argon2id provides, and that is exactly what
[RESEARCH-SECURE-ELEMENT.md](RESEARCH-SECURE-ELEMENT.md) and the grant milestone
promise. The two are complementary; the chip is the attempt limiter, not the
signer.

---

# Part 2: architecture decisions

## 8. Tomb: borrow the shape, not the code

**Do not copy Tomb source.** Tomb is **GPL-3.0** and this repository is
Apache-2.0. Importing its logic into our firmware would force the whole
firmware to GPL-3.0. That is a licensing decision, not a technical one, and it
is not ours to make casually.

It is also not worth it. Tomb is roughly: create a file, `losetup` it,
`cryptsetup luksFormat`, `mount`, and manage keyfiles with GnuPG. Strip the
Linux and almost nothing remains.

What *is* worth borrowing is one idea, and it comes from LUKS rather than Tomb:
**key slots**. The payload is encrypted under a random master key, and the
master key is stored several times, each copy wrapped by a different
credential.

```
LEEKVAULT header (plaintext)
  magic "LEEKVLT1", version, flags
  slot[0..3], each:
      argon2id salt (16 B), m_cost, t_cost, p
      wrapped master key: AES-256-GCM(32 B key + 16 B tag)
      slot flags (empty / in use / bound to eFuse)
  payload nonce (12 B)

encrypted payload: AES-256-GCM
  seed entropy, creation time, derivation metadata
```

Why slots earn their place: changing the PIN rewraps a 32-byte key instead of
re-encrypting the vault, and a second slot can require the eFuse HMAC while the
first does not, so one card can work in OPEN or BOUND mode without reformatting.

Everything needed is already in the build: **mbedTLS** ships with ESP-IDF and
gives AES-256-GCM with hardware acceleration, and Argon2id is a single small C
file (the reference implementation is CC0/Apache-2.0 dual licensed, which is
compatible). No new large dependency, and the whole format is a few hundred
lines of C we own and can audit.

## 9. Is eFuse burning required? No.

Moving the vault to the SD card **removes the reason eFuse binding existed.**

[VAULT.md](VAULT.md) burns an eFuse key because the seed lives in the device's
flash, so `esptool read_flash` on a stolen device must return ciphertext. Once
the seed lives only on a removable card, **a device without its card contains
no seed at all.** There is nothing in flash to protect.

So the three modes re-sort:

| Threat | Defence | Needs eFuse? |
|---|---|---|
| Device stolen, card elsewhere | Nothing to steal | **no** |
| Card stolen or copied | Argon2id + optional passphrase | **no** |
| Card copied *and* device stolen | eFuse HMAC binding | yes |
| Attacker flashes own firmware to brute-force | Secure Boot + Flash Encryption | yes |

**Recommendation: ship OPEN as the default and do not burn anything.** BOUND
stays available for people who want it, and it is the one thing that makes a
copied card useless without this exact board. Every mode gets exercised under
QEMU with emulated fuses first.

One honest gap either way: **a copied SD card defeats attempt counting.** The
attacker restores the old card and the count resets, whatever the count is
stored in. Only an on-device monotonic counter fixes that, which is the
ATECC608B's one irreplaceable job. Argon2id is what makes each attempt
expensive meanwhile, and it is the main defence in OPEN mode.

## 10. Argon2id parameters

A six-digit PIN is 10^6 candidates. Tune on the bench, aiming at **about one
second per attempt** on device using PSRAM:

- `m_cost` around 64 MB, `t_cost` 3, `p` 1 as a starting point, measured and
  then fixed in the header so an old card still opens on a newer build.
- At one second, 10^6 PIN candidates is roughly 11 days on the same hardware,
  and much less on a GPU — which is why the **passphrase matters** and why the
  docs must say a PIN alone is a delay, not a wall.
- The parameters live in the header, so they can be raised for new vaults
  without breaking old ones.

## 11. The cloak: PIN entry that is not PIN entry

With no card inserted the device is a gadget: clock, Pomodoro, dice, QR tool,
Snake. Those are real, working apps.

PIN entry is expressed as ordinary settings inside one of them:

```
Snake > Settings          Clock > Set time
  difficulty  1             hours    12
  lives       2             minutes  34
  speed       3             seconds  56
```

Entering `1 2 3` or `12:34:56` *is* entering the PIN. The screen shows a normal
settings page either way, and a wrong value simply starts a normal game or sets
a normal clock. There is no "wrong PIN" message, because there is nothing that
looks like a PIN.

Transition to wallet mode needs all three: the right card, the right entry
point, and the right values.

Stated accurately:

- It is operational, not cryptographic. It does not advertise a seed; it does
  not protect one.
- The vault file is high entropy and **detectable by anyone who looks**. It can
  be named innocuously, but it cannot be made to look like a save file to an
  examiner.
- The strongest part of this design is not the disguise. It is that **the
  device genuinely holds nothing** when the card is out.

## 12. Architecture and workflow

```
power on
   │
   ▼
cloak shell ── clock · pomodoro · dice · QR tool · snake      no card: this is all there is
   │
   │  card present + entry point + correct values (section 11)
   ▼
Argon2id(PIN [+ passphrase]) ─┬─ [BOUND] HMAC_efuse ─┐
                              └──────────────────────┴─► unwrap slot ─► master key
   │
   ▼
wallet mode (RAM only, zeroised on eject, timeout or exit)
   │
   ├── export account: BC-UR crypto-hdkey  ──────► animated QR out ──► companion
   │
   └── sign:
         companion ──► animated QR in ──► OV5640 ──► quirc ──► BC-UR fountain
                                                               │
                                                     eth-sign-request (EIP-4527)
                                                               │
                                            device parses calldata itself
                                            device draws it on its own screen
                                                               │
                                                 buttons: approve / reject
                                                               │
                                                     sign, then zeroise key
                                                               │
                                            eth-signature ──► animated QR out
                                                               │
                                                  companion broadcasts
```

Firmware layering, so the S3-mini build and the CAM build stay one tree:

```
board profile (pins, features)   <- the only thing that differs per board
      ├── display driver
      ├── buttons
      ├── camera + quirc            (CAM only)
      ├── sdcard + vault            (CAM only)
      └── atecc608b                 (optional, either board)
core: bip39/32/44, signing, calldata decoder, BC-UR codec, cloak shell
transports: qr (default) · usb (opt-in) · ble (opt-in)
```

The calldata decoder, the signing core and the BC-UR codec are all host
testable, and the BC-UR codec gets tested against Keystone's published vectors
before it ever runs on hardware.

## 13. What to measure on the board

Power off, USB unplugged, meter in continuity (beep) mode, one probe on a GND
header pin to confirm the meter works first.

1. **microSD.** Probe each candidate header pin (1, 2, 14, 21, 38, 39, 40, 41,
   42, 47, 48) against the SD socket's CLK, CMD and DAT0 contacts. Boards in
   this class often use 39/38/40, but that must be confirmed rather than
   assumed. Also confirm the socket is actually populated and routed on this
   PCB revision.
2. **The two USB-C ports.** For each, check the D+ and D- pins for continuity
   to GPIO19 and GPIO20. If one port does not reach them, it goes through a
   bridge instead: read the small chip's marking with the loupe (CH340, CP2102,
   CH343).
3. **LEDs.** Continuity from each LED pad to a header pin tells you the GPIO,
   and diode mode across the LED tells you its polarity.
4. **OLED pull-ups.** Resistance on the 20 kΩ range from the screen's VCC pin to
   its SDA pin, and to SCL. Around 4.7 or 10 means pull-ups are fitted.
5. **3V3 rail.** Continuity from the header's 3V3 pin to the module's 3V3, so
   the ATECC608B and OLED get power from a pin that is actually the rail.
6. **Camera FPC, power ON, meter in DC volts.** Do **not** assume every FPC pin
   is 3.3 V. The sensor uses several domains and the adapter may regulate.
   Measure before connecting anything of your own to those nets.

Record the results in this document before step 4 of section 6.
