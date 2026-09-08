# Using the sponsors' SDKs

Judges check that a project used the sponsor's SDK rather than only calling
contracts. That is a fair check, and the current state does not pass it:

| Sponsor | SDK | Used today? |
|---|---|---|
| 1inch | `@1inch/aqua-sdk` **0.3.1** | ⚠️ tests only — **licence**, see below |
| Hedera | `@hashgraph/asset-tokenization-sdk` **8.0.0** | ◐ its contracts package is the authority for every signature and role id (E3); its ports are not used at runtime — see below |
| Circle | `@circle-fin/app-kit` **1.14.0** | ✅ `/chains` subpath is the source for every USDC/EURC address, chain id and CCTP domain (La Caja) |

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

**Aqua** — this was the plan, and the licence stopped it. It is worth reading
before doing the same thing to Hedera or Circle.

`@1inch/aqua-sdk` is `LicenseRef-Degensoft-Aqua-Source-1.1`: source-available,
not open source. Calling the deployed Aqua contracts is unaffected, which is
what `AQUA-1INCH.md` already said — but **putting the package inside a signed
Apache-2.0 release binary is a different act**, and it fails. §2.1 permits
distributing *unmodified* forms while §1.7 counts static linking and "artifacts
shipped together as one product" as a Modification; §5 attaches commercial
triggers, §6 an audit right, §11.3 a bar on assignment, §7.1 a terminating
patent grant, and §5.3's saving waiver is revocable on ten days' notice. Our
`LICENSE` promises every recipient of a release that they carry none of that,
and this project cannot make that promise about code it does not own. Clause by
clause: `THIRD-PARTY-LICENSES.md`.

So the SDK is a **devDependency**, and `app/packages/apps/aqua/test/sdk-parity.test.ts`
uses it for everything the list above named: `AquaProtocolContract` builds every
`ship` and `dock` a second time and the bytes must match ours exactly,
`calculateStrategyHash` must match our hash, and the `Shipped`/`Pushed`/`Docked`
topics and `AQUA_CONTRACT_ADDRESSES` must match our constants. That suite also
asserts no `src/` file imports the SDK, which is what keeps it out of the
bundle.

This is not a retreat from the rule at the top of this file. Two independent
implementations of one ABI, compared byte for byte, is a **stronger** claim than
one implementation would have been — importing the SDK would have collapsed them
into a single source of truth and proved nothing. "We ran the sponsor's own SDK
against ours and the bytes are identical, and then we decoded them on the device"
is the sentence, and it is true.

Our firmware decoder stays regardless: it is the device's independent reading of
the same bytes, which is exactly rule 2. That test now runs **SDK-built**
calldata through it, which is the strongest form of rule 2 available — the
sponsor builds the bytes, and the device still says what they do.

**The general lesson: read the SDK's licence before adopting it, not after.**
Sponsorship is not a licence grant, and "the sponsor wants integrations" is not
one either. Check Hedera's and Circle's before wiring them in — if either is
similarly encumbered, the same test-only shape applies and is equally
submittable.

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
