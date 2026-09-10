# Hedera ATS — the issuer console

Required by the audit gates of C1, C2 and C3 in `docs/HACKATHON-MILESTONES.md`.
This file records what the console does, what the contracts actually offer, and
what has and has not been done on a chain.

## Status, stated plainly

| Milestone | State |
|---|---|
| C1 — chain support | done |
| C1 — a deployed asset | **one equity deployed, and it cannot be minted.** See below. |
| C2 — issuer dashboard | done, exercised against a fixture only |
| C3 — dividend declaration and reconciliation | done, never run against a chain |
| Secondary market contract | written, 21 tests green, Slither-clean, **not deployed** |
| Secondary market deployment path | scripted and dry-run against the live chain, **not broadcast** |

**One thing in this app has touched Hedera: a single equity, deployed and then
found to be inert.** Everything else the console draws is `FIXTURE_ADDRESS`,
and every figure carries `FIXTURE_NOTICE`:

> Fixture data. This is a constructed example, not a security read from a chain
> — no figure on this screen came from Hedera.

That notice is not decoration. Until securities are deployed *and minted*
(`app/packages/apps/ats/contracts/RUNBOOK.md`), it is the honest description of
every number here.

### The one deployed equity, and what is wrong with it

| | |
|---|---|
| Address | `0x651e73ebcf18ef7e050c90af0461d91d640635bb` (`0.0.10461772`) |
| Name / symbol | `LeekWallet` / `LEEK`, 6 decimals |
| Max supply | 1,000,000 shares (`1e12` base units) |
| Total supply | **0** |
| Admin | `0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45` (`0.0.7307292`) |
| Compliance / Identity registry | both zero — correct, see below |
| `isControllable` | true |
| `isInternalKycActivated` | false |

**It was deployed with `DEFAULT_ADMIN_ROLE` and nothing else, so `mint`
reverts.** Verified by `eth_call` on 2026-09-10:

```
hasRole(ROLE_ISSUER, 0x9c77c6…) -> false
mint(0xbDEB…, 1000000)          -> AccountHasNoRole(caller, [ROLE_ISSUER, ROLE_AGENT])
```

The admin can grant itself `ROLE_ISSUER` and recover it. The deployment scripts
take the other path and grant all twelve roles the console's privileged surface
needs at birth, because a security that has to be repaired before it can be used
is a security somebody will forget to repair.

### Deployment facts, re-derived 2026-09-10

Against the chain, not from documentation. Full derivation in
`app/packages/apps/ats/contracts/RUNBOOK.md` §0.

| Fact | Value |
|---|---|
| `deployEquity` selector | `0x837b37b6` |
| `deployBond` selector | `0x29002951` |
| Equity facet config | key `bytes32(1)`, version 1 |
| Bond facet config | key `bytes32(2)`, version 1 |
| Factory EVM alias (what appears in logs) | `0xd1f118a40f3b02883d35909ef2517e7edd78379d` |

**`docs/ATS-DEPLOY-C1.md` records `0x29002951` as `deployEquity`. That is
wrong — it is `deployBond`.** Both were re-derived with `cast sig` from the
canonical signatures and then confirmed by ABI-decoding live calldata of each
shape off the mirror node: the `0x837b37b6` call decoded to this project's own
LEEK equity, a `0x29002951` call to somebody else's `Demo Bond 2026`. The equity
deploy that document describes did happen; it is recorded under the wrong
selector. `script/IAtsFactory.sol` asserts both selectors at run time.

### Why ERC-3643 stays off

`compliance` and `identityRegistry` are zero on every security here, and
`internalKycActivated` is false, and that is a decision rather than an omission.
`_validateIdentifiedAccount` staticcalls `isVerified` on the identity registry;
the package's `LowLevelCall.functionStaticCall` returns empty for a zero target
and the check passes, and `verifyKycStatus` short-circuits to true while
internal KYC is deactivated. Point either field at a contract that does not
exist and **every mint and every transfer reverts**. `ROLE_KYC` and
`ROLE_INTERNAL_KYC_MANAGER` are granted anyway, so the issuer can turn internal
KYC on later from the console — as a deliberate act, on the device, with a
screen in front of it.

## Facts

| | |
|---|---|
| Chain id | 296 (`0x128`), Hedera testnet |
| RPC | `https://testnet.hashio.io/api` |
| Factory | `0.0.9213391` = `0x00000000000000000000000000000000008c95cf` |
| Resolver | `0xba2d5fc2083a0b8f164c50e65d782087fba18e0a` |
| Contracts | `@hashgraph/asset-tokenization-contracts` 8.0.0, Apache-2.0 |

The resolver is not published in the npm package; it was recovered by decoding
the factory's own `deployEquity` calls on the mirror node. See
`docs/ATS-DEPLOY-C1.md` §0 for the derivation and the command to repeat it.

## The privileged surface

Thirteen actions rendered through the shared ERC-7730 engine, each with a
descriptor and a consequence line, plus two more rendered by a
purpose-built decoder (below). **A privileged call with no descriptor
refuses** — it does not render the selector, and does not show raw calldata
with a warning:

`grantRole`, `revokeRole`, `revokeKyc`, `pause`, `unpause`, `lock`, `mint`,
`setMaxSupply`, `setAddressFrozen`, `freezePartialTokens`, `addToControlList`,
`removeFromControlList`, `setDividend`.

Why refusal is the default: an unlabelled screen on an irreversible action
manufactures confidence. The user sees a wallet that has clearly examined the
transaction and infers that a wallet which examined it and did not object has
nothing to object to. Every path that does not end in a complete screen ends in
`refuse()`, and each has a test — including `test/app.test.ts`'s "H4: with the
descriptor removed, the console refuses and never asks", which proves the rule
by deleting a descriptor.

Verification that holds these honest, all in `app/packages/apps/ats/test/`:

- every action's signature is a function these contracts declare;
- all 37 role ids match `contracts/constants/roles.sol`;
- the unrenderable list names real functions, none of which parse;
- nothing here claims to be verified — no host-derived label is presented as
  device-attested.

### Compliance controls: `controllerTransfer` and `grantKyc`

The shared ERC-7730 engine (`packages/core/src/erc7730.ts`) refuses every
signature with a `bytes` or `string` argument, on principle: it will not
follow an offset it cannot bounds-check, for any descriptor set that uses it.
That refusal is correct and stays in place. But two of the calls it refuses —
`controllerTransfer(address,address,uint256,bytes,bytes)` (a forced transfer)
and `grantKyc(address,string,uint256,uint256,address)` (granting KYC) — are
exactly the compliance-control actions this track's extra-points item names,
and hiding them behind a generic refusal was a worse trade than writing a
second, narrower decoder for just these two shapes.

`action.ts`'s `decodeDynamicTail` is that decoder. It does not "follow"
offsets so much as predict them: from the declared head shape it recomputes
where a canonical ABI encoder must have placed each dynamic segment
(tightly packed, in head order, zero-padded to a whole word), and refuses
unless the actual calldata matches that prediction exactly — no gap, no
overlap, no reordering, no unaccounted trailing bytes, no nonzero padding
past the declared length. There is no reading of a malformed offset; there is
only "this is canonical" or "refused".

The two screens say what they can and no more:

- **Force transfer** states plainly that shares move *without the holder's
  consent*. The two `bytes` fields (`_data`, `_operatorData`) are shown as
  opaque hex, truncated for the screen only — never interpreted, because the
  contracts declare no meaning for them.
- **Grant KYC** shows the holder, the validity window, the issuer, and the
  credential id as sanitised text (the same treatment `name()` already gets)
  — explicitly labelled as unverified, host-decoded text, not a value checked
  against any registry.

`test/conformance.test.ts` re-derives both signatures and every parameter name
from the same compiled ABI as `ACTIONS`, and additionally asserts that the
shared engine still refuses to parse them — the decoder exists because that
refusal is correct, not despite it. `test/descriptors.test.ts` pins a group of
malformed-offset/length fixtures (misaligned offset, skipped offset, an
over-long declared length, nonzero padding, trailing calldata) that must all
refuse rather than render.

`issue`, `issueByPartition` and `applyRoles` remain unrendered — not because
they are harder to bounds-check, but because nobody has yet written their
consequence wording.

## C3 — what the contracts actually do

C3's plan reads: *"`Dividend.setDividend()` against a snapshot, then
distribution."* **The contracts cannot do that in one call, and the design is
arranged around the difference.**

Verified against `@hashgraph/asset-tokenization-contracts` 8.0.0:

```solidity
// contracts/facets/dividend/IDividendTypes.sol
struct Dividend {
    uint256 recordDate;
    uint256 executionDate;
    uint256 amount;
    uint8   amountDecimals;
}
// contracts/facets/dividend/IDividend.sol
function setDividend(Dividend calldata newDividend) external returns (uint256 dividendId_);
```

Two consequences:

1. **`setDividend` declares a corporate action. It moves no money.** There is no
   `payDividend`, and no `distribute`, anywhere in the package — checked by
   searching every contract. The register binds its own snapshot when the record
   date is reached and then answers `getDividendAmountFor(id, holder)`; the
   actual payment is a transfer of some other token, made by the issuer.
2. **`setDividend` takes no snapshot id.** So the snapshot on the screen is one
   this console *read* — `totalSupplyAtSnapshot(id)` and the holder balances at
   that id — and the screen says which id it used. If the register changes
   between the reading and the record date, the contract will bind a different
   set. The screen says what it knows and quotes what it does not.

### THE PROPERTY

> A distribution whose total does not equal per-share × snapshot supply refuses.

Asserted twice, deliberately — at the planner and again at the encoder — so
neither path can drift alone while the other keeps the suite green. Around it:

- holders' balances must add up to the snapshot's supply;
- every holder's amount is a whole number of payment units, or nothing is —
  a rate that cannot pay some holder a whole unit is refused, and the remedy
  (a finer per-share figure, or a token with more decimals) is the issuer's;
- the allocations sum to exactly the total shown on the device;
- a zero-supply or zero-rate distribution has nothing to reconcile.

### Resumability

A partial payout resumes and never pays a holder twice; a ledger belonging to a
different distribution refuses rather than resuming. An unknown outcome stops
the run rather than retrying it, and a throw out of `propose` is recorded as
*uncertain*, not as a failure to pay — retrying an uncertain payment is how a
holder gets paid twice.

## The secondary market

`app/packages/apps/ats/contracts/` holds `AtsEscrowMarket`, a market that does
not check whether a trade is allowed: it attempts both legs and lets the
security's own guards revert it. Design and rationale in
`app/packages/apps/ats/docs/SECONDARY-MARKET-SPEC.md`; the review in
`contracts/AUDIT-REPORT.md`. 21 tests, 10,000-run fuzz, Slither-clean.

It settles in **native HBAR** by default (`PAYMENT_TOKEN == address(0)`), and
the reason is worth recording: on Hedera an HTS token cannot be received by an
account that has not associated with it, and none of this project's accounts
holds any HTS token — the Circle faucet delivered nothing. HBAR needs no
association. A token leg still exists and the constructor associates through the
system contract at `0x167`, but **no test covers that path and none can**: a
local chain has no code at `0x167`. The runbook makes proving it a step.

`priceTotal` on the native leg is in **weibar** (1 HBAR = 1e18), not tinybar —
`msg.value` is 18-decimal on Hedera's EVM while HBAR itself has 8. The listing
script takes whole HBAR and does the multiplication, so that number is never
typed by hand.

## Running one round of deployments

`app/packages/apps/ats/contracts/RUNBOOK.md` is the single procedure, from key
import to a filled trade. In outline:

```bash
cd app/packages/apps/ats/contracts
cast wallet import hedera-deployer --interactive
cast wallet import buyer --interactive

N=3 forge script script/DeploySecurities.s.sol:DeploySecurities --rpc-url $RPC --account hedera-deployer --broadcast --slow
./script/addresses.sh                       # the REAL addresses, from receipts

SECURITY=$SEC HOLDERS=0xbDEB…,0xe7df…,$ISSUER SHARES=1200,800,500 \
  forge script script/MintAndDistribute.s.sol:MintAndDistribute --rpc-url $RPC --account hedera-deployer --broadcast --slow

PAYMENT_TOKEN=0x0 forge script script/DeployMarket.s.sol:DeployMarket --rpc-url $RPC --account hedera-deployer --broadcast

MARKET=$MARKET SECURITY=$SEC SHARES=100 PRICE_HBAR=25 \
  forge script script/ListAndFill.s.sol:ListLot --rpc-url $RPC --account hedera-deployer --broadcast
MARKET=$MARKET LISTING_ID=1 \
  forge script script/ListAndFill.s.sol:FillLot --rpc-url $RPC --account buyer --broadcast
```

`N=3` plus the bond dry-ran successfully against a fork of the live chain on
2026-09-10 — the structs, the resolver, the facet config keys and the ISIN check
digits are all confirmed by that run. It was **not broadcast**: the estimate was
~11.1M gas per security, ~105 HBAR for the four, against a deployer holding 141.
Choosing the account and the value of `N` is the operator's call, and the runbook
says so rather than assuming.

## What must happen before any of this is evidence

1. Broadcast the deployments — `contracts/RUNBOOK.md` §4.
2. Mint, so the register has holders — §5. Then paste an address into
   **Read register**; the fixture notice should vanish because the figures are
   real.
3. Deploy the market and prove a trade end to end — §6 to §8.
4. Grant a role, then revoke it, photographing the device screen each time.
5. Declare one dividend against a real snapshot and reconcile it.
6. **Record every deployed address, transaction hash and the admin account in
   the table below.** A deployment nobody wrote down is a deployment nobody can
   reproduce.

### Deployed securities

| Symbol | Address | Hedera id | Tx hash | Admin |
|---|---|---|---|---|
| `LEEK` | `0x651e73ebcf18ef7e050c90af0461d91d640635bb` | `0.0.10461772` | `0x80c31d518c29f7203da71c631ded2ebfdf57bde46af51963cf3ef91f27f3ba7f` | `0x9c77c6…6e45` |

Nothing else has been deployed. Until this table grows, this document describes
a console that works, a market that is tested, and one token that has never been
used.


---

## Deployed securities — Hedera testnet, 2026-09-10

Broadcast with `script/DeploySecurities.s.sol`, issuer
`0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45` (`0.0.7307292`). Cost 18.12 HBAR
for all four. Every field below was verified afterwards by direct `eth_call`,
not taken from the broadcast log.

| Symbol | Address | Type | Max supply | Supply | `hasRole(ISSUER, issuer)` |
|---|---|---|---|---|---|
| LEEKA | `0x188fd9e330d22edd3381b21715d0a1722206b43f` | equity | 1,000,000 | 0 | **true** |
| VGF1 | `0xaab4b09e4691ec2284399a6a27466a498051bb23` | equity | 250,000 | 0 | **true** |
| HRBR | `0x653bfb114985583e30a80b62a81f5bad1d4852eb` | equity | 5,000,000 | 0 | **true** |
| LEEKB | `0x512988f3e1a2fc5da6fa65daffd35bb7437a3c84` | bond | 100,000 | 0 | **true** |

All 6 decimals. Transaction hashes are in
`app/packages/apps/ats/contracts/broadcast/DeploySecurities.s.sol/296/run-latest.json`.

**The ISSUER column is the point.** The earlier pilot equity
`0x651e73ebcf18ef7e050c90af0461d91d640635bb` (`LEEK`, `0.0.10461772`) was
deployed with `DEFAULT_ADMIN_ROLE` only, so it can never be minted and its
supply is permanently 0. These four grant ISSUER at birth, which is why they
can. Do not confuse the two: **LEEK is the dead pilot, LEEKA is the live one.**
