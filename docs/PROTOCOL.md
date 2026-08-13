# LeekWallet Wire Protocol v1 (draft)

One command set over two transports (BLE GATT, USB CDC-ACM). The firmware dispatcher and the
`@leekwallet/core` TypeScript client are both written against this document, so it needs to be
settled before either side starts.

---

## 1. Threat model — read this before designing anything on top

Three distinct attackers, and the protocol only defends against two of them.

| Attacker | Defended by | Effective? |
|---|---|---|
| Passive radio eavesdropper | Session encryption (§3) | Yes |
| Active MITM between host and device | Passkey-confirmed key exchange (§3) | Yes |
| **Compromised host application** | **Nothing in this protocol** | **No** |

The third one is the important one. If the phone or PC is compromised, the attacker is *inside*
the app, above the encryption layer. They see every keystroke before it is encrypted and can
substitute any payload they like.

So the protocol's job is not to make the host trustworthy. It is to ensure that **anything the
host cannot be trusted with is decided on the device, in front of the user's eyes.** That gives
one hard rule which the whole command set is organised around:

> **Rule 1.** Every operation that moves funds or reveals a secret requires physical
> confirmation on the device, against data rendered by the device from its own parsed state —
> never from a string supplied by the host.

The host is a keyboard and a screen. It is never an authority.

---

## 2. Framing

```
┌────────┬────────┬──────────────────────┐
│ len:u16│ type:u8│ payload (CBOR)       │
└────────┴────────┴──────────────────────┘
   big-endian, len covers type + payload
```

CBOR over JSON: compact enough for a 244-byte BLE MTU, binary-safe for hashes and signatures,
and it has a strict canonical form — which matters, because a permissive parser on a signing
device is an attack surface.

| type | meaning |
|---|---|
| `0x01` | Request (plaintext, pre-session only) |
| `0x02` | Response (plaintext, pre-session only) |
| `0x11` | Request (encrypted) |
| `0x12` | Response (encrypted) |
| `0x13` | Event (encrypted, device→host, unsolicited) |
| `0x7F` | Error |

**BLE chunking.** GATT writes cap at MTU−3. Frames are split into chunks with a 1-byte header:
bit 7 = "more follows", bits 0-6 = sequence. The receiver reassembles before parsing. USB CDC
uses the same frames without chunking. Everything above this layer is transport-blind.

**Limits.** Max frame 4 KB. The device rejects anything larger without buffering it — a signing
device must never let the host dictate an allocation size.

---

## 3. Session establishment

Runs once per connection, before any encrypted command.

```
host                                            device
 ──── 0x01 Hello {version, hostPubkey} ───────────▶
 ◀─── 0x02 HelloAck {version, devicePubkey, deviceId}
      both sides: X25519 ECDH → HKDF-SHA256 → k_h2d, k_d2h
 ◀─── device displays a 6-digit passkey on its OLED
 ──── user reads it off the screen, types it into the app
 ──── 0x11 Confirm {passkey}  (encrypted) ─────────▶
 ◀─── 0x12 ConfirmAck {sessionId}
```

The passkey is derived from the ECDH shared secret, not randomly generated. A MITM negotiating
two separate sessions produces two *different* shared secrets, so the passkey it can show will
not match the one the device displays — the user comparing screen to app is what actually
detects the attack. This is the standard numeric-comparison pattern and it is the only reason
the channel means anything.

Payload encryption is **ChaCha20-Poly1305** with a per-direction 96-bit nonce that is a
monotonic counter. Counters never reset within a session; a reused nonce is a session abort. The
ESP32-S3's AES accelerator would make AES-GCM tempting, but ChaCha20 is constant-time in
software everywhere, which matters more on the host side than raw throughput does at our sizes.

**What this buys and what it does not:** an eavesdropper learns nothing and a MITM is detected.
A compromised host is entirely unaffected — see §1.

---

## 3b. One transport at a time

**The device exposes exactly one channel at a time: USB or BLE, never both.**
Selectable on the device, defaulting to USB.

This is not a preference. Three reasons, in increasing order of how badly they
bite:

1. **The session layer is single-peer by construction.** There is one session
   state and one pair of nonce counters (`src/session.c`). Two concurrent peers
   would advance the same counters and each other's frames would fail to
   decrypt — the same class of fault that a request colliding with a
   background poll already produced on a single channel.
2. **The framing has no request IDs.** A reply belongs to whichever request
   went out last. Two channels means two "last"s.
3. **A device listening on BLE while plugged into USB is reachable by someone
   you cannot see.** The user believes they are on a cable. Advertising should
   be off — not merely unpaired — whenever BLE is not the selected transport,
   which is also the honest answer to the privacy question in T56: a wallet
   that does not advertise announces nothing.

Switching transports tears down any active session. There is no state worth
carrying across, and pretending otherwise would mean deciding whether a passkey
confirmed over one channel authorises the other. It does not.

## 4. Commands

Permission tiers mirror the existing `RPC_PERM_*` model in the pixiecolibri sibling project.

| Command | Tier | Device confirmation |
|---|---|---|
| `ping` | always | — |
| `getFeatures` | always | — |
| `getStatus` | always | — |
| `unlock` | always | PIN entered **on device** |
| `lock` | always | — |
| `listWallets` | unlocked | — |
| `selectWallet` | unlocked | — |
| `setPassphrase` | unlocked | **yes — fingerprint confirm (§5)** |
| `clearPassphrase` | unlocked | — |
| `getFingerprint` | keys | — |
| `getAddress` | keys | optional `display: true` |
| `getPublicKey` | keys | — |
| `signMessage` | keys | **yes** |
| `signTypedData` | keys | **yes** |
| `signTransaction` | keys | **yes** |
| `signHash` | keys | **yes**, and refused unless blind signing is enabled on-device |

**Deliberately absent:** there is no host-invokable `wipe`, no `getMnemonic`, and no way to set
or change the PIN over the wire. Those are device-only, permanently. A protocol that can erase
your wallet is a protocol that a malicious host can erase your wallet with.

`unlock` does not carry a PIN. It asks the device to prompt; the user types on the device; the
response says whether it worked. The PIN never crosses the wire in any form.

### Signing

The host sends structured fields, never a pre-serialised blob:

```
signTransaction {
  path:     "m/44'/60'/0'/0/0",
  chainId:  1,
  nonce:    42,
  to:       h'...20 bytes',
  value:    h'...',
  data:     h'...',
  maxFeePerGas: h'...', maxPriorityFeePerGas: h'...', gasLimit: h'...'
}
```

The device re-serialises and re-hashes these itself, renders what it computed, and signs only
what it rendered. It must never sign a hash the host handed it (that is `signHash`, which exists
for compatibility and is off by default). This is Rule 1 in concrete form: the bytes displayed
and the bytes signed have a single source, and it is not the host.

---

## 5. Passphrase entry — the "app as secure keyboard"

Typing a passphrase on four buttons is punishing, so the app can act as the keyboard. This is
worth doing, and it is what Trezor Suite does. But the security accounting has to be honest.

```
setPassphrase { passphrase: "..." }        (encrypted, §3)
  ▼
device derives seed, computes fingerprint + first address
  ▼
device displays:   XFP 3A7B1C22
                   0x71C7…8976
  ▼
user confirms on the device → passphrase becomes active for the session
```

**What this protects against:** the radio, and a MITM. Not the host. A compromised app sees the
passphrase as it is typed, before encryption touches it. Host entry is therefore *strictly
weaker* than on-device entry, and the UI must say so rather than implying the encryption makes
it equivalent.

That said, the tradeoff is reasonable for the stated use case — a cold-storage device used
occasionally from a machine you control — provided three things hold:

1. **The app uses its own in-app keyboard for this field, never the system IME.** This is not
   optional on Android. Third-party keyboards (Gboard, SwiftKey) sync typed text to the cloud
   and keep learned-word caches. A passphrase typed into a system IME should be considered
   disclosed. Disable autocorrect, clipboard, and screenshots on that view.
2. **The passphrase is never persisted host-side.** Not in local storage, not in a "remember
   this wallet" convenience, not in a crash log.
3. **The fingerprint is confirmed on the device screen.** Which brings us to the real problem.

### Why the fingerprint check matters, and its one limitation

A mistyped passphrase does not error. It derives a different, perfectly valid, empty wallet.
Users conclude their funds are gone. So the device shows the master fingerprint (XFP) and first
address before the passphrase is used for anything.

Be precise about what that check catches:

- **On every use after the first:** it catches both typos *and* a malicious host substituting a
  passphrase, because you recognise your own fingerprint. This is a genuine tamper detector.
- **On first use:** it catches nothing, because you have no reference to compare against.

Therefore: **record the fingerprint when the passphrase is created**, on the device screen, and
write it down with the seed backup. Without that reference the check is decorative on the one
occasion it would matter most. Coldcard's XFP-on-screen convention exists for exactly this
reason and we should follow it.

Derivation is plain BIP39 — `PBKDF2-HMAC-SHA512(mnemonic, "mnemonic" + passphrase, 2048)` — and
is verified against the spec's known-answer vectors in `sim/test_passphrase.c`. Any seed and
passphrase produce the same wallet here as on Trezor, Ledger, Coldcard or Sparrow.

### What the companion app must do about it

The device drops the passphrase on lock, wallet switch and disconnect. The host
has to mirror that, and the reason is sharper than tidiness.

Addresses derived under a passphrase belong to a wallet the device can no longer
produce once that passphrase is gone. Left on screen they look exactly like
valid ones. So:

- **Derived state is valid only for the exact `(unlocked, wallet, passphrase)`
  tuple it was derived under.** Any change discards it, including a fresh
  unlock — the user may have entered a different passphrase, or none.
- **The app must poll**, not merely react to its own commands. The device
  auto-locks on its own timer and the user can switch wallets by hand; neither
  passes through the app. `getStatus` returns `unlocked`, `activeWallet` and a
  boolean `passphrase`, which is enough to detect every case.
- **Never persist derived addresses.** A passphrase wallet leaves no trace on
  the device by design, and writing its addresses into host storage undoes
  precisely that: anyone reading the app's data learns a hidden wallet exists,
  which is the fact being protected. Memory only.

Note the status flag says *whether* a passphrase is applied, never which one,
and it is session state rather than something stored — so it reveals nothing
about a device sitting locked.

### Session lifetime

The passphrase lives in RAM only and is cleared on: device lock, PIN re-entry, wallet switch,
transport disconnect, and inactivity timeout. The status bar must always show which wallet is
active, because "am I in the passphrase wallet or the base wallet?" is the question users get
wrong and lose money over.

---

## 5b. Who picks the address

The device and the app select addresses for different reasons, and conflating
them produces a worse version of both.

| Purpose | Chosen by | How |
|---|---|---|
| Which address signs | **The app** | full BIP44 path in every signing request |
| Which address to receive on | **The device** | UP/DOWN on the wallet screen |

This mirrors how a Ledger behaves behind Rabby: the extension enumerates derived
addresses, the user picks one there, and the device is never asked to browse.
The device's own selector exists for the case with no app at all — plug it into
a power bank, scroll to an address, show the QR, receive funds. That is a
genuine standalone mode and worth keeping, but it is not the signing path.

**No device, no signature**, in either mode.

### Consequence: confirmation must show the source

Because the host names the path, the host can name a *different* path than the
user believes they selected. The signature would come from an account they did
not intend — same signature machinery, wrong key.

So the on-device confirmation screen must show **the address being signed from**,
not only the destination and amount. The user compares what the app claims with
what the device says, and the device is the authority. Folded into T12.

Implemented as the full checksummed address, not the index (T47). The index
alone describes what the device was *asked*, and is blind to what it did — a
task race once had it signing with a key the screen never named. The address is
derived on the protocol task, at the same path the signature is taken at, and
handed to the UI rather than looked up there: the UI task shares derivation
state, which is how the original race happened.

## 6. Errors

```
0x7F { code: u16, message: "short ascii" }
```

| code | meaning |
|---|---|
| `0x0001` | Malformed frame |
| `0x0002` | Unsupported version |
| `0x0100` | Not unlocked |
| `0x0101` | Wrong permission tier |
| `0x0200` | User rejected on device |
| `0x0201` | Timed out waiting for the user |
| `0x0300` | No wallet selected |
| `0x0400` | Session required / nonce reuse |
| `0x0202` | Outside the decodable set (section 6bis) |

Messages are for developers. Never render a device-supplied string to the user as if it were a
security statement — that is a phishing vector.

---

## 6b. Dapp connectivity: WalletConnect, and no built-in browser

Three ways a dapp could reach the wallet:

| Approach | Where the dapp runs | Verdict |
|---|---|---|
| Injected provider (MetaMask-style `window.ethereum`) | Browser extension | Needs an extension per browser; large surface; not available to a desktop app |
| **WalletConnect v2** | **The user's own browser** | **Chosen** |
| Built-in dapp browser | Inside the wallet app | Rejected |

**WalletConnect is the right call**, and the reason is where the dapp's code
executes. With WalletConnect the dapp stays in the user's browser, and all that
crosses the relay is structured JSON-RPC — `eth_sendTransaction`,
`personal_sign`, `eth_signTypedData_v4`. The wallet app renders none of the
dapp's HTML or JavaScript.

**The built-in browser is the part to push back on.** Rendering arbitrary
untrusted web content inside the process that talks to a signing device
undoes much of the point. Every dapp becomes code running one webview away from
the transport, and the app's own attack surface becomes the whole web platform.
Mobile wallets that ship dapp browsers do it for reach, and it is consistently
their largest security liability.

So: pair by URI or QR, list active sessions, show pending requests. No address
bar.

Two things to plan for:

- **The relay is a third party.** It sees connection metadata and encrypted
  payloads, never keys. Acceptable, worth stating in the UI.
- **A project ID is required** from WalletConnect Cloud, so the app needs
  network access. That is fine — the host was never trusted. The device still
  confirms every request on its own screen, which is what makes the untrusted
  host survivable.

## 6bis. Blind signing, and what actually prevents it

A common misreading: that a companion app which decodes and explains a
transaction removes blind signing. It does not. It is closer to the opposite.

**Blind signing means the device signs bytes it cannot itself decode and
display.** Whether the host drew a beautiful summary is irrelevant — that
summary is produced by the machine you are trying not to trust. A gorgeous
"Sending 1 ETH to vitalik.eth" over a device screen showing a bare hash *is*
blind signing, with better lighting.

Three things prevent it, all of them on the device:

1. The host sends **structured fields, never a pre-hashed blob** (section 4).
2. The device **re-serialises and re-hashes** those fields itself, renders what
   it computed, and signs only that.
3. `signHash` — sign whatever 32 bytes I hand you — is **refused unless blind
   signing is explicitly enabled on-device**, and it is off by default.

### We will hit the same wall Ledger did

Ledger's blind-signing toggle exists because their EVM app cannot decode
arbitrary contract calls. Ours is a 128x64 display with a small parser; the same
limit applies, sooner. Native transfers and common ERC-20 calls are decodable.
An arbitrary dapp interaction is not.

Being honest about that is the design. Where the device cannot decode calldata
it must **refuse by default** and say so, rather than quietly showing a hash and
accepting a confirmation that means nothing. The user who genuinely needs it can
turn blind signing on, once, having read what it costs.

The decodable set should grow deliberately — native transfer, ERC-20
`transfer`/`approve`, EIP-712 typed data — and everything outside it should be a
refusal, not a shrug. Tracked as T50.

#### The decodable set as implemented

`src/eth-decode.c`, mirrored host-side in `app/packages/core/src/eth-decode.ts`
so the mock refuses exactly what the device refuses:

| calldata | shown as |
|---|---|
| empty | native transfer: amount, chain, recipient |
| `transfer(address,uint256)` | recipient, raw amount, token contract |
| `approve(address,uint256)` | spender, raw amount **or** an unlimited warning, token contract |
| anything else | `0x0202`, refused before the confirmation screen |

Contract creation is refused too — there is no recipient to name and no code the
device can describe.

Three details that are load-bearing:

- **Decoding is exact, not best-effort.** A recognised selector with a short
  argument block, trailing bytes, or non-zero padding in the address word is
  `0x0202`, not a guess. Half-understanding a call and rendering it confidently
  is worse than refusing it.
- **Token amounts are raw units.** The device cannot call `decimals()` on the
  contract, so the screen says "raw units" rather than implying a scale. The app
  may show a scaled figure from a token list; that is advisory (section 6c).
- **Unlimited approvals get their own screen.** Anything from 2^255 up is an
  allowance nobody spends through and the pattern behind most drain incidents,
  so it is named in words instead of printed as a 78-digit number nobody reads.

EIP-712 typed data is in the set as designed and not yet implemented — the
device has no `signTypedData` today. When it lands it needs a renderer, not just
a decoder; a recognised type that cannot be displayed is still blind signing.

### Session model: unlock once, confirm every time

Ledger's flow is unlock with the PIN, then sign repeatedly without re-entering
it, pressing to approve each transaction. We match that, deliberately:

| | Required |
|---|---|
| Unlocking the device | PIN, on the device |
| Each signature | **Physical confirmation, no PIN** |
| After auto-lock | PIN again |

Asking for a PIN per signature sounds stricter and is not. It trains PIN entry
into muscle memory, which is the habit that makes shoulder-surfing and fake
prompts work. The per-signature control is the button press against
device-rendered data; the PIN establishes the session.

## 6d. Chains and tokens

**Chain-agnostic within EVM is nearly free; across coin families it is not.**
Worth separating the two, because they cost very different amounts.

*EVM chains* differ only by `chainId`, which is already a signed field under
EIP-155. Supporting Base, Arbitrum, Optimism, Polygon, BSC and anything else is
a matter of the app knowing RPC endpoints — the firmware barely changes.

*Other families* — Bitcoin, Solana, Cardano — mean different curves, address
encodings and signing schemes. trezor-crypto already carries secp256k1 and
ed25519, so it is achievable, but each is a real project rather than a
configuration flag. EVM first, deliberately.

**The device must display the chain.** The same address exists on every EVM
chain and a signature valid on one is not on another; a host that quietly swaps
chain 1 for chain 56 changes what a signature authorises. Unknown chain IDs are
shown as raw numbers rather than guessed at — "chain 8453" is honest, a wrong
name is worse than none.

### Token lists belong in the app, and are advisory

The [Uniswap token list](https://tokenlists.org) format is the standard, and
CoinGecko publishes per-chain lists in it. That is the right source, and it
belongs in the companion app: the device cannot hold thousands of entries, and
would gain nothing by trying.

The trap is what the device then displays. A token list maps a contract address
to a symbol, so if the device renders "1000 USDC" from a host-supplied symbol, a
compromised host relabels a worthless contract as USDC and the confirmation
screen becomes the attack.

So:

- **The device shows the contract address** for any token transfer, alongside
  whatever symbol it can verify itself.
- The device carries a **small built-in list of well-known token contracts per
  supported chain** — the handful worth hardcoding — and labels only those.
  Everything else is displayed as an address.
- Host-supplied symbols never reach the device. The app may show them; the app
  is a preview.

A short verified list the device owns beats a long list it has to trust.
Tracked as T51.

## 6c. Transaction interpretation is advisory

The companion app should decode calldata and explain it in plain language, the
way Rabby does — "Approve unlimited USDC to 0x1f98…" beats a hex blob, and most
users cannot read the blob at all.

**But that explanation is produced by the host, and the host is not trusted.**
A compromised app can render a friendly, entirely false summary. So:

- The app's interpretation is a **convenience preview** and must be visibly
  labelled as one.
- The device shows the fields that decide the outcome — source path, recipient,
  value, chain — and those are what the user approves.
- Where the two disagree, the device is right. The UI should make that hierarchy
  obvious rather than presenting both as equally authoritative.

Practical notes for whoever builds it:

- Decoding beyond the standard ERC-20/721 selectors needs an ABI source.
  Querying a remote registry such as 4byte or Sourcify **leaks what you are
  about to sign** to that service. Bundle the common selectors locally, make any
  remote lookup opt-in, and say what it discloses.
- Unlimited-approval detection is the single highest-value warning to implement
  first. It is the pattern behind most drain incidents.

## 6e. Where the firmware and the mock still disagree

`sim/test_protocol.c` runs the real `src/protocol.c` on the host, which is what
makes "the mock must never be more permissive than the device" checkable instead
of aspirational. Running it the first time turned up twelve divergences. Two
were the mock being weaker and are fixed (the passkey-pending state, and errors
inside a session being encrypted). The rest are recorded here rather than
quietly patched, because most of them are the **firmware** being behind, and
deciding which side is right is a protocol question, not a bug fix.

| # | Divergence | Which side is right | Status |
|---|---|---|---|
| 1 | `unlock` is asynchronous on the device (`{prompted:1, unlocked:0}`, host polls); the mock unlocks synchronously | Device. An app built on the mock believes unlocking is instant | **Closed** — mock prompts and stays locked until `enterPin()`; app polls `getStatus` |
| 2 | `selectWallet`, `setPassphrase`, `signMessage` exist in the mock, not in the firmware | Mock — these are specified in section 4 and the firmware has not caught up | **Closed** — all three implemented on the device; shapes below |
| 3 | `signTransaction` returns `{index, r, s, yParity}` on the device, `{signature, path}` in the mock | Device. Nothing that parses one parses the other | **Closed** — mock emits `{index, r, s, yParity}`; the host reassembles `r ‖ s ‖ yParity` |
| 4 | `getAddress` returns `{address, index}` on the device, `{path, address}` in the mock | **Device: `{address, index}`** (see below) | **Closed** |
| 5 | `chainId` is mandatory on the device (`0x0001` if absent), ignored by the mock | Device. Signing without knowing the chain is a replay waiting to happen | **Closed** — mock requires an unsigned integer `chainId` |
| 6 | Device refuses calldata longer than `ETH_MAX_DATA` (256) before checking decodability; the mock has no bound | Device | **Closed** — and in that order, so the code is `0x0001` and not `0x0202` |
| 7 | Device rejects an address index above `0x7FFFFFFF`; the mock accepts any non-negative integer | Device | **Closed** — on `getAddress` and `signTransaction` alike |
| 8 | `getFeatures` includes `initialized` in the mock only; `lock` returns `{}` in the mock, `{unlocked:0}` on the device | Cosmetic, but pick one | **Closed** — device's wording in both: no `initialized`, `lock` answers `{unlocked:0}` |

### #4 resolved: `getAddress` answers `{address, index}`

The device's shape wins, and the mock no longer echoes the requested `path`.

The argument for keeping `path` is that the host asked in paths and viem thinks
in paths. The argument against is stronger: **the device never retains the
path.** It reads the trailing component into a `uint32` and discards the rest —
`m/44'/60'/0'/0/7` and `m/9999'/1'/2'/3/7` derive the same key today. A reply
echoing the path back would therefore be the host reading its own request and
concluding the device agreed with it, which is precisely the class of confusion
that produced ten identical addresses the last time (#4's neighbour in this
table). `index` is the only field the device can honestly attest to, so it is
the only one it sends.

Returning both was rejected for the same reason the rest of this section exists:
a field present in the mock and absent from the firmware is a field app code can
come to depend on, and the ripple is discovered on hardware. The app builds the
path itself when it needs one to display — it is the side that chose it.

### The three methods as implemented (divergence 2, closed)

The shapes the device now speaks, so the mock can be made to match rather than
guessed at:

| Command | Request | Reply |
|---|---|---|
| `signMessage` | `{ message: text, index \| path }` | `{ index, r, s, yParity }` — the same shape as `signTransaction` |
| `selectWallet` | `{ index: 1-based }` | `{ activeWallet }`, `0x0300` if there is no such wallet |
| `setPassphrase` | `{ passphrase: text }` | `{ address, passphrase: 1 }` after the on-device confirm |

Four decisions inside those, each of which the mock has to copy to stay no more
permissive than the device:

- **`signMessage` refuses a message it cannot render.** The digest is the
  EIP-191 one — `keccak256("\x19Ethereum Signed Message:\n" || decimal_length ||
  message)` — and the device displays the message in full on the confirmation
  screen before signing it. So the message must be printable ASCII (0x20–0x7E,
  no newlines or tabs) and at most 120 bytes, the six twenty-character rows the
  screen has. Anything else is `0x0202`, refused *before* any prompt. Showing a
  mangled rendering of what is being signed, or a hash beside "undisplayable
  content", is the same bargain as blind signing (6bis) — the confirmation would
  carry no information. Non-ASCII messages are a real limitation and belong in
  the honest-refusal column, not in a workaround.
- **`setPassphrase` answers with the first address, not an XFP.** The device has
  no fingerprint API today, and inventing an eight-hex-digit value that is not a
  BIP32 fingerprint would be worse than showing the thing the user actually
  compares. The same string is on the screen and in the reply; a rejection or a
  timeout clears the passphrase, so a wrong one is recoverable rather than
  silently a different wallet. Empty passphrases are `0x0001` — clearing is
  `clearPassphrase`'s job and is not implemented yet.
- **`selectWallet` drops the passphrase**, because a passphrase belongs to the
  seed it was entered against (section 5).
- Neither `selectWallet` nor `setPassphrase` accepts an index or a passphrase
  the device's own UI could not produce: indices are bounded before the cast to
  `uint8_t` (257 must not become 1), and passphrases are printable ASCII, so no
  wallet exists that is reachable from the app and not from the device.

**The sync marker is a documentation bug, not a mock bug.** `protocol.c` requires
and emits `'L','K'` before every frame because it shares the port with console
output; section 2 above describes the frame starting at `len:u16`, and
`framing.ts` implements it that way. The Rust transport adds and strips the
marker, so both are correct at their own layer — but section 2 should say so,
because anything else bridging to real hardware has to know.

## 7. Versioning

`Hello` carries a major version. Mismatch is a hard failure with an upgrade prompt, not a
best-effort downgrade. Silent negotiation to a weaker protocol is a downgrade attack.

---

## Open questions

- **Does the passkey confirm survive BLE re-pairing**, or is it re-run per connection? Per
  connection is safer and costs the user one screen glance.
- **Should `getAddress` without `display: true` exist at all?** It is convenient for populating
  a UI, and it is also how an attacker gets an address list without the user noticing. Leaning
  toward keeping it but rate-limiting it.
- **Do we need a pre-session `getFeatures`** for app compatibility checks before pairing? Likely
  yes, and it must expose nothing user-specific.
