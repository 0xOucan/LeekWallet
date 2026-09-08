# Issuer console — Hedera ATS mini-app

Standalone plan. **A desktop dashboard for issuing digital shares, managing the
register, and distributing revenue — where every privileged action requires a
physical press on the device.**

---

## 1. What ATS is, and where the device belongs

The Asset Tokenization Studio issues **securities** — equities and bonds —
implementing ERC-1400 with partial ERC-3643, on a diamond-pattern upgradeable
architecture, plus a mass-payout framework.

It is not a physical-goods tracker. Its subject is shares, bonds, registers and
corporate actions.

**Where a hardware wallet earns its place:** whoever holds the ATS controller
roles can **freeze a holder, force a transfer, mint supply, pause the register,
or revoke KYC**. Those actions are irreversible and they affect third parties.
Today they are signed by whatever key the admin's browser happens to hold.

Making each one a rendered screen and a physical press is the entire
contribution — and it is exactly the "avoid bad practices" requirement.

## 2. The architectural decision, made early to de-risk

| | |
|---|---|
| Chain | **296** (0x128), Hedera testnet |
| RPC | `https://testnet.hashio.io/api` |
| SDK | `@hashgraph/asset-tokenization-sdk` **v8.0.0** |
| Contracts | `@hashgraph/asset-tokenization-contracts` |
| Wallets the SDK supports | `METAMASK`, `HWALLETCONNECT`, `DFNS`, `FIREBLOCKS`, `AWSKMS` |

The SDK is a ports-and-adapters stack with `reflect-metadata` and its own wallet
layer. **`METAMASK` appearing in that list is the useful fact**: it confirms
these are ordinary EIP-155 transactions over Hedera's JSON-RPC relay.

### What we use the SDK for, and what we do not (revised at E3)

`docs/SDK-POLICY.md` is binding: use the SDK for everything it does well,
replace only its wallet layer, and say why. Reconsidered at E3 with the package
actually installed, which changed two of the earlier answers.

**Adopted: `@hashgraph/asset-tokenization-contracts` 8.0.0**, the contracts
package the SDK itself depends on at that exact version, as a devDependency of
the ATS app. `test/conformance.test.ts` re-derives from its compiled ABI every
function signature this console encodes and all 37 role ids, and fails if any
of ours is not something those contracts declare. It caught two bugs on its
first run that had passed human review:

- `lock` was written `lock(address,uint256,uint256)`. The contracts declare
  `lock(uint256 _amount, address _tokenHolder, uint256 _expirationTimestamp)` —
  **amount first**. Wrong order, wrong selector, so every lock would have
  refused for a reason nobody could have found.
- `grantKyc(address)` exists only on `MockedExternalKycList`. The real
  `IKyc.grantKyc` takes five arguments including a `string`.

**Not adopted: the SDK's ports at runtime**, for three reasons, in order of how
hard they are:

1. **Its write ports execute; they do not build calldata.** `Role.grantRole`
   returns `{payload, transactionId}` — it goes through the command bus to the
   connected wallet's transaction adapter. There is no "give me the bytes" call
   anywhere in `Role`, `Kyc`, `Equity` or `Dividend`. SDK-POLICY rule 1 settles
   it: a call that wants a signer is not for us.
2. **Its read ports construct their own transport.** They work with no wallet —
   after `Network.init` with a mirror node and an RPC relay, `Role.getRoleMemberCount`
   makes a real call to `testnet.hashio.io` and fails only on decoding — but it
   is an ethers `JsonRpcProvider` the SDK made, which routes around the user's
   chosen endpoint, the failover policy and the CSP allowlist that
   `AppContext.request` exists to enforce (`packages/core/src/mini-app.ts`).
3. **Its dependency footprint.** 1016 transitive packages, including
   `@metamask/providers`, three WalletConnect majors, `@reown/appkit` and the
   full `@hashgraph/sdk`, all of it wallet-adapter code we would not call. That
   is a large amount of unexecuted third-party surface to ship inside a hardware
   wallet's renderer.

Two earlier reasons in this document were **wrong** and are corrected here:

- *"We never fight the DI container."* The compiled package loads and its
  container resolves with no build change at all: `experimentalDecorators` and
  `emitDecoratorMetadata` are needed to COMPILE the SDK's sources, not to
  consume its published build. What does not work is its ESM entry, which has
  extensionless internal imports and dies under Node ESM with
  `ERR_MODULE_NOT_FOUND … /build/esm/src/port/in/index`; the CJS build loads
  fine through `createRequire`.
- *"The `METAMASK` path wants our broken extension."* True but irrelevant to
  reads: `Network.init` alone returns `["DFNS","Fireblocks","AWSKMS"]` and
  serves queries without any `connect`. The wallet layer is only in the way of
  writes — which is where we replace it anyway.

**The sixth wallet.** The SDK supports `METAMASK`, `HWALLETCONNECT`, `DFNS`,
`FIREBLOCKS` and `AWSKMS` — an injected browser key, or three custody APIs. The
sixth option should be **a hardware wallet the issuer holds**, where the
consequence of a freeze or a role grant is drawn on a screen the host cannot
repaint and confirmed with a physical press. That is what this app is.

### Real API surface, read from the package

- `Equity.create`, `setVotingRights`, `setScheduledBalanceAdjustment`
- `Bond.create`, `Coupon.setCoupon`
- `Dividend.setDividend`, `getDividendHolders`, `getDividendAmountFor`
- `Role.grantRole`, `revokeRole`, `applyRoles`
- `Kyc.grantKyc`, `revokeKyc`, `getKycStatusFor`
- Modules: Access Control, Control List, Supply Cap, Pause, Lock, **Snapshots**

`Snapshots` is what makes revenue distribution reconcilable rather than
approximate, and the plan leans on it.

## 2b. The Hedera trap that is not in any EVM playbook

**An HTS system contract answers an unknown selector with `success` and
non-conforming data instead of reverting.**

On every other EVM chain, "does this contract implement `getSnapshotCount()`?"
is answered by calling it and seeing whether it reverts. On Hedera that test
returns *true for everything*. Run against real testnet USDC, a first
implementation of this app reported a plain ERC-20 as a security with 64
snapshots.

This is a live-network finding, not a hypothesis — it was reproduced against
`testnet.hashio.io` with the real USDC contract at `0x…1549`.

**The rule that follows:** a feature probe must require a value that **decodes**,
not merely a call that returned. Anything that treats `success == true` as
evidence of an interface is wrong on this chain.

Two consequences worth carrying into E3–E4:

- Role ids are **not derivable**. The contracts annotate them
  `@custom:hash role Cap`, but no plausible preimage reproduces the constant.
  Extract all 37 mechanically from the compiled artifacts. A wrong id reads as
  a role with no members, which is indistinguishable from an unheld role.
- **`getKycStatusFor` returns a uint8 enum**, not a bool. Keep it a number, so a
  future third member surfaces as an unknown code rather than silently reading
  as "not granted".

Snapshots have no `currentSnapshotId()` view — the id is only returned by
`takeSnapshot()`, a transaction — and no enumeration of *taken* snapshots. So
the list must be probed upward until `SnapshotIdDoesNotExists(uint256)`
(selector `0x8e81eb83`), bounded, and reported as "at least N" whenever the
bound stops the walk rather than the chain.

## 3. Build, step by step

### Step 1 — Chain and issuance
Add chain 296 to `chains.ts`. Issue one **equity** on testnet; verify on
HashScan. The deployment itself is approved on the device.

### Step 2 — The dashboard
A desktop panel: holders, supply, roles, KYC status, control list, snapshots.
Read-heavy, so it is useful before any signing is wired — and it demos on its
own.

### Step 3 — The privileged surface, rendered
ERC-7730 descriptors for every dangerous call: `grantRole`, `revokeRole`,
`grantKyc`, `revokeKyc`, `pause`, `lock`, `setSupplyCap`, control-list edits.

```
  GRANT ROLE · ACME Equity          FREEZE HOLDER · ACME Equity
  Role    MINTER                    Holder  0x7a3f…91c2
  To      0x7a3f…91c2               Effect  blocks all transfers
  Effect  can create new shares     Reason  code 4
  [ REJECT ]      [ APPROVE ]       [ REJECT ]      [ APPROVE ]
```

**A privileged call with no descriptor must refuse.** An unlabelled screen on an
irreversible action is worse than no screen, because it manufactures confidence.

### Step 4 — Revenue distribution
`setDividend` against a **snapshot**, then distribute.

```
  DISTRIBUTE DIVIDEND · ACME
  Snapshot  #3 (14 holders)
  Per share 0.25 USDC
  Total     3,500.00 USDC
  [ REJECT ]              [ APPROVE ]
```

**Refuse if `total ≠ per-share × snapshot supply`.** The device shows a total;
that total must be checkable arithmetic, not an assertion from the host.

### Step 5 *(stretch)* — secondary market
The extra-points item the Studio lacks today: an order book or auction with
compliance enforced **at transfer**, so a trade to a non-KYC holder fails by
construction. Only after Step 4 works.

## 4. Testing rounds

| # | What is tested | Funds |
|---|---|---|
| **H1** | Equity deployed, visible on HashScan, readable by the dashboard | testnet **HBAR** |
| **H2** | Grant then revoke MINTER; dashboard reflects immediately, **no cached "still admin"** | HBAR |
| **H3** | Grant/revoke KYC; a transfer to a non-KYC holder **fails as designed** | HBAR |
| **H4** | Remove one descriptor → the privileged call **refuses** | HBAR |
| **H5** | Snapshot with ≥3 holders; holder list and balances correct | HBAR + 3 test accounts |
| **H6** | Dividend distributes proportionally; totals reconcile to the snapshot | HBAR + payment token |
| **H7** | Distribution where `total ≠ per-share × supply` **refuses** | HBAR |
| **H8** | Pause the register, confirm transfers fail, unpause | HBAR |

**H3, H4 and H7 are the ones that matter.** They are the tests that prove the
compliance controls are real and that the device is not a rubber stamp.

### Funds to obtain

| Asset | Source |
|---|---|
| Testnet **HBAR** | `portal.hedera.com` |
| 3 test accounts as holders | same portal |
| A payment token for dividends | deploy a test ERC-20, or use an existing testnet token |

## 5. Milestones and gates

| Gate | Deliverable | Submittable if we stop |
|---|---|---|
| **E1** | Chain 296 + equity issued (H1) | Hardware-signed issuance on Hedera |
| **E2** | Dashboard, read-only (H2 partial) | + a readable register |
| **E3** | **Privileged surface rendered and wired to `propose()` (H4 ✅; H2–H3, H8 not run)** | **Issuer console with hardware-gated controls** ✅ |
| **E4** | Snapshot + distribution (H5–H7) | + a lifecycle operation |
| **E5** *(stretch)* | Secondary market | + the extra-points item |

Judging favours "real asset classes and real lifecycle management over a token
with a name on it", so **E4 is worth more than breadth elsewhere**. A bond or
equity with an actual distribution beats three half-configured assets.

**Record the demo at E3.**

## 6. Why this is last in the running order

Largest single pool ($6,000, up to three winners) but furthest from LeekWallet's
identity and the heaviest SDK. It is scheduled after Arc and Aqua have reached
submittable states, because two finished integrations beat three unfinished
ones — every track requires a working MVP, an architecture diagram **and** a
demo video, and a half-built app produces none of the three.

## 6b. What is fixture-only, as of E3

No testnet HBAR was available, so **no ATS security has been deployed and
nothing in this app has been exercised against one.** Stated field by field so
the gap is not left to inference:

| Claim | Evidence |
|---|---|
| The 37 role ids are the contracts' own | **Verified** against `contracts/constants/roles.sol` 8.0.0, by test |
| Every encoded signature is a real ATS function | **Verified** against the compiled ABI, by test |
| A privileged call with no descriptor refuses (H4) | **Verified**, by test — the format is deleted and the console refuses without calling `propose` |
| The register renders holders, roles, KYC, snapshots | **Fixture only.** `fixtures.ts` answers through the same `aggregate3` path |
| A non-ATS address is diagnosed rather than repeated | **Fixture only**, using `htsLikeRequest()` — which encodes a behaviour observed live on `testnet.hashio.io` at E2 |
| The device draws these screens and a press signs them | **NOT verified.** The host-side path is tested with a stub `propose`; no transaction has been signed, sent, or seen on HashScan |
| The descriptors match calldata a deployed security accepts | **NOT verified.** Signatures are right; whether a given diamond has the facet is a live question |

H2, H3, H5–H8 all require HBAR and none of them has been run. The demo at E3
is a demo of the console and its refusals, not of a settled transaction.

## 7. What we will not claim

- **A token is not a share certificate.** ATS issues an instrument with
  compliance controls; the legal standing of that instrument is not ours to
  assert, and no screen will imply it.
- We do not claim regulatory compliance — we implement the controls the Studio
  provides and demonstrate them working.
- Testnet only. No real securities, no real funds.
