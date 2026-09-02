# LeekWallet

> *lek* — a container made from a dried jícara gourd

<p align="center">
  <img src="docs/leekwallet-logo.png" alt="LeekWallet" width="200"/>
</p>

## The name

A **lek** is a gourd container from the Yucatán Peninsula, used to hold
something worth keeping. The word is Yucatec Maya. It was chosen because a
container's whole purpose is to protect what is put inside it.

## What is LeekWallet?

An **open-source hardware wallet** built on the ESP32-S3. It holds private keys —
which for the person who owns them are usually irreplaceable, and whose value is
out of all proportion to the size of the thing holding them — and it makes every
use of them visible on a screen that the computer it is plugged into cannot
change.

That is the entire design goal. Everything below follows from it: the device
decides, the host asks, and anything the device cannot display in full it
refuses to sign.

### Features

| Feature | Description |
|---------|-------------|
| **HD wallet** | BIP39/BIP32/BIP44, secp256k1 signing (RFC6979) |
| **Multi-wallet** | Up to 30 independent seed phrases, each encrypted under its own nonce |
| **Seed phrases** | 12 or 24-word generation and import; BIP39 passphrase entered on-device |
| **PIN** | 4-8 digits, 3-attempt wipe, counter hardened against power-cut attacks |
| **Change PIN** | Re-encrypts every wallet atomically — a power cut leaves exactly one PIN that opens everything (`sim/test_pin_change.c`) |
| **Vault** | Per-device salted PBKDF2-HMAC-SHA512, ~1 s on hardware, AES-256-GCM, domain-separated key and verifier |
| **Entropy** | Hardware RNG behind a fails-closed SP 800-90B gate that health-checks a 512-byte sample, plus a mandatory button-timing pool that is mixed in, never substituted |
| **Physical dice** | Optional at seed creation, worth exactly **log2(6) = 2.585 bits** per roll, counted on screen. Mixed with the RNG, never substituted — physical dice only, never a phone app |
| **Temporary seed** | Type a phrase, sign with it, and the device stores **nothing**: no slot, no ciphertext, no wallet count. Gone on lock |
| **Transaction signing** | EIP-1559, re-serialised and re-hashed on-device, displayed page by page, signed only as rendered |
| **Decodable set** | Native transfer, ERC-20 `transfer`/`approve`/`transferFrom`, `setApprovalForAll`, WETH `deposit`/`withdraw`, three `mint` shapes. Anything else — including contract creation — is **refused** (`src/eth-decode.c`) |
| **Blind signing** | Off by default, set on the device only, five presses past a warning screen. No command can turn it on |
| **Link** | USB CDC-ACM **or** BLE GATT, one at a time, chosen on the device (Settings → Link) |
| **BLE name** | User-set, 1-29 printable ASCII, refused rather than truncated — an over-long name would silently stop advertising |
| **Session** | X25519 with a commit-then-reveal nonce exchange, passkey bound to the whole transcript and compared on the device's own screen; ChaCha20-Poly1305 frames |
| **QR codes** | Display addresses as scannable QR codes |
| **Companion app** | Tauri v2 on Linux/macOS/Windows and an Android APK, with WalletConnect v2 for real dapps |

### Stateless mode, and dice

Two features that answer the same question — *what does this device leave behind?*
Both are optional, and neither is required to use the wallet normally.

**Temporary seed** is the arrangement [SeedSigner](https://seedsigner.com/) is
built around, and the credit belongs there: a wallet that holds no key at rest
cannot have one taken from it. Enter a phrase from Main menu → **Temp Seed**, and
it goes into RAM and nowhere else — no vault slot is allocated, no ciphertext is
written, the wallet count does not move. Sign as normal; the device derives,
displays and signs exactly as it does for a stored wallet. Lock it, or lose power,
and the seed is gone: `wallet_lock()` zeroes it, and nothing anywhere can bring it
back, because it was never written down. A passphrase works in this mode too, and
the pairing of the two is the strongest rung on the ladder below — a flash dump
then has neither secret to attack.

The cost is the honest one: you retype the phrase every session, and nothing on
the device will remind you of it.

**Physical dice** apply when *creating* a seed. Choose 12 or 24 words first, since
that sets the target, then roll: each roll is credited **2.585 bits** — arithmetic,
not an estimate — and the screen counts down to the target. The rolls are mixed
into the hardware RNG's output, **never substituted for it**, so a mistake with the
dice cannot make the seed weaker than it would have been. Dice are optional; the
button-timing pool is not.

Use **real dice**. A dice app runs an unauditable PRNG on a networked phone, which
is the one device this whole design assumes is compromised.

**Not yet connected:** dice entropy generates seeds that are *stored*. There is no
path today that generates a temporary seed — temporary mode takes a phrase you
already have. Combining them is on the list.

### Capacity

| | Limit | Set by |
|---|---|---|
| Seed phrases stored | **30** | `MAX_WALLETS`, bounded by the 24 KB NVS partition |
| Words per phrase | 12 or 24 | BIP39 |
| Addresses per phrase | **2³¹ accounts x 2³¹ indices** | BIP44; the derivation is unbounded because addresses are computed, not stored |
| Addresses reachable on the device | **10** (`m/44'/60'/0'/0/0`…`/9`) | `ADDRESS_INDEX_COUNT` in `src/ui.c`; UP/DOWN on the address screen |
| Addresses reachable from the app | **10** per wallet | the app derives `m/44'/60'/0'/0/0..9` and lets you pick |

Each phrase is encrypted under its own IV with the vault key, so wallets are
independent: the 30 slots are 30 separate seeds, not 30 addresses.

The gap worth knowing: the device *can* derive any BIP44 path, but both the UI
and the app fix the account level at `0'` and offer the first ten indices. One
seed covering several *accounts* (`m/44'/60'/account'/0/0`) is T45, and it is a
missing selector rather than a limitation of the crypto.

### Hardware

```
┌─────────────────────────────────────┐
│         LeekWallet Hardware         │
├─────────────────────────────────────┤
│  MCU:     ESP32-S3 Mini, no PSRAM   │
│  Flash:   16MB (4MB app partition)  │
│  Display: SSD1306 OLED 128x64       │
│  Input:   4 tactile buttons         │
│  Links:   USB-C (CDC) or BLE GATT   │
└─────────────────────────────────────┘
```

**Button Mapping:**
- **K1** (GPIO10) → UP / Increment
- **K2** (GPIO5)  → DOWN / Decrement
- **K3** (GPIO6)  → CANCEL / Back
- **K4** (GPIO7)  → ACCEPT / Confirm

**I2C Connections:**
- SDA: GPIO8
- SCL: GPIO9
- OLED Address: 0x3C

---

## Bill of Materials

Total cost is roughly **$8-15 USD** depending on how much you buy in bulk and how patient you
are with shipping.

| Qty | Part | Notes | Approx. |
|-----|------|-------|---------|
| 1 | ESP32-S3 Mini dev board | Must have **native USB-C**, not a CH340/CP2102 UART bridge — the USB companion app depends on the S3's built-in USB peripheral | $4-7 |
| 1 | SSD1306 OLED 128x64, I2C, 0.96" | **I2C (4-pin), not SPI (7-pin).** Address 0x3C | $2-4 |
| 4 | Tactile push buttons, 6x6mm | Through-hole, any travel | $1 |
| 1 | Dupont jumper wires, female-female | 8 minimum | $1 |
| 1 | USB-C data cable | Charge-only cables are the #1 "device not found" cause | — |
| — | Perfboard or 400-pt breadboard | Optional, for a non-flying-wire build | $1-2 |

**Sourcing.** These are generic parts sold by hundreds of AliExpress vendors under rotating
listing IDs, so specific product links rot within months. The searches below are stable; sort by
orders and pick a vendor with a long history rather than the cheapest result.

- [ESP32-S3 Mini boards](https://www.aliexpress.com/w/wholesale-esp32-s3-mini.html) — check the silkscreen for the module variant before ordering, see the warning below
- [SSD1306 0.96" I2C OLED](https://www.aliexpress.com/w/wholesale-ssd1306-0.96-oled-i2c.html) — 4-pin modules only
- [6x6mm tactile buttons](https://www.aliexpress.com/w/wholesale-6x6mm-tactile-push-button.html)
- [Dupont jumper wires](https://www.aliexpress.com/w/wholesale-dupont-jumper-wire-female-female.html)

> **Which S3 module?** The firmware is configured for **16 MB flash, no PSRAM**
> (`platformio.ini`, `partitions.csv`, `CONFIG_SPIRAM=n`), which matches the board this was
> developed against. If yours reports a different size the boot log will say so:
> `Detected size(16384k) larger than the size in the binary image header(4096k)` means the
> config is too small and flash is being wasted. Adjust `board_build.flash_size` and
> `partitions.csv` together. Keep PSRAM disabled — it is
> [broken under QEMU](https://github.com/espressif/qemu/issues/129), which the test strategy
> relies on.

### Wiring

Header pin order on the button board is `GND, VCC, SCL, SDA, K4, K3, K2, K1`.

| Signal | GPIO |
|--------|------|
| OLED SDA | 8 |
| OLED SCL | 9 |
| OLED VCC | 3V3 |
| OLED GND | GND |
| K1 (UP) | 10 |
| K2 (DOWN) | 5 |
| K3 (CANCEL) | 6 |
| K4 (ACCEPT) | 7 |

Buttons are active-low against the ESP32's internal pull-ups, so wire each one between its GPIO
and GND — no external resistors. **GPIO4 is unusable on this board** (stuck LOW), which is why
K1 lives on GPIO10.

---

## Verifying what you downloaded

Every release publishes a `SHA256SUMS` file listing the hash of each binary, and
`SHA256SUMS.asc`, a signature over that list. Checking the hash takes one command
and catches a download that arrived corrupted, truncated, or altered by whatever
sat between you and GitHub.

Open a terminal in the folder where you saved the files:

| | |
|---|---|
| **Linux** | `sha256sum -c SHA256SUMS` |
| **macOS** | `shasum -a 256 -c SHA256SUMS` |
| **Windows** (PowerShell) | `Get-FileHash .\leekwallet.bin -Algorithm SHA256` then compare the line to `SHA256SUMS` by eye |

You want to see `OK` beside the file you downloaded. If you see `FAILED`, or the
Windows hash does not match, **delete the file and download it again** — and if
it fails a second time, open an issue rather than running it.

**Be clear about what this proves.** It proves the bytes you have are the bytes
that were published. It does *not* prove those bytes are trustworthy: the hash
list sits on the same page as the download, so anyone who could replace one could
replace the other. The signature raises that bar — it takes a key, not just write
access to a page — and `docs/RELEASE.md` explains how to check it.

What actually closes the gap is not trusting the release at all.

### Testing signing paths without a dapp

Real dapps are a poor test rig: Uniswap hides testnets behind a settings toggle,
Aave never offers a custom approval amount, and none of them can be asked to send
the one payload you want to see. `app/scripts/test-dapp.mjs` is the dapp half of
WalletConnect and nothing else — it prints a pairing code, waits for the wallet,
sends exactly the request you name, and then does the check the device cannot
make for itself.

```bash
node app/scripts/test-dapp.mjs permit2     # Permit2 PermitSingle, 588 bytes, six leaves
node app/scripts/test-dapp.mjs permit      # EIP-2612, five leaves, renders in full
node app/scripts/test-dapp.mjs unlimited   # a drainer-shaped permit: 2^160-1, far deadline
node app/scripts/test-dapp.mjs personal    # personal_sign
```

Scan the QR it prints with the companion's camera, or paste the `wc:` line into
the pairing field. **Nothing is deployed and no gas is spent** — these are
signature requests, and Permit2 is a canonical singleton already present at the
same address on every chain.

The last step is the one that matters: it recovers the signer from the returned
signature and compares it to the address the wallet claims. A device that renders
a Permit beautifully and signs a *different digest* passes every other test in
this repo and fails here.

A refusal can also be the correct answer — see [docs/PROTOCOL.md](docs/PROTOCOL.md)
section 6bis on what the device will not sign.

### If you can build it, please audit it

The builds are reproducible: two machines building the same tag produce
byte-identical firmware, so you can check that a published binary really is the
published source rather than taking anyone's word for it.

```bash
./scripts/repro-verify.sh      # build twice, compare hashes
./scripts/check.sh             # the full suite: host sim, app, firmware
make -C sim test               # the firmware's own logic, on your machine, no hardware
```

The host suite compiles the **real firmware C** natively, so most of this
project's logic can be read, run and broken on a laptop with nothing plugged in.
`sim/mutants.py` does mutation testing, and `sim/fuzz_transport.c` fuzzes the
parsers that see attacker-controlled bytes before authentication.

The audits in [`docs/AUDIT-ENTROPY.md`](docs/AUDIT-ENTROPY.md),
[`docs/AUDIT-SECRETS.md`](docs/AUDIT-SECRETS.md) and
[`docs/AUDIT-TRANSPORT.md`](docs/AUDIT-TRANSPORT.md) are written to be argued
with — they include the measurements and the harnesses, so a finding can be
reproduced or refuted rather than believed. Several of them contradict claims
this project's own documentation used to make. Finding the next one is the most
useful thing anyone can do here.

## Getting Started

### Prerequisites

Nothing at all is needed to run the [host test suite](sim/README.md) beyond a C
compiler — start there if you just want to read and poke at the logic.

| Tool | Needed for | Install |
|---|---|---|
| `gcc`, `make` | Host test suite | `sudo apt install build-essential` |
| [PlatformIO](https://platformio.org/) | Building and flashing firmware | `pip install platformio` |
| `python3`, `pyserial` | Serial monitoring | `sudo apt install python3 python3-serial` |
| Node 22+ | Companion app core | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| pnpm 9+ | Companion app workspace | `corepack enable pnpm` (ships with Node) |
| Rust 1.88+ | Companion app shell and transports | [rustup.rs](https://rustup.rs) — a distro Rust is usually too old for Tauri |
| `qemu-system-xtensa` (Espressif fork) | Emulated firmware testing | see [docs/QEMU.md](docs/QEMU.md) |

PlatformIO downloads the ESP-IDF toolchain itself on first build — expect a few
hundred MB and several minutes.

**Linux serial access.** The board appears as `/dev/ttyACM0`. You must be in the
`dialout` group:

```bash
sudo usermod -a -G dialout $USER   # then log out and back in
id -nG | grep dialout              # verify
```

### Verify your setup

```bash
make -C sim test                   # host suite, no hardware, ~1 second
pio run -e esp32s3                 # firmware builds
cd app && pnpm install && pnpm test # protocol codec
```

All three should pass before you plug anything in.

### Build & Flash

```bash
git clone https://github.com/0xoucan/leekwallet.git
cd leekwallet

pio run -e esp32s3                 # build
pio run -e esp32s3 -t upload       # flash over USB-C
./monitor.sh                       # serial monitor (Ctrl-] to exit)
```

A healthy boot log ends with something like:

```
I leekwallet: NVS initialized
I vault-kdf:  KDF benchmark: 4500 iterations in 1008 ms
I oled:       SSD1306 initialized: 128x64 @ 0x3C
I button:     Buttons initialized (polling): K1=10, K2=5, K3=6, K4=7
I ui:         UI task started
```

If the OLED line is missing, check SDA/SCL and that the display is a 4-pin I²C
module at `0x3C`. If the KDF benchmark reports a wildly different figure than
~1000 ms, the iteration count needs retuning for your board — see
`VAULT_KDF_V2_ITERATIONS`.

### First Boot

1. **Set PIN**: On first boot, create a 4-8 digit PIN
2. **Confirm PIN**: Re-enter to confirm
3. **Main Menu**: Navigate with UP/DOWN, select with ACCEPT

---

## User Interface

### Screen Flow

```
┌──────────┐     ┌──────────────┐     ┌─────────────┐
│   BOOT   │────▶│  PIN Setup   │────▶│  Main Menu  │
└──────────┘     │  or Unlock   │     └──────┬──────┘
                 └──────────────┘            │
        ┌────────────────┬──────────────────┼──────────────────┬────────────────┐
        ▼                ▼                  ▼                  ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ View Address │ │ Select Wallet│ │  New Wallet  │ │Import Wallet │ │   Settings   │
└──────┬───────┘ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│   QR Code    │────▶│  Seed Phrase │
│   Display    │     │  (PIN req'd) │
└──────────────┘     └──────────────┘
```

The main menu is built from what exists: "View Address" appears once there is a
wallet, "Select Wallet" once there is more than one, and "New Wallet" /
"Import Wallet" only while there are none — after that they live in Settings.
UP/DOWN on the address screen walks indices 0-9.

### Settings Menu

In the order they appear (`settings_items` in `src/ui.c`):

- **Show Seed** — displays the phrase, and always re-asks for the PIN rather than riding an open session
- **New Wallet** / **Import Wallet** — generate or type a 12 or 24-word phrase
- **Passphrase** — BIP39 passphrase, typed on the device; the resulting address is shown before anything else so a typo is caught
- **Brightness**, **Auto-lock** (1/5/10/30 min), **Word entry** (Blocks or Simple)
- **Change PIN** — re-encrypts every wallet under the new PIN, atomically
- **Link** — `Link USB` or `Link BLE`. One at a time; the unselected one is off, and switching tears down any session. See [docs/PROTOCOL.md](docs/PROTOCOL.md) §3b
- **BLE Name** — what the device broadcasts, and therefore a privacy control. 1-29 printable ASCII; longer is refused, not truncated
- **USB HID Test** — a stub. It logs what it would type and nothing more; there is no keyboard emulation
- **Blind sign** — `[ON]`/`[OFF]`, off by default. Turning it on costs five OK presses past a warning screen; turning it off costs one
- **Wipe Device** — factory reset, three deliberate presses, resumable if power is cut mid-wipe

**WiFi Test** appears only in `pio run -e esp32s3-wifi`. It is compiled out of the
default build entirely — it shipped a hardcoded WPA2 password and was reachable
while the wallet was unlocked (AUDIT S8g).

---

## Security

### Cryptographic Implementation

| Component | Algorithm |
|-----------|-----------|
| Seed generation | BIP39 over `src/entropy.c` — hardware RNG plus a mandatory button-timing pool, SP 800-90B health tests on a 512-byte sample, fails closed |
| Key derivation | BIP32/BIP44 |
| Vault key | PBKDF2-HMAC-SHA512 over a per-device random salt, ~1 s on hardware; key and verifier domain-separated so the stored verifier is not an oracle for the key |
| Storage encryption | AES-256-GCM, `nonce ‖ ciphertext ‖ tag`, format v3, with crash-safe migration from the older CBC vaults |
| Transport session | X25519 → HKDF (salted with the handshake transcript) → ChaCha20-Poly1305, passkey compared on the device screen |
| Signing | ECDSA secp256k1 (RFC6979) |

### Security Features

- **Encrypted at rest**: mnemonics in the NVS partition, each under its own nonce, authenticated
- **PIN**: 4-8 digits; 3 failed attempts wipes the device, and the counter is written before the compare so a power cut grants no free attempts
- **Keys never leave the device**: the protocol has no method that returns a private key or a seed
- **What you see is what you sign**: the device re-serialises and re-hashes the transaction itself and signs only what it rendered

The one thing this does **not** protect against is someone who has the device in
their hand: flash encryption is not enabled, so the vault can be read off the
chip. See [S1 in AUDIT.md](AUDIT.md), and the box below.

### The security ladder, cheapest first

Nothing here is mandatory. Each rung defends something the one below it does not,
and the honest ceiling is stated at the top rather than at the bottom.

| | What it defends | Cost | Status |
|---|---|---|---|
| 24 words + 8-digit PIN | Someone pressing buttons | none | shipped |
| **+ passphrase** | **A stolen device** — nothing stored can confirm a guess | remember a second secret | shipped |
| + temporary seed | Everything at rest — there is no vault to attack | retype the phrase each session | shipped |
| + HMAC-eFuse binding | A flash dump, without secure boot | one small irreversible burn | **researched only** |
| + ATECC608B gatekeeper | Hardware attempt limiting the firmware cannot override | ~$1, four wires, real work | **researched only** |
| + secure boot | Firmware replacement (the evil maid) | irreversible, user-held key | **rehearsed in QEMU only** |

The bottom three rungs have **never been executed on hardware** — no spare board
and no secure element are available to this project. They are written up in
[docs/BURN-PROCEDURE.md](docs/BURN-PROCEDURE.md) and
[docs/RESEARCH-SECURE-ELEMENT.md](docs/RESEARCH-SECURE-ELEMENT.md) as procedures
to be verified, not as results. **Do not read them as protections the wallet
currently has.**

Two rungs are worth singling out. **The passphrase is the one that matters today**,
because there is no at-rest protection yet. And a **temporary seed with a passphrase**
stores nothing at all — a flash dump has neither secret to attack and nothing to
confirm a guess against.

None of this makes an ESP32-S3 a secure element. There is no certified tamper
resistance, and the ESP32 family has a public history of glitching work against
these very protections. The claim is *"a flash dump yields nothing useful"*, never
*"impenetrable"*.

### If your device is stolen, the passphrase is what protects you

There is no flash encryption yet. That means someone holding the device can read
the chip and attack the PIN offline, where the three-attempt wipe does not apply:
eight digits is about **45 seconds** against one consumer GPU. The PIN protects
against someone pressing buttons, not against someone with a chip reader.

A **BIP-39 passphrase** is the one defence that still stands in that situation,
because of where it lives:

- It is **never written to flash**. Verified by enumerating every write in the
  firmware — see [docs/AUDIT-SECRETS.md](docs/AUDIT-SECRETS.md).
- It is erased from RAM on lock, on wallet switch, on wipe, and when the session
  ends. A locked device does not contain it in any form.
- **Nothing stored can confirm a guess.** No check-value, no fingerprint, no
  cached address. So an attacker who reads the chip and cracks the PIN cannot
  tell a passphrase wallet exists at all — they find the wallet the mnemonic
  alone produces, and it looks complete.

Two things about it are not optional to understand:

**Its strength is its entropy, and nothing else.** There is no lockout behind it.
An attacker holding your mnemonic can try passphrase after passphrase offline,
deriving addresses and checking the chain for funds. A short or guessable
passphrase falls the same way a short PIN does. Treat it as a second secret to be
chosen properly, not as a second factor.

**There is no recovery.** Lose it and the funds are gone — not locked, gone. The
same property that stops an attacker confirming a guess stops anyone, including
you, proving which passphrase was right. Back it up as carefully as the seed
phrase, and separately from it: together in one place, they are one secret.

### Backing up a seed that holds value

The device protects a seed while it is on the device. The copy you write down is
where funds are actually lost, and it is the part no firmware can help with.
**[docs/BACKUP.md](docs/BACKUP.md) is the full reasoning; this is the summary.**

**The one rule: the seed and the passphrase never live in the same place.** If
someone finds both, they have your funds. If you lose both, so have you.

**Do not split a phrase by cutting it up.** Words 1-8 on one paper, 5-12 on
another, so any two rebuild the twelve — it looks like a 2-of-3 backup and is
not one. Someone holding eight words faces about 2^44 candidates for the rest,
which a rented GPU rig grinds in days to weeks. A real threshold scheme leaks
*nothing* from one share; you cannot get that by cutting plaintext into
overlapping pieces.

**A passphrase does not license a weak split.** It does raise the cost — an
attacker needs the missing words *and* the passphrase, and can test neither
alone. But it quietly makes a 30-40 bit human-chosen secret the only thing
standing between a thief and the funds, when you started with 128 bits. A
passphrase is protection against a stolen *complete* backup; spending it to
justify a weakened one spends it twice.

**What to do instead: several complete copies, in different places, with the
passphrase somewhere else again.** One location robbed and the thief holds a
valid seed they cannot spend. One location lost and the others are whole, with
nothing to reconstruct. Better against theft *and* against loss than three
partial papers.

**Verify a restore before funding it.** A wrong passphrase does not fail — it
produces a valid wallet that is not yours. Record the master fingerprint (XFP)
shown on the wallet screen, and check it matches after restoring. Eight hex
characters, a few seconds, and it identifies the seed rather than one address.

### Why a DIY wallet, when commercial ones have secure elements?

A secure element protects a private key against someone with the physical device and a
laboratory. That is a real threat and dedicated silicon genuinely helps. But it is not the
threat that has taken people's money, and a chip cannot help with the ones that have:

| What actually went wrong | Would a secure element have prevented it? |
|---|---|
| **Coldcard, 2021-2026** — a build configuration error made seed generation silently fall back from the hardware RNG to a weak software one. Effective strength dropped from 128 bits to 40-72. Undetected for five years; ~1,596 BTC swept from ~7,300 addresses once found. | **No.** The key was stored perfectly. It was *generated* guessably. |
| **Milk Sad (CVE-2023-39910)** — Libbitcoin Explorer seeded a Mersenne Twister from 32-bit time. | **No.** Same failure, different vendor. |
| Malicious or spoofed companion apps substituting a recipient address | **No.** Prevented only by confirming on the device's own screen. |
| Supply-chain tampering between factory and buyer | **No.** Prevented by building it yourself, or by reproducible builds. |

The pattern: **the chip protects the key at rest, and nearly every real loss happened somewhere
else** — at generation, at confirmation, or in the software around it. Those are exactly the
places where being open and auditable beats being tamper-resistant, because the only defence is
someone being able to look.

So LeekWallet's argument is not "our crypto is better." It is that the parts that have actually
failed in the field are the parts you can inspect here:

- **You add your own entropy, and it is not optional.** Before a seed is generated the device
  demands 128 bits of user contribution, and whatever it collects is hashed *together with* the
  hardware RNG — never instead of it, so it can only help. This is the layer that survives a
  compromised silicon source, and it is the layer that protected the Coldcard users who supplied
  their own entropy. Two ways to supply it, and they can be mixed freely:
  - **Physical dice**, worth exactly **log2(6) = 2.585 bits per roll** — arithmetic, not an
    estimate. 50 rolls is 129 bits; 100 is 258. Rolls are entered on a 1–6 selector, roughly two
    presses each, with the armed face bracketed and the committed one echoed back. This must be a
    real die: a dice app runs an unauditable PRNG on a networked phone, so a compromised phone
    picks your seed while you feel *more* confident in it — the Coldcard failure shape exactly.
    The screen says so while you roll.
  - **Button presses**, at a deliberately pessimistic **2 bits each**, so 64 presses on their own.
    The press is quantised by a 10 ms poll and a 100 ms debounce before it is timestamped, and
    `docs/AUDIT-ENTROPY-2.md` §7.1 measures where the bits really come from (`ui_task` dequeue
    jitter, not the human) — which is precisely why the dice figure, which needs no such
    measurement, exists beside it.

  The press timing of the dice entry itself is mixed in and credited **zero** bits, so the two
  numbers never count the same act twice and the total is a floor with that jitter left over as
  margin. `docs/AUDIT-ENTROPY.md` shows the derivations.
- **Entropy is gated and fails closed.** Every byte of key material goes through
  `src/entropy.c`, which runs NIST SP 800-90B style health tests and **refuses to generate**
  rather than degrade. There is no second path — `random_buffer()` itself is routed through the
  gate, so `mnemonic_generate()` cannot bypass it. The tests run on a 512-byte sample drawn purely
  to be checked and then discarded, not on the caller's 32 bytes, because that is the first length
  at which the windowed proportion test runs at all: measured detection of a source with ~1 bit of
  min-entropy per byte is **0.21 on 32 bytes and 1.00 on 512**, for about 2.8 ms. What the tests
  catch even then is a *grossly* broken source: stuck, dead, constant, biased. They do not catch a
  source that looks uniform but has little real entropy behind it, which is what Coldcard's
  fallback PRNG was — that one is the user pool's job, and `docs/AUDIT-ENTROPY.md` measures both.
  Covered by `sim/test_entropy.c`.
- **The host is never trusted.** Transactions are re-serialised and re-hashed on-device and
  signed only as rendered. Calldata the device cannot decode is **refused**, not shown as a hex
  blob with an OK button; contract creation is refused outright, and no command can change that
  from the host. See [docs/PROTOCOL.md](docs/PROTOCOL.md) §1 and 6bis.
- **Every claim is a test you can run**, on your own machine, without buying anything:
  `make -C sim test`.
- **You build the firmware**, so there is no supply chain between the source and your device.

The seed-at-rest story is [docs/VAULT.md](docs/VAULT.md), which is explicit about its own limit:
the goal is "your seed survives losing the device," not "your seed survives a funded laboratory."
That second claim would need a secure element, and we do not make it.

None of this makes an $8 board equal to a certified secure element for physical-extraction
resistance — it does not, and the open findings below are
real. It makes a different bet: that verifiability is worth more than tamper-resistance against
the attacks that actually happen, and that you should be able to check rather than trust.

Notably, the two groups unaffected by the Coldcard incident were users with a **BIP39
passphrase** and users who supplied their own dice entropy. Passphrase support here is
standard-compliant and verified against the spec's known-answer vectors
(`sim/test_passphrase.c`).

### Status: it works, on testnets

**Over a cable.** A LeekWallet has signed and broadcast a real Sepolia
transaction end to end — seed generated on-device from user-supplied entropy,
stored under a salted PBKDF2 key with authenticated encryption, derived to
`m/44'/60'/0'/0/0`, displayed page by page on the OLED, approved by button,
signed by secp256k1, carried over an X25519-authenticated channel, and accepted
by the network.

[`0xa035de1c…`](https://sepolia.etherscan.io/tx/0xa035de1cb50860956dd8cfead9efd204e8d94dbb857a4bc26b4e1350bc20d96c)
— 0.0001 ETH, EIP-1559, nonce 0, confirmed.

**Over the radio, from a real dapp.** Aave's Base Sepolia faucet, reached in an
ordinary browser, routed through WalletConnect v2 to the companion app and over
BLE to a device running on battery. `mint(address,address,uint256)` was decoded
and confirmed on the device's own screen with blind signing off
(tx `0x48696ca6…`; the full hash was not recorded, so take that one as a
build note rather than something you can go and check).

That transaction is also where the decoding limits show. The device displayed
`10000000000` raw units where the explorer says `10,000 USDT`: the explorer
asked the contract for its `decimals`, and the device cannot. A scale taken from
the host is exactly the unverifiable claim that turns a confirmation into
decoration, so it shows the true number and says what it is.

**Not yet on a phone.** The Android APK builds, with both BLE and USB wired up,
but it has never been installed or run on a device — no permission dialog, no
enumeration, no signature. See `app/ANDROID.md`, "Known state".

### ⚠️ Testnets only — verify it yourself before trusting it with anything

LeekWallet is a proof of concept under active development. **Use testnets.**

Nothing here stops you from using it with real funds — it is your device, your
keys, and the code is all here to read. But the only sensible order is: read the
audit below, build the firmware yourself, run the test suite, verify the seed
derivation against a wallet you already trust, and move a token amount first.
Anyone recommending otherwise about software this young, including us, should be
ignored.

LeekWallet is a work in progress and has **not** been independently audited. The self-audit in
[AUDIT.md](AUDIT.md) tracks eight findings. Most are closed and covered by tests. One is not, and
it is the one that matters:

> ### S1 is open: anyone holding the device can read the vault off it
>
> **Flash encryption and secure boot are not enabled.** Someone with the board
> in their hand runs `esptool read_flash`, walks away with the encrypted vault,
> and attacks your PIN on their own hardware, at their own pace, with the
> 3-attempt wipe counter never involved — because that attack never goes through
> the firmware.
>
> The key derivation is salted PBKDF2 at roughly a second per guess and storage
> is authenticated AES-256-GCM, so a 4-8 digit PIN costs days rather than
> microseconds. **That is a delay, not a defence. It does not stop the read.**
>
> The procedure to close it is written
> ([docs/BURN-PROCEDURE.md](docs/BURN-PROCEDURE.md)), gated by a pre-flight
> script (`scripts/preflight-secure.sh`), and rehearsed end to end against
> QEMU's emulated eFuses. **No fuse has been burned on real silicon.** Until
> one is, treat a LeekWallet you cannot physically account for as compromised.

**Also open, lower severity:**

- **A re-entrant render path** in the wallet-creation screen — works, but the screen contract now has two ways in. (S8f)
- **Button events can be dropped** if the 8-slot queue fills during a long render. (S8j)
- The entropy gate's output has **never been run through dieharder on hardware** — the health tests pass, but the statistical certification is still owed. (S6)

**Closed since the first audit**, each with a regression test: the four-digit PIN ceiling (S2),
110 BIP39 words being unreachable so that roughly half of all seeds could not be imported (S3),
the attempt counter resetting after a power cut (S4), seed material lingering in `.bss` (S5),
non-atomic wiping (S7), silent entropy degradation (S6), unauthenticated CBC storage (S8h), the
unlabelled seed-reveal shortcut (S8i), and the display composing frames in front of the user
(S8k).

Progress against these is tracked in [ROADMAP.md](ROADMAP.md).

---

## Testing

You do not need hardware to work on most of this firmware:

```bash
make -C sim test
```

That is **18 suites and they all pass** — PIN, PIN change under crash injection, vault KDF and
AES-GCM, entropy health, mnemonic and text entry, CBOR, session, protocol conformance, BLE
chunking, transaction encoding, calldata decoding, device wipe, UI screens, buttons, master
fingerprint. `make -C sim asan` builds the protocol and chunking suites under sanitizers.

Three tiers are available — host-native logic tests, the ESP-IDF Linux target, and QEMU's
`esp32s3` machine (which emulates eFuses, so flash encryption and secure boot can be developed
without burning anything irreversible). See [sim/README.md](sim/README.md).

`./scripts/check.sh` runs the lot — host suites, app tests, typecheck and the firmware build —
and is what CI calls.

---

## Project Structure

```
leekwallet/
├── src/
│   ├── main.c            # Application entry point
│   ├── ui.c/h            # Screen state machine
│   ├── oled.c/h          # SSD1306 display driver
│   ├── button.c/h        # Button input handler
│   ├── pin.c/h           # PIN management
│   ├── entropy.c/h       # RNG gate, health tests, user pool
│   ├── mnemonic-entry.c  # BIP39 word selector
│   ├── text-entry.c      # Free-text selector (passphrase, BLE name)
│   ├── eth-tx.c/h        # EIP-1559 encoding and rendering
│   ├── eth-decode.c/h    # Calldata decoding — the refuse-by-default set
│   ├── blind-signing.c/h # The default-off hatch past a refusal
│   ├── protocol.c/h      # Command dispatch, transport-blind
│   ├── session.c/h       # X25519 / ChaCha20-Poly1305
│   ├── cbor.c/h          # Frame encoding
│   ├── transport.c/h     # USB or BLE — the only door to either
│   ├── ble.c/h           # NimBLE GATT service
│   ├── ble-chunk.c/h     # MTU chunking and reassembly
│   ├── ble-name.c/h      # Advertised name, validated and persisted
│   ├── device-wipe.c/h   # Atomic wipe with a resume-on-boot marker
│   ├── qrcode.c/h        # QR code generation
│   └── rand_esp32.c      # Hardware RNG bridge
├── components/
│   ├── trezor-crypto/    # Cryptographic primitives (vendored, MIT)
│   └── leek-wallet/      # HD wallet core, vault-kdf, vault-crypt
├── sim/                  # Host-native test harness (no hardware needed)
├── app/                  # Tauri v2 companion app + Rust transports
├── docs/                 # PROTOCOL, VAULT, CLEAR-SIGNING, BURN-PROCEDURE, QEMU, DESIGN
├── scripts/              # check.sh, preflight-secure.sh, QEMU helpers
├── AUDIT.md              # Known defects, by severity
├── ROADMAP.md            # Parallelizable task breakdown
├── platformio.ini        # Build configuration
├── partitions.csv        # Flash partition table
└── sdkconfig.defaults    # ESP-IDF configuration
```

---

## Connectivity

**One link at a time, chosen on the device.** Settings → Link picks USB or BLE;
the other is fully off, not merely unpaired, and switching tears down any
session. The reasoning is in [docs/PROTOCOL.md](docs/PROTOCOL.md) §3b, and it is
not a preference: the session layer holds one pair of nonce counters, the framing
has no request IDs, and a device advertising while you believe you are on a cable
is reachable by someone you cannot see.

| | USB | BLE |
|---|---|---|
| Wire | USB-Serial-JTAG CDC, sync-marked so it shares the console port | NimBLE GATT, chunked to the negotiated MTU |
| Default | yes | no |
| Advertised name | — | `LeekWallet`, or whatever you set in Settings → BLE Name |

Both carry identical frames, and `sim/test_protocol.c` runs every conformance
case down both channels and compares the replies — which is how a `getMnemonic`
that was answered on the cable and silently dropped on the radio was found.

**Wi-Fi is gone from the default build** (AUDIT S8g). `pio run -e esp32s3-wifi`
still builds the old AP test — SSID `LeekWallet`, password `leek1234`,
`192.168.4.1` — and you should not run it on a device holding anything.

---

## Roadmap

- [x] HD wallet (BIP39/BIP32/BIP44), up to 30 seeds
- [x] PIN protection with auto-wipe, and Change PIN with atomic re-encryption
- [x] QR code display for addresses
- [x] Host test harness (no hardware required) — 19 suites
- [x] Seed import fixed: all 2048 BIP39 words reachable
- [x] Salted vault KDF, tuned on hardware
- [x] Authenticated storage (AES-256-GCM, format v3 with crash-safe migration)
- [x] Encrypted session with on-device passkey comparison
- [x] On-device transaction decode and confirmation, with a refuse-by-default set
- [x] Blind-signing hatch, off by default, device-only
- [x] USB and BLE protocol layer, one link at a time
- [x] Companion app (Tauri v2) signing real transactions
- [x] WalletConnect v2 — a real dapp request signed over BLE
- [x] Android APK runs on a tablet: camera scan, BLE signing, broadcast
- [x] Send flow with camera QR recipient scanning, Max amount, and token discovery
- [x] Address panel: selector, QR, copy, and share where a share sheet exists
- [x] Dapp pairing under the shipping CSP on both platforms, signing verified on-chain
- [x] EIP-712 typed data, rendered field by field — a Snapshot vote signed on hardware
- [x] Contract calls decoded from a self-verifying signature table (Aave `supply`
      and friends), the table checked by hashing rather than trusted
- [x] Editable approval cap: replace a dapp's amount before it reaches the device
- [x] Account selector and host-side passphrase entry, both reachable from the app
- [x] Screen-reader labels, keyboard traversal and a measured contrast audit
- [x] Reproducible builds, firmware and companion, with a signed release manifest
- [x] Physical-dice entropy, counted in bits, optional and mixed never substituted
- [x] Temporary seed: type a phrase, store nothing, lose it on lock — the SeedSigner
      arrangement, offered as a menu action
- [x] Passkey comparison that actually resists a relay (commitment round, v2 handshake)
- [x] The PIN's only stored verifier is behind the vault's slow KDF
- [x] A wipe that erases the flash rather than the bookkeeping
- [ ] At-rest protection — **nothing yet.** A flash dump still yields the vault and the
      PIN falls in minutes. HMAC-eFuse binding is the cheapest fix; flash encryption
      and secure boot are the fuller one, and optional per user
- [ ] Firmware flasher in the companion app (ROADMAP T65, gated on secure boot)
- [ ] Generate a temporary seed, with dice — the two stateless halves currently
      meet only if you write the phrase down in between
- [ ] Airgapped QR signing (needs a camera)
- [ ] Secure element integration (ATECC608B as a PIN gatekeeper)

**Chains.** EVM only — deliberately, not pending. Solana, Bitcoin and Monero are not on the
roadmap; if coins are ever added the shape is one seed and one firmware at a time
(`leek-evm.bin`, `leek-btc.bin`), not an app loader and not every chain compiled into one image.
The reasoning is in [ROADMAP.md](ROADMAP.md). Within EVM it is chain-agnostic — chains differ by a chain ID
that is already signed, so Base, Arbitrum, Optimism and the rest are an app-side
concern. Bitcoin, Solana and Monero are recorded in
[ROADMAP.md](ROADMAP.md#other-coins-possible-not-planned) as possible but
unscheduled, roughly in that order of difficulty. Unlike Ledger they would ship
in one firmware rather than as loadable apps: that design answers a 320 KB flash
constraint we do not have, and an app loader is a security-critical component we
would rather not write.

### Companion app

One [Tauri v2](https://tauri.app) codebase targets Linux, macOS, Windows and Android. Both
transports are built on both — desktop over USB CDC (`serialport`) or BLE (`btleplug`), Android
over BLE (`tauri-plugin-blec`) or a USB cable (`tauri-plugin-serialplugin`, since Android cannot
open `/dev/ttyACM*` unrooted). They sit behind a single transport-blind protocol
([docs/PROTOCOL.md](docs/PROTOCOL.md)), so commands are written once. Which one is live is the
device's decision, not the app's.

Chain interaction uses [viem](https://viem.sh), with the wallet exposed as a custom `toAccount()`
signer so any wagmi/RainbowKit dapp can use it unmodified.
[WalletConnect v2](https://walletconnect.network) pairs it with dapps in your own browser — there
is deliberately no in-app dapp browser. A project ID is bundled so pairing works out of the box, and
Settings takes your own if you would rather not share the quota; a fork should replace the bundled
value, since quota is per ID. Pairing is proven on both platforms by signing from a live Aave
session: desktop `0x299ac220…` and Android `0xe3b53e2f…`, each `from` the device's own address.

Developers: the Vite dev server serves the shipping Content-Security-Policy, read from
`tauri.conf.json`. Tauri injects that header only when it serves the built app over its own
protocol, so a `tauri dev` webview would otherwise run with no policy at all — and for a while it
did, which is how a WalletConnect failure hid on Android that the Linux release build shared. What
you install is a bundled binary, never a dev server, so **verify a release against the bundle**.

The app shows a Rabby-style preview of what a transaction does, including ERC-7730 descriptor
labels for a few pinned contracts (WETH, Lido, Aave). **This is advisory and the device never
sees it.** Descriptors are unsigned and nothing cryptographic ties them to the contract being
called; the device's own refuse-by-default decoding is the thing that decides. Why the industry
does it this way, and what it would take to make it trustworthy on-device, is in
[docs/CLEAR-SIGNING.md](docs/CLEAR-SIGNING.md) — a research spike, not a plan of record.

What the device *does* trust is a different mechanism, and it needs no descriptor and no key:
function signatures are bundled in the firmware as strings, and a row is reachable only by
recomputing `keccak256(signature)[0:4]` and matching the selector actually being signed. A
tampered signature cannot produce the right selector, so the table certifies itself. That is how
`supply(address,uint256,address,uint16)` renders argument by argument rather than as a hash. Its
limit is stated on the device's own screen: this proves what a function is **named** and what it
was **passed**, never what it does — a drainer may call its entry point `supply` and every page
will render correctly.

Approvals can be capped before they reach the device: a dapp asking for an unlimited allowance can
be answered with 500, re-encoded and confirmed on the device's own screen. Unlimited approvals are
the most exploited thing in this space (see [docs/ANTI-SCAM.md](docs/ANTI-SCAM.md)), and dapps
rarely offer the choice — Aave never does. Two things learned by doing it: tokens of the USDT kind
refuse to move from one non-zero allowance to another, so a standing allowance is zeroed first and
signed as two transactions; and an allowance exactly equal to the spend is refused by dapps that
check with a margin, so approve a little above what you mean to spend and reload the dapp, which
will otherwise keep using the figure it last read.

Visual language — minimal, mono-forward, no pixel art — is specified in
[docs/DESIGN.md](docs/DESIGN.md). What the companion owes a user who cannot see
it is in [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md), which treats one thing
as a security requirement rather than a courtesy: if the app cannot tell you
that the device is waiting for a confirmation, the confirmation is not doing its
job.

See [ROADMAP.md](ROADMAP.md) for the detailed task breakdown, and
[NEXT-SESSION.md](NEXT-SESSION.md) for a cold-start brief covering current
state, priorities, parallelisable tracks and the traps worth knowing.

---

## Acknowledgments

- **Trezor** - For the open-source [trezor-crypto](https://github.com/trezor/trezor-crypto) library
- **Colibri** - For the design inspiration behind the RPC surface (no code used; see [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md))
- **Yucatec Maya** - the source of the name; see [The name](#the-name)
- **ricmoo** - For the [QRCode](https://github.com/ricmoo/QRCode) library

---

## Etymology

> **lek** /lek/ — Yucatec Maya
>
> A container made from the dried gourd of *Lagenaria siceraria* (*jícara*), used
> in the Yucatán Peninsula. Commonly a *tortillero*, for holding tortillas.

---

## License

LeekWallet is licensed under the [Apache License 2.0](LICENSE).

It bundles third-party components under their own (MIT) licenses — notably
[trezor-crypto](https://github.com/trezor/trezor-firmware) for BIP32/BIP39/
secp256k1 and [ricmoo/QRCode](https://github.com/ricmoo/QRCode) for QR
generation. Full inventory and attribution in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) and [NOTICE](NOTICE).

**Note for contributors:** the [Colibri](https://github.com/xtools-at/colibri)
hardware wallet inspired this project's RPC surface, but it is AGPL-3.0 and no
code from it is used here. Copying Colibri code into this repository would make
the whole project AGPL. See THIRD-PARTY-LICENSES.md.

---

## If you use this

It is an open-source hardware wallet built by one person, audited by nobody
independent, and it has no secure boot yet. Read [AUDIT.md](AUDIT.md) before
trusting it with anything you cannot afford to lose, and treat the roadmap's
open items as the honest list of what is missing rather than a formality.

Bug reports, review of the cryptographic paths, and someone finding a hole in
this are worth more to the project than stars.

---

<p align="center">
  Open source. Not for sale.
</p>
