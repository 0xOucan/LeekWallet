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
