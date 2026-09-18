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
the ATECC608B (shares the OLED's I2C) = 9. **It fits, with margin.**

**Verified against the vendor pinout diagram and continuity tested on the
board, 2026-09-17. Full transcription in
[BOARD-S3CAM-PINOUT.md](BOARD-S3CAM-PINOUT.md):**

| Function | GPIO | Source |
|---|---|---|
| microSD CMD / CLK / DATA | **38 / 39 / 40** | diagram, confirmed by meter |
| PSRAM | 35, 36, 37 | diagram, octal as expected for R8 |
| onboard WS2812 | 48 | diagram |
| onboard LED | 2 | diagram, "LED ON" |
| UART0 TXD / RXD + TX/RX LEDs | 43 / 44 | diagram |
| USB D-/D+ | 19 / 20 | diagram (it prints them swapped; the datasheet has 19 = D-) |
| 3V3 and 5V rails | header | continuity tested, both good |

The SD exposes **one data line**, so **1-bit SDMMC is the only mode** on this
board. That is fine for a vault file and it costs three pins instead of six.

The camera map on the diagram matches the `esp32-camera` `BOARD_ESP32S3_WROOM`
map exactly, including the Y-numbering: Y2=D0=11, Y3=D1=9, Y4=D2=8, Y5=D3=10,
Y6=D4=12, Y7=D5=18, Y8=D6=17, Y9=D7=16.

**Final pin map** (revised: GPIO48 is the onboard WS2812, so SCL moves to 21):

```
OLED + ATECC608B I2C   SDA 47   SCL 21
buttons K1..K4          1, 2, 14, 42
microSD 1-bit           CMD 38   CLK 39   DATA 40
status LED              48 (onboard WS2812, free)
serial logs             43 / 44 (UART0, kept)
spare                   41
```

GPIO2 also drives the onboard LED, which is harmless for a button input with an
internal pull-up. GPIO42 is JTAG MTMS, unused while debugging goes over native
USB. Nothing here touches a strapping pin (0, 3, 45, 46).

**Still unverified:** which of the two USB-C ports is native USB and which goes
through a bridge. The diagram labelling UART0 with TX/RX LEDs on 43/44 implies
a bridge on one of them. This does not block anything: plug into one, and if
the board enumerates as a USB Serial/JTAG device it is the native port.

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

1. ~~microSD~~ **done**: CMD 38, CLK 39, DATA 40, 1-bit only.
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
5. ~~3V3 rail~~ **done**: 3V3 and 5V both continuous to the header.
   the ATECC608B and OLED get power from a pin that is actually the rail.
6. **Camera FPC, power ON, meter in DC volts.** Do **not** assume every FPC pin
   is 3.3 V. The sensor uses several domains and the adapter may regulate.
   Measure before connecting anything of your own to those nets.

Record the results in this document before step 4 of section 6.

---

# Part 3: what Tomb actually does, and the radio rule

## 14. Anatomy of a Tomb

Tomb is a zsh script. It invents no cryptography; it orchestrates `cryptsetup`,
GnuPG and the kernel loop device. The structure is worth knowing exactly,
because **the structure is the part that ports**.

```
tomb dig     secret.tomb filled with /dev/urandom
             (so used and free space are indistinguishable)

tomb forge   random key material
             encrypted with GnuPG symmetric:
               AES-256, SHA-512 s2k, iterated+salted, max iteration count
             -> secret.tomb.key, an ASCII-armoured file

tomb lock    losetup secret.tomb
             cryptsetup luksFormat, using the *decrypted key file contents*
             as the LUKS passphrase  (aes-xts-plain64, 512-bit key by default)
             mkfs.ext4 inside

tomb open    prompt passphrase -> gpg decrypts the key file
             -> cryptsetup luksOpen -> mount
tomb slam    kill holders, unmount, close, forget
```

So there are **two chained layers**, and this is the whole idea:

```
passphrase ──GPG s2k (salted, heavily iterated)──► key file contents
                                                        │
                                          LUKS keyslot (PBKDF2)
                                                        ▼
                                              LUKS master key
                                                        │
                                            AES-XTS over the volume
```

The passphrase never touches the volume's master key. It unlocks a *stored
secret*, and that secret unlocks the master key. That indirection is exactly
why changing the passphrase is cheap and why the key file can be kept
separately from the tomb, on a different USB stick.

That is the same shape as section 8, and it is what we are reimplementing:
Argon2id in place of GPG's s2k, AES-256-GCM in place of AES-XTS, our own header
in place of LUKS's. Nothing is copied; the architecture is convergent because
it is the right architecture.

Two further habits worth stealing:

- **`dig` fills the file with random first.** Our vault file should be a fixed
  size, pre-filled with random, so its contents reveal nothing about how much
  is stored. It still looks like high-entropy data, which section 11 already
  admits.
- **`slam` exists.** Closing is a first-class operation that assumes something
  went wrong. Our equivalent is zeroising the key on card eject, on timeout and
  on exit, and it should be written before the opening path is.

One thing **not** to steal: Tomb can hide the key file inside a JPEG with
steghide. It is the same operational-not-cryptographic trade as our cloak, and
steghide is old and weakly analysed. If a decoy is ever wanted, it should be
designed deliberately rather than inherited.

Two honest caveats on this section: defaults such as the exact cipher string
have varied across Tomb versions, and Tomb has optional extra PBKDF2 stretching
on the key file. Neither changes the shape above, which is what we use.

## 15. The radio rule

The ESP32-S3 has Wi-Fi 802.11 b/g/n and Bluetooth LE 5 sharing one antenna.

**An airgapped wallet with a working radio is not airgapped.** So:

- The radios are **present in the firmware but disabled at boot**, and turning
  one on is a deliberate act: a 5-second hold, or five confirmations, with the
  device stating plainly on its own screen that the air gap is being given up.
  It stays on for that session only and is off again after a power cycle.
- QR is the only transport that works without that act, so the default
  configuration is airgapped and the exception is visible and chosen.
- The honest cost of this choice, which the docs must carry: dormant code is
  still code. Firmware that has already been compromised can enable a radio
  without asking, so this defends against an untrusted companion and an
  ordinary mistake, not against malicious firmware. Secure Boot is what
  defends against malicious firmware, and it is a separate, optional decision.

Same reasoning for the relevant SoC facts: the S3's AES and SHA accelerators do
help the vault, and its ECC accelerator covers P-256 rather than **secp256k1**,
so Ethereum signing stays in software either way — as it already is.

---

# Part 4: the device keeps the decoder

## 16. Raw calldata crosses the gap, nothing else

`eth-sign-request` carries the **unsigned transaction itself**: chain id, to,
value, gas, nonce and the full `data` field, as bytes. It does not carry a
description of the transaction. That is what makes QR a transport change rather
than a security change:

```
companion                                         device
──────────                                        ──────
build unsigned tx                                 
simulate it, preview it, label it  ── none of ──►  (not sent)
                                      this          
RLP bytes + derivation path        ──── QR ─────►  eth-sign-request
                                                        │
                                                   eth-decode.c
                                                   23 signatures, two gates
                                                        │
                                                   draw it on OUR screen
                                                        │
                                                   buttons: approve / reject
                                                        │
signature  ◄──────────── QR ─────────────────────  eth-signature
```

The existing decoder does not change at all. `eth-decode.c`, the 23 signatures,
the two-gate decode and the 60 shared vectors carry over untouched, because
they operate on calldata and calldata is exactly what arrives.

**The rules that make this hold, and they are the whole point:**

1. **Nothing the companion says about the transaction is displayed.** No label,
   no token name, no fiat value, no simulation result, no ERC-7730 text is read
   off the wire and shown. If it is on the device screen, the device derived it
   from the bytes.
2. **What cannot be decoded is refused.** Unchanged from today. A transport that
   is easier to use must not become a reason to relax this.
3. **The chain id comes from the signed payload**, never from a side channel,
   so the screen cannot say Base while the signature is valid on mainnet.
4. **The derivation path is verified, not trusted.** `eth-sign-request` carries
   a path and an address. The device derives the address from the path itself
   and refuses if they disagree, rather than displaying the address it was
   handed.
5. **The signature covers exactly what was displayed.** Decode, display and sign
   all read one buffer, and it is not re-parsed between approval and signing.

Companion-side simulation and preview stay, and they are genuinely useful — but
they are a convenience for the person at the computer, not an input to the
device. The device screen is authoritative, and the README already says the
user is responsible for reading it.

This is also the honest answer to "is QR less safe than USB". It is not, and it
is slightly better: the payload is self-contained, there is no session, no
pairing, no driver and no bidirectional channel for a companion to probe.

## 17. Handshake, WalletConnect and plain sends

### There is no handshake, and that is the point

USB and BLE need a session: pairing, a shared secret, a connection to keep
alive. QR needs none of it. The device exports its account once, as a
`crypto-hdkey` shown in animated QR, and the companion stores it. That is the
entire setup, it is one-directional, and nothing about it is secret — an
extended public key is public by construction.

The trade is **privacy, not safety**: an xpub lets the companion derive every
address in the account. A single-address export is the tighter option and
breaks address discovery. Offer both, default to whichever the account model
needs, and say which in the UI.

### WalletConnect: the companion is the wallet, the device is the signer

The device is not part of WalletConnect and never touches the network.

```
dapp ──WC relay (internet)──► companion ──QR──► device
                              (WC client)       (signer)
     ◄──────────────────────  companion ◄─QR──  signature
```

WalletConnect pairs the **dapp with the companion**. When a request arrives the
companion extracts the raw payload, shows it as animated QR, the device decodes
and displays it from the bytes, signs, and the companion returns the signature
over the relay. From WalletConnect's point of view the companion is the wallet.
From the device's point of view a WalletConnect request is an
`eth-sign-request` like any other, and it is decoded and refused on the same
terms. Nothing about the air gap changes.

### Plain sends, and what EIP-4527 does not do

A transfer from one wallet to another is an `eth-sign-request` with empty
calldata. The device shows chain, destination and amount, which it reads from
the payload.

EIP-4527 deliberately does **not** cover:

| Job | Who does it |
|---|---|
| Broadcasting the signed transaction | companion |
| Reading nonce, gas price and balance | companion |
| Resolving ENS | companion |
| Token metadata and prices | companion |

All of it needs a network, so all of it belongs to the companion. Consequences
the docs must state:

- **The device cannot sanity-check the nonce or gas**, because it cannot see a
  chain. A wrong nonce produces a failed transaction, not lost funds.
- **ENS cannot be verified on device.** A name resolved by the companion is a
  claim, and rule 1 of section 16 forbids displaying it. So the device shows
  the raw hex address and the user compares it. That is a real usability cost
  of being airgapped, and it is paid honestly rather than papered over with a
  name the device cannot check.

## 18. The nonce, and what to do about it

**EIP-4527 does not solve the nonce. It cannot.** The nonce is a field in the
transaction the companion built, and the device has no chain to check it
against. 4527 only guarantees the device *sees* it, because it is in the RLP
that gets signed.

Three levels of answer, and the middle one is worth building.

**0. It is already solved, at the companion.** The companion reads
`eth_getTransactionCount(address, "pending")` from its RPC provider when it
builds the transaction, exactly as any wallet does. Nothing is stored and
nothing is outstanding. Everything below is optional hardening on top of a
working answer.

**1. Display it. This is what ships.** The nonce is in the RLP, so the device
decodes it and puts it on screen for free. No state, no storage.

**2. Keep a nonce ledger on the device — ROADMAP, not now.** Store the highest nonce signed per
`(chain id, address)` in the vault, and compare before signing:

| Observed | Meaning | Device does |
|---|---|---|
| expected + 1 | normal | sign |
| already signed | **reuse** | refuse, or warn hard and require a second confirmation |
| a gap ahead | companion skipped, or another wallet is spending | warn, allow |

This is **not** scheduled. It defends against a malicious companion, which is
not the threat model for a wallet used at home and at meetups on testnets,
and it is the only part of this design that would need new vault state. Level 1
costs nothing and is what ships. This paragraph exists so the reason is on
record if real funds ever change the calculation.

The attack it would defend against, for that record: A malicious companion can ask for two different transactions at the
**same nonce**: the user approves the harmless one, and the attacker broadcasts
the other. Only one can confirm, and the attacker chooses which. A device that
remembers refuses the second request without needing a chain. It is a few
bytes per account in the vault and it is the only nonce defence an airgapped
device can actually offer.

Replacement transactions — speed-ups and cancels — are legitimately the same
nonce, so this is a confirmation rather than a hard block, and the screen has to
say *why* it is asking.

**2b. A signed-transaction history, which is the useful version of the same
data.** Rather than a counter the user never sees, keep the last N signed
transactions in the vault: chain, account, nonce, destination, token, amount
and gas. The user gets something they actually want — "what did I sign, and
what did it cost" — and reuse detection falls out of it for free if it is ever
wanted, because the nonces are right there.

Two honest limits. It records what was **signed**, not what **confirmed**: an
airgapped device cannot know whether a transaction landed, was replaced or was
dropped, so the screen has to say "signed" and never "sent". And it is not a
balance. For balances and confirmations the answer is an explorer or a
portfolio viewer such as DeBank, using the public address — which needs no
device, leaks nothing the chain does not already show, and is what the guides
should teach.

The history lives inside the encrypted vault on the card, so it is protected by
the same key as the seed and disappears with the card.

**3. Accept the residue.** A wrong nonce that is merely wrong, rather than
malicious, produces a transaction that fails or sits pending. **It does not lose
funds.** The same is true of balances: the device cannot check a balance either,
and signing a transfer larger than the balance produces a failed transaction,
not a loss. These are usability failures, and it is honest to call them that
rather than to imply the device is checking something it is not.

## 19. "Stagnant" does not mean abandoned

EIP-4527 is marked **Stagnant** on eips.ethereum.org, which measures activity in
the EIP *process*, not use in the world. The distinction matters here because
the market went the other way:

- **Keystone** implements it and publishes the SDKs.
- **AirGap and imToken** interoperate over it, and imToken documents the pairing
  as "the EIP-4527 standard".
- **TokenPocket** documents an EIP-4527 flow.
- **MetaMask, Sparrow, Solflare and Keplr** consume BC-UR account types.

There is **no successor EIP**. The nearest thing is NGRAVE's
[NBCR-2023-002](https://github.com/ngraveio/Research/blob/main/papers/nbcr-2023-002-multi-layer-sync.md),
which explicitly says it "is based on existing sync protocols, e.g. EIP-4527"
and extends BC-UR to be chain-agnostic with `coin-identity` and `portfolio`
types. It **complements rather than replaces**, and its Layer 3 additions are
so far mostly NGRAVE's own.

So the decision stands, with one adjustment to how we hold it:

> **BC-UR is the durable layer; EIP-4527 is the Ethereum profile on top.**

Build the codec against BC-UR, keep the 4527 UR types behind a small mapping,
and a future chain-agnostic profile is an addition rather than a rewrite. This
also matches how the ecosystem is actually layered, and it means the Stagnant
label costs us nothing: what we interoperate with is the set of wallets above,
not the EIP's editorial state.

## 20. The handshake exports chosen accounts, not the master key

Revises section 17. The xpub export is the wrong default.

Use **`crypto-multi-accounts`**: the device exports the specific accounts the
user picked, each as a public key with its derivation path. NGRAVE calls this
Layer 2 and it is what Keystone already sends.

What this buys:

| | xpub export | chosen accounts |
|---|---|---|
| Companion can derive addresses you did not approve | **yes** | no |
| Companion learns about future accounts | **yes** | no |
| Adding an account later | automatic | one more QR handshake |
| Account discovery after restore | automatic | manual |

The cost is real but small and one-time, and it is the right trade for a wallet
whose whole argument is minimising what any one party holds.

**And it is what makes the nonce work.** The companion *is* the wallet in every
sense that needs a network: it queries `eth_getTransactionCount(account,
"pending")` for exactly the accounts the handshake pinned, exactly as MetaMask
does. The nonce problem is solved in the ordinary way, at the companion, and
the handshake is what defines the account set it is solved for.

That leaves the device's nonce ledger (section 18) as **defence in depth
against a malicious companion**, not as the primary mechanism — and it is keyed
on `(chain id, account)`, which is the same set the handshake pinned. The two
halves line up because both are scoped by the accounts the user chose.

## 21. No pairing at all: ask for the address when you need it

Supersedes the default in section 20. There is no pairing step, no stored
extended key, and nothing the companion has to keep.

```
companion needs to act for an account
        │
        ├─► "show me the address"      ── user picks it on the DEVICE
        │
        │   device shows one QR: address + its derivation path
        │
        ├─► companion reads it, queries its RPC provider:
        │        eth_getTransactionCount(address, "pending")
        │        eth_getBalance, gas, token data
        │
        ├─► builds the unsigned tx, shows it as animated QR
        │
        └─► device decodes, verifies, displays, signs
```

The companion holds a **plain address** for as long as it is working, which is
the least it can possibly hold and still be a wallet. No xpub, no account list,
no derived future addresses, no secret, nothing to leak later, nothing to keep
in sync, and no state that can go stale against a device that has been
restored, re-ordered or re-passphrased.

The nonce follows for free: it comes from the RPC provider like any wallet's
does, per address, at the moment it is needed. **Nothing is stored to make the
nonce work.**

**Why the path travels with the address.** The QR carries both, and the
companion echoes the path back inside `eth-sign-request`. The device then
re-derives the address from that path and refuses if it does not match the
`from` it was given — rule 4 of section 16, unchanged. Carrying the path is what
keeps the device from having to search its accounts to find which key signs,
and it leaks nothing: a path beside an address the user just chose to reveal
tells an observer nothing new.

`crypto-multi-accounts` from section 20 stays available for users who want a
companion that watches several accounts at once without rescanning. It becomes
a convenience, not the default, and it is the user's explicit choice to hand
over more.

This is the same principle as the vault on a removable card and the device that
holds nothing without it: **keep the parts separate, and make the state
somebody else holds as small as it can be.**

## 22. The signed-transaction history

Promoted from "nice to have" to a feature. The SafePal S1 is the precedent:
airgapped, QR-only, and it still shows you what the device signed.

### One log, filtered — not a menu per chain

The chain id is a field in the entry, not a directory. Filters over one flat
log, newest first:

```
History                        filter: [ all chains ▾ ] [ all accounts ▾ ]
────────────────────────────────────────────────────────────────────────
#124  Base      swap        0.30 USDC        0x9aeae4…   fee 0.00002 ETH
#123  Base      approve     USDC → 0x1111…   0xc78e2d…   fee 0.00001 ETH
#122  Arc       transfer    12.00 USDC       0x4f21a8…   fee 0.00000 ETH
```

A per-chain menu would need a new screen every time a chain is added and would
hide the thing people actually scan for, which is "the last thing I did".

### What each entry holds

Chain id, account, nonce, destination, the decoded action, token and amount
where the decoder produced them, the gas fields, and — the part worth the
whole feature — **the transaction hash**.

The device signs, so it can keccak the signed RLP itself. That hash is
device-derived, needs no network, and is exactly what you paste into an
explorer or DeBank to find out what actually happened. It is the bridge between
a device that can never know a balance and the tools that do.

### No timestamps, because there is no clock to trust

An airgapped device has no reliable time. Its RTC drifts and resets, and time
offered by the companion is companion-supplied data, which rule 1 of section 16
keeps off the screen. So entries carry a **monotonic sequence number**, not a
date, and the UI says "#124" rather than inventing a time it cannot stand
behind. The explorer supplies the timestamp, from the hash.

### Storage

A fixed-size ring buffer inside the encrypted vault: fixed-width entries, no
allocator, no fragmentation, oldest overwritten. Pre-filled with random like
the vault itself, so the file does not reveal how many transactions exist. At
roughly 96 bytes an entry, 256 entries is about 24 KB, which is nothing on a
card.

Boards without a card (the reference S3 and the Pixie) can keep a shorter log
in NVS behind `LEEK_HAS_SDCARD`, or none at all. The feature is capability
gated like everything else.

### Defaults

History is **on by default**, and is a settings toggle for anyone who wants it
off. That is the opposite of the radios, which ship off and take a deliberate
act to enable, and the difference is the point: a radio changes who can reach
the device, while a log changes only what the owner can see about their own
device. Turning history off does not delete what is already stored; clearing it
is its own action, so neither can happen by accident.

### What it does not claim

- It records what was **signed**. Not what confirmed, was replaced or was
  dropped, because the device cannot know. The screen says "signed".
- **It is a log of this device, not of the seed.** The same seed used in
  another wallet leaves no trace here. That is a property of the design rather
  than a defect, and the guides should say so plainly instead of letting people
  read the list as a complete history of their funds.
- It is not a balance. The hash plus an explorer is the answer to that.

### Opening an entry shows a QR of the explorer link

Select an entry and the device draws a QR of the explorer URL. Phone camera,
browser opens, and the airgap is never crossed — the device emitted light, and
nothing came back.

```
#124  Base · swap                      ┌───────────────┐
0x9aeae445…                            │ ▄▄▄▄▄ ██ ▄▄▄▄ │
0.30 USDC                              │ █   █ ▀▄ █   █ │   basescan.org/tx/0x9a…
fee 0.00002 ETH                        │ █▄▄▄█ █▄ █▄▄▄█ │
                                       └───────────────┘
```

The URL is built **on the device**, from a chain id to explorer table compiled
into the firmware — the same data the companion's `chains.ts` holds, moved
where it can be trusted. It is not a URL the companion sent, because a URL from
the companion is a link the device cannot verify and rule 1 keeps it off the
screen. A short URL is a QR version 4 or 5, which the 128x64 panel shows in one
static frame, no animation.

Worth telling users once, in the guides: **opening that link tells the explorer
your IP and that you care about that address.** It is their choice, the device
is not making it for them, and they can equally type the hash in by hand.

### How much history, and when it overwrites

Entry layout, fixed width so there is no allocator and no fragmentation:

| Field | Bytes |
|---|---|
| sequence, chain id, nonce | 20 |
| account address, destination, token address | 60 |
| value, token amount | 64 |
| gas limit, fee cap | 16 |
| **transaction hash** | 32 |
| action code, decimals, symbol, flags | 16 |
| reserved | to 256 |

**256 bytes an entry.** So:

| Board | Entries | Space | At 3 signatures a day |
|---|---|---|---|
| SD vault | **4096** | 1 MB | ~3.7 years |
| NVS only (reference S3, Pixie) | 64 | 16 KB | ~3 weeks |

On a card, 1 MB is nothing, so the honest answer to "when does it delete" is
**effectively never, for how this wallet gets used.** Set at vault creation and
recorded in the header, so a user who wants 16384 entries can have them.

When it does wrap, the oldest entry is overwritten silently. No prompt: a wallet
that interrupts you to ask about a log entry has its priorities wrong. A
`Clear history` action exists for people who want it gone sooner.

Two engineering constraints that follow, and they matter more than the size:

- **Entries are sealed individually, not as part of the vault blob.** Each is
  its own AES-256-GCM record under a key derived from the master key and the
  entry slot. Otherwise every signature rewrites the whole vault, which is
  write amplification on a card and a window where a power loss costs the seed.
- **There is no head pointer.** The head is found by scanning for the highest
  sequence number at startup. A separate pointer is one more thing that can tear
  on a power cut and disagree with the data it points at.

## 23. Choosing a cloak, and what each one can carry

The cloak app is a setting. Whichever is chosen is what the device boots into,
every time, so the device is consistent to anyone who picks it up rather than
being a wallet wearing a costume it takes off.

Each app defines two things: a **digit alphabet** and a **submit gesture**. The
PIN is entered through those, and a wrong value does the ordinary thing the app
would have done anyway. There is never a "wrong PIN" message, because there is
nothing on screen that looks like a PIN.

| App | Entry | Digits | Combinations | Submit is |
|---|---|---|---|---|
| **Calculator** | type a number | any length, 0-9 | **unbounded** | pressing `=` |
| **Clock** | set HH:MM:SS | 6, constrained | 86,400 | confirming seconds |
| **Timer** | countdown MM:SS | 4, constrained | 3,600 | starting the timer |
| **Dice** | N dice, M sides, S rolls | 3 | ~1,000 | rolling |
| **Snake** | difficulty, lives, speed | 3, each 1-9 | 729 | starting the game |
| **Metronome** | BPM, 40-240 | 3 | 201 | starting the beat |

**The calculator is the strongest and should be the default.** It is the only
one with no ceiling: a fourteen-digit PIN looks exactly like arithmetic, and a
wrong entry simply computes a number. The clock is the friendliest. Snake and
the metronome are the most fun and the weakest, and the UI must say so when one
is picked rather than letting someone discover it later.

Say the entropy out loud, because it is the part that is easy to get wrong:
**729 combinations is not a PIN, it is a speed bump.** What protects the vault
is Argon2id making each guess cost about a second and a BIP-39 passphrase
sitting outside the device entirely. The cloak buys deniability, not strength,
and a user who picks Snake and no passphrase should be told plainly that they
have chosen a fun lock.

Apps that are real either way and need no cloak duty: a QR tool, a flashlight,
and a dice roller that is genuinely used for seed generation.

## 24. What the README has to say, once this ships

Not written yet - the README is being edited elsewhere as the hackathon
material comes out. Recording the argument here so it goes in intact.

**Why there is no secure element, stated without overclaiming.** Not "secure
elements are pointless": they are not, and on resistance to invasive physical
key extraction a certified one wins. The argument is that a secure element
protects a secret inside a chip and does nothing about the database that knows
who bought the chip. Ledger's 2020 breach exposed roughly 272,000 records with
names, postal addresses and phone numbers while no device or seed was
compromised, and tampered replacement devices were then mailed to people on
that list. Trezor's 2024 support incident exposed names and email addresses and
an attacker contacted 40 users asking for their recovery seeds. A generic
ESP32-S3 bought with cash at an electronics shop carries no such association.

**And what replaces it here.** Separation, not silicon: the vault lives on a
removable microSD card, so **a device without its card holds no seed, no xpub,
no address list and nothing to extract**. Argon2id makes a copied card
expensive to attack and a BIP-39 passphrase makes it useless. The ATECC608B is
not cancelled by this argument and stays on the roadmap for the one thing
neither approach gives: a monotonic attempt counter that reflashing cannot
reset.

**The honest costs, in the same breath.** Buying anywhere means knowing less
about the board, so provenance assurance gets worse, not better. Open source
does not make the binary on the device honest, which is what reproducible
builds and signed releases are for. And invasive physical attack is explicitly
out of scope.
