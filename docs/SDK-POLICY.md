# Using the sponsors' SDKs

Judges check that a project used the sponsor's SDK rather than only calling
contracts. That is a fair check, and the current state does not pass it:

| Sponsor | SDK | Used today? |
|---|---|---|
| 1inch | `@1inch/aqua-sdk` **0.3.1** | ❌ hand-rolled encoders |
| Hedera | `@hashgraph/asset-tokenization-sdk` **8.0.0** | ◐ its contracts package is the authority for every signature and role id (E3); its ports are not used at runtime — see below |
| Circle | `@circle-fin/app-kit` **1.14.0** | ❌ not at all |

All four packages are published and installable. An earlier note in this repo
said the Aqua SDK was unpublished; that was wrong.

## The rule

**Use the SDK for everything it does well. Replace only its wallet layer, and
say why.**

Every one of these SDKs assumes a hot key — MetaMask, WalletConnect, a custody
API. This project's whole thesis is that the key is on a device and the user
presses a button. So:

- **Encoding, decoding, addresses, hashing, event parsing, reads** — the SDK.
  There is no reason to reimplement `calculateStrategyHash` when it is
  `keccak256(strategy)` in a package that already ships it.
- **Signing** — ours. The SDK builds the call; the device approves it.

That substitution is not a weakness in the submission, it is the submission.
"We used the SDK and gave it a hardware signer" is a stronger sentence than "we
used the SDK", and it is true.

## What must remain true

An SDK is a dependency in a wallet, so three rules survive contact with it:

1. **An SDK never gets a key, a seed, or the transport.** It produces calldata
   or reads chain state. If a call wants a signer, that call is not for us.
2. **What the device shows is decoded by us, not by the SDK.** A screen drawn
   from an SDK's own formatting is a screen we cannot audit. The SDK may build
   the bytes; the description of those bytes on the device is ours.
3. **An SDK cannot widen a refusal.** `DEVICE_DRAWN_KINDS` and the descriptor
   rule apply the same whether the calldata came from a helper or from us.

Rule 2 is the one that matters most and is easiest to lose: the point of the
device is that it says what the bytes do, independently of whatever built them.

## Per app

**Aqua** — `AquaProtocolContract` for `ship`/`dock` encoding, `calculateStrategyHash`,
and the `Shipped`/`Pushed`/`Docked` event decoders. Our firmware decoder stays:
it is the device's independent reading of the same bytes, which is exactly rule 2.

**Hedera ATS** — revised at E3, with the package installed and measured rather
than reasoned about. `docs/apps/HEDERA-ATS.md` §2 has the detail; the summary:

- **Adopted:** `@hashgraph/asset-tokenization-contracts` 8.0.0, the SDK's own
  pinned contracts dependency, as the authority for every function signature
  and all 37 role ids, enforced by `conformance.test.ts`. It caught two bugs
  that had passed review — `lock` with its arguments in the wrong order, and a
  `grantKyc` that existed only on a mock.
- **Not adopted:** the `Role`, `Kyc`, `Equity` and `Dividend` ports at runtime.
  Their write methods *execute* rather than returning calldata
  (`Role.grantRole` → `{payload, transactionId}` through the command bus), which
  rule 1 above settles; their read methods build their own ethers provider,
  which routes around `AppContext.request` and with it the user's endpoint
  choice, the failover policy and the CSP allowlist.

Note for the submission: the SDK's wallet layer is `METAMASK`,
`HWALLETCONNECT`, `DFNS`, `FIREBLOCKS`, `AWSKMS` — a browser key or three
custody APIs. **The sixth option should be a hardware wallet the issuer holds**,
and that is what this app demonstrates.

**Circle** — `@circle-fin/app-kit` with `@circle-fin/adapter-viem-v2` for the
CCTP path. This is the largest gap: the Arc app currently uses no Circle tooling
beyond the USDC contract address.
