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


---

## The secondary market is live, and a trade has settled (2026-09-10)

**Market:** `0xCde9596fd89C5368b5Bd46c2B93544Cbb201f8DF`, native HBAR leg,
`PAYMENT_DECIMALS = 8`.

A full lifecycle ran on Hedera testnet: **issue → mint → list → settle.**

| Step | Result |
|---|---|
| 4 securities deployed | LEEKA, VGF1, HRBR + LEEKB bond, ISSUER granted at birth |
| 2,500 LEEKA minted | device 1,200 · funder 800 · issuer 500 |
| 100 shares listed | 25 HBAR, escrowed in the market |
| Filled by a second account | `0xde9d90634b56c0972f7327cb3dd7e5ededc94e70c491b1abae1cb0aa0059154e` |

Verified from chain state afterwards, not from a script's log:

```
seller      400000000   (500 - 100)
buyer       900000000   (800 minted + 100 bought)
market         0        holds neither the security ...
market HBAR    0        ... nor the payment
listing     status 2    Filled
```

The last two lines are the invariant the fuzz suite pins, now true on a real
network rather than in a local EVM.

### What this cost to learn

Four bugs, none of them logic errors in the market, all of them units or
identity:

1. `deployEquity` and `deployBond` selectors were recorded swapped.
2. `mint` was declared `returns (bool)`; it returns nothing. The mint
   **succeeded on chain and then reported failure** — the shape most likely to
   cause a double-mint.
3. `ISSUER`/`SELLER` silently became Foundry's `DefaultSender` three times.
4. HBAR has two units either side of Hedera's relay: a transaction's `value`
   field is weibar, `msg.value` is tinybar. Both halves took a separate failure
   to establish.

Every one was caught by a dry run, a guard, or the exact-value comparison.
Total cost in gas for the failures: **under 0.1 HBAR**.

**And 21 passing tests said nothing about #4**, because a local EVM has no
relay. That is not a weak test suite; it is the limit of what a local runtime
can tell you about a non-local one.

### Not yet demonstrated

A **refused** trade. The market never checks compliance — the security's own
guards do — so the demo worth recording is: freeze or de-KYC the buyer in the
LeekWallet console, signed on the device, and watch the same fill revert. Grant
it back and it settles. That is the compliance story, and it has not been run
on chain yet.

---

## Issuing from the device — `LeekSecurityFactory` (2026-09-11)

The console can now issue a security, find what this wallet has issued, read
what it holds, mint, and send — the four panels above the register. What each
one can and cannot do is below, stated the way the rest of this file states
things.

### The factory

| | |
|---|---|
| Address | `0x3a56974075d734afa5bf7f63e34f9c3237408aed` |
| Chain | 296, Hedera testnet |
| Deploy tx | `0x15ec3da4b3601a4e11ef58210991b33e1773961254b1d150f8623c01186e0353` |
| Deploy block | 40,397,299 |
| Verification | sourcify `exact_match` (runtime `exact_match`) |
| Source | `app/packages/apps/ats/contracts/src/LeekSecurityFactory.sol` |
| Console constant | `LEEK_SECURITY_FACTORY` in `app/packages/apps/ats/src/issue.ts` |
| Scan start | `FACTORY_DEPLOY_BLOCK` in `app/packages/apps/ats/src/discover.ts` |

Confirmed by `eth_call` rather than read out of the broadcast file: `FACTORY()`
is `0x00000000000000000000000000000000008c95cf`, `RESOLVER()` is
`0xba2d5fc2083a0b8f164c50e65d782087fba18e0a`, `MAX_SUPPLY_SHARES()` is
1,000,000, `MAX_BOND_NOTES()` is 100,000, `BOND_TERM()` is 31,536,000 seconds.

Why the contract exists at all: the ATS factory's own `deployEquity` carries
3,748 bytes of calldata and the device holds `ETH_MAX_DATA` (768). The template
moved on chain so the call became `deployEquity(string,string)` — 228 bytes at
this console's maximum name and symbol — and the screen shows the only two
things that vary.

### Signing a deploy — the firmware work, done 2026-09-11

This section previously said a deploy **could not** be signed, and it was right
at the time: `screenProposal` signs a call only when a bundled ERC-7730
descriptor renders every argument, or the firmware draws the call itself
(`DEVICE_DRAWN_KINDS`). `deployEquity(string,string)` can have no descriptor —
`parseSignature` refuses every signature containing a dynamic type, correctly —
so the only route was the firmware one. It has now been taken:

| part | where |
|---|---|
| Firmware decoder | `ats_decode_two_strings()`, `src/eth-decode.c` |
| String accessor | `eth_ats_string()`, same file |
| Device pages | `SIGN_PAGE_ATS_ACTION` / `_NAME` / `_SYMBOL`, `src/ui.c` |
| Host mirror | `decodeTwoStrings()`, `packages/core/src/eth-decode.ts` |
| Admission | `CallKind.AtsDeployEquity` / `AtsDeployBond` in `DEVICE_DRAWN_KINDS` |

**Why this call is drawable when the ATS factory's own is not.** The wrapper
freezes the 3,748-byte template in verified on-chain code, so the name and the
symbol are not a *summary* of what is being signed — they are all of it.
Decimals, max supply, nominal value, regulation, control-list polarity and
which twelve roles land where cannot be varied by the caller. That is the only
condition under which drawing a call is not blind signing with better manners,
and it is why admitting these two kinds does not widen what a mini-app may ask
for in any general way.

**Three pages, in this order:** what it creates and that the signer becomes
issuer holding every role (mint, freeze, force-transfer, pause — said in those
words, because that is authority over other people's holdings); the name in
full; the symbol in full. Then the contract page, as every call has.

**Both strings must be drawable or the whole call is refused.** Printable ASCII
only, no leading or trailing space, and within the factory's own bounds (64 and
12), enforced identically on both sides. This is stricter than "a valid ABI
string" on purpose: a control byte can blank or reposition what follows, a
UTF-8 right-to-left override can reverse a symbol on screen, a byte with no
glyph draws as nothing and silently shortens the name being approved, and a
space at either end is invisible on glass and present on chain. Each of those
makes the screen disagree with what is signed, which is the one failure a
hardware wallet exists to prevent. The string is refused, never cleaned or
truncated. Enforcing the factory's bounds here also means a call that would
revert on chain costs no press.

**Only the canonical encoding is accepted** — two offsets, the tails back to
back, every pad byte zero, nothing trailing — the same rule the Aqua decoders
apply, because a second encoding of "the same" call is a second thing to reason
about on a screen somebody is about to trust.

**Proof the two decoders agree:** 11 shared vectors in
`packages/core/test/eth-decode-vectors.json`, emitted from the firmware by
`make -C sim eth-decode-conformance` and replayed by the TS suite — 4
acceptances compared on the decoded *name and symbol*, not merely on
"accepted", and 7 refusals (control byte, non-ASCII, leading space, over-bound
name, a gap between the tails, non-zero padding, a trailing byte). A mirror
that accepted any of those would render a call the device rejects.

While adding these, `kind_json_name()` in `sim/test_eth_decode.c` was found to
end in `default: return "unknown"`, which meant a newly added kind would be
emitted into the vector file as *refused* — a vector asserting the device
rejects a call it actually accepts, handed to the mirror as ground truth. That
is the exact failure the vectors exist to catch, reproduced inside the thing
that catches it. The default is gone; the switch is now exhaustive and aborts
loudly if a kind is ever missed.

**A board flashed before 2026-09-11 cannot sign an issuance** and will refuse
it as an undecodable call. There is no version string in the protocol, so the
only check is behavioural.

holdings, mint, send — works against securities that already exist.

### Discovery: what a failed scan says

`discoverIssued` filters `EquityDeployed`/`BondDeployed` on the indexed `caller`
topic, chunked at 1,000 blocks, bounded at 256 chunks, two retries per chunk.
One failed chunk **refuses the whole scan**; a log it cannot decode refuses the
whole scan. The view then renders the failure where the list would have been and
shows the hard-coded table below it, labelled as the table. Nothing in that path
can produce the sentence "you have issued nothing."

The window is reported with every result. It starts at `FACTORY_DEPLOY_BLOCK`
while the head is within 200,000 blocks of it, and clamps to the most recent
200,000 after that — so **compare the window's start against the deployment
block before reading the list as complete.** The chunk size is a guess biased
towards working: it has not been measured against `testnet.hashio.io`, unlike
the Base measurements the sibling log-scanning app records.

### Mint and send

`hasRole(ROLE_ISSUER, <this wallet>)` is **read** per security, never assumed —
the retired pilot `0x651e73eb…` is exactly the case that makes this necessary.
A mint form appears only where that read came back `ok: true`. A revert, an
unreachable node and an absent row each get their own sentence (`mintRefusal`)
and never a greyed-out button, because "we could not ask" and "you do not hold
it" are different facts.

`mint(address,uint256)` is 68 bytes and goes through the privileged descriptor
table, so it gets a consequence line. `transfer(address,uint256)` is also 68
bytes and is **not** privileged: it has its own descriptor
(`securityTransferDescriptors`) rather than being folded into `ACTIONS`, which
would owe it a consequence line about an authority it does not confer. Both were
put through the real `screenProposal` gate in `test/holdings.test.ts`, including
the negative cases — no descriptor refuses, and one security's descriptor does
not describe another's call.

The recipient book is a list of strings somebody typed. Nothing in it has been
checked against a chain, a label is never rendered without its address, and the
device shows the address and never the label.

### Market

The holdings panel reads this wallet's balance in every known and discovered
security and says which of them have something to sell. Its "read register /
sell in the market" button loads that security into the console, which is what
puts the existing market panel's sell form in front of a register that has
actually been read.
