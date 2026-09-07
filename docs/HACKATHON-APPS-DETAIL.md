# The three mini-apps, in detail

Deep plan per app: design decisions with their reasons, step-by-step build,
testing rounds, and the testnet funds each round needs.

Every address, domain ID and timing below was read from Circle, 1inch or Hedera
documentation and packages. Where a documented limit changes the design, the
design changed.

---

## Cross-cutting: what the device brings

All three apps route every signature through the device, and none of them may
ask for a signature the device cannot render (`docs/APPS.md`, rule 4).

**On the roadmap, stated honestly and not claimed as shipped:** we are about to
begin bench testing an **ATECC608B** secure element as a SHA/HMAC and key
co-processor, and an **airgapped mode** that moves companion↔device
communication off USB entirely. Neither is implemented. Secure boot and eFuse
burning are deliberately **not** in scope for this work.

---

# App 1 — La Caja (Arc): multi-chain point of sale

## The research that shaped the design

| Fact | Source | Consequence |
|---|---|---|
| CCTP V2 **Fast Transfer ≈ 8–20 s**, Standard **15–19 min** | Circle CCTP docs | Standard is unusable at a table; anything user-facing must not wait on a bridge at all |
| **Arc is CCTP domain 26** | Circle supported-chains | Arc can be a settlement destination |
| **Arc as CCTP *source* is broken**: public Iris returns nothing for domain 26, open issue, workaround is a community relay | `circlefin/evm-cctp-contracts#110` | **Never bridge out of Arc.** Money flows *into* Arc and settles there |
| CCTP moves **USDC and EURC** (EURC support added recently) | Circle blog | Both are in scope, but not equally |
| **EURC exists on far fewer chains than USDC** | Circle EURC addresses | The accepted-asset matrix is asymmetric and the UI must say so |
| USDC is **Arc's native gas token**; native 18 decimals, ERC-20 interface 6 | Arc docs | The merchant needs no second asset; the decimals split is a 10¹² hazard |

### The decision this forces

**The customer never touches CCTP.** They make a plain ERC-20 transfer on
whatever chain they already hold USDC on. The terminal watches every supported
chain and confirms in seconds. **Bridging happens later, on the merchant side,
batched and hardware-approved.**

The naive design — customer calls `depositForBurn` so funds arrive on Arc — is
wrong twice over: it demands a CCTP-aware wallet from a diner, and even Fast
Transfer's 8–20 s is dead time at a table while Standard's 15–19 min is
unthinkable. Watching for a transfer is instant and works with every wallet
that exists.

```
  Waiter                     Customer                  Merchant
  terminal, NO KEY           any wallet, any chain     LeekWallet device
  ───────────────────        ─────────────────────     ─────────────────
  total + tip %          →   scans / opens link
  share via QR or link       plain USDC transfer   →   funds land on that chain
  watches N chains       ←   confirmed in seconds
                                                       shift close: ONE approval
                                                       CCTP sweep → Arc  ✅
```

## Reference data the app is built on

**CCTP V2 testnet contracts — identical on every chain:**

| Contract | Address |
|---|---|
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| TokenMinterV2 | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` |
| MessageV2 | `0xbaC0179bB358A8936169a63408C8481D582390C4` |

**Domains, USDC and EURC (testnet):**

| Chain | Domain | USDC | EURC |
|---|---|---|---|
| Ethereum Sepolia | 0 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4` |
| Avalanche Fuji | 1 | `0x5425890298aed601595a70AB815c96711a31Bc65` | `0x5E44db7996c682E92a960b65AC713a54AD815c6B` |
| OP Sepolia | 2 | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | — |
| Arbitrum Sepolia | 3 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | — |
| Base Sepolia | 6 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x808456652fdb597867f38412077A9182bf77359F` |
| Polygon Amoy | 7 | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | — |
| Unichain Sepolia | 10 | `0x31d0220469e10c4E71834a79b1f276d740d3768F` | — |
| Linea Sepolia | 11 | `0xFEce4462D57bD51A6A552365A011b95f0E16d9B7` | — |
| **Arc Testnet** | **26** | `0x3600000000000000000000000000000000000000` | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |

Arc: chain **5042002**, RPC `https://rpc.testnet.arc.io`, explorer
`https://testnet.arcscan.app`. Attestation API
`https://iris-api-sandbox.circle.com/v2/messages/{sourceDomain}/{txHash}`.

**USDC pays from 9 testnet chains; EURC only from 4.** The terminal must grey
out EURC on chains that do not have it rather than offering a payment that
cannot arrive.

## How a payment is matched to an order

A plain transfer carries no order id, so the terminal must recognise its own
payment.

**MVP: a unique amount.** The total gets sub-cent entropy — `$284.53` becomes
`$284.5317`. Two open orders never share an amount. Simple, needs no key
material on the terminal, and works with every wallet. This is what real crypto
POS systems do.

**Upgrade: per-order derived addresses.** LeekWallet is an HD wallet, so the
terminal can hold the merchant's **public xpub** and derive a fresh receiving
address per order — watch-only, no key on the terminal, unambiguous matching,
and the same address works across every EVM chain. The cost is gas per address
at sweep time. Do this after the MVP works.

## Build, step by step

### Step 1 — Chains and descriptors
Add Arc (5042002) and the eight source chains to
`app/packages/core/src/chains.ts`. Write ERC-7730 descriptors for USDC and EURC
on each. **The Arc descriptor is the one that prevents a 10¹² error**, because
native USDC is 18 decimals and the ERC-20 interface is 6, and the device renders
raw units by design (`src/ui.c:4834`).

### Step 2 — Terminal mode
A companion mode with **no key and no reachable signing path**. Waiter enters a
total, picks a tip preset — **10% / 15% / custom** — and the terminal shows the
grand total, then produces:

- a **QR** encoding an EIP-681 URI, and
- a **share link** for WhatsApp, which is how a bill actually gets sent in most
  of Latin America

```
ethereum:<token>@<chainId>/transfer?address=<merchant>&uint256=<amount>
```

### Step 3 — The multi-chain watcher
Poll `Transfer` logs for the merchant address on all nine chains, filtered to
the USDC/EURC contracts above. On a match: mark paid, show the waiter, show the
customer.

**A zero balance and an unreachable RPC must never look alike.** A chain the
watcher cannot reach is displayed as *unknown*, never as *unpaid* — telling a
customer their payment did not arrive when the RPC is simply down is the worst
failure this app can have.

### Step 4 — Roles and the shift
**Admin** (holds the device), **cashier**, **waiter** (own staff id on every
request). Tips accrue per staff id. Closing a shift produces one settlement the
admin approves on the device.

### Step 5 — The sweep to Arc
At shift close, for each chain holding funds: `approve` → `depositForBurn`
(Fast Transfer) → poll Iris → `receiveMessage` on Arc.

**Only ever inbound.** Arc is the destination; we never make Arc the source,
because domain 26 attestations are unavailable.

```
  SWEEP TO ARC
  From    Base Sepolia    412.50 USDC
          Polygon Amoy    118.00 USDC
  To      Arc · treasury
  Fee     CCTP fast, deducted from amount
  [ REJECT ]              [ APPROVE ]
```

## Testing rounds

| Round | What is tested | Testnet funds needed |
|---|---|---|
| **T1** Descriptors | USDC and EURC render correctly on Arc and on Base Sepolia; a missing descriptor **refuses** | Arc USDC (gas + test), Base Sepolia USDC + ETH |
| **T2** Single-chain payment | QR paid from a phone wallet on Base Sepolia; terminal confirms; **terminal cannot sign** | Base Sepolia USDC + ETH |
| **T3** Multi-chain watcher | Pay from 3 chains; all detected; kill one RPC and confirm it shows *unknown*, not *unpaid* | USDC + native gas on Base Sepolia, Polygon Amoy, Avalanche Fuji |
| **T4** EURC asymmetry | EURC accepted on Base Sepolia, correctly **unavailable** on Polygon Amoy | Base Sepolia EURC |
| **T5** Tips and shift | 10% / 15% / custom compute correctly; batch settlement reconciles to orders; a mismatched recipient list **refuses** | Arc USDC |
| **T6** CCTP sweep | Base Sepolia → Arc via Fast Transfer, end to end; measure the real time | Base Sepolia USDC + ETH, Arc USDC |
| **T7** Sweep failure | Kill the process after `depositForBurn`, before `receiveMessage`; confirm it **resumes** and does not double-spend | as T6 |

**T7 is the one that matters.** CCTP burns on the source before minting on the
destination; a crash in between leaves real money in flight. The app must
resume from the attestation, not re-burn.

---

# App 2 — Aqua (1inch): portfolio deployment and management

## The security fact that shapes the app

Aqua keeps the maker's tokens **in their own wallet** — the registry holds
virtual balances (`balances[maker][app][strategyHash][token]`) and moves tokens
only at execution via `pull()`/`push()`.

But Aqua **pulls from that wallet during swaps**. So the maker's true exposure
is **approval × shipped strategies**, not the strategy alone. An unlimited
approval plus one strategy is unlimited exposure.

The companion already has `approval-cap.ts` and `allowances.ts`. This is what
they are for, and this app is the reason to finish them.

| | |
|---|---|
| Aqua registry | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` |
| SwapVM router | `0x111111338c5091e8440b67b168bae16a668ac0de` |
| SDK | `@1inch/aqua-sdk` |
| Chains | Polygon, Gnosis, Optimism, Unichain, Sonic, BNB — **already in `chains.ts`** |

`AquaApp` requires a strategy struct containing `maker` (for hash uniqueness),
immutable once shipped; changing parameters means `dock()` then `ship()` again.

## Build, step by step

### Step 1 — Read-only portfolio
`AQUA.safeBalances(maker, app, strategyHash, tokenA, tokenB)` per known
strategy. Show app, pair, virtual balances, strategy hash, and — prominently —
**the current approval**, because that is the real exposure.

Read-only first, deliberately: prove we model the data correctly before asking
anyone to sign into it.

### Step 2 — Deploy a position
Two signatures, both rendered:

1. `approve`, **capped to the amount being shipped**, never unlimited
2. `ship()`, with the strategy decoded on screen

```
  SHIP STRATEGY · Aqua
  App       XYCSwap
  Pair      USDC / DAI
  Provide   1,000.00 USDC
  Fee       0.05%
  Approval  capped at 1,000 USDC
  [ REJECT ]              [ APPROVE ]
```

The device **refuses** if the decoded `maker` is not its own address. A strategy
that names someone else is either a mistake or an attack.

### Step 3 — Manage
`dock()` to withdraw; re-`ship()` to change parameters, shown as the two
operations it really is rather than an "edit".

### Step 4 — SwapVM decoding
Programs are `[opcode][args_len][args]`; render intent per instruction. An
**unknown opcode refuses to render, and therefore refuses to sign** — a partial
decode produces a screen that looks authoritative and is not.

### Step 5 *(stretch)* — a custom opcode
`_merchantFloorSwap`: refuses below a floor price, caps drawdown per epoch.
Tested against the repo's `CoreInvariants`, which already asserts seven
invariants including rounding-favours-maker and swap additivity.

## Testing rounds

| Round | What is tested | Funds needed |
|---|---|---|
| **A1** Read-only | Positions match a direct RPC query; RPC failure shows *unavailable*, never zero | none (read-only, fork or public RPC) |
| **A2** Approval cap | Unlimited approval is **refused by default**; capped approval renders the cap | Foundry fork of Polygon or Gnosis **mainnet** — no funds |
| **A3** Ship | Position shipped from the device appears in A1's view and on-chain | as A2 (same fork) |
| **A4** Wrong maker | A strategy naming another address **refuses on the device** | as A2 (same fork) |
| **A5** Dock | Full withdrawal returns virtual balances to zero; approval is then revoked or reduced | as A2 (same fork) |
| **A6** Half-failure | `approve` succeeds, `ship` fails: app reports a **capped approval outstanding**, does not silently retry | as A2 (same fork) |
| **A7** SwapVM decode | Three programs decode correctly against `forge` fixtures; an unknown opcode refuses | local fork only |

A mainnet fork (Foundry `--fork-url`) is acceptable per the sponsor's rules and
avoids needing real liquidity.

---

# App 3 — Issuer console (Hedera ATS)

## The architectural decision, made early

The ATS SDK is a ports-and-adapters stack with `reflect-metadata` and its own
wallet layer supporting `METAMASK`, `HWALLETCONNECT`, `DFNS`, `FIREBLOCKS`,
`AWSKMS`.

**`METAMASK` in that list is the useful fact**: it confirms these are ordinary
EIP-155 transactions over Hedera's JSON-RPC relay. So we use the **contract ABIs
with viem and sign ourselves**, taking the SDK for encoding and reads. We never
fight its DI container, and we do not depend on our Chrome extension — which is
currently broken at the offscreen document, and would otherwise be a hard
dependency through the `METAMASK` path.

| | |
|---|---|
| Chain | **296** (0x128) Hedera testnet |
| RPC | `https://testnet.hashio.io/api` |
| SDK | `@hashgraph/asset-tokenization-sdk` **v8.0.0** |
| Contracts | `@hashgraph/asset-tokenization-contracts` |

Real API surface, read from the package:

- `Equity.create`, `setVotingRights`, `setScheduledBalanceAdjustment`
- `Bond.create`, `Coupon.setCoupon`
- `Dividend.setDividend`, `getDividendHolders`, `getDividendAmountFor`
- `Role.grantRole`, `revokeRole`, `applyRoles`
- `Kyc.grantKyc`, `revokeKyc`, `getKycStatusFor`
- Modules: Access Control, Control List, Supply Cap, Pause, Lock, **Snapshots**

## Build, step by step

### Step 1 — Chain and issuance
Add chain 296. Issue one equity on testnet; verify on HashScan.

### Step 2 — The dashboard
A desktop panel: holders, supply, roles, KYC status, control list, snapshots.
Read-heavy, so it works before any signing is wired.

### Step 3 — The privileged surface, rendered
Descriptors for every dangerous call — `grantRole`, `revokeRole`, `grantKyc`,
`revokeKyc`, `pause`, `lock`, `setSupplyCap`, control-list edits.

```
  GRANT ROLE · ACME Equity
  Role    MINTER
  To      0x7a3f…91c2
  This lets them create new shares.
  [ REJECT ]              [ APPROVE ]
```

**This is the "avoid bad practices" requirement.** These actions are
irreversible and affect third parties. A privileged call with **no descriptor
must refuse**, because an unlabelled screen is worse than no screen.

### Step 4 — Revenue distribution
`setDividend` against a **snapshot**, then distribute. One approval, a readable
summary, and a refusal if `total ≠ per-share × snapshot supply`.

```
  DISTRIBUTE DIVIDEND · ACME
  Snapshot  #3 (14 holders)
  Per share 0.25 USDC
  Total     3,500.00 USDC
  [ REJECT ]              [ APPROVE ]
```

## Testing rounds

| Round | What is tested | Funds needed |
|---|---|---|
| **H1** Issuance | Equity deployed, visible on HashScan, readable by the dashboard | testnet **HBAR** (portal.hedera.com) |
| **H2** Roles | Grant then revoke MINTER; dashboard reflects immediately, no cached "still admin" | HBAR |
| **H3** KYC | Grant/revoke KYC; a transfer to a non-KYC holder **fails as designed** | HBAR |
| **H4** No descriptor | Remove one descriptor; the privileged call **refuses** | HBAR |
| **H5** Snapshot | Snapshot with ≥3 holders; holder list and balances correct | HBAR + 3 test accounts |
| **H6** Distribution | Dividend distributes proportionally; totals reconcile | HBAR + a payment token |
| **H7** Bad total | Distribution whose total ≠ per-share × supply **refuses** | HBAR |

---

# Testnet funds — the shopping list

| Asset | Where | Needed for |
|---|---|---|
| **Arc USDC** | `faucet.circle.com` | gas *and* settlement on Arc — it is the native gas token |
| USDC on Base Sepolia, Polygon Amoy, Avalanche Fuji | `faucet.circle.com` | multi-chain watcher, CCTP sweep |
| USDC on Ethereum / OP / Arbitrum / Unichain / Linea Sepolia | `faucet.circle.com` | wider watcher coverage (optional) |
| **EURC** on Base Sepolia, Ethereum Sepolia, Avalanche Fuji | `faucet.circle.com` | the EURC path and its asymmetry |
| Native gas: Sepolia ETH, Base Sepolia ETH, POL (Amoy), AVAX (Fuji) | public faucets | source-chain transactions and burns |
| **HBAR** testnet | `portal.hedera.com` | every Hedera round |
| *(none — Aqua is mainnet-only; fork it)* | `anvil --fork-url` | Aqua ship/dock |
| *(no funds)* | Foundry fork | Aqua read-only and SwapVM decoding |

**Get Arc USDC first.** It is both the gas and the settlement asset, so nothing
on Arc runs without it.

---

# Order of work, and what ships at each point

| # | Milestone | Submittable if we stop |
|---|---|---|
| 1 | Apps framework (gate A0) | — |
| 2 | Arc chains + descriptors (T1) | Arc support with correct rendering |
| 3 | **Terminal + single-chain payment (T2)** | **Arc: working POS** ✅ |
| 4 | Aqua read-only (A1) | + portfolio view |
| 5 | **Aqua ship/dock (A2–A6)** | **1inch: hardware-authorised positions** ✅ |
| 6 | Multi-chain watcher + tips + shift (T3–T5) | + accountability |
| 7 | Hedera issuance + dashboard (H1–H2) | + issued asset |
| 8 | **Privileged surface (H3–H4)** | **Hedera: issuer console** ✅ |
| 9 | CCTP sweep (T6–T7) | + the multi-chain story completed |
| 10 | Dividends (H5–H7) | + lifecycle operation |
| 11 | SwapVM decode (A7) | + the differentiator |

**Record the demo video at every ✅.** A finished step 3 on video beats an
unrecorded step 6.
