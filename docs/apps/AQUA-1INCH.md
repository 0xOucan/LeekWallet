# Aqua — 1inch mini-app

Standalone plan. **Portfolio deployment, visualisation and management, with
every authorisation on the device.**

---

## 1. What Aqua is, and why it suits a hardware wallet

Aqua is a **shared liquidity layer in which the maker's tokens never leave their
wallet**. The registry holds *virtual* balances —
`balances[maker][app][strategyHash][token]` — and tokens move only at execution,
through `pull()` and `push()`.

An LP who never deposits into a pool, and whose key lives on a device, is the
strongest form of self-custodial market making. **We are Aqua's natural client,
not an integration bolted onto it.** That is the pitch, and it is true rather
than convenient.

| | |
|---|---|
| Aqua registry | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` |
| SwapVM router | `0x111111338c5091e8440b67b168bae16a668ac0de` |
| SDK | `@1inch/aqua-sdk` — `AquaProtocolContract`, `ship()`, `dock()`, `calculateStrategyHash()` |
| Chains | Polygon, Gnosis, Optimism, Unichain, Sonic, BNB, and more — **all already in `app/packages/core/src/chains.ts`** |

## 2. The security fact that shapes the whole app

Tokens stay in the maker's wallet — **but Aqua pulls from that wallet during
swaps.** So the maker's real exposure is:

> **approval × shipped strategies**

An unlimited approval plus a single strategy is unlimited exposure. The strategy
alone tells you nothing.

This is why the portfolio view shows the **approval** as prominently as the
positions, and why every `ship()` is paired with a **capped** approval. The
companion already has `approval-cap.ts` and `allowances.ts`; this app is the
reason to finish them.

`AquaApp` requires the strategy struct to contain `maker` (so the hash is unique
per user) and to be **immutable once shipped** — changing a parameter means
`dock()` then `ship()` again, which the UI must present as the two operations it
really is rather than as an "edit".

## 3. Build, step by step

### Step 1 — Read-only portfolio
`AQUA.safeBalances(maker, app, strategyHash, tokenA, tokenB)` per known strategy.
Show app, pair, virtual balances, strategy hash, and the **current allowance**.

Read-only first, deliberately: prove the data model is understood before asking
anyone to sign into it.

**A zero balance and an unreachable RPC must never look alike.** An LP who reads
"0" and believes their liquidity is gone will do something expensive.

### Step 2 — Deploy a position
Two signatures, both rendered on the device:

```
  APPROVE · Aqua                SHIP STRATEGY · Aqua
  Token     USDC                App       XYCSwap
  Spender   Aqua registry       Pair      USDC / DAI
  Cap       1,000.00 USDC       Provide   1,000.00 USDC
  (not unlimited)               Fee       0.05%
  [ REJECT ]    [ APPROVE ]     [ REJECT ]    [ APPROVE ]
```

Two refusals are non-negotiable:

- **an unlimited approval is refused by default**
- **a strategy whose decoded `maker` is not this device's address is refused
  outright** — it is either a mistake or an attack, and neither should be signed

### Step 3 — Manage
`dock()` to withdraw. Re-`ship()` to change parameters, shown honestly as
withdraw-then-redeploy. After a full `dock()`, offer to **reduce the approval to
zero** — a standing allowance with no position is exposure with no upside.

### Step 4 — SwapVM decoding
Programs are `[opcode][args_length][args]` triples. Decode and render intent:

```
  0x17 staticBalances   →  Provide 1,000 USDC
  0x26 limitSwap1D      →  Sell at ≥ 0.9995 / DAI
  0x?? deadline         →  Expires 6 Sep 14:00
```

**An unknown opcode refuses to render, and therefore refuses to sign.** A
partial decode produces a screen that looks authoritative and is not, which is
worse than showing nothing.

Nobody else will render bytecode on a hardware screen, and SwapVM use is
explicitly scored higher by the sponsor.

### Step 5 *(stretch)* — a custom opcode
`_merchantFloorSwap`: a limit swap that refuses below a floor price and caps
drawdown per epoch — a treasury instruction for a business holding revenue in
one stablecoin and owing costs in another. It ties Aqua to La Caja.

Tested against the repo's `CoreInvariants`, which already asserts seven
invariants including exact-in/out symmetry, additivity, price monotonicity and
rounding-favours-maker. We add ours to that harness rather than inventing one.

## 4. Testing rounds

| # | What is tested | Funds |
|---|---|---|
| **A1** | Positions match a direct RPC query; RPC failure shows **unavailable, never zero** | none — public RPC or fork |
| **A2** | Unlimited approval **refused by default**; a capped approval renders its cap | testnet gas + 2 ERC-20s |
| **A3** | Position shipped from the device appears in A1's view and on-chain | as A2 |
| **A4** | A strategy naming another `maker` **refuses on the device** | as A2 |
| **A5** | `dock()` returns virtual balances to zero; app offers to zero the approval | as A2 |
| **A6** | `approve` succeeds and `ship` fails → app reports a **capped approval outstanding**, does not silently retry | as A2 |
| **A7** | Three programs decode against `forge` fixtures; an **unknown opcode refuses** | local fork |
| **A8** *(stretch)* | Custom opcode passes `CoreInvariants` | local fork |

A Foundry mainnet fork (`--fork-url`) is explicitly acceptable to the sponsor
and avoids needing real liquidity.

## 5. Milestones and gates

| Gate | Deliverable | Submittable if we stop |
|---|---|---|
| **Q1** | Read-only portfolio (A1) | "LeekWallet shows your Aqua portfolio" |
| **Q2** | **Approve + ship + dock (A2–A6)** | **Deploy, view and withdraw with hardware authorisation** ✅ |
| **Q3** | SwapVM decoding (A7) | + the differentiator |
| **Q4** *(stretch)* | Custom opcode (A8) | + the scoring bonus |

**Record the demo at Q2.**

## 6. What we will not claim

- We do not claim yield, returns, or that any strategy is sound. The app
  deploys what the user chose and shows what it did.
- Decoding covers a **named set of opcodes**; the rest refuse. The supported
  list goes in the docs, and so does the unsupported one.
- Testnets and forks only. No real funds.
