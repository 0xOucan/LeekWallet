# Clear Signing: how other wallets name a transaction, and what this one can

A research spike, not a plan of record. The question behind it: this wallet
paired with Aave's testnet faucet over WalletConnect and refused to sign,
because its decodable set is four hardcoded cases (empty calldata, ERC-20
`transfer`, ERC-20 `approve`, and nothing else). Refusing was correct. But
hardcoding selectors does not scale — every dapp becomes a firmware change — so
the question is what the industry does instead, and whether any of it survives
contact with [PROTOCOL.md 6bis and 6c](PROTOCOL.md), whose reasoning is binding
here.

**Update (T12c): option (a) landed, and it turned out not to need a signature
at all.** The device now carries a table of ABI *signature strings* and selects
a row only when `keccak256(signature)[0:4]` equals the selector being signed —
so the mapping certifies itself and there is no descriptor to sign, no key to
run, and no review process deciding which mappings are true. Keccak decides.
The rest of this document is the research that led there and stands as written;
see [PROTOCOL.md 6bis](PROTOCOL.md) for what shipped.

Short version of the answer, before the detail:

**The standard everyone points at (ERC-7730) deliberately does not solve
authenticity. Ledger solves it separately, by signing descriptors with Ledger's
own key and verifying that signature on the device against a public key baked
into the app. The trust anchor is not the standard and not the dapp — it is the
vendor. Any version of this we adopt inherits that shape: whoever signs the
descriptors is who the user is trusting, and on this project that would be us.**

Everything below is cited. Where a claim is inferred rather than read from a
primary source, it says so.

---

## 1. ERC-7730 — what it is, and the hole in the middle

ERC-7730 "Structured Data Clear Signing Format" is a real, live standard, at
**Draft** status on eips.ethereum.org
([EIP-7730](https://eips.ethereum.org/EIPS/eip-7730)). It defines a JSON
*descriptor*: for a given contract on a given chain, how each function's
calldata should be turned into human sentences. Three parts:

- **context** — which contract, which chain, which ABI the descriptor binds to;
- **metadata** — constants: the owner's name, token info, enums, maps;
- **display** — per-selector *formats*: an `intent` string ("Approve",
  "Deposit") plus per-field `label` and `format` (amount, token amount, address,
  date, duration, enum…), each pointing at a path into the decoded calldata.

So a descriptor is a rendering recipe keyed by `(chainId, contract, selector)`.
It does not carry the calldata; the wallet decodes calldata itself and uses the
descriptor to decide what to call each field.

Descriptors live in a public registry,
[github.com/ethereum/clear-signing-erc7730-registry](https://github.com/ethereum/clear-signing-erc7730-registry)
(mirrored/originated at `LedgerHQ/clear-signing-erc7730-registry`). Submission
is "open a pull request"; a CI job regenerates `index.calldata.json` and
`index.eip712.json` at the repo root so "wallets and libraries find the right
descriptor for a transaction without downloading the whole registry" (registry
README). The README documents no cryptographic signing of registry contents.

### The crux: authenticity

Read the EIP's own security section. It **does not define an authentication
mechanism**. It pushes the problem outward:

> "A secure registry should (a) require cryptographically verifiable provenance
> and attestations for each ERC-7730 file and its maintainer, (b) keep a public,
> tamper-evident history of submissions, approvals, and revocations"

— [EIP-7730, Security Considerations](https://eips.ethereum.org/EIPS/eip-7730)

That is a recommendation to registries, not a wire format. The EIP names
**registry poisoning** as a named risk, and states the rule that matters most
for us:

> "Wallets MUST never fallback to presenting untrusted information as if it was
> trusted and verified."

Which is [PROTOCOL.md 6c](PROTOCOL.md) restated by a standards body.

So: **an ERC-7730 JSON file, on its own, is unsigned host-supplied data.** A
device that renders labels out of one, as delivered, has handed the host a
caption box over its own screen. That is exactly the failure 6c forbids — a
compromised host writes "Deposit 10 USDC" over calldata that drains an
allowance, and the device dutifully prints it.

The standard does not close this. Something else has to.

---

## 2. Ledger: the vendor signs, and the device checks

Ledger is where the thing is actually deployed, and Ledger's mechanism is
documented at the byte level in `LedgerHQ/app-ethereum/doc/`. This is the most
useful part of the spike, because it shows authenticity being solved *outside*
the JSON.

### 2a. The old world: per-dapp plugins

Historically, clear signing on Ledger meant a **plugin**: a separate small
device application (`app-plugin-*`, e.g. `app-plugin-coinbase`) that the ETH app
called to interpret a specific contract's calldata. From
`doc/ethapp_plugins.adoc`: "An external plugin is a library application named
after the base64 encoding of the 20 bytes smart contract address." Each plugin
is a state machine fed 32 bytes of ABI data at a time. Plugin development
[requires prior approval from Ledger](https://developers.ledger.com/docs/device-app/integration/how-to/plugin).

The binding — *this contract and this selector are handled by this plugin* — is
supplied by the host and **signed**. From
[`doc/apdu.md`, SET EXTERNAL PLUGIN](https://github.com/LedgerHQ/app-ethereum/blob/develop/doc/apdu.md):

> The signature is computed on:
> `len(pluginName) || pluginName || contractAddress || methodSelector`
> signed by the following secp256k1 public key:
> `0482bbf2…78f353`

A raw secp256k1 public key, compiled into the app. The host may deliver the
binding; it cannot forge one. Same shape for token metadata — PROVIDE ERC 20
TOKEN INFORMATION, legacy P1=00, signs
`ticker || address || decimals || chainId` under another hardcoded key
`045e6c10…979183`. That is how the device knows "USDC, 6 decimals" is not the
host's invention.

Why plugins died: they don't scale. Every protocol needed Ledger to review,
build, sign and ship a firmware app.

### 2b. The new world: the Generic Parser, still vendor-signed

In 2025 Ledger shipped the **Generic Parser** — one on-device parser that reads
ERC-7730-derived metadata instead of one app per protocol
([Ledger blog](https://www.ledger.com/blog-generic-parser-erc7730)). Marketing
describes it as "dApps submit JSON files." The interesting part is what happens
to that JSON before it reaches the device.

It does **not** reach the device as JSON. Ledger's backend — the **CAL**, Crypto
Asset List — compiles the descriptor into TLV structures and signs them. From
[`doc/tlv_structs.md`](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/tlv_structs.md),
the `TRANSACTION_INFO` struct:

| Tag | Field | Source |
|---|---|---|
| 0x01 | CHAIN_ID | `$.context.contract.deployments[].chainId` |
| 0x02 | CONTRACT_ADDR | `$.context.contract.deployments[].address` |
| 0x03 | SELECTOR | the 4-byte selector |
| 0x04 | FIELDS_HASH | "SHA3-256 hash of all the FIELD structs — **computed by CAL**" |
| 0x05 | OPERATION_TYPE | `$.display.formats.<selector>.intent` |
| 0x06–0x0a | CREATOR_NAME, CREATOR_LEGAL_NAME, CREATOR_URL, CONTRACT_NAME, DEPLOY_DATE | `$.metadata.*` |
| 0xff | SIGNATURE | "signature of all the other struct fields — **computed by CAL**" |

And the `FIELD` struct — the individual labels and formats — carries no
signature of its own, for a reason the doc states explicitly:

> "It contains no signature since the signed TRANSACTION_INFO struct already has
> a hash of all the FIELD structs, which attests of the authenticity, order and
> completeness of all FIELD structs."

That is a clean design. One signature over a header that binds chain, contract,
selector and a hash of the entire ordered field list. Reorder a field, add one,
drop one, relabel one — the hash breaks. Point the descriptor at a different
contract — the binding breaks. The device streams fields, hashes them, compares.

Newer paths verify through **Ledger PKI** rather than a bare hardcoded key: the
TLV token descriptor (P1=01) is "signed via the Ledger PKI (key usage
`COIN_META`)", and "the signature covers the SHA-256 hash of all TLV fields
except the SIGNATURE tag itself" (`doc/apdu.md`). The SDK gained TLV +
PKI helpers for exactly this
([ledger-secure-sdk PR #1118](https://github.com/LedgerHQ/ledger-secure-sdk/pull/1118)).
So the anchor moved from "a constant in the app binary" to "a certificate chain
rooted in Ledger's OS", but it is the same claim: *Ledger vouches for this
metadata.*

Two more details worth stealing:

- **`VISIBLE: MUST_BE`** — a field that is not displayed but "must match one of
  the constraint values, otherwise tx is rejected". A signed assertion about
  calldata the user never sees. This is a constraint, not a caption, and it is
  the one descriptor feature that *adds* security rather than just legibility.
- **Descriptors expire.** `NOT_VALID_AFTER` (app version) on trusted names;
  `CHALLENGE` for freshness. Signed data that never expires is signed data
  forever replayable.

### 2c. What Ledger's answer actually is

> **What stops a compromised host sending a descriptor that makes a drain look
> like a deposit?**
>
> Ledger's answer: nothing in ERC-7730. The stop is that the device will not
> render a descriptor unless it verifies under a Ledger-controlled key, and
> Ledger only signs what its registry review process accepted.

Which means the residual risk is not "the host lies" — that's closed — it is
"Ledger's review merged a bad descriptor", or "Ledger's signing key is abused".
The user is trusting Ledger's curation. Confirmed: the trust anchor is the
vendor. The open registry is a *contribution* channel, not a trust channel.

*Unconfirmed:* whether the ERC-7730 registry's merge process involves any
verification of the submitter's control of the contract, and exactly which
Ledger key usage covers `TRANSACTION_INFO` today. The signing is documented; the
governance around who gets signed is not, in the sources I read.

---

## 3. Rabby: rich because it is a computer with a network

Rabby's summaries are richer than anything a hardware wallet shows, and it is
worth being precise about why, because none of the reasons are available to us.

Three layers, per Rabby's own package split
([`RabbyHub/rabby-action`](https://github.com/RabbyHub/rabby-action) depends on
`@rabby-wallet/rabby-api` and `@rabby-wallet/rabby-security-engine`;
[`RabbyHub/web3-security-engine-core`](https://github.com/RabbyHub/web3-security-engine-core)):

1. **ABI decoding / action parsing** — calldata to a named "action"
   (approve, swap, send, permit…).
2. **Pre-execution (simulation)** — the transaction is executed against current
   chain state on a fork, and the result is shown as *balance changes*: what
   leaves your account, what arrives. This is the feature people actually mean
   when they praise Rabby. It sidesteps ABI knowledge entirely — you do not need
   to understand a call to observe that it moves 4.2 ETH out.
3. **Security engine** — a rule set over the parsed action and the simulation
   result (unlimited approval, unknown spender, address book mismatch,
   phishing-listed origin) producing warnings.

*Verified:* the package structure and the existence of the three layers.
*Inferred, but strongly:* simulation and the risk data run on Rabby/DeBank
backend services, not in the extension — the extension bundles an API client,
and forking mainnet is not something a browser extension does locally. Treat the
architectural claim as solid and the specific endpoints as unverified.

The important consequence for us: **simulation is the best UX in the space and
is structurally impossible on a signing device.** It needs chain state, an EVM,
and a network. Our device has none of the three. It is also, note, *advisory
even in Rabby* — the simulation is a prediction against a state that can change
before inclusion, and it comes from a server.

So Rabby maps cleanly onto 6c: all three layers are host-side, all three are a
preview. None of it is device-verifiable, and pretending otherwise by piping
Rabby-style summaries to a screen would be the exact anti-pattern 6bis names —
"a gorgeous 'Sending 1 ETH to vitalik.eth' over a device screen showing a bare
hash *is* blind signing, with better lighting."

Where Rabby is genuinely instructive is the *warning taxonomy*. Unlimited
approval, spender you have never interacted with, recipient not in your address
book — those are cheap rules over fields the device already decodes itself. We
already do the first one.

---

## 4. Trezor: no plugins, and a signature scheme worth copying

Trezor has a screen and no plugin ecosystem, and its answer to unknown contract
calls is roughly ours: decode the standard shapes, and otherwise tell the truth.
For non-standard calldata it shows the contract as unknown and confirms the data
blob rather than narrating it; the community-visible symptom is the "Unknown
contract address" warning that fires on anything that isn't ERC-20-shaped
([trezor-firmware#6032](https://github.com/trezor/trezor-firmware/issues/6032),
[#5045](https://github.com/trezor/trezor-firmware/issues/5045)). *Partly
inferred* — I read the issue titles and support pages, not the display code.

The part that is fully documented, and directly useful to us, is
**[external definitions](https://github.com/trezor/trezor-firmware/blob/main/docs/common/external-definitions.md)**.
Trezor needs token symbols and chain names it cannot fit in flash. Its solution:

- A **subset is baked into firmware** (`common/defs/ethereum/networks.json`,
  `tokens.json`) — the common chains and tokens, edited by hand.
- The **full set is compiled, signed, and served** from
  `https://data.trezor.io/firmware/definitions/`, fetched by the *host* and
  passed to the device with the transaction.
- Each definition is a small binary blob: magic `trzd1`, type, data version,
  protobuf payload. A **Merkle tree** is built over all definitions and **the
  root is signed with CoSi**. Each definition ships with its Merkle proof
  (`n` × 32-byte neighbour hashes) plus the CoSi sigmask and 64-byte signature.
- **Definitions expire**: "A given Trezor firmware will only accept signed
  definitions newer than a certain date, typically one month before firmware
  release."

That is the third independent confirmation of the same architecture: *host
delivers, vendor signs, device verifies, and the signature expires.* Note the
elegance of the Merkle construction — the device verifies one signature over a
root, and a single 32-byte-per-level proof lets it accept one definition out of
tens of thousands without holding any of the rest. On a device with 250 KB of
RAM that property is not cosmetic; it is the whole reason the scheme fits.

---

## 5. What is actually feasible on a 128x64 OLED

Constraints, stated plainly, because they do most of the deciding:

- **21 characters per line**, a handful of lines. A descriptor's `intent` string
  and three labelled fields is already several screens of paging. Ledger's
  Nano-class screens are similar and this is why their format is intent + a
  short ordered field list, not prose.
- **~250 KB free RAM.** A JSON parser over an arbitrary registry file is out.
  Ledger reached the same conclusion — the device never sees JSON, only TLV
  compiled by a backend. Any descriptor path here must be a fixed-layout binary
  streamed and hashed, never parsed as text.
- **No network.** The device cannot fetch a descriptor, cannot check a
  revocation list, cannot know today's date except as far as it trusts the host.
  Expiry-by-firmware-version (Trezor's trick) works; expiry-by-wall-clock does
  not.
- **Every displayed byte must be verifiable by the device.** This is the
  binding constraint from 6c and it eliminates the easy version of this feature
  entirely.
- **We are not Ledger.** The vendor-signing model requires a signing key we
  operate, a review process for what gets signed, and a revocation story. For an
  Apache-2.0 hobby-scale firmware, standing up "the LeekWallet metadata
  authority" is a governance commitment far larger than the code.

There is also a subtler cost. A signed-descriptor path adds an entire second
class of trusted input to the protocol — new parser, new signature check, new
key management, new failure modes — in service of *legibility*, not custody.
The existing decoder is exact-or-refuse and about 400 lines. That asymmetry
should weigh heavily.

### The three options, judged

**(a) Bundled descriptor set, signed at build time.**
Ship a compiled table of `(chainId, contract, selector) → intent + field
layout` inside the firmware image. Authenticity is free: it is covered by
whatever signs the firmware, and the user already trusts that. No host input, no
new key, no expiry problem.
The cost is flash and firmware churn — but note this is *the same cost we
already pay for hardcoded selectors*, just expressed as data instead of C. That
is the real win: it moves "add a protocol" from "write and review a parser" to
"add a table row and cut a release", and it makes the decodable set auditable at
a glance. It does not remove the release cycle, and anyone claiming it scales to
the whole registry is wrong — a few dozen entries, chosen deliberately, is the
honest ceiling.
Notably, this is also exactly what Trezor does for its *built-in* subset, and
what [PROTOCOL.md 6d](PROTOCOL.md) already commits us to for tokens (T51): "A
short verified list the device owns beats a long list it has to trust."

**(b) Fetched descriptors, verified on-device against a key we control.**
The Ledger/Trezor model. Technically achievable — TLV or Trezor's
Merkle-proof-plus-one-signature scheme both fit comfortably in our RAM, and the
verification code is small (we already have secp256k1 and SHA-256). The
engineering is not the problem.
The problem is everything around it: we would have to run the signing key, the
build pipeline that converts registry JSON to signed blobs, and — the hard part
— a review process deciding which descriptors are true. A signing key with a
lax review process is worse than no key, because it converts "the host said so"
into "the device verified it", which is precisely the manufactured confidence
this project refuses to sell. Alternatively we pin *Ledger's* public keys and
consume their CAL — which is technically the cheapest path and means telling our
users their transaction labels are underwritten by Ledger's business. That is a
defensible choice but it must be said out loud, not buried.
Realistic verdict: right architecture, wrong project size, for now.

**(c) Status quo: hardcoded selectors, refuse everything else, opt-in blind
signing (T16).**
Currently correct and currently honest. Its failure mode is a refusal — the Aave
faucet incident — which is the *safe* failure. Its cost is that legitimate dapp
use requires the user to enable blind signing, at which point they get a hash
and the app's preview, and the security guarantee reduces to "the app is
telling the truth". That is a real loss, and it is why (a) is worth doing:
every descriptor added is one more interaction that does *not* push a user
toward the blind-signing toggle.

**What should not be done at all:** rendering host-supplied descriptor text on
the device without a signature check. Not "temporarily", not "behind a flag",
not "with a warning banner". A device that will print host-chosen labels is
strictly worse than one that prints a hash, because the hash does not lie and
the label does. If we ever ship (b) and the signature check fails, the correct
behaviour is to fall back to the hardcoded decoder or refuse — never to the
unverified labels.

---

## 5b. The registry is public, and that changes what is worth doing now

Confirmed from Ledger's dapp-facing documentation, which is the other half of
the picture and sharpens the staging below.

A protocol author writes a descriptor and opens a pull request against
**`github.com/ethereum/clear-signing-erc7730-registry`** — the Ethereum
Foundation's repository, canonical home `clearsigning.org`, not Ledger's.
Automated checks run first (schema, linting, ABI and deployment consistency),
then a maintainer reviews; the documented rejection reasons are mismatched
contract addresses, misleading display labels and schema violations. On merge
the descriptor "becomes available … in all wallets that support the Clear
Signing standard, and through the public registry API".

Two things follow, and they point in opposite directions.

**The corpus is ours to read.** It is public, reviewed, and explicitly meant to
be consumed by any compatible wallet — not a Ledger asset we would be
borrowing. For the companion app's preview, which is advisory by construction
anyway (section 3, PROTOCOL.md 6c), a reviewed descriptor is strictly better
than the four selectors we hardcode: it is the difference between "unknown
call" and "Supply 100 USDC to Aave v3". That is available now, costs no trust
we are not already spending, and is most of what a user means when they ask for
Rabby-style readability.

**It buys the device nothing on its own.** Note what the dapp-side
documentation does *not* mention anywhere: signing, device trust, or the CAL.
That silence is consistent — registry review is a *quality* gate run by
maintainers, and the cryptographic step that lets a Ledger device believe a
descriptor happens later and elsewhere, under Ledger's key (section 2). A
descriptor pulled from the registry arrives at our firmware as host-supplied
data with no signature our device can check, and rendering it on the OLED would
be precisely the thing PROTOCOL.md 6c forbids. Merged-by-a-maintainer is a
reason to trust it in a browser window; it is not a signature.

So: read the registry in the app, sign our own subset for the device.

## 6. Recommendation, staged

### Now (worth doing, small)

1. **Nothing in the descriptor direction on the device.** Keep exact-or-refuse.
   Finish T16 (the blind-signing gate) as designed — it is the honest hatch and
   it must ship *with* `signHash`, never after.
1b. **Consume the ERC-7730 registry host-side**, in the app's preview only,
   under the existing advisory framing and never echoed to the device screen.
   See 5b: it is public, reviewed and meant to be read.
2. **Make the refusal actionable.** `0x0202` already names the selector it
   refused (commit `c862c70`). The app should turn that into a preview of what
   the call *would* have been — clearly labelled advisory, per 6c — so the user
   understands what was refused and why, rather than hitting a dead end.
3. **Adopt the ERC-7730 *vocabulary* host-side.** The app's preview layer should
   consume registry descriptors — it is a host, it has a network, its output is
   already advisory, and this costs no device trust whatsoever. This is where
   Rabby-grade legibility belongs and it is free of the authenticity problem
   because nothing it produces is presented as verified.

### Next (worth doing, medium)

4. **Build the bundled signed-at-build-time descriptor table — option (a).**
   *Done, and cheaper than described: because a selector IS the hash of its
   signature, bundling the signature string makes the table verify itself and
   the "signed at build time" half is unnecessary. Firmware signing still
   covers the table, but nothing rests on it.*
   Generate it from the ERC-7730 registry at build time, review the generated
   table as source, and compile it to a fixed-layout binary blob inside the
   firmware. Steal Ledger's structure: `(chainId, contract, selector) → intent
   string + ordered field list`, with formats restricted to what a 21-column
   screen can render (address, raw amount, token amount, enum). Keep the
   entry count small enough that a human can read the whole table.
   Two features worth porting on day one: Ledger's `VISIBLE: MUST_BE`
   constraint — assert on a field you do not display, and refuse if it does not
   match — and their rule that a partial match is a refusal, which we already
   enforce in `src/eth-decode.c`.
5. **Bind the table to the firmware version in the protocol**, so the app can
   tell the user "your device does not know this contract; firmware 1.4 does"
   rather than presenting a bare refusal.

### Later (only with a real reason)

6. **Fetched, device-verified descriptors — option (b).** Revisit only if the
   bundled table demonstrably runs out of room, *and* there is a maintainer
   willing to own a signing key and a review process. If it happens, copy
   Trezor: Merkle root signed once, per-entry proof, expiry pinned to firmware
   version. Do not invent a scheme.
7. **Consuming Ledger's CAL by pinning Ledger's keys.** Technically the cheapest
   route to breadth. Only with an explicit, user-visible statement of what it
   means. Ranked last not because it is insecure but because it silently
   outsources our trust anchor to a company we do not control.

### Never

8. Rendering unverified host-supplied labels on the device screen, in any form.
9. On-device JSON parsing of registry files.
10. Remote ABI lookup initiated by the device. (The app doing it is already
    covered by 6c: it leaks what you are about to sign, so it stays opt-in and
    disclosed.)

---

## 7. Consistency with PROTOCOL.md

Nothing here asks to change 6bis or 6c. The spike *strengthens* them: three
independent vendors, given far more silicon and staff than this project has,
all converged on the same rule — **host delivers, vendor signs, device
verifies** — and the one standard that tried to skip the signing step
explicitly punted it to registries and told wallets never to present untrusted
information as verified.

The one place the existing text could be sharpened: 6bis frames the decodable
set as something that "should grow deliberately", listing selectors. After this
spike, the better framing is that it should grow as a **signed table**, and that
the signature covering it is the firmware's — because the mechanism by which a
label becomes trustworthy is the interesting part, not the length of the list.

---

## Sources

Primary:

- [EIP-7730: Structured Data Clear Signing Format](https://eips.ethereum.org/EIPS/eip-7730) — status, format, security considerations
- [ethereum/clear-signing-erc7730-registry](https://github.com/ethereum/clear-signing-erc7730-registry) — submission process, index files
- [LedgerHQ/app-ethereum `doc/apdu.md`](https://github.com/LedgerHQ/app-ethereum/blob/develop/doc/apdu.md) — SET EXTERNAL PLUGIN and PROVIDE ERC 20 TOKEN INFORMATION signature schemes and hardcoded public keys; Ledger PKI key usage `COIN_META`
- [LedgerHQ/app-ethereum `doc/tlv_structs.md`](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/tlv_structs.md) — TRANSACTION_INFO / FIELD / ENUM_VALUE structs, FIELDS_HASH, CAL signature, VISIBLE constraints
- [LedgerHQ/app-ethereum `doc/ethapp_plugins.adoc`](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/ethapp_plugins.adoc) — external plugin model
- [trezor-firmware `docs/common/external-definitions.md`](https://github.com/trezor/trezor-firmware/blob/main/docs/common/external-definitions.md) — Merkle tree + CoSi signed definitions, expiry, built-in subset

Secondary / vendor marketing:

- [Ledger: Introducing Generic Parser & ERC-7730](https://www.ledger.com/blog-generic-parser-erc7730)
- [Ledger Developer Portal: Clear Signing for wallets](https://developers.ledger.com/docs/clear-signing/for-wallets) — context module, `originToken`
- [Ledger Developer Portal: how to develop an Ethereum plugin](https://developers.ledger.com/docs/device-app/integration/how-to/plugin)
- [ledger-secure-sdk PR #1118](https://github.com/LedgerHQ/ledger-secure-sdk/pull/1118) — TLV library and PKI helper
- [RabbyHub/rabby-action](https://github.com/RabbyHub/rabby-action), [RabbyHub/web3-security-engine-core](https://github.com/RabbyHub/web3-security-engine-core)
- [trezor-firmware#6032](https://github.com/trezor/trezor-firmware/issues/6032), [#5045](https://github.com/trezor/trezor-firmware/issues/5045)

Could not confirm: the governance of ERC-7730 registry merges (who verifies a
submitter controls the contract); which Ledger PKI key usage covers
`TRANSACTION_INFO` specifically; the exact Rabby backend endpoints performing
pre-execution; the precise Trezor firmware code path for non-ERC-20 calldata
display.
