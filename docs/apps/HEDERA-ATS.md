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

So we use the **contract ABIs with viem and sign ourselves**, taking the SDK for
encoding and reads where convenient.

Two reasons, both concrete:

1. We never fight the SDK's dependency-injection container inside our build.
2. **The `METAMASK` path expects an injected EIP-1193 provider — and ours is the
   Chrome extension, which is currently broken at the offscreen document.**
   Depending on it would make a known-broken component load-bearing. The desktop
   companion signs directly instead.

### Real API surface, read from the package

- `Equity.create`, `setVotingRights`, `setScheduledBalanceAdjustment`
- `Bond.create`, `Coupon.setCoupon`
- `Dividend.setDividend`, `getDividendHolders`, `getDividendAmountFor`
- `Role.grantRole`, `revokeRole`, `applyRoles`
- `Kyc.grantKyc`, `revokeKyc`, `getKycStatusFor`
- Modules: Access Control, Control List, Supply Cap, Pause, Lock, **Snapshots**

`Snapshots` is what makes revenue distribution reconcilable rather than
approximate, and the plan leans on it.

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
| **E3** | **Privileged surface rendered (H2–H4, H8)** | **Issuer console with hardware-gated controls** ✅ |
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

## 7. What we will not claim

- **A token is not a share certificate.** ATS issues an instrument with
  compliance controls; the legal standing of that instrument is not ours to
  assert, and no screen will imply it.
- We do not claim regulatory compliance — we implement the controls the Studio
  provides and demonstrate them working.
- Testnet only. No real securities, no real funds.
