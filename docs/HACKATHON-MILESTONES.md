# Execution plan — milestones, audit gates, and what ships if time runs out

Companion to `HACKATHON-PLAN.md`. Every SDK signature, address and chain ID
below was read from the package or the sponsor's docs, not recalled.

---

## Ground rules

**1. Every milestone ends in something demonstrable.** If the clock stops at any
gate, the last completed milestone is a submission. There is no state in which
we have "nearly" three integrations and can show none.

**2. No milestone starts until the previous one passes its audit.** The audit is
written before the work, so it cannot be softened afterwards to fit what got
built. This is the same discipline as `AUDIT.md` and `scripts/check.sh`.

**3. One branch per track, no cross-imports.** An app is one directory plus one
registry row. Rollback is `git revert` of one merge.

**4. If the device cannot render it, we do not sign it.** An integration that
asks for a blind signature is not finished, however well it works.

**Audit gate template** — each gate answers all five:

| | |
|---|---|
| Works | the happy path, on the real network |
| Refuses | the failure we most want: wrong chain, wrong amount, wrong role |
| Renders | what the device shows, screenshotted |
| Recovers | what happens when it fails halfway |
| Written down | a `docs/` note a stranger could follow |

---

## M0 — The apps framework *(shared, lands first)*

Small, and everything depends on it.

**Build.** `app/packages/apps/` with `registry.ts` and `types.ts`. An app
declares: id, display name, chains it supports, the descriptors it ships, and
whether it is enabled. The framework forbids an app from importing anything
outside its own folder, and gives it no access to the vault or the session — it
returns unsigned payloads to the existing device pipeline.

**Definition of done.** A stub app appears in the companion menu, is toggleable,
and can round-trip an unsigned transaction to the device and back.

**Audit gate A0.**
- Works: stub app builds a transfer, device renders it, signature verifies
- Refuses: an app that returns a payload with no matching descriptor is
  **rejected by the framework**, not merely warned about
- Renders: screenshot of the menu and the stub approval
- Recovers: disabling an app mid-session leaves no stale state
- Written: `docs/APPS.md` — how to add one, and the four rules

**Ships if we stop here.** Nothing sponsor-facing. This gate must pass.

---

## Track A — Arc: point-of-sale with accountability

The role structure is the product. **Staff take money in; only an admin takes
money out.**

### Facts this is built on

| | |
|---|---|
| Chain ID | **5042002** |
| RPC | `https://rpc.testnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| Native gas | **USDC** |
| Native USDC decimals | **18** |
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000`, **6 decimals** |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, 6 decimals |
| App Kit | `@circle-fin/app-kit` + `@circle-fin/adapter-viem-v2`, `kit.send()` |

### A1 — Chain support and the decimals trap

Add Arc to `app/packages/core/src/chains.ts`. Write ERC-7730 descriptors for
USDC and EURC on 5042002.

**This is the milestone that prevents a 10¹² error.** The device renders raw
units by design (`src/ui.c:4834` — `decimals()` is not callable from firmware).
Native USDC is 18 decimals and the ERC-20 interface is 6. The descriptor is what
makes `1000000` render as `1.00 USDC` and not `0.000000000001`.

**Done.** Device shows a correct human amount for both paths, on hardware.

**Audit gate A1.**
- Works: send 1.00 USDC and 1.00 EURC, both render correctly
- **Refuses: a payload on chain 5042002 with no descriptor must refuse, not
  guess.** Deliberately remove the descriptor and confirm refusal
- Renders: photograph both approval screens next to the explorer amount
- Recovers: unknown token falls back to raw units *and says so*
- Written: `docs/ARC.md` with the 18-vs-6 split explained

**Ships if we stop here.** "LeekWallet supports Arc and renders USDC/EURC
correctly." Modest, true, and demonstrable.

### A2 — Terminal mode (the MVP)

A companion mode holding **no key at all**. It composes an **EIP-681** request
and renders a QR:

```
ethereum:0x3600…0000@5042002/transfer?address=<merchant>&uint256=<amount>
```

Any wallet can pay it. A cashier is handed this with zero custody risk.

**Done.** A phone wallet pays a QR from the terminal; funds land at the merchant
address; the terminal shows paid/unpaid.

**Audit gate A2.**
- Works: end-to-end payment on Arc testnet, tx on `testnet.arcscan.app`
- Refuses: **terminal mode cannot sign anything.** Assert in code and in test
  that no signing path is reachable from it
- Renders: not applicable — no device involved, which is the point
- Recovers: terminal restarts without losing open tabs; duplicate payment
  detected rather than double-counted
- Written: `docs/ARC.md` — the role model, with the trust boundary drawn

**Ships if we stop here.** **This is the minimum viable submission for Arc**: a
working USDC/EURC point of sale with a real trust boundary. It satisfies
"USDC or EURC payment flows on Arc added to a commerce, fintech, or wallet
product" on its own.

### A3 — Roles and shift accountability

Three roles: **admin** (device), **cashier** (terminal), **waiter** (terminal,
own staff id). Every request carries the staff id. A shift closes into a
settlement the admin approves on the device — one signature, one screen, a
readable list.

```
  CLOSE SHIFT · Tacos del Parque
  Sales     42 orders    1,284.50 USDC
  Tips                      96.00 USDC
  Staff     4 recipients
  [ REJECT ]              [ APPROVE ]
```

**Done.** Tips split across four staff addresses in one approved transaction.

**Audit gate A3.**
- Works: batch settlement pays every recipient, amounts reconcile to the orders
- **Refuses: a settlement whose recipient list does not match the shift's
  orders must refuse.** The device shows totals; the reconciliation must be
  checkable, not asserted
- Renders: the close-shift screen, photographed
- Recovers: partial batch failure is detectable and re-runnable without
  double-paying
- Written: `docs/ARC.md` — reconciliation rules

**Ships if we stop here.** A complete POS with accountability. The strongest
Arc submission we can make.

### A4 *(stretch)* — App Kit unified balance

Use `kit.send()` and unified balance so a merchant can be paid from another
chain and settle on Arc. Only after A3 passes.

---

## Track B — 1inch Aqua: portfolio deployment, visualisation, management

### What Aqua is, precisely

Aqua is a **shared liquidity layer where the maker's tokens never leave their
wallet**. The registry tracks *virtual* balances
(`balances[maker][app][strategyHash][token]`); tokens move only at execution via
`pull()`/`push()`.

| | |
|---|---|
| Aqua registry | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` |
| SwapVM router | `0x111111338c5091e8440b67b168bae16a668ac0de` |
| SDK | `@1inch/aqua-sdk` — `AquaProtocolContract`, `ship()`, `dock()`, `calculateStrategyHash()` |
| Chains | Polygon, Gnosis, Optimism, Unichain, Sonic, BNB — **all already in `chains.ts`** |

**The security fact that shapes this track.** Tokens stay in the maker's wallet,
but Aqua **pulls from it during swaps**. So the maker's real exposure is
*approval × shipped strategies*, not the strategy alone. The companion already
has `approval-cap.ts` and `allowances.ts`; this is what they are for.

### B1 — Read-only portfolio view

`AQUA.safeBalances()` per strategy. Show every position the connected address
has shipped: app, tokens, virtual balances, strategy hash.

Read-only first on purpose: it proves we understand the data model before we
ask anyone to sign into it.

**Done.** A real address's Aqua positions render in the companion.

**Audit gate B1.**
- Works: positions match the explorer / a direct RPC query
- Refuses: an address with no positions shows an empty state, not a spinner
- Renders: n/a (read-only)
- Recovers: RPC failure is reported, not shown as zero balances — **a zero
  balance and an unavailable balance must never look the same**
- Written: `docs/AQUA.md` — the data model in our words

**Ships if we stop here.** "LeekWallet shows your Aqua portfolio." Honest, and
the visualisation half of what was asked for.

### B2 — Deploy a position, signed on the device (the MVP)

Two signatures, both rendered:

1. **`approve`** — capped, never unlimited, using the existing approval-cap code
2. **`ship()`** — with the encoded strategy **decoded** on screen

```
  SHIP STRATEGY · Aqua
  App       XYCSwap
  Pair      USDC / DAI
  Provide   1,000.00 USDC
  Fee       0.05%
  Approval  capped at 1,000 USDC
  [ REJECT ]              [ APPROVE ]
```

**Done.** A position shipped from the device appears in B1's view.

**Audit gate B2.**
- Works: shipped on a live testnet/fork, visible on-chain, `dock()` returns it
- **Refuses: an unlimited approval must be refused by default**, and a strategy
  whose decoded `maker` is not the device's address must refuse outright
- Renders: photographed approval screens for both signatures
- Recovers: `approve` succeeding and `ship` failing leaves a *capped* approval,
  and the app says so plainly rather than silently retrying
- Written: `docs/AQUA.md` — the approval-times-strategy exposure model

**Ships if we stop here.** **Minimum viable Aqua submission**: deploy, view and
withdraw a real position with hardware authorisation.

### B3 — SwapVM program decoding

SwapVM programs are `[opcode][args_len][args]` triples, signed as EIP-712. Decode
and render intent:

```
  18 xycConcentrateGrowLiquidity2D  →  concentrated range
  21 flatFeeAmountInXD              →  taker pays 0.10% of input
  17 xycSwapXD                      →  constant product, x·y=k
  20 salt                           →  uniqueness only, no effect on price
```

The numbers are the **dense indices** the deployed `AquaSwapVMRouter` v1.0.2
dispatches on, not the `Opcode` enum (`XYCSwap = 0x50`) — settled by decoding
real `Shipped` events on Base mainnet; the four above are one of them. The
full table is `docs/AQUA-B3-SPEC.md` §3, and the two real programs are pinned
in the shared calldata vectors.


Nobody else will render bytecode on a hardware screen, and SwapVM use is
explicitly scored higher.

**Audit gate B3.**
- Works: three real programs decode correctly against `forge` fixtures
- **Refuses: an unknown opcode must refuse to render and therefore refuse to
  sign.** Partial decoding is worse than none — it produces a screen that looks
  authoritative and is not
- Renders: photographed, next to the program's source
- Recovers: a truncated program is rejected, not padded
- Written: the opcode table we support and, explicitly, the ones we do not

### B4 *(stretch)* — a custom opcode

`_merchantFloorSwap` — a limit swap refusing below a floor and capping drawdown
per epoch. Tested against the repo's `CoreInvariants`, which already checks
seven invariants. Only after B3.

---

## Track C — Hedera ATS: issuer dashboard

### Facts

| | |
|---|---|
| Chain ID | **296** (0x128), Hedera testnet |
| RPC | `https://testnet.hashio.io/api` |
| SDK | `@hashgraph/asset-tokenization-sdk` **v8.0.0** |
| Contracts pkg | `@hashgraph/asset-tokenization-contracts` |
| Wallets supported | `METAMASK`, `HWALLETCONNECT`, `DFNS`, `FIREBLOCKS`, `AWSKMS` |

Real API surface, read from the package:

- `Equity.create()`, `setVotingRights()`, `setScheduledBalanceAdjustment()`
- `Bond.create()`, `Coupon.setCoupon()`
- `Dividend.setDividend()`, `getDividendHolders()`
- `Role.grantRole()`, `revokeRole()`, `applyRoles()`
- `Kyc.grantKyc()`, `revokeKyc()`
- Modules: Access Control, Control List, Supply Cap, Pause, Lock, **Snapshots**

**An architectural decision, made early to de-risk.** The SDK is a heavy
DI/ports-and-adapters stack with `reflect-metadata` and its own wallet layer. We
use the **contract ABIs with viem** and sign ourselves, taking the SDK for
encoding and reads where convenient. `METAMASK` support confirms these are plain
EIP-155 transactions on chain 296 — so LeekWallet signs them like any other EVM
transaction, and we never fight the SDK's wallet abstraction.

### C1 — Hedera chain support and a deployed asset

Add chain 296. Deploy one equity on testnet, verified on HashScan.

**Done.** An equity exists, and the companion can read its details.

**Audit gate C1.**
- Works: token deployed, visible on HashScan
- Refuses: wrong-chain payloads rejected by chain id
- Renders: the deployment approved on the device
- Recovers: a failed deploy leaves no half-configured token we later mistake
  for live
- Written: `docs/ATS.md` — the deployment we ran, reproducibly

**Ships if we stop here.** A hardware-signed token issuance on Hedera testnet.
Thin, but real and demonstrable.

### C2 — The issuer dashboard (the MVP)

A desktop panel for: holders, supply, roles, KYC status, and the privileged
actions. **Every privileged action is rendered on the device.**

```
  GRANT ROLE · ACME Equity
  Role    MINTER
  To      0x7a3f…91c2
  This lets them create new shares.
  [ REJECT ]              [ APPROVE ]
```

Descriptors for the whole privileged surface: `grantRole`, `revokeRole`,
`grantKyc`, `revokeKyc`, `pause`, `lock`, `setSupplyCap`, control-list edits.

**This is the "avoiding bad practices" requirement.** The issuer's controller
keys can freeze holders, mint supply and force transfers. Those actions are
irreversible and affect third parties. Making each one a physical press on a
screen the host cannot forge is the entire point.

**Audit gate C2.**
- Works: grant and revoke a role and KYC, end to end
- **Refuses: any privileged call without a descriptor must refuse.** Test by
  removing one
- Renders: photographs of at least four distinct privileged screens
- Recovers: a revoked role reflects immediately; no cached "still admin" state
- Written: `docs/ATS.md` — the full privileged surface and its descriptors

**Ships if we stop here.** **Minimum viable Hedera submission**: an issuer
console where every dangerous action requires hardware confirmation.

### C3 — Revenue distribution

`Dividend.setDividend()` against a **snapshot**, then distribution. One approval,
a readable summary.

```
  DISTRIBUTE DIVIDEND · ACME
  Snapshot  #3 (14 holders)
  Per share 0.25 USDC
  Total     3,500.00 USDC
  [ REJECT ]              [ APPROVE ]
```

**Audit gate C3.**
- Works: holders receive proportionally; totals reconcile to the snapshot
- **Refuses: a distribution whose total does not equal per-share × snapshot
  supply must refuse**
- Renders: photographed
- Recovers: partial distribution is resumable without double-paying
- Written: `docs/ATS.md`

**Ships if we stop here.** Issuance, compliance control and a lifecycle
operation — precisely what the track asks for.

### C4 *(stretch)* — secondary market

The extra-points item ATS lacks, compliance enforced at transfer. Only after C3.

---

## Sequence, and what ships at every point

| Order | Gate | If the clock stops here, we submit |
|---|---|---|
| 1 | A0 | nothing — must pass |
| 2 | A1 | Arc chain + correct token rendering |
| 3 | **A2** | **Arc: working POS** ✅ |
| 4 | B1 | + Aqua portfolio view |
| 5 | **B2** | **1inch: deploy/view/withdraw with hardware auth** ✅ |
| 6 | A3 | + shift accountability, tips, batch settlement |
| 7 | C1 | + Hedera token issued |
| 8 | **C2** | **Hedera: issuer console** ✅ |
| 9 | C3 | + revenue distribution |
| 10 | B3 | + SwapVM decoding *(the differentiator)* |
| 11 | B4 / C4 / A4 | stretch, in that order |

**Two complete tracks beat three half-built ones.** Every sponsor requires a
working MVP, an architecture diagram and a demo video; a half-finished
integration produces none of the three. The order above reaches a submittable
state for Arc at step 3 and for 1inch at step 5.

**Record the demo after each ✅**, not at the end. A five-minute video of a
finished A2 is worth more than an unrecorded A3.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Arc decimals confusion** (18 vs 6) | High | A1 exists solely for this; test both paths on hardware |
| **Chrome extension is broken** and ATS's `METAMASK` path assumes an injected provider | High | Do not depend on it. The dashboard is the desktop companion signing directly over chain 296 |
| ATS SDK's DI stack fights our build | Medium | Use ABIs + viem; treat the SDK as encoding and reads |
| Aqua approval semantics misunderstood | Medium | B1 is read-only first; B2 caps every approval |
| SwapVM decoding is larger than it looks | Medium | It is step 10, after three submittable states |
| Arc "mainnet by 30 Sep" | Medium | Arc is testnet-only; submit as deployment-ready and say so |
| Firmware regression breaks a board | Low | `scripts/check.sh` before every merge; transport changes need a board |

## Standing constraints

- Testnets only. No real funds.
- Secure boot is **not burned**; we do not claim tamper resistance.
- Windows and macOS companions build but have **never been run**.
- Browser flashing is blocked for the ESP32-C3.
