# LeekWallet

> *"Lek"* - The Maya word for jícara, a sacred gourd container

<p align="center">
  <img src="docs/leekwallet-logo.png" alt="LeekWallet" width="200"/>
</p>

## The Story of Lek

In the kitchens of the **Yucatán Peninsula**, where the ancient Maya civilization still lives through its descendants, there exists a humble yet sacred object: the **Lek** (also written *leek*).

The Lek is a traditional **tortillero** - a container crafted from *jícara*, the dried fruit of the gourd plant (*Lagenaria siceraria*, known as *guaje* in Spanish). For generations, Maya families have used the Lek to store and keep warm their freshly made corn tortillas.

### The Wisdom of the Lek

```
    ╭───────────────────╮
    │    ┌─────────┐    │
    │    │ ~~~~~~~ │    │  The Lek protects what matters most:
    │    │ tortilla│    │  warmth, nourishment, tradition
    │    │ ~~~~~~~ │    │
    │    └─────────┘    │
    ╰───────────────────╯
         The Lek
```

Inside every Lek, a **servilleta de manta** (cotton cloth napkin) cradles the tortillas, preserving their warmth and softness. The Lek is not merely functional - it is often adorned with engravings and paintings that reflect the rich artistic heritage of the Maya people.

**The Lek embodies three principles:**

- **Protection** - Shields the precious tortillas from the outside world
- **Preservation** - Maintains warmth and freshness over time
- **Beauty** - Carries the artistic spirit of Maya culture

Just as the Lek **guards the sacred corn tortilla** - the heart of Maya sustenance - **LeekWallet guards your digital seeds** - the foundation of your financial sovereignty.

---

## What is LeekWallet?

LeekWallet is an **open-source hardware wallet** built on the ESP32-S3 microcontroller. Like its namesake, it is a minimalist container designed with one purpose: to **protect what is precious**.

Your cryptocurrency keys are like the warm tortillas of the digital age - they must be kept safe, secure, and close at hand.

### Features

| Feature | Description |
|---------|-------------|
| **HD Wallet** | BIP39/BIP32/BIP44 hierarchical deterministic wallet |
| **Multi-Wallet** | Store up to 30 wallets securely |
| **PIN Protection** | 4-8 digit PIN, 3-attempt wipe, counter hardened against power-cut attacks |
| **Seed Phrases** | 12 or 24-word mnemonic generation and import |
| **QR Codes** | Display addresses as scannable QR codes |
| **Air-Gapped** | No internet required for key operations |
| **WiFi Testing** | AP mode for connectivity verification |
| **BLE Support** | NimBLE stack for future integrations |

### Hardware

```
┌─────────────────────────────────────┐
│         LeekWallet Hardware         │
├─────────────────────────────────────┤
│  MCU:     ESP32-S3 Mini             │
│  Flash:   4MB                       │
│  Display: SSD1306 OLED 128x64       │
│  Input:   4 tactile buttons         │
│  USB:     USB-C (Serial + HID)      │
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

> **Which S3 module?** This firmware is currently configured for **4 MB flash, no PSRAM**
> (`platformio.ini`, `partitions.csv`, `CONFIG_SPIRAM=n`). Boards advertised as **N16R8** have
> 16 MB flash and 8 MB PSRAM — they will work, but you must update `board_build.flash_size`
> and the partition table together, and PSRAM should stay disabled (it is
> [broken under QEMU](https://github.com/espressif/qemu/issues/129), which this project's test
> strategy relies on). Tracked as T33 in [ROADMAP.md](ROADMAP.md).

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

## Getting Started

### Prerequisites

- [PlatformIO](https://platformio.org/) (VS Code extension or CLI)
- The parts above — or nothing at all, if you only want to run the
  [host test suite](sim/README.md)

### Build & Flash

```bash
# Clone the repository
git clone https://github.com/yourusername/leekwallet.git
cd leekwallet

# Build
pio run -e esp32s3

# Flash
pio run -e esp32s3 -t upload

# Monitor serial output
pio device monitor
```

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

### Settings Menu

- **WiFi Test** - Broadcasts AP "LeekWallet" (password: leek1234)
- **BLE Test** - Enables NimBLE advertising as "LeekWallet"
- **USB HID Test** - Keyboard emulation (in development)
- **Change PIN** - Update your PIN
- **Wipe Device** - Factory reset (erases all data)

---

## Security

### Cryptographic Implementation

| Component | Algorithm |
|-----------|-----------|
| Seed Generation | BIP39 via `esp_random()` — entropy unverified, see S6 |
| Key Derivation | BIP32/BIP44 |
| Storage Encryption | AES-256-CBC, unauthenticated, key = `SHA256²(pin)` — see S1 |
| PIN Hashing | SHA-256, 101 rounds, unsalted — see S1 |
| Signing | ECDSA secp256k1 (RFC6979) |

### Security Features

- **Secure Storage**: Encrypted mnemonics in NVS partition
- **PIN Protection**: 3 failed attempts triggers device wipe
- **No External Communication**: Keys never leave the device

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

- **You can add your own entropy.** Before generating a seed, an optional screen harvests the
  microsecond timing between your button presses and hashes it *together with* the hardware RNG
  — never instead of it, so it can only help. This is the layer that survives a compromised
  silicon source, because no firmware bug can predict when a human presses a button.
- **Entropy is gated and fails closed.** Every byte of key material goes through
  `src/entropy.c`, which runs NIST SP 800-90B style health tests and **refuses to generate**
  rather than degrade. There is no second path — `random_buffer()` itself is routed through the
  gate, so `mnemonic_generate()` cannot bypass it. The failure that hit Coldcard would abort
  this device instead of silently producing a weak seed. Covered by `sim/test_entropy.c`.
- **The host is never trusted.** Transactions are re-serialised and re-hashed on-device and
  signed only as rendered; blind hash signing is off by default. See
  [docs/PROTOCOL.md](docs/PROTOCOL.md) §1.
- **Every claim is a test you can run**, on your own machine, without buying anything:
  `make -C sim test`.
- **You build the firmware**, so there is no supply chain between the source and your device.

The seed-at-rest story is [docs/VAULT.md](docs/VAULT.md), which is explicit about its own limit:
the goal is "your seed survives losing the device," not "your seed survives a funded laboratory."
That second claim would need a secure element, and we do not make it.

None of this makes an $8 board equal to a certified secure element for physical-extraction
resistance — it does not, and [the open findings below](#-do-not-put-real-funds-on-this-yet) are
real. It makes a different bet: that verifiability is worth more than tamper-resistance against
the attacks that actually happen, and that you should be able to check rather than trust.

Notably, the two groups unaffected by the Coldcard incident were users with a **BIP39
passphrase** and users who supplied their own dice entropy. Passphrase support here is
standard-compliant and verified against the spec's known-answer vectors
(`sim/test_passphrase.c`).

### ⚠️ Do not put real funds on this yet

LeekWallet is a work in progress and has **not** been independently audited. A self-audit
([AUDIT.md](AUDIT.md)) found defects that are disqualifying for a device holding value:

- **The seed is recoverable from a flash dump.** Storage keys are `SHA256(SHA256(pin))` with no
  salt and no KDF, the PIN is effectively 4 digits, and flash encryption is not enabled. Anyone
  with the physical device and `esptool` recovers the seed in seconds. (S1)
- **~48% of 12-word seeds cannot be imported.** 110 BIP39 words are unreachable in the entry UI.
  (S3)
- **The wipe counter can be bypassed** by cutting power at the right moment. (S4)
- **Plaintext seeds linger in RAM** after the screen showing them is dismissed. (S5)
- **Seed-generation entropy is unverified** — the S3 hardware RNG's guarantees depend on an RF
  subsystem being active, and mnemonics are generated with Wi-Fi and BLE off. (S6)
- **There is no on-device transaction confirmation yet**, so the "what you see is what you sign"
  property that makes a hardware wallet meaningful does not exist. (ROADMAP T12)

Use testnets and throwaway seeds. Progress against these is tracked in [ROADMAP.md](ROADMAP.md).

---

## Testing

You do not need hardware to work on most of this firmware:

```bash
make -C sim test
```

Three tiers are available — host-native logic tests, the ESP-IDF Linux target, and QEMU's
`esp32s3` machine (which emulates eFuses, so flash encryption and secure boot can be developed
without burning anything irreversible). See [sim/README.md](sim/README.md).

The suite currently **fails on purpose**: `sim/test_mnemonic_entry.c` pins down the import bug
above so the fix has something to turn green.

---

## Project Structure

```
leekwallet/
├── src/
│   ├── main.c          # Application entry point
│   ├── ui.c/h          # Screen state machine
│   ├── oled.c/h        # SSD1306 display driver
│   ├── button.c/h      # Button input handler
│   ├── pin.c/h         # PIN management
│   ├── qrcode.c/h      # QR code generation
│   └── rand_esp32.c    # Hardware RNG bridge
├── components/
│   ├── trezor-crypto/  # Cryptographic primitives
│   └── colibri-wallet/ # HD wallet core
├── sim/                # Host-native test harness (no hardware needed)
├── AUDIT.md            # Known defects, by severity
├── ROADMAP.md          # Parallelizable task breakdown
├── platformio.ini      # Build configuration
├── partitions.csv      # Flash partition table
└── sdkconfig.defaults  # ESP-IDF configuration
```

---

## Connectivity Testing

### WiFi AP Mode

When enabled, LeekWallet broadcasts:
- **SSID**: `LeekWallet`
- **Password**: `leek1234`
- **IP**: `192.168.4.1`

### BLE Mode

When enabled, LeekWallet advertises as:
- **Device Name**: `LeekWallet`
- **Stack**: NimBLE

---

## Roadmap

- [x] HD Wallet (BIP39/BIP32/BIP44)
- [x] Multi-wallet support (up to 30)
- [x] PIN protection with auto-wipe
- [x] QR code display for addresses
- [x] WiFi AP mode
- [x] BLE NimBLE stack
- [x] Host test harness (no hardware required)
- [ ] Fix seed import (110 unreachable BIP39 words)
- [ ] Real PIN entropy + KDF + flash encryption
- [ ] On-device transaction decode & confirmation
- [ ] BLE + USB protocol layer
- [ ] Companion app — Tauri v2 (Linux/macOS/Windows + Android)
- [ ] Multiple coin support (BTC, ETH, etc.)
- [ ] Secure element integration

### Companion app

One [Tauri v2](https://tauri.app) codebase targets Linux, macOS, Windows and Android, with one
transport per platform: **BLE on Android, USB cable on desktop.** Both sit behind a single
transport-blind protocol ([docs/PROTOCOL.md](docs/PROTOCOL.md)), so commands are written once.
The app can also act as a keyboard for the BIP39 passphrase over an encrypted, MITM-checked
session — with the wallet fingerprint confirmed on the device screen before it is used. Chain interaction
uses [viem](https://viem.sh), with the wallet exposed as a custom `toAccount()` signer so any
wagmi/RainbowKit dapp can use it unmodified.

Visual language — minimal, mono-forward, no pixel art — is specified in
[docs/DESIGN.md](docs/DESIGN.md).

See [ROADMAP.md](ROADMAP.md) for the detailed, parallelizable task breakdown.

---

## Acknowledgments

- **Trezor** - For the open-source [trezor-crypto](https://github.com/trezor/trezor-crypto) library
- **Colibri** - For the design inspiration behind the RPC surface (no code used; see [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md))
- **The Maya People** - For the inspiration of the *Lek* and their enduring wisdom
- **ricmoo** - For the [QRCode](https://github.com/ricmoo/QRCode) library

---

## Etymology

> **Lek** /lek/ - From Yucatec Maya
>
> A traditional Maya tortillero (tortilla container) crafted from *jícara*, the dried gourd of the *Lagenaria siceraria* plant. Used for generations in the Yucatán Peninsula to store and keep warm freshly made corn tortillas.
>
> Inside the Lek, a *servilleta de manta* (cotton cloth) cradles the tortillas, preserving their warmth. The Lek is often decorated with engravings and paintings reflecting Maya artistic traditions.
>
> Just as the Lek protects the sacred tortilla, **LeekWallet** protects your digital seeds.

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

## Final Words

*"In Lak'ech Ala K'in"* - Maya greeting meaning "I am you, and you are me"

The Maya understood that what we protect, we become part of. The Lek is not separate from the tortilla it holds - together they sustain life. LeekWallet is not separate from the seeds it guards - together they build your future.

**Guard your seeds. Preserve your warmth. Build your future.**

---

<p align="center">
  Made with care in the Yucatán Peninsula
</p>
