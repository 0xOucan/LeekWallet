# Hedera ATS — the issuer console

Required by the audit gates of C1, C2 and C3 in `docs/HACKATHON-MILESTONES.md`.
This file records what the console does, what the contracts actually offer, and
what has and has not been done on a chain.

## Status, stated plainly

| Milestone | State |
|---|---|
| C1 — chain support | done |
| C1 — a deployed asset | **NOT DONE.** No security has been deployed. |
| C2 — issuer dashboard | done, exercised against a fixture only |
| C3 — dividend declaration and reconciliation | done, never run against a chain |

**Nothing in this app has touched Hedera.** The console's only data is
`FIXTURE_ADDRESS`, and every figure it draws carries `FIXTURE_NOTICE`:

> Fixture data. This is a constructed example, not a security read from a chain
> — no figure on this screen came from Hedera.

That notice is not decoration. Until an equity is deployed
(`docs/ATS-DEPLOY-C1.md`), it is the honest description of every number here.

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

Thirteen actions, each with a descriptor and a consequence line. **A privileged
call with no descriptor refuses** — it does not render the selector, and does
not show raw calldata with a warning:

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

## What must happen before any of this is evidence

1. Deploy one equity — `docs/ATS-DEPLOY-C1.md`.
2. Paste its address into **Read register**; the fixture notice should vanish
   because the figures are real.
3. Grant a role, then revoke it, photographing the device screen each time.
4. Declare one dividend against a real snapshot and reconcile it.
5. Record the equity address, transaction hashes and the admin account here.

Until step 1, this document describes a console that works and has never been
used.
