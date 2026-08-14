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

> **Superseded by what shipped.** Both platforms now build both transports:
> desktop has USB (`serialport`) and BLE (`btleplug`), and Android has both too
> (`tauri-plugin-blec` for T30, `tauri-plugin-serialplugin` for T59) — built and
> packaged into an APK, but never run on a phone. The
> reasoning below is kept because it is why the *device* exposes one link at a
> time (T57) and why the `Transport` trait exists — which is exactly what made
> adding the second one configuration rather than rework, as the last paragraph
> of this section predicted.

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
| ~~T39b~~ ✅ | Add the master XFP alongside the address, as Coldcard does — shorter to write down than 42 hex characters | T39 | the XFP renders on the wallet screen and both passphrase confirmations, cached per derivation, checked against two published vectors in `sim/test_xfp.c` |
| T40 | Host-side passphrase entry over the protocol, marked as the lower-security path | T20, T38 | **Wire done, UI not**: `setPassphrase` is dispatched by the firmware (`src/protocol.c`) and answered by the mock (`app/packages/core/src/mock-device.ts`), and the app reads back whether one is applied. Nothing in the app *sends* one, so the lower-security path is unreachable — and unlabelled, which is the half that matters |
| ~~T41~~ ✅ | Interop vectors: BIP39 known-answer seeds with and without passphrase | — | `sim/test_passphrase.c`, both spec vectors match byte-for-byte |
| ~~T45~~ ✅ | Per-seed accounts: expose `m/44'/60'/account'/0/0` so one seed covers multiple identities, which is the model that should be the default rather than 30 stored seeds | T43 | accounts 0-9 in Settings, persisted; the wire is bounded only at 2^31 because a host asking for account 12 wants a real wallet; every confirmation renders the full path, which is T47's argument made stronger |
| ~~T42~~ ✅ | Session model: when the passphrase clears (on lock, on timeout, on wallet switch) and how the UI shows which wallet is active | T38 | one `lock_device()` is the only thing that locks; a host passphrase dies with its session; the wallet screen re-derives rather than showing an address the device would no longer produce. Four per-path lock tests, five mutants |

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
| ~~T0.2~~ ✅ | Fake `esp_log`, GPIO, FreeRTOS queue shims | — | `ui.c` links on host |
| ~~T0.3~~ ✅ | Fake `oled.c` → 128x64 bit buffer, ASCII dump | — | `fake_oled_row_contains()` works; text is asserted as text, pixels kept secondary |
| ~~T0.4~~ ✅ | Scripted button driver + golden-screen diffing | T0.2, T0.3 | `sim/test_ui.c`, 11 groups; scripted PIN and import sessions pass |
| ~~T0.5~~ ✅ | CI: `make -C sim test` on push | T0.4 | `scripts/check.sh` runs host suites, app tests, typecheck and the firmware build; `.github/workflows/ci.yml` calls the same script in three jobs. **The workflow has never run** — this repo has no remote yet, so only the script itself is verified, including that it exits non-zero on failure |

`sim/` already contains a working example (`test_mnemonic_entry.c`) and the Makefile.
Everything else in T0 follows its shape. **Do this first** — it is what makes the rest of the
plan parallelizable, because every other track can then be verified without competing for the
one physical board.

### Track A — firmware correctness (parallel after T0)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T1~~ ✅ | Fix mnemonic autocomplete ([S3](AUDIT.md)) — commit only on unique completion, use `mnemonic_word_completion_mask()` to constrain the letter selector | T0.1 | `test_mnemonic_entry` reports 0/2048 wrong |
| ~~T2~~ ✅ | Explicit PIN submit ([S2](AUDIT.md)); support 4-8 digits | T0.4 | golden test enters a 6-digit PIN |
| ~~T3~~ ✅ | 24-word import ([S8d](AUDIT.md)) — word-count selector on entry screen | T1 | 24-word round-trip test passes; a length prompt precedes typing, BACK returns to it |
| ~~T4~~ ✅ | Implement "Change PIN" ([S8e](AUDIT.md)) — `pin_change()` already exists | T2 | re-encrypts wallets under the new PIN, atomically: generation-scoped slots and one blob carrying both the generation and the verifier. Crash-swept at all 132 write points in each of the normal and legacy layouts |
| ~~T5~~ ✅ | Unified `device_wipe()`, idempotent + confirmation screen ([S7](AUDIT.md)) | T0.1 | crash-injection test leaves no half state — `sim/test_device_wipe.c`, 7 groups, marker + resume-on-boot |
| ~~T6~~ ✅ | Wire the unused `screen_t.exit` hook; `memzero()` seed buffers ([S5](AUDIT.md)) | T0.2 | buffer is zero after leaving the screen, and *not* zeroed across the display ↔ verify hand-off; removing the hook fails 6 assertions, over-correcting fails 9 |
| ~~T7~~ ✅ | Error display separated from `eth_address.hex` ([S8a](AUDIT.md)) | T0.3 | error screen says "Error" and names the reason; QR refuses to encode anything that is not a 42-character address |
| ~~T43~~ ✅ | Account/address-index selector — the wallet core already derives any BIP44 path, the UI hardcoded index 0 | T0.3 | UP/DOWN on the address screen walk `m/44'/60'/0'/0/0..9` (`ADDRESS_INDEX_COUNT`, `screen_wallet_info_on_button` in `src/ui.c`), the title shows which, and switching wallets resets to 0. **Bounded at ten, not arbitrary n**: ten is what fits a menu with two buttons and matches what the app enumerates. The *account* level is still fixed at `0'` — that is T45 |
| ~~T44~~ ✅ | Faster word selector: letters offered as coarse blocks, and the selector switches to whole candidate words once ≤8 still match | T0.4 | measured over all 2048 words in `sim/test_mnemonic_entry.c`: worst case 38 → 19 presses, average 19.8 → 12.0, with both figures budgeted so a regression fails the suite |
| ~~T8~~ ✅ | Button queue backpressure ([S8j](AUDIT.md)) | T0.4 | no dropped events across a simulated 800 ms stall; queue size derived from the stall budget and the debounce floor, overflow drops the oldest and is counted |

### Track B — firmware security (parallel after T0)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| T9 | **The vault** — salted PBKDF2 KDF, AES-GCM, flash encryption + secure boot. Full design and subtask breakdown in [docs/VAULT.md](docs/VAULT.md) ([S1](AUDIT.md)) | T0.1 | **Two thirds done**: the KDF (`components/leek-wallet/vault-kdf.c`, per-device salt, domain-separated key and verifier) and authenticated storage (T14) are in and tested. Flash encryption and secure boot are T11, and they are the part S1 turns on |
| ~~T10~~ ✅ | Attempt counter: persist before compare, sentinel for 0 ([S4](AUDIT.md)) | T0.1 | crash-injection test grants no free attempts |
| T11 | Flash encryption + secure boot v2 (must ship together — see [docs/VAULT.md](docs/VAULT.md)). Proven end-to-end in QEMU; the hardware burn is written up in [docs/BURN-PROCEDURE.md](docs/BURN-PROCEDURE.md) and **not yet executed** | — | `read_flash` yields no plaintext *on a real board*; unsigned image refuses to boot |
| ~~T11b~~ ✅ | Migration path for wallets encrypted under the old KDF | T9 | `migrate_vault_to_current()` in `components/leek-wallet/leek-wallet.c` re-encrypts one wallet at a time on the first successful unlock, flips the version marker last, and resumes rather than bricking if it is interrupted. Verified on hardware: a device holding three v2 wallets migrated on unlock and derived the same addresses afterwards ([S8h](AUDIT.md)) |
| ~~T12~~ ✅ | On-device EIP-1559 decode, three-page confirmation, sign only what was displayed | T0.3 | 6 test groups on encoding and rendering; signs on hardware |
| T12b | ERC-20 transfer and approve decoding ✅, and EIP-712 typed data (pending — needs a `signTypedData` command first) | T12, T50 | a token transfer shows the contract address and amount |
| ~~T13~~ ✅ | Address and amount presentation: EIP-55 casing, one wei never rounds to zero, unknown chains show a number | T0.3 | covered by `sim/test_eth_tx.c` |
| ~~T14~~ ✅ | AES-GCM instead of unauthenticated CBC ([S8h](AUDIT.md)) | T9 | `components/leek-wallet/vault-crypt.c`: AES-256-GCM, `nonce ‖ ciphertext ‖ tag`, nonce generated internally so a caller cannot reuse one. `sim/test_vault_crypt.c` flips a single bit in each of the three parts and all three are rejected. Shipped as storage format v3 |
| ~~T15~~ ✅ | Entropy gate ([S6](AUDIT.md)): bootloader RNG + SP 800-90B health tests, fails closed | — | `sim/test_entropy.c` green; **dieharder run on hardware still pending** |
| ~~T15b~~ ✅ | User entropy pool: button-timing collection screen, hashed with hardware entropy | T15 | 5 pool tests green; worst-case user cannot weaken output |
| ~~T16~~ ✅ | Default-off, on-device-only blind-signing setting: permits signing calldata the device cannot decode, and nothing else. See [PROTOCOL.md 6bis](docs/PROTOCOL.md) | T12 | `src/blind-signing.c`; off by default and persisted, five presses behind a warning screen, no command can change it, `getFeatures` reports the real state. Contract creation, oversized calldata and unrenderable messages stay refused. When `signHash` lands it gates on this same setting |
| ~~T51~~ ✅ | Chain-agnostic EVM: chain ID displayed on-device, per-chain RPC config in the app, Uniswap-format token lists (CoinGecko) as an app-side advisory layer with a small device-verified list of major contracts. See [PROTOCOL.md 6d](docs/PROTOCOL.md) | T50 | signs on two chains; a token transfer shows a contract address, not a host-supplied symbol |
| ~~T50~~ ✅ | Define the decodable transaction set (native transfer, ERC-20 transfer/approve, EIP-712) and **refuse** anything outside it unless blind signing is on. See [PROTOCOL.md 6bis](docs/PROTOCOL.md) | T12 | `sim/test_eth_decode.c` + `eth-decode.test.ts`; `0x0202` before any prompt, and the mock refuses identically. EIP-712 waits on a `signTypedData` command |
| ~~T17~~ ✅ | Strip Wi-Fi AP from release builds ([S8g](AUDIT.md)) | — | absent from the settings menu in release; 43 KB of flash and 480 bytes of RAM back. `pio run -e esp32s3-wifi` still builds it for testing |

### Track C — protocol + shared core (parallel after T0, no firmware dependency)

Write the protocol spec first and both sides build against it simultaneously.

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T20~~ ✅ | **Protocol spec** → [docs/PROTOCOL.md](docs/PROTOCOL.md): framing, session/passkey, command set, passphrase-as-keyboard, errors | — | drafted; open questions listed at the end |
| ~~T21~~ ✅ | `@leekwallet/core`: framing, CBOR, session (X25519/HKDF/ChaCha20-Poly1305), device-state invalidation, viem adapter, mock device | T20 | 6 suites, no platform dependencies |
| ~~T22a~~ ✅ | Rust USB serial transport (`app/transport-serial/`), sync-marked framing, resynchronises past console text. Verified against hardware with `cargo run --bin leek-probe` | T21 | device answers ping/getFeatures/getStatus over the crate the app will use |
| ~~T22b~~ ✅ | Tauri command surface over the serial transport; the shell picks hardware when the backend is present and the mock otherwise | T22a | backend builds; frontend selects transport automatically |
| ~~T22c~~ ✅ | BLE transport (`btleplug`) for Android behind the same interface | T22a | identical results over both channels — desktop proven end to end; Android still needs the JVM driver class (T30) |
| ~~T23~~ ✅ | **Mock device** implementing the protocol: session, permission tiers, confirmations, rejection, latency | T20 | 10 test groups green; UI can be built with no hardware |
| ~~T48~~ ✅ | Transaction interpretation in the app (Rabby-style), with unlimited-approval warnings and local selector DB. Advisory only — see [PROTOCOL.md 6c](docs/PROTOCOL.md) | T24 | ERC-20 transfer and approve decoded and labelled as a preview; addresses render EIP-55 to match the device screen |
| T49 | WalletConnect project ID: bundled default plus a user override in settings | T32 | **Override done, bundled default deliberately not**: `app/src/wc/project-id.ts` takes an ID in settings, validates its 32 hex characters so a paste error is caught there, and persists it. `BUNDLED_PROJECT_ID` is empty on purpose — an ID is issued to a person and rate-limited per ID, so committing one would be either a fake string that fails at the relay or somebody else's quota. So it does *not* work out of the box, and says so instead of failing at connect time. Whoever ships a build fills it in |
| ~~T24~~ ✅ | viem `toAccount()` adapter — structured fields only, never a serialised payload | T21 | 5 test groups; drops into any walletClient |
| ~~T25~~ ✅ | Firmware: BLE GATT service + protocol dispatcher. `src/ble.c` (NimBLE) + `src/ble-chunk.c`; the same `protocol_handle_frame()` the cable uses, no marker on BLE, chunked to the negotiated MTU | T20 | ping answered over GATT; chunking verified against `chunkForBle` at MTU 23 and 244 in `sim/test_ble_chunk.c` |
| ~~T57~~ ✅ | **One transport at a time**: a device setting selecting USB or BLE, with the unselected one fully off and any session torn down on switch. See [PROTOCOL.md 3b](docs/PROTOCOL.md) | T25 | both cannot be reachable simultaneously; BLE does not advertise when USB is selected. `src/transport.c` is the only door to either; Settings → Link toggles it, default USB, and a switch tears the session down |
| ~~T25b~~ ✅ | Firmware protocol endpoint over USB-Serial-JTAG, sync-marked so it shares the console port. `scripts/probe-device.py` talks to it | T20 | ping/getFeatures/getStatus answered on hardware; key commands correctly refused |
| ~~T25c~~ ✅ | Session layer wired in: X25519 handshake, on-device passkey comparison screen, encrypted frames, `getAddress` behind a confirmed session | T25b | handshake works on hardware; key commands refused without confirmation |
| ~~T56~~ ✅ | Configurable BLE device name, as Ledger allows. Affects advertising, so it is also a privacy control: a name is broadcast to anyone scanning | T25 | name set on-device, persists, appears in the advertisement. Settings → BLE Name; `src/ble-name.c` bounds it at 29 bytes, the scan-response limit, and REFUSES anything longer rather than truncating — an over-long name would make `ble_gap_adv_rsp_set_fields()` reject the lot and the radio would silently never advertise |
| T26 | Conformance suite against mock, BLE firmware, USB firmware | T23, T25, T25b | all three identical — this is what keeps the two transports honest. **USB and BLE done**: `sim/test_protocol.c` runs the real `protocol.c` on the host and found 12 divergences ([PROTOCOL.md 6e](docs/PROTOCOL.md)); every conformance case now runs down BOTH channels and the replies are compared, after `getMnemonic` was answered on the cable and silently dropped on the radio. Mock still outstanding |

T23 is the highest-leverage item in the plan: it decouples Track D from all firmware work.

### Track D — Tauri apps (parallel after T20 + T23)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T27a~~ ✅ | Design tokens from [docs/DESIGN.md](docs/DESIGN.md) as CSS custom properties + base components (button, field, address, status bar) | — | `app/src/tokens.css` is the single source of colour, space and size; dark applies on both an explicit `data-theme` and `prefers-color-scheme`, and `prefers-reduced-motion` is honoured. `styles.css` carries the phone, tablet, desktop and coarse-pointer breakpoints |
| ~~T27b~~ ✅ | Tauri v2 shell, desktop targets, capability allowlist | — | `app/src-tauri/` builds on Linux; `capabilities/default.json` is the whole invokable surface, which is what Tauri was chosen for. Exercised end to end against hardware by T27c |
| ~~T27c~~ ✅ | Discovery, pairing with passkey comparison, unlock, address list, signing — against the mock and against hardware | T22, T23, T27a | verified end to end on a real device |
| ~~T28~~ ✅ | Transaction construction + send flow (viem) | T24, T27a | past the done-condition: not the mock but a real device, and not only a transfer. `signPlannedTransaction()` in `app/src/main.ts` builds, signs and optionally broadcasts, refusing to broadcast to a chain other than the one signed for. Sepolia transfer `0xa035de1c…` and the Aave faucet call under T32 |
| ~~T29~~ ✅ | Android target: `tauri android init`, build, sign | T27b | APK builds; see `app/ANDROID.md`. Never installed on a phone yet |
| ~~T30~~ ✅ | Android BLE: runtime permissions (`BLUETOOTH_SCAN`/`CONNECT`, location on older APIs), scan/pair flow, reconnect handling | T22, T29 | `tauri-plugin-blec`; permissions requested at first scan, denial and adapter-off are distinct errors; BLE signed a real transaction from a tablet |
| T31 | Screen-reader labels, keyboard traversal, contrast audit | T27c, T28 | pre-delivery checklist passes |
| ~~T32~~ ✅ | WalletConnect v2 pairing (URI + QR), session list, pending-request view. **No in-app dapp browser** — see [PROTOCOL.md 6b](docs/PROTOCOL.md) | T28 | signs a request from a real dapp in the user's own browser — Aave's Base Sepolia faucet, `0x48696ca6…`, decoded and confirmed on-device, no blind signing |
| T46 | Address enumeration in the app: derive and list addresses so the user picks there, Ledger-behind-Rabby style | T24 | **Listing and selection done, balances not**: `loadAddresses()` in `app/src/main.ts` derives `m/44'/60'/0'/0/0..9`, lists them, and the selection drives the signing path (with a generation counter so a second run cannot append to a list it no longer owns). No balance is fetched, so picking an address is still done by index rather than by what is in it |
| ~~T47~~ ✅ | Show the signing *source* address on the device confirmation, not just the destination | T12 | the full checksummed address is rendered, derived on the protocol task at the signing path |

T30 is still the riskiest item — Android BLE permissions and background/reconnect behaviour are
device- and OEM-specific, and none of it can be validated against the mock. But it is now
*only* BLE: the USB host-mode work is gone entirely.

### Track E — hardware + docs (fully independent, start now)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T33~~ ✅ | Decide 4 MB vs N16R8; update `platformio.ini` + `partitions.csv` together | — | settled on **16 MB flash, no PSRAM**, which is what the development board reports. `board_build.flash_size = 16MB` and `partitions.csv` (4 MB app, 24 KB nvs) agree, and the firmware builds and boots on it. PSRAM stays off — it is broken under QEMU, which the test strategy depends on. The comment block at the top of `platformio.ini` still says 4 MB and is wrong |
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
| T58 | **Airgapped QR signing.** Needs a camera; the display half already exists (`src/qrcode.c`). Unlocks two things at once: a genuine airgap — the device never electrically touches the host — and MetaMask's QR keyring, which [BROWSER-INTEGRATION.md](docs/BROWSER-INTEGRATION.md) found is the one route into MetaMask open to any vendor without their cooperation, and which was ranked out *solely* for lack of a camera. Needs animated QR (UR / BC-UR, as Keystone uses): a 128x64 screen caps a single frame near version 10-14, far short of a signed EIP-1559 transaction | T12 | a transaction is signed with no cable and no radio, and MetaMask drives it |
| T58a | Research spike before committing: verify ERC-4527's current shape and the UR encoding, and **measure** whether decode fits in RAM at a usable frame rate. A camera that cannot decode fast enough to be pleasant is worse than none. A scanner module that decodes onboard and speaks UART/I2C sidesteps the framebuffer and the decoder entirely and should be costed first | — | measured, not assumed |
| T58c | PSRAM is present and deliberately off. `esptool` reports 8 MB embedded on the attached board; the config had disabled it under a comment describing a Mini that has none. External memory is a separate die, and a seed the allocator spills there is reachable in ways internal SRAM is not — with the S3's external-memory encryption riding on T11. Enable only when something needs the space, with secrets pinned `MALLOC_CAP_INTERNAL`. Octal PSRAM also takes GPIO35/36/37 | T11 | enabled with a test that no secret allocation lands off-die |
| T58b | Costed hardware for T58: prefer a **scanner module that decodes onboard** and speaks UART or I2C — GM65/GM66/GM77 (UART, ~4 pins), M5Stack QR Unit or DFRobot Gravity (plug connectors, no soldering), Tiny Code Reader (I2C, 4 pins). A raw DVP camera (OV2640, 16+ pins) needs a framebuffer and a decoder on a core that has neither to spare. **Check the module's continuous scan rate before buying**: animated QR streams frames, and a trigger-per-scan module makes airgapped signing miserable | T58a | a module chosen against a measured frame rate |
| ~~T60~~ ✅ | Two-level selector for **passphrase** entry, reusing T44's work in `text-entry.c`. Still 13.6 presses per character, so a 17-character passphrase costs 231 presses — and a passphrase is typed far more often than a seed, which is where the selector's complexity actually pays | T44 | 13.6 → 12.1 presses per character on the flat ring; blocks measured at 6.8 but deliberately not applied to the passphrase (three levels of navigation on four buttons), reported worse on hardware |
| ~~T61~~ ✅ | Tidy the entropy screen: ACCEPT doubles as a sample before the target is met, which muddles "collect" and "proceed". **Not** a security fix — the pool is mixed with the hardware RNG and can only add (`entropy_mix_pool`), so no number of presses changes the seed's strength. Button chords were considered and rejected: the pool's value is timing jitter between presses, so fewer richer presses collect less, not more | — | UP/DOWN collect, CANCEL abandons, ACCEPT only ever proceeds and is drawn `----` until the target is met |
| T62 | Camera noise as an extra entropy input, **mixed never substituted**, if T58 lands. Conservative extraction only — raw pixels from a lens pointed at a white wall are not random, and the source is attacker-influenceable in a way the RNG is not. Nice-to-have: the seed is already full strength without it | T58 | mixed through `entropy_mix_pool`, with a test that a degenerate camera cannot weaken the output |
| ~~T59~~ ✅ | **USB transport on Android**, alongside BLE. Android cannot open `/dev/ttyACM*` unrooted; it needs the USB Host API through a Kotlin driver. The route is the one T30 proved — a Tauri mobile plugin whose Gradle project `tauri-build` wires in automatically — not hand-rolled JNI. A cable takes the radio out of the threat model, which some users will prefer | T30 | `tauri-plugin-serialplugin` behind the T30 pattern; APK builds with both transports; one tap on Connect is one connection |

T59 is **built but unproven**: `tauri-plugin-serialplugin` 3.x is wired in, `transports()` answers
`["usb", "ble"]` on Android, and an arm64 APK builds with the plugin's Kotlin compiled and its
`device_filter.xml` packaged. No phone was attached, so no permission dialog, no enumeration and no
signature over a cable has been seen. Same standard as T30 — see `app/ANDROID.md`, "Known state".

## Critical path to the PoC

Everything else is parallel decoration around this chain:

**T0 → T20 → T23 → (T25 ∥ T27) → T12 → T24 → T28 → end-to-end signed testnet transaction**

The two items most likely to slip are **T12** (on-device decode — the screen is small and the
data is not) and **T30** (the Android plugin — the only piece with no mock).

## Where this stands

**A real Sepolia transaction has been signed and broadcast.** The chain that
had to work all at once — entropy, vault, derivation, display, approval,
signing, transport, session, encoding — works.

**And then again from a real dapp.** Aave's Base Sepolia faucet, in an ordinary
browser, over WalletConnect, over BLE, to a device on battery: `0x48696ca6…`,
`mint(address,address,uint256)` decoded and confirmed on the device's own
screen with blind signing off. Which also means the refusal path is real — the
same faucet was refused before its selector was in the decodable set.

What is still true: **flash encryption is not enabled**, so anyone holding the
device can read the vault off the chip and attack the PIN offline. That is the
one thing between this and real funds, and no amount of work elsewhere
substitutes for it.

### What hardware testing found that host tests could not

Recorded because it shaped the roadmap, and because the pattern will repeat:

| Bug | Why the suites missed it |
|---|---|
| Screen flicker on every keypress | Timing, not logic |
| Wallet metadata never loaded at boot | A deadlock between two correct components |
| Nonce counters desynchronised on any rejected frame | The mock never rejects |
| Address list re-derived itself into a loop | `setInterval` re-entrancy under real latency |
| Client sent `path`, firmware read `index` | The mock accepted both |
| **Two tasks sharing one derivation state** | **No test runs two FreeRTOS tasks** |

The last one signed a real transaction with a key nobody selected. It failed
safely only because that key held no funds.

Twice the mock was *more permissive than the device* and certified code that
could not work. Both times the fix was making the mock stricter.

## Progress

The T0 gate, all of Track A except T45, the protocol and both transports, the
mock, the viem adapter, the app and WalletConnect are done. The full host suite
is **18 files, all passing** (`make -C sim test`).

What is left, in the order it matters:

1. **T11** — flash encryption and secure boot. Rehearsed in QEMU, written up in
   [docs/BURN-PROCEDURE.md](docs/BURN-PROCEDURE.md), gated by
   `scripts/preflight-secure.sh`. No fuse has been burned. Nothing else on this
   list changes what a person holding the device can do.
2. **T30** — install the APK on a phone. Everything Android is currently
   verified by a compiler and nothing else.
3. **T26** — the mock leg of the conformance suite. USB and BLE already run
   against each other; the mock is the one that has twice certified code that
   could not work.
4. Then the smaller open rows: **T45** (accounts), **T46** (balances), **T40**
   (host passphrase entry), **T39b** (XFP on screen), **T12b** (EIP-712, which
   needs a `signTypedData` command first), **T31** (accessibility), **T35**
   (the missing logo), **T36**, **T37**.

Firmware size figures were removed rather than carried forward — the last ones
recorded predate the protocol, BLE and decoding work, and nobody has measured
since.
