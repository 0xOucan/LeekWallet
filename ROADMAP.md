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
| ~~T40~~ ✅ | Host-side passphrase entry over the protocol, marked as the lower-security path | T20, T38 | Companion UI shipped: on-device entry is described first and needs no control, host entry sits behind a closed disclosure whose warning is *inside* it — this app reads every character before encryption applies, so a compromised host learns the passphrase and the encrypted link does not change that. Validated to protocol.c's own bounds (printable ASCII, 1–63) before it is sent, cleared from the field in a `finally`, never logged, announced or put in diagnostics. Applying a passphrase invalidates derived state by hand, because passphrase→passphrase leaves the status boolean unchanged and `derivationsInvalidated()` cannot see it. Untested on hardware |
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
| ~~T12b~~ ✅ | ERC-20 transfer and approve decoding, and EIP-712 typed data | T12, T50 | a token transfer shows the contract address and amount. EIP-712 landed with `signTypedData`: `src/eip712.c` recomputes `keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct)` from the structure — never a host-supplied digest — and renders the domain and every leaf of the struct, nested ones flattened to `details.amount`. A Permit's spender, amount and deadline each get a page and an infinite allowance is named UNLIMITED rather than printed. Two refusals, and only one is policy: a document the device cannot **hash** (arrays, an undefined type, a value contradicting its declared type) stays refused however blind signing is set, because the only way past would be to take a digest from the host; a document it cannot **show** is the blind-signing case. `sim/test_eip712.c` drives the real firmware C against EIP-712's own `Mail` vector plus a Permit and a Permit2 `PermitSingle`, whose digests `app/packages/core/test/eip712.test.ts` recomputes with viem so the two implementations cannot drift onto the same wrong answer. The frame buffer went 512 → 1024 to fit the type definitions. **Never run on hardware** | **On hardware**: flashed and booted clean (no panic, KDF 2250 iters/508 ms), then the frame path measured over real USB-Serial-JTAG rather than argued about -- an 854-byte `signTypedData` request crosses intact and reaches dispatch, and the boundary is exact: **1024 accepted, 1025 dropped**, with the device answering `ping` afterwards, so an over-long length field is refused rather than trusted and does not wedge the parser. That closes the 1 KB-frame risk the frame bump introduced. **Signed on hardware**: a Snapshot vote, a real dapp's `eth_signTypedData_v4`, rendered on the device and accepted by the dapp -- the first EIP-712 signature this project has produced outside a test. Getting there cost a regression worth remembering: the 744-byte render struct is a local in `dispatch()`, so the compiler sized that frame for **every** method, and 4 KB of task stack was no longer enough for unlock's PBKDF2 and BIP32 work. The BLE task overflowed and rebooted the board mid-unlock, and what reached the user was "unlock failed: derivation failed" -- an error from wallet code that was working perfectly. Both request tasks are now 8 KB and `protocol_handle_frame()` warns while there is still stack left to warn with |
| ~~T12c~~ ✅ | Self-verifying signature table: bundled ABI signature strings, decoded from their declared types | T12b, T50 | The refusal that prompted it was real: a session on Base Sepolia signed two Aave approvals and was then refused Aave's own deposit (`supply`, `0x617ba037`) — the device understood the dangerous half of the pair and not the useful half. `src/eth-decode.c` now carries signature STRINGS and no selectors at all: a row is chosen only when `keccak256(signature)[0:4]` equals the selector being signed (`signature_matches()`, on the matching path rather than in an assertion, because an assertion can be compiled out). The table therefore certifies itself — a mistyped, corrupted or tampered string hashes elsewhere and matches nothing — so there is no signed descriptor, no key to run and no host to trust. This is CLEAR-SIGNING.md option (a) without the signature. Added: Aave V3 `supply`/`withdraw`/`borrow`/`repay`, ERC-721 `safeTransferFrom`, Permit2 `approve`. Static single-word ABI types only (`address`, `uint<N>`, `int<N>`, `bool`, `bytes<N>`); a dynamic type keeps the whole call refused rather than showing the arguments it did read. Every word is checked against its declared type, and UNLIMITED is judged against the argument's OWN width so Permit2's `2^160-1` gets the same wording an unlimited ERC-20 approve gets. The screen states its own limit — a verified name proves what a function is CALLED, never what it does, so the contract address keeps a page. Tests: the C suite hashes every row, confirms each matches its own hash and that a signature altered by one character matches nothing; the TypeScript mirror does the same; two conformance vectors (`supply` signs, `supply` with an over-wide `uint16` is `0x0202`) diff the mock against the real protocol.c; ten new mutants, all killed. Stack: `dispatch()` 1600 → 1648 bytes, `sizeof(EthCall)` 96 → 136 — argument values are read back out of the caller's calldata rather than copied, which is what keeps it to 48 bytes on the 8 KB task. **Never run on hardware** | **On hardware, against a live Aave session**: the refused `0x617ba037` now decodes, is confirmed page by page on the device, and mined (block 45605909). The companion's approval cap was exercised on the same session -- 1505 USDC approved, 1500 supplied, block 45608095 -- with the two-transaction zero-first sequence run separately against a standing allowance |
| ~~T12d~~ ✅ | Editable approval cap in the companion: replace a dapp's amount before it reaches the device | T12c | Aave never offers a custom amount, so the wallet is the only place the control can exist. The device stays the authority -- it decodes the *re-encoded* call, so the capped figure is confirmed on its own screen. Three things were only learnable from a real session: tokens of the USDT kind refuse a non-zero to non-zero `approve`, so a standing allowance is zeroed first and signed as two transactions with nonces assigned here rather than re-read (a second read returns the same nonce and the cap would *replace* the zero, leaving zero); a failed allowance read is never treated as zero, because that assumption is the silent revert; and **an allowance exactly equal to the spend is refused by dapps that check with any margin** -- Aave blocked a 150 supply against exactly 150 and accepted it against 160, so the notice tells the reader to approve above the spend and reload the dapp, which does not re-read allowances live |
| ~~T13~~ ✅ | Address and amount presentation: EIP-55 casing, one wei never rounds to zero, unknown chains show a number | T0.3 | covered by `sim/test_eth_tx.c` |
| ~~T14~~ ✅ | AES-GCM instead of unauthenticated CBC ([S8h](AUDIT.md)) | T9 | `components/leek-wallet/vault-crypt.c`: AES-256-GCM, `nonce ‖ ciphertext ‖ tag`, nonce generated internally so a caller cannot reuse one. `sim/test_vault_crypt.c` flips a single bit in each of the three parts and all three are rejected. Shipped as storage format v3 |
| ~~T15~~ ✅ | Entropy gate ([S6](AUDIT.md)): bootloader RNG + SP 800-90B health tests, fails closed | — | `sim/test_entropy.c` green; **dieharder run on hardware still pending** |
| ~~T15b~~ ✅ | User entropy pool: button-timing collection screen, hashed with hardware entropy | T15 | 5 pool tests green; worst-case user cannot weaken output |
| ~~T16~~ ✅ | Default-off, on-device-only blind-signing setting: permits signing calldata the device cannot decode, and nothing else. See [PROTOCOL.md 6bis](docs/PROTOCOL.md) | T12 | `src/blind-signing.c`; off by default and persisted, five presses behind a warning screen, no command can change it, `getFeatures` reports the real state. Contract creation, oversized calldata and unrenderable messages stay refused. When `signHash` lands it gates on this same setting |
| ~~T51~~ ✅ | Chain-agnostic EVM: chain ID displayed on-device, per-chain RPC config in the app, Uniswap-format token lists (CoinGecko) as an app-side advisory layer with a small device-verified list of major contracts. See [PROTOCOL.md 6d](docs/PROTOCOL.md) | T50 | signs on two chains; a token transfer shows a contract address, not a host-supplied symbol |
| ~~T50~~ ✅ | Define the decodable transaction set (native transfer, ERC-20 transfer/approve, EIP-712) and **refuse** anything outside it unless blind signing is on. See [PROTOCOL.md 6bis](docs/PROTOCOL.md) | T12 | `sim/test_eth_decode.c` + `eth-decode.test.ts`; `0x0202` before any prompt, and the mock refuses identically. EIP-712 landed under T12b |
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
| ~~T49~~ ✅ | WalletConnect project ID: bundled default plus a user override in settings | T32 | `project-id.ts` resolves the user override first, then `BUNDLED_PROJECT_ID`, which holds this project's own ID, so pairing works out of the box. The override validates its 32 hex characters so a paste error is caught there rather than at the relay. A fork should replace the bundled value: quota is per ID, and borrowing one means somebody else's runs out |
| ~~T24~~ ✅ | viem `toAccount()` adapter — structured fields only, never a serialised payload | T21 | 5 test groups; drops into any walletClient |
| ~~T25~~ ✅ | Firmware: BLE GATT service + protocol dispatcher. `src/ble.c` (NimBLE) + `src/ble-chunk.c`; the same `protocol_handle_frame()` the cable uses, no marker on BLE, chunked to the negotiated MTU | T20 | ping answered over GATT; chunking verified against `chunkForBle` at MTU 23 and 244 in `sim/test_ble_chunk.c` |
| ~~T57~~ ✅ | **One transport at a time**: a device setting selecting USB or BLE, with the unselected one fully off and any session torn down on switch. See [PROTOCOL.md 3b](docs/PROTOCOL.md) | T25 | both cannot be reachable simultaneously; BLE does not advertise when USB is selected. `src/transport.c` is the only door to either; Settings → Link toggles it, default USB, and a switch tears the session down |
| ~~T25b~~ ✅ | Firmware protocol endpoint over USB-Serial-JTAG, sync-marked so it shares the console port. `scripts/probe-device.py` talks to it | T20 | ping/getFeatures/getStatus answered on hardware; key commands correctly refused |
| ~~T25c~~ ✅ | Session layer wired in: X25519 handshake, on-device passkey comparison screen, encrypted frames, `getAddress` behind a confirmed session | T25b | handshake works on hardware; key commands refused without confirmation |
| ~~T56~~ ✅ | Configurable BLE device name, as Ledger allows. Affects advertising, so it is also a privacy control: a name is broadcast to anyone scanning | T25 | name set on-device, persists, appears in the advertisement. Settings → BLE Name; `src/ble-name.c` bounds it at 29 bytes, the scan-response limit, and REFUSES anything longer rather than truncating — an over-long name would make `ble_gap_adv_rsp_set_fields()` reject the lot and the radio would silently never advertise |
| ~~T26~~ ✅ | Conformance suite against mock, BLE firmware, USB firmware | T23, T25, T25b | all three identical, and compared by machine rather than by document. **USB and BLE**: `sim/test_protocol.c` runs the real `protocol.c` on the host and found 12 divergences ([PROTOCOL.md 6e](docs/PROTOCOL.md)); every conformance case runs down BOTH channels and the replies are compared, after `getMnemonic` was answered on the cable and silently dropped on the radio. **Mock**: `--emit-vectors` records what the firmware answers to a 48-request corpus, byte for byte, and `mock-conformance.test.ts` feeds the same bytes to `MockDevice` and diffs frame type, map shape, field names, values and error codes — only `address`/`r`/`s`/`yParity` are exempt, since the mock has no BIP32 and no secp256k1, and those are still checked for shape. Seven more divergences, all of them the mock ([PROTOCOL.md 6f](docs/PROTOCOL.md)): `setPassphrase` answered an invented `fingerprint` field, `selectWallet` with no index selected wallet 1 instead of refusing, blind signing was unreachable on `signTransaction`, an over-long message and an empty one both got the wrong code, and an unknown method with no session claimed to need pairing. `./scripts/check.sh` regenerates the corpus before the app suite, so a firmware change that alters an answer fails in the same run |

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
| ~~T31~~ ✅ | Screen-reader labels, keyboard traversal, contrast audit | T27c, T28 | checklist written and passing: [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md). The one that mattered was not a label: every "the device is waiting for you" line — compare the passkey, enter the PIN, check every page then approve — went to the log and nowhere else, so a screen-reader user was never told the hardware had asked. `deviceAttention()` now logs and announces the same string through an assertive region. Contrast was measured, not eyeballed: all text clears 4.5:1 in both themes (tightest is `--warn` on `--bg` at 4.86:1), and controls failed 1.4.11 — a button is surface-on-surface and its `--border` edge measured 1.39:1, so a `--control-border` token at 3.4–3.8:1 was added for anything you can operate. Fixed on the way past: `[hidden]` was losing to class rules that set a `display`, leaving the amount-unit selector and the address QR on screen and in the tab order while the code believed they were gone. Not yet exercised with a real screen reader |
| ~~T32~~ ✅ | WalletConnect v2 pairing (URI + QR), session list, pending-request view. **No in-app dapp browser** — see [PROTOCOL.md 6b](docs/PROTOCOL.md) | T28 | signs a request from a real dapp in the user's own browser — Aave's Base Sepolia faucet, `0x48696ca6…`, decoded and confirmed on-device, no blind signing |
| ~~T46~~ ✅ | Address enumeration in the app: derive and list addresses so the user picks there, Ledger-behind-Rabby style | T24 | `loadAddresses()` derives `m/44'/60'/0'/0/0..9` behind a generation counter, and the selection drives the signing path. The chosen address is shown in full with its native balance, a QR behind a toggle, Copy, and Share where a share sheet exists. Balances land through `balances.ts` and are labelled as fetched-from-an-operator, never attested. **Note the account level is still hardcoded to `0'`** — see T45a |
| ~~T47~~ ✅ | Show the signing *source* address on the device confirmation, not just the destination | T12 | the full checksummed address is rendered, derived on the protocol task at the signing path |

T30 is still the riskiest item — Android BLE permissions and background/reconnect behaviour are
device- and OEM-specific, and none of it can be validated against the mock. But it is now
*only* BLE: the USB host-mode work is gone entirely.

### Track E — hardware + docs (fully independent, start now)

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| ~~T33~~ ✅ | Decide 4 MB vs N16R8; update `platformio.ini` + `partitions.csv` together | — | settled on **16 MB flash, no PSRAM**, which is what the development board reports. `board_build.flash_size = 16MB` and `partitions.csv` (4 MB app, 24 KB nvs) agree, and the firmware builds and boots on it. PSRAM stays off — it is broken under QEMU, which the test strategy depends on. The comment block at the top of `platformio.ini` still says 4 MB and is wrong |
| T34 | Enclosure / physical form | T33 | printable |
| ~~T35~~ ✅ | Add the missing `docs/leekwallet-logo.png` | — | resolves. The mark is the Lek itself — a jícara gourd, lid on, sprouting — drawn from primitives in `docs/leekwallet-logo.svg` and rendered to PNG with ImageMagick, so it is source in the repo rather than a binary nobody can edit. Colours are the app's own accent greens, chosen to hold against a light and a dark README alike |
| T36 | Assembly guide with photos | T33 | someone else can build one |
| ~~T37~~ ✅ | Reproducible builds + release signing | — | Both halves of a release rebuild to the same bytes, verified rather than assumed. **Firmware:** two builds from two different paths give identical `firmware.bin`/`bootloader.bin`/`partitions.bin`; the only divergence was ESP-IDF's wall-clock stamp (`CONFIG_APP_REPRODUCIBLE_BUILD`), plus a fixed bug where `PROJECT_VER` reported the *previous* commit on an incremental build. **Companion:** the Vite bundle was already byte-identical across paths and needed nothing; the Rust binary needed a toolchain pin (`app/rust-toolchain.toml`) and one honest caveat — it is a function of the source *and the build path*. Measured, not guessed: at two paths `.text`, `.rodata` and `.data` are identical and only `.eh_frame`/`.gcc_except_table` reorder, no path is embedded anywhere (`strings` finds zero), and `--remap-path-prefix` over three prefixes changed neither hash by a byte. The cause is cargo's `-C metadata` hash feeding codegen-unit names and hence link order; there is no stable-Rust fix, so the build path is published as part of the recipe, as Debian does. Packaged installers (`.deb`/`.msi`/`.dmg`) are **not** claimed — `dpkg-deb` and WiX stamp their own timestamps. `scripts/repro-verify.sh` checks both and CI runs each as its own job; `scripts/release.sh` signs `SHA256SUMS` with `--local-user` and verifies what it wrote, and will not generate, print or commit a key |
| ~~T68~~ ✅ | Pair a dapp under the shipping Content-Security-Policy on both platforms | T32, T67 | A pairing reached the relay, subscribed, received the proposal -- the same 1684 bytes on every platform -- and then nothing: the SDK handles a proposal inside a try/catch that reports through its own logger and **auto-rejects the dapp**, so the failure was invisible and looked like silence. It read as an Android bug for days. It was not: `tauri dev` loads the webview straight from Vite, which Tauri cannot inject the CSP header into, so **no desktop run had ever applied the shipping policy** and the Linux release build would have failed the same way. Vite now serves the policy read from `tauri.conf.json` (`vite.config.js`), so dev and production enforce one rule. Two entries were missing: `ipc: http://ipc.localhost`, which Tauri documents but does not inject and without which every `invoke` is refused on Linux (Android and Windows put IPC on the app origin, so `'self'` covered it and the gap was invisible); and `verify.walletconnect.org`, the origin attestation. Static reading of the SDK said Verify could not be the cause -- `getVerifyContext` swallows its own errors -- and **two devices disagreed**; the empirical result won. `pulse.walletconnect.org` telemetry stays blocked and pairing is unaffected. Proven by signing from a live Aave session on both: desktop `0x299ac220…` (block 45527068) and Android `0xe3b53e2f…` (block 45527294), each `from` the device's own address |
| ~~T67~~ ✅ | Camera QR scanning that works on both platforms | T32 | Verified end to end: a WalletConnect pairing code read from the camera and paired, on Android (`scanned a pairing link from the camera`, ~2s) and on Linux desktop (~21s, then an Aave session). Six separate faults sat on this one path, each presenting as "camera on, nothing happens": a 640x480 default capture, a lens parked at its 8cm macro limit, a portrait frame downscaled to 607px wide, a decoder that could not read the code, a self-pacing loop that stopped after its first frame, and a centre crop that sliced the top off a code that filled the frame. The decoder is `zxing-wasm`: jsQR and the pure-JS ZXing port were both handed the real captured image and found nothing. **The thing that actually resolved it was instrumentation** -- `decoder ready`, a frame counter, and a log line saying a pairing came from the camera rather than a paste. Until those existed every distinct fault looked identical and each round was a guess |
| ~~T63~~ ✅ | Send flow: scan a recipient by camera, Max amount, token discovery | T46, T51 | camera → jsQR → EIP-681 parser → device-confirmed signature → broadcast, proven on Sepolia from both desktop and Android (`0xe84c3e48…`, `0x600b51e4…`). `maxSendableNative` reserves the fee at the 1559 **cap**, not the expected fee, so a "send everything" transaction cannot become unpayable after a base-fee spike. Token discovery batches every listed `balanceOf` through Multicall3 in one call, and a contract that fails to answer stays distinguishable from one holding zero |
| ~~T64~~ ✅ | Bundled Uniswap/CoinGecko token list with an opt-in refresh | T51 | `token-list.ts` validates an untrusted list into `TokenHint` (`verified: false`, always), sanitises symbols against RTL-override and lookalike spoofing, and lets the hand-typed table in chains.ts win. `scripts/fetch-token-lists.mjs` regenerates the snapshot deterministically; a re-run is byte-identical |
| ~~T45a~~ ✅ | App-side account selection: let the app reach the device's BIP-44 account, not only `0'` | T45 | An Account selector in the Addresses panel: "Follow the device" (the default, and it names the number the device reports) or accounts 0–9. Every `getAddress` derives `m/44'/60'/<account>'/0/i` and every signing call sends `account` explicitly rather than leaning on the device's selection happening to match. The account the addresses on screen were derived under is recorded, and a signing request whose account no longer matches it is refused rather than signed — an index means a different key under a different account, and nothing on either screen would look wrong. Ten, not 2^31, because ten is what the device's menus reach. **The mock ignores `account`**, so its addresses do not vary with the selector; hardware is where this is confirmed |
| T65 | Firmware flasher in the companion app | T11 | desktop first, `espflash` as a library rather than a bundled CLI; Android reuses the two-backend split `transport-serial` already makes. **Gated on T11 in substance, not just in sequence**: without secure boot a flasher is a one-click way to install firmware that captures the PIN, so a device that is not locked must say so plainly rather than the button being quietly greyed |
| T66 | OTA update path | T11, T65 | not possible today — the partition table has a single `factory` app slot and no `otadata`. There is room: 16 MB flash with ~4.1 MB allocated, and **`nvs` sits at 0x9000, before the app**, so `ota_0`/`ota_1` can be added without moving the vault and provisioned devices keep their wallets. USB first; radio OTA only if a sealed device ever ships (Wi-Fi is refused for the reason on `sdkconfig.wifi`, and BLE at 20–100 kB/s is minutes per image) |

---

## Other coins: not planned, and deliberately not scheduled

**EVM only.** Solana, Bitcoin and Monero were once listed here as tasks. They
are removed rather than deferred, because a roadmap row is a promise about
direction and this project is not making that one. The research that produced
them is in git history if it is ever wanted again — what was vendored, what was
missing, and that Bitcoin's real cost is the UTXO model rather than the curve,
since change-output verification is a class of bug that does not exist in EVM
and getting it wrong sends your change to an attacker.

If coins are ever added, the shape is **one seed, one firmware at a time**: the
same BIP-39 phrase, with the device carrying only the coin you asked for. That
is the user-facing arrangement Ledger has, and it is worth being precise about
which half of it is being adopted, because the two halves cost very different
things.

Ledger loads a separate signed **app per coin onto the device at runtime**. That
architecture is an answer to the Nano S having 320 KB of flash. Our app
partition is 4 MB and the firmware uses about 1.1 MB, so the constraint that
produced it is not ours — and copying it means building an app loader with
memory isolation and per-app signature verification, a security-critical
component and a large new attack surface bought to solve a problem we do not
have.

**Build-time variants give the same result without the loader.** `leek-evm.bin`
and a hypothetical `leek-btc.bin` are the same seed and the same device, and the
user flashes the one they need; code for coins they do not use is not merely
unreachable but absent, which is a stronger property than isolation. The cost
moves to the flashing step, which T65 already has to solve — and which is gated
on secure boot (T11) regardless, since a wallet that will install firmware on
request must first be able to prove what it installed.

Nothing here should begin before T11.

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
mock, the viem adapter, the app and WalletConnect are done. `./scripts/check.sh`
runs 19 host suites, the TypeScript suites and both typechecks; `./scripts/check.sh
rpc` is a separate, network-touching stage that checks every registry endpoint is
alive (see below).

The app now works end to end on **both** desktop Linux and Android: camera scan
of a recipient, device-confirmed signature, broadcast — verified on Sepolia from
each platform, with the on-chain `from` matching the address the device showed
and the `to` matching the scanned code.

What is left, in the order it matters:

1. **T11** — flash encryption and secure boot. Rehearsed in QEMU, written up in
   [docs/BURN-PROCEDURE.md](docs/BURN-PROCEDURE.md), gated by
   `scripts/preflight-secure.sh`. No fuse has been burned. Nothing else on this
   list changes what a person holding the device can do.
2. ~~**T30**~~ — done. The APK is installed and driven on a tablet, and doing so
   found four defects a compiler and 37 green suites had all passed: a missing
   `CAMERA` permission, a `BarcodeDetector` crash by way of Play Services, an
   uninitialised `rustls-platform-verifier` that *panicked* and so hung every RPC
   with no error to show, and a Tauri entry point silently lost to a misplaced
   `#[cfg_attr]`. None of them were reachable without the hardware.
3. ~~**T26**~~ — done. The mock leg is no longer a document: the firmware
   records its own answers and the TypeScript suite diffs the mock against
   them, which turned up seven divergences on the first run, every one of them
   the mock.
4. Then the smaller open rows: **T39b** (XFP on screen) and **T36** (the
   assembly guide, which needs photographs of real hardware). T12b, T12c, T12d,
   T26, T31, T35, T37, T40 and T45a all landed this cycle and are confirmed on
   hardware against a live dapp session, so what remains outside T11 is
   physical: an enclosure, photographs, and the camera work in T58.

A standing rule learned the hard way this cycle: **a chain that has stopped
producing blocks comes out of the registry**, whether it was formally shut down
(Polygon zkEVM, Holesky) or merely stalled with no announcement (Scroll Sepolia).
A dead chain can keep answering `eth_chainId` and `eth_blockNumber` perfectly —
Holesky did, frozen at one height, for months — so liveness is a block-height
question and `./scripts/check.sh rpc` is how it gets asked.

Firmware size figures were removed rather than carried forward — the last ones
recorded predate the protocol, BLE and decoding work, and nobody has measured
since.
