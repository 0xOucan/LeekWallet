# LeekWallet — Proof of Concept Roadmap

Goal: a LeekWallet you can plug into a desktop or Android app, that displays a decoded
transaction on its own screen, and signs it after a PIN-gated confirmation — with the seed
never leaving the device.

Tasks are written to be worked in parallel. Each has an ID, its blocking dependencies, and a
done-condition that is checkable without hardware wherever possible.

---

## Architecture decisions

Settled: **Tauri v2** for desktop and Android, **BLE on Android and USB cable on desktop**
(one transport per platform), **viem** for chain interaction. The reasoning is below. The decision
that actually determines whether this is a wallet or a toy is the last one — on-device
confirmation.

### Transport: one per platform — BLE on Android, cable on desktop

**Decided: Android speaks BLE, desktop speaks USB CDC-ACM. Neither platform implements both.**

Each platform gets the transport that is native to it, and skips the one that is painful there:

| | Android | Desktop (Linux/macOS/Windows) |
|---|---|---|
| Transport | BLE (GATT) | USB CDC-ACM |
| Rust crate | `btleplug` (Android backend) | `serialport-rs` / `tauri-plugin-serialplugin` |
| Avoided | USB host mode, OTG adapters, `device_filter.xml`, "your phone can't do host mode" dead ends | Three incompatible desktop BT stacks (BlueZ / CoreBluetooth / WinRT), OS pairing UI, macOS Bluetooth entitlements |

This deletes the two worst surfaces in the whole plan. Desktop BLE means three separate backends
with genuinely different pairing semantics; Android USB means an adapter the user has to own and
a host-mode capability their phone may simply lack. Dropping both removes roughly half of
Track D and all of its hardware-dependent risk.

Desktop gains a bonus: firmware flashing and the protocol share one cable and one port, so
"plug it in" is the entire setup instruction.

**What we give up: the per-platform fallback.** If Android BLE misbehaves — Bluetooth off,
pairing wedged, device not advertising — there is no cable path on that phone. If a desktop user
grabs a charge-only cable, there is no BLE path on that machine. Both remain recoverable
*across* devices (a user with a phone and a laptop has two independent routes to the same
wallet), which is enough for a PoC, and the wallet is never inaccessible since the device is
self-contained.

Because §2 of [PROTOCOL.md](docs/PROTOCOL.md) is transport-blind — same frames, same commands,
BLE only adds a chunking layer — adding the second transport to either platform later is
configuration, not rework. Keep the `Transport` trait even though each build only has one
implementation.

Practical notes: Linux serial needs the `dialout` group (already in the README); the ESP32-S3's
native USB CDC enumerates driverless on Windows 10+ and macOS.

### GUI: Tauri v2, desktop and Android

**Decided: Tauri v2 everywhere**, dropping Electron and Capacitor entirely.

| | Tauri v2 | Electron |
|---|---|---|
| Bundle | ~10 MB | ~150 MB |
| Renderer | OS webview | Bundled Chromium |
| Backend | Rust; capabilities allowlisted per-window | Node; full fs/net reachable from main |
| Android | Supported | Not supported |
| CVE patching | OS ships webview updates | You re-ship Chromium |

For a wallet the security model is the deciding factor, not the bundle size. Tauri denies by
default and makes you enumerate what the frontend may invoke; Electron hands the process that
talks to your device a complete Node runtime. Covering desktop *and* Android from one Rust
backend is what makes it a clear call rather than a close one.

Costs accepted: three webview engines to test against (WebKitGTK, WKWebView, WebView2), a
younger plugin ecosystem, and Rust for anything native. For a UI this small, all three are
manageable — and the Rust side is where BLE and serial want to live anyway.

**This removes the Capacitor USB plugin** that was the schedule risk in the previous plan.
Android USB now goes through Rust, and Android BLE through `btleplug`, sharing the desktop code
path. It does not remove the underlying Android platform work — see T30.

### viem vs ethers — use viem

viem is the better fit, for one specific reason beyond the usual tree-shaking arguments:
**`toAccount()`**. It lets you define a custom account by supplying three functions:

```ts
const leekAccount = toAccount({
  address,
  async signMessage({ message }) { return device.signMessage(message) },
  async signTransaction(tx)      { return device.signTransaction(tx) },
  async signTypedData(typedData) { return device.signTypedData(typedData) },
})
```

That object then drops into any `walletClient`, and by extension into wagmi, RainbowKit, and the
whole web3 app ecosystem — without those apps knowing a hardware wallet exists. It is exactly
the seam your firmware already exposes (`signHash`, `signMessage`, `signTypedData`,
`signTransaction`). ethers' `AbstractSigner` gets you to the same place, but viem's typing
around EIP-712 and EIP-1559 fields is stricter, which matters when the bytes you get wrong are
the bytes the user signs.

### BIP39 passphrase (the "25th word")

**Good news: the crypto is already done and it is standard.** `cache_seed_from_mnemonic()`
(`colibri-wallet.c:73`) passes the passphrase straight into trezor-crypto's `mnemonic_to_seed()`,
which builds the PBKDF2-HMAC-SHA512 salt as `"mnemonic" + passphrase` over 2048 rounds — exactly
BIP39. `wallet_set_passphrase()` / `wallet_clear_passphrase()` / `wallet_has_passphrase()` all
exist, the passphrase lives in RAM only and is never persisted, and setting it invalidates the
cached seed. That is the correct design, and it matches how Trezor treats hidden wallets.

So this is **interoperable today at the seed level**. A LeekWallet seed + passphrase produces the
same addresses as the same seed + passphrase on any BIP39 passphrase wallet:

| Wallet | Passphrase | Notes |
|---|---|---|
| Trezor | Yes | "Hidden wallets"; up to 50 ASCII chars; on-device or host entry |
| Ledger | Yes | Up to 100 chars; can attach a passphrase to a secondary PIN |
| Coldcard | Yes | Shows a master fingerprint (XFP) so you can confirm which wallet you opened |
| Keystone, BitBox | Yes | |
| Sparrow, Electrum | Yes | Via BIP39 import |
| MetaMask | No passphrase field exposed | Verify before relying on it for a given version |

**Our own constraints, which are tighter than the standard:** `MAX_PASSPHRASE_LENGTH` is 128
(`colibri-wallet.c:44`), and the only input device is four buttons and a 128x64 OLED. Typing an
arbitrary UTF-8 sentence on that is brutal — the mnemonic entry screen already costs up to 49
presses for one *known* word, and a passphrase has no wordlist to constrain the selector.

That points at a two-path design:

1. **Host entry** over BLE/USB for long passphrases, typed on a real keyboard. Fast, but the
   passphrase crosses the wire and touches a general-purpose computer — the exact machine the
   hardware wallet exists to distrust.
2. **On-device entry** for people who want the passphrase never to touch a host. Slow, and it
   should be, but it is the only option that preserves the threat model.

Offer both, default to on-device, and be explicit in the UI about what each choice costs.

**The dangerous part is not the crypto, it is the UX.** A mistyped passphrase does not error —
it silently derives a *different, equally valid* wallet that appears empty. Users conclude their
funds are gone. Every serious implementation solves this by showing an identifier before use:
Coldcard shows the master fingerprint, Trezor shows the first address. We must do the same
(T39), and it is not optional.

Second trap: the passphrase is **not** a recovery factor. Lose it and the funds are
unrecoverable — there is no reset, because no record of it exists anywhere by design. The UI has
to say this at the moment of creation, not in a manual.

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T38~~ ✅ | On-device passphrase entry: full printable ASCII via mode entries in the selector ring | T3 | every printable character reachable; **13.6 presses/char measured**, so a 17-char passphrase costs 231 presses |
| ~~T39~~ ✅ | Address shown after a passphrase is applied, before anything else, with RETRY to clear a wrong one | T38 | address changes with the passphrase; wrong entry is recoverable |
| T39b | Add the master XFP alongside the address, as Coldcard does — shorter to write down than 42 hex characters | T39 | XFP matches a reference implementation |
| T40 | Host-side passphrase entry over the protocol, marked as the lower-security path | T20, T38 | mock device round-trips it |
| ~~T41~~ ✅ | Interop vectors: BIP39 known-answer seeds with and without passphrase | — | `sim/test_passphrase.c`, both spec vectors match byte-for-byte |
| T45 | Per-seed accounts: expose `m/44'/60'/account'/0/0` so one seed covers multiple identities, which is the model that should be the default rather than 30 stored seeds | T43 | account selector on the wallet screen |
| T42 | Session model: when the passphrase clears (on lock, on timeout, on wallet switch) and how the UI shows which wallet is active | T38 | no path silently reuses a stale passphrase |

T41 is worth doing first and independently — it is a pure host test with no UI, it proves the
interop claim above rather than assuming it, and it will catch any future regression in the
derivation path.

### The security property that actually matters

You mentioned "a secure protocol, PIN protected." Be careful about what that buys you. Encrypting
the USB link defends against a malicious *observer* on the wire. It does nothing against the far
more likely threat: a **compromised host application** that shows you one transaction and sends
the device another.

The defense against that is not cryptographic, it is architectural: **what you see is what you
sign.** The device must decode the transaction itself — recipient, value, chain ID, and for
ERC-20/permit calls the decoded selector and arguments — render it on its own OLED, and require
a physical button press. Never sign an opaque 32-byte hash from the host in the normal flow.

This is why T12 (on-device decode) is marked critical-path and channel encryption is not. It is
also why `signHash` should be gated behind a "blind signing" setting that is off by default.

Practical consequence: a 128x64 OLED showing a 42-character address is your real UX constraint.
Design that screen early (T13) — it will feed back into the protocol.

---

## Workstreams

Five tracks that can run concurrently after the T0 gate. Roughly: A and B are firmware, C is the
shared TypeScript core, D is the apps, E is hardware/docs.

```
        ┌─ A. Firmware correctness ────────────┐
        │                                      │
 T0 ────┼─ B. Firmware security ───────────────┼──── T30 integration ──── PoC
        │                                      │
        ├─ C. Protocol + TS core ──────────────┤
        │                                      │
        ├─ D. Desktop + Android apps ──────────┤
        │                                      │
        └─ E. Hardware + docs (independent) ───┘
```

### Gate: T0 — test harness (blocks everything, ~1 day)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T0.1~~ ✅ | Fake NVS with crash injection + write/read ordering probe | — | `pin.c` runs on host; 9 test groups pass |
| T0.2 | Fake `esp_log`, GPIO, FreeRTOS queue shims | — | `ui.c` links on host |
| T0.3 | Fake `oled.c` → 128x64 bit buffer, ASCII dump | — | `assert_screen_contains()` works |
| T0.4 | Scripted button driver + golden-screen diffing | T0.2, T0.3 | a scripted PIN-entry session passes |
| T0.5 | CI: `make -C sim test` on push | T0.4 | red on the S3 test, green after its fix |

`sim/` already contains a working example (`test_mnemonic_entry.c`) and the Makefile.
Everything else in T0 follows its shape. **Do this first** — it is what makes the rest of the
plan parallelizable, because every other track can then be verified without competing for the
one physical board.

### Track A — firmware correctness (parallel after T0)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T1~~ ✅ | Fix mnemonic autocomplete ([S3](AUDIT.md)) — commit only on unique completion, use `mnemonic_word_completion_mask()` to constrain the letter selector | T0.1 | `test_mnemonic_entry` reports 0/2048 wrong |
| ~~T2~~ ✅ | Explicit PIN submit ([S2](AUDIT.md)); support 4-8 digits | T0.4 | golden test enters a 6-digit PIN |
| T3 | 24-word import ([S8d](AUDIT.md)) — word-count selector on entry screen | T1 | 24-word round-trip test passes |
| T4 | Implement "Change PIN" ([S8e](AUDIT.md)) — `pin_change()` already exists | T2 | re-encrypts wallets under the new PIN |
| T5 | Unified `device_wipe()`, idempotent + confirmation screen ([S7](AUDIT.md)) | T0.1 | crash-injection test leaves no half state |
| T6 | Wire the unused `screen_t.exit` hook; `memzero()` seed buffers ([S5](AUDIT.md)) | T0.2 | buffer is zero after leaving the screen |
| T7 | Error display separated from `eth_address.hex` ([S8a](AUDIT.md)) | T0.3 | error golden-screen differs from address |
| T43 | Account/address-index selector — the wallet core already derives any BIP44 path, the UI hardcodes index 0 | T0.3 | can view `m/44'/60'/0'/0/n` for arbitrary n |
| T44 | Faster word selector — verification costs up to 49 presses per word; a two-axis or coarse-jump selector would cut it | T0.4 | worst-case presses per word measured and reduced |
| T8 | Button queue backpressure ([S8j](AUDIT.md)) | T0.4 | no dropped events across a simulated 800 ms stall |

### Track B — firmware security (parallel after T0)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| T9 | **The vault** — salted PBKDF2 KDF, AES-GCM, flash encryption + secure boot. Full design and subtask breakdown in [docs/VAULT.md](docs/VAULT.md) ([S1](AUDIT.md)) | T0.1 | see VAULT.md T9a-T11c |
| ~~T10~~ ✅ | Attempt counter: persist before compare, sentinel for 0 ([S4](AUDIT.md)) | T0.1 | crash-injection test grants no free attempts |
| T11 | Flash encryption + secure boot v2 (must ship together — see [docs/VAULT.md](docs/VAULT.md)) | — | `read_flash` yields no plaintext; unsigned image refuses to boot |
| T11b | Migration path for wallets encrypted under the old KDF | T9 | existing device upgrades without seed loss |
| ~~T12~~ ✅ | On-device EIP-1559 decode, three-page confirmation, sign only what was displayed | T0.3 | 6 test groups on encoding and rendering; signs on hardware |
| T12b | ERC-20 transfer and approve decoding, and EIP-712 typed data | T12, T50 | a token transfer shows the contract address and amount |
| ~~T13~~ ✅ | Address and amount presentation: EIP-55 casing, one wei never rounds to zero, unknown chains show a number | T0.3 | covered by `sim/test_eth_tx.c` |
| T14 | AES-GCM instead of unauthenticated CBC ([S8h](AUDIT.md)) | T9 | tampered ciphertext is rejected |
| ~~T15~~ ✅ | Entropy gate ([S6](AUDIT.md)): bootloader RNG + SP 800-90B health tests, fails closed | — | `sim/test_entropy.c` green; **dieharder run on hardware still pending** |
| ~~T15b~~ ✅ | User entropy pool: button-timing collection screen, hashed with hardware entropy | T15 | 5 pool tests green; worst-case user cannot weaken output |
| T16 | Gate `signHash` behind a default-off blind-signing setting | T12 | off by default, warns when enabled |
| T51 | Chain-agnostic EVM: chain ID displayed on-device, per-chain RPC config in the app, Uniswap-format token lists (CoinGecko) as an app-side advisory layer with a small device-verified list of major contracts. See [PROTOCOL.md 6d](docs/PROTOCOL.md) | T50 | signs on two chains; a token transfer shows a contract address, not a host-supplied symbol |
| T50 | Define the decodable transaction set (native transfer, ERC-20 transfer/approve, EIP-712) and **refuse** anything outside it unless blind signing is on. See [PROTOCOL.md 6bis](docs/PROTOCOL.md) | T12 | undecodable calldata is refused with a clear reason, not shown as a hash |
| T17 | Strip Wi-Fi AP from release builds ([S8g](AUDIT.md)) | — | absent from the settings menu in release |

### Track C — protocol + shared core (parallel after T0, no firmware dependency)

Write the protocol spec first and both sides build against it simultaneously.

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T20~~ ✅ | **Protocol spec** → [docs/PROTOCOL.md](docs/PROTOCOL.md): framing, session/passkey, command set, passphrase-as-keyboard, errors | — | drafted; open questions listed at the end |
| ~~T21~~ ✅ | `@leekwallet/core`: framing, CBOR, session (X25519/HKDF/ChaCha20-Poly1305), device-state invalidation, viem adapter, mock device | T20 | 6 suites, no platform dependencies |
| ~~T22a~~ ✅ | Rust USB serial transport (`app/transport-serial/`), sync-marked framing, resynchronises past console text. Verified against hardware with `cargo run --bin leek-probe` | T21 | device answers ping/getFeatures/getStatus over the crate the app will use |
| ~~T22b~~ ✅ | Tauri command surface over the serial transport; the shell picks hardware when the backend is present and the mock otherwise | T22a | backend builds; frontend selects transport automatically |
| T22c | BLE transport (`btleplug`) for Android behind the same interface | T22a | identical results over both channels |
| ~~T23~~ ✅ | **Mock device** implementing the protocol: session, permission tiers, confirmations, rejection, latency | T20 | 10 test groups green; UI can be built with no hardware |
| T48 | Transaction interpretation in the app (Rabby-style), with unlimited-approval warnings and local selector DB. Advisory only — see [PROTOCOL.md 6c](docs/PROTOCOL.md) | T24 | ERC-20 transfer and approve decoded and labelled as a preview |
| T49 | WalletConnect project ID: bundled default plus a user override in settings | T32 | app works out of the box and can be pointed at your own project |
| ~~T24~~ ✅ | viem `toAccount()` adapter — structured fields only, never a serialised payload | T21 | 5 test groups; drops into any walletClient |
| T25 | Firmware: BLE GATT service + protocol dispatcher | T20 | echoes a ping from a phone |
| ~~T25b~~ ✅ | Firmware protocol endpoint over USB-Serial-JTAG, sync-marked so it shares the console port. `scripts/probe-device.py` talks to it | T20 | ping/getFeatures/getStatus answered on hardware; key commands correctly refused |
| ~~T25c~~ ✅ | Session layer wired in: X25519 handshake, on-device passkey comparison screen, encrypted frames, `getAddress` behind a confirmed session | T25b | handshake works on hardware; key commands refused without confirmation |
| T56 | Configurable BLE device name, as Ledger allows. Affects advertising, so it is also a privacy control: a name is broadcast to anyone scanning | T25 | name set on-device, persists, appears in the advertisement |
| T26 | Conformance suite against mock, BLE firmware, USB firmware | T23, T25, T25b | all three identical — this is what keeps the two transports honest |

T23 is the highest-leverage item in the plan: it decouples Track D from all firmware work.

### Track D — Tauri apps (parallel after T20 + T23)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| T27a | Design tokens from [docs/DESIGN.md](docs/DESIGN.md) as CSS custom properties + base components (button, field, address, status bar) | — | renders at all 4 breakpoints, both themes |
| T27b | Tauri v2 shell, desktop targets, capability allowlist | — | empty app builds on Linux |
| ~~T27c~~ ✅ | Discovery, pairing with passkey comparison, unlock, address list, signing — against the mock and against hardware | T22, T23, T27a | verified end to end on a real device |
| T28 | Transaction construction + send flow (viem) | T24, T27a | testnet transfer signed by the mock |
| T29 | Android target: `tauri android init`, build, sign | T27b | APK runs on a device |
| T30 | Android BLE: runtime permissions (`BLUETOOTH_SCAN`/`CONNECT`, location on older APIs), scan/pair flow, reconnect handling | T22, T29 | phone connects and survives a backgrounding |
| T31 | Screen-reader labels, keyboard traversal, contrast audit | T27c, T28 | pre-delivery checklist passes |
| T32 | WalletConnect v2 pairing (URI + QR), session list, pending-request view. **No in-app dapp browser** — see [PROTOCOL.md 6b](docs/PROTOCOL.md) | T28 | signs a request from a real dapp in the user's own browser |
| T46 | Address enumeration in the app: derive and list addresses so the user picks there, Ledger-behind-Rabby style | T24 | list of 10 addresses with balances, selection drives the signing path |
| T47 | Show the signing *source* address on the device confirmation, not just the destination | T12 | a host naming a different path is visible on screen |

T30 is still the riskiest item — Android BLE permissions and background/reconnect behaviour are
device- and OEM-specific, and none of it can be validated against the mock. But it is now
*only* BLE: the USB host-mode work is gone entirely.

### Track E — hardware + docs (fully independent, start now)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| T33 | Decide 4 MB vs N16R8; update `platformio.ini` + `partitions.csv` together | — | chosen target builds and boots |
| T34 | Enclosure / physical form | T33 | printable |
| T35 | Add the missing `docs/leekwallet-logo.png` | — | README image resolves |
| T36 | Assembly guide with photos | T33 | someone else can build one |
| T37 | Reproducible builds + release signing | — | two machines produce identical binaries |

---

## Other coins: possible, not planned

**EVM only for now.** The items below are recorded so the door stays open, not
because they are scheduled. None of them should start before flash encryption
(T11) and on-device transaction decode (T12) are done — a second coin on an
insecure vault is two insecure wallets.

### Do not copy Ledger's app model

Ledger loads a separate app per coin onto the device. That architecture exists
because the Nano S had 320 KB of flash and could not hold everything at once. It
is an answer to a constraint we do not share: our app partition is 4 MB and the
current firmware uses 1.09 MB, about 26%.

Copying it would mean building an app loader with memory isolation and per-app
signature verification — a security-critical component, and a large new attack
surface, bought to solve a problem we do not have. **One firmware with per-coin
modules compiled in is simpler and safer here.**

If separation is ever wanted, build-time variants (`leek-evm.bin`,
`leek-btc.bin`) give most of the benefit for none of the risk: the user flashes
what they need and unused code is not merely unreachable but absent.

### Rough order, easiest first

| Coin | Difficulty | What is already vendored | What is missing |
|---|---|---|---|
| **Solana** | Moderate | `ed25519` in trezor-crypto | Base58 addresses (have `base58.c`), transaction format, no UTXO model to handle |
| **Bitcoin** | Harder | `secp256k1`, `segwit_addr.c`, `script.c`, `base58.c` | PSBT parsing, multi-input signing, and change-output verification — the device must prove a change address is its own or a host can steal the change |
| **Monero** | **Much harder** | `ed25519` only | Ring signatures, Bulletproofs, view/spend key split, subaddresses, and a multi-round protocol with the host. Ledger's and Trezor's Monero apps are among their largest. Not a weekend. |

Bitcoin's real cost is not the curve, it is the UTXO model: change-output
verification is a class of bug that does not exist in EVM, and getting it wrong
sends your change to an attacker. Solana is the natural second coin.

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| T52 | Coin abstraction layer: derivation, address format and signing behind one interface, EVM as the first implementation | T12 | adding a coin touches no shared code |
| T53 | Solana support | T52 | signs a testnet transfer |
| T54 | Bitcoin support, including change-output verification | T52 | signs a testnet PSBT; a foreign change address is refused |
| T55 | Monero — research spike first, scope before committing | T54 | a written assessment, not code |

## Critical path to the PoC

Everything else is parallel decoration around this chain:

**T0 → T20 → T23 → (T25 ∥ T27) → T12 → T24 → T28 → end-to-end signed testnet transaction**

The two items most likely to slip are **T12** (on-device decode — the screen is small and the
data is not) and **T30** (the Android plugin — the only piece with no mock).

## Progress

Done: **T0.1** (fake NVS with crash injection and an I/O-ordering probe), **T1** (import fixed —
2048/2048 words enterable), **T2** (explicit PIN submit, 4-8 digits), **T10** (attempt counter
hardened, interrupted wipe resumes on boot).

Firmware: 34.4% flash, 14.2% RAM.

Next, mutually independent — different files, any order, safe in parallel:
**T20** (protocol spec — unblocks all of Track C and D),
**T3** (12/24-word selector; the entry module already handles 24, it needs a screen),
**T41** (passphrase interop vectors — pure host test, no UI, proves the BIP39 claim),
**T27a** (design tokens + base components from [docs/DESIGN.md](docs/DESIGN.md)).

## Suggested first week

Day 1 is T0. Then, if you have people to spread across it:

- **T1** (import is 50/50 broken today, contained fix, immediately visible win)
- **T20** (unblocks the entire TS side; costs a document, not code)
- **T33** (settle the hardware target before anyone tunes partitions)

If you are working alone, that same order still holds — T1 is a morning, T20 is an afternoon,
and after those two the rest of the plan stops being sequential.
