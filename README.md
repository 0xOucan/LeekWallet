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
| **HD wallet** | BIP39/BIP32/BIP44, secp256k1 signing (RFC6979) |
| **Multi-wallet** | Up to 30 independent seed phrases, each encrypted under its own nonce |
| **Seed phrases** | 12 or 24-word generation and import; BIP39 passphrase entered on-device |
| **PIN** | 4-8 digits, 3-attempt wipe, counter hardened against power-cut attacks |
| **Change PIN** | Re-encrypts every wallet atomically — a power cut leaves exactly one PIN that opens everything (`sim/test_pin_change.c`) |
| **Vault** | Per-device salted PBKDF2-HMAC-SHA512, ~1 s on hardware, AES-256-GCM, domain-separated key and verifier |
| **Entropy** | Hardware RNG behind a fails-closed SP 800-90B gate, plus an optional button-timing pool that is mixed in, never substituted |
| **Transaction signing** | EIP-1559, re-serialised and re-hashed on-device, displayed page by page, signed only as rendered |
| **Decodable set** | Native transfer, ERC-20 `transfer`/`approve`/`transferFrom`, `setApprovalForAll`, WETH `deposit`/`withdraw`, three `mint` shapes. Anything else — including contract creation — is **refused** (`src/eth-decode.c`) |
| **Blind signing** | Off by default, set on the device only, five presses past a warning screen. No command can turn it on |
| **Link** | USB CDC-ACM **or** BLE GATT, one at a time, chosen on the device (Settings → Link) |
| **BLE name** | User-set, 1-29 printable ASCII, refused rather than truncated — an over-long name would silently stop advertising |
| **Session** | X25519 handshake with a passkey compared on the device's own screen; ChaCha20-Poly1305 frames |
| **QR codes** | Display addresses as scannable QR codes |
| **Companion app** | Tauri v2 on Linux/macOS/Windows and an Android APK, with WalletConnect v2 for real dapps |

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
| Seed generation | BIP39 over `src/entropy.c` — hardware RNG plus optional button-timing pool, SP 800-90B health tests, fails closed |
| Key derivation | BIP32/BIP44 |
| Vault key | PBKDF2-HMAC-SHA512 over a per-device random salt, ~1 s on hardware; key and verifier domain-separated so the stored verifier is not an oracle for the key |
| Storage encryption | AES-256-GCM, `nonce ‖ ciphertext ‖ tag`, format v3, with crash-safe migration from the older CBC vaults |
| Transport session | X25519 → HKDF → ChaCha20-Poly1305, passkey compared on the device screen |
| Signing | ECDSA secp256k1 (RFC6979) |

### Security Features

- **Encrypted at rest**: mnemonics in the NVS partition, each under its own nonce, authenticated
- **PIN**: 4-8 digits; 3 failed attempts wipes the device, and the counter is written before the compare so a power cut grants no free attempts
- **Keys never leave the device**: the protocol has no method that returns a private key or a seed
- **What you see is what you sign**: the device re-serialises and re-hashes the transaction itself and signs only what it rendered

The one thing this does **not** protect against is someone who has the device in
their hand: flash encryption is not enabled, so the vault can be read off the
chip. See [S1 in AUDIT.md](AUDIT.md), and the box below.

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
- [x] Host test harness (no hardware required) — 18 suites
- [x] Seed import fixed: all 2048 BIP39 words reachable
- [x] Salted vault KDF, tuned on hardware
- [x] Authenticated storage (AES-256-GCM, format v3 with crash-safe migration)
- [x] Encrypted session with on-device passkey comparison
- [x] On-device transaction decode and confirmation, with a refuse-by-default set
- [x] Blind-signing hatch, off by default, device-only
- [x] USB and BLE protocol layer, one link at a time
- [x] Companion app (Tauri v2) signing real transactions
- [x] WalletConnect v2 — a real dapp request signed over BLE
- [x] Android APK builds with both transports — never run on a phone
- [ ] Flash encryption + secure boot — **the gate before real funds**
- [ ] Account selector (`m/44'/60'/account'/0/0`)
- [ ] EIP-712 typed data (needs a `signTypedData` command first)
- [ ] Airgapped QR signing (needs a camera)
- [ ] Secure element integration

**Chains.** EVM only, and chain-agnostic within it — chains differ by a chain ID
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
is deliberately no in-app dapp browser. You supply your own WalletConnect project ID; none is
bundled, because a committed one would be either fake or somebody else's quota.

The app shows a Rabby-style preview of what a transaction does, including ERC-7730 descriptor
labels for a few pinned contracts (WETH, Lido, Aave). **This is advisory and the device never
sees it.** Descriptors are unsigned and nothing cryptographic ties them to the contract being
called; the device's own refuse-by-default decoding is the thing that decides. Why the industry
does it this way, and what it would take to make it trustworthy on-device, is in
[docs/CLEAR-SIGNING.md](docs/CLEAR-SIGNING.md) — a research spike, not a plan of record.

Visual language — minimal, mono-forward, no pixel art — is specified in
[docs/DESIGN.md](docs/DESIGN.md).

See [ROADMAP.md](ROADMAP.md) for the detailed task breakdown, and
[NEXT-SESSION.md](NEXT-SESSION.md) for a cold-start brief covering current
state, priorities, parallelisable tracks and the traps worth knowing.

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
