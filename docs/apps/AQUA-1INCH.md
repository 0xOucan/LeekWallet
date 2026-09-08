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
`AQUA.rawBalances(maker, app, strategyHash, token) -> (uint248, uint8)` per leg.
Show app, pair, virtual balances, strategy hash, and the **current allowance**.

> **Not `safeBalances`.** An earlier draft of this plan said to use it. It
> **reverts** — `require(tokensCount > 0 && tokensCount != _DOCKED,
> SafeBalancesForTokenNotInActiveStrategy(...))` — so a docked strategy, a
> token that was never in one, and an unreachable node all arrive as the same
> failed call inside a multicall. That collapses precisely the states this
> milestone exists to keep apart. `rawBalances` answers every state without
> reverting, which leaves a revert meaning "nobody answered".

Three further corrections found by reading the deployed contract, each of which
shapes the app:

- **Aqua indexes no event parameter, not even `maker`.** `eth_getLogs` cannot
  filter by maker, so discovery is topic-filtered and matched client-side, and
  is a claim about a **block range** rather than about all history. Positions
  are a floor, never a census, and the UI must say so.
- **`strategyHash = keccak256(strategy)` is not per-user.** The registry keys by
  `msg.sender` separately. So Q2's refusal to sign a strategy naming another
  maker must **decode the app's struct**; it cannot be derived from the hash.
- **`Shipped` does not carry the token list.** Tokens come from the per-token
  `Pushed` events that `ship()` emits in the same transaction.

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

> ### What Q2 turned out to cost, which this section did not anticipate
>
> "Both rendered on the device" was not a matter of writing two screens. The
> device refused `ship()` twice over, and both refusals had to be answered in
> firmware before any of the above was reachable:
>
> 1. **Dynamic arguments.** `ship(address,bytes,address[],uint256[])` has three
>    of them, and both the firmware decoder and the host's ERC-7730 layer refuse
>    any signature with a dynamic argument on principle — an offset the host
>    chose, followed into a tail nobody can predict, is how a screen ends up
>    describing something other than what executes. The answer was **two
>    hand-written decoders**, not dynamic types in general: `ship` and `dock`
>    each have one fixed layout, compared against the canonical encoding
>    exactly, so anything that is merely legal ABI for the same arguments is
>    refused rather than normalised.
> 2. **`ETH_MAX_DATA`.** It was 256 bytes and a `ship` is about 600 — the
>    strategy blob alone is 256 in every deployment observed on chain. That is a
>    capacity limit standing in for a comprehension one, so it went to 640
>    (still under `PROTOCOL_MAX_FRAME`), and both request tasks went 8 → 10 KB
>    to keep the stack margin rather than spend it.
>
> There was a third, on the host: `screenProposal` required a bundled ERC-7730
> descriptor, and a call with a dynamic argument can never have one. So
> `DEVICE_DRAWN_KINDS` was added — a narrow second route for calls the firmware
> decodes and draws itself, which is *stronger* evidence of describability than
> an unsigned registry file, not weaker.
>
> The upshot for anyone reading this plan before doing Q3: a milestone phrased
> as "and render it on the device" is a firmware milestone. Budget it as one.

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

> ### Where Aqua actually is
>
> The README lists sixteen networks and every one is a mainnet; the SDK contains
> **no testnet reference at all** — no sepolia, goerli, amoy, chiado, fuji or
> mumbai. But the README is not the whole story, and `eth_getCode` disagrees
> with it in one useful way:
>
> | Chain | Aqua registry | SwapVM router |
> |---|---|---|
> | Polygon, Gnosis (mainnet) | ✅ 5620 B | ✅ |
> | **Ethereum Sepolia** | ✅ **5620 B** | ❌ none |
> | Base / Arbitrum / OP Sepolia, Fuji, Amoy, Chiado | ❌ | ❌ |
>
> The Sepolia deployment is real and current, not a leftover: its runtime
> bytecode hashes **identical** to Polygon's and Gnosis's (`4c886bff…`), which
> follows from the deterministic deployment the README describes, and it emitted
> **25 events in the last 9000 blocks**.
>
> **What that means for testing.** Q2 is `approve` + `ship()` + `dock()` — the
> registry alone — so it can run on **Sepolia with faucet ETH**. Q3's SwapVM
> decoding cannot: the router is not there, so that needs a **fork**. The
> sponsor states plainly that *"local forks are ok"*, and
> `anvil --fork-url <mainnet>` gives real contracts and real liquidity with
> nothing to acquire.
>
> **A caution about single endpoints.** `polygon-rpc.com` answered `eth_getCode`
> with `0x` for a contract that is demonstrably there, and two other endpoints
> disagreed with it. One RPC is not evidence. That is the same failure this app
> renders as *unavailable* rather than *zero*.
>
> **Licence.** Aqua is `LicenseRef-Degensoft-Aqua-Source-1.1` — source-available,
> **not** open source, and not compatible with this project's Apache-2.0.
> Calling the deployed contracts is unaffected. **Copying or modifying SwapVM
> source** — which the hackathon rules permit — would be governed by that
> licence, so read it before B4 rather than after.

## 4. Testing rounds

| # | What is tested | Funds |
|---|---|---|
| **A1** | Positions match a direct RPC query; RPC failure shows **unavailable, never zero** | none — public RPC or fork |
| **A2** | Unlimited approval **refused by default**; a capped approval renders its cap | Sepolia ETH + 2 ERC-20s, **or** a mainnet fork |
| **A3** | Position shipped from the device appears in A1's view and on-chain | as A2 (same fork) |
| **A4** | A strategy naming another `maker` **refuses on the device** | as A2 (same fork) |
| **A5** | `dock()` returns virtual balances to zero; app offers to zero the approval | as A2 (same fork) |
| **A6** | `approve` succeeds and `ship` fails → app reports a **capped approval outstanding**, does not silently retry | as A2 (same fork) |
| **A7** | Three programs decode against `forge` fixtures; an **unknown opcode refuses** | local fork |
| **A8** *(stretch)* | Custom opcode passes `CoreInvariants` | local fork |

A Foundry mainnet fork (`--fork-url`) is explicitly acceptable to the sponsor
and avoids needing real liquidity.

**What A2, A3 and A5 were actually run against.** `app/scripts/aqua-fork-check.mjs`
drives the app's own planner and encoders at the real deployed registry over an
`anvil --fork-url` of Sepolia. It is not part of `pnpm test` — a suite that goes
red because a fork is not running is a suite people learn to ignore — so it is
run by hand:

```
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com &
pnpm --dir app exec node --experimental-strip-types scripts/aqua-fork-check.mjs
```

It asserts the capped `approve` lands and the **token** reports the cap, the
`ship` lands and the registry files it under exactly the hash we computed, the
`Shipped` event returns the strategy bytes verbatim, `rawBalances` reports the
position, `dock` returns it and leaves `tokensCount == 0xff` (docked, not
absent), and the revoke sets the allowance to zero.

**Unverified against real hardware.** No device was attached at any point. The
signing path was exercised against a fake `propose`, and the decoder and screens
against the host suites — `sim/test_eth_decode.c`, `sim/test_ui.c` (which drives
the real `ui.c` against a fake OLED and reads the framebuffer), and three
mock-conformance vectors where the firmware and the host mirror are compared
byte for byte. What has **not** happened is a human pressing the button on a
board: no claim is made that the maker page is legible on the physical 128×64
panel, or that a 640-byte `signTransaction` survives a real BLE or USB
round-trip at the new frame size.

## 5. Milestones and gates

| Gate | Deliverable | Submittable if we stop |
|---|---|---|
| **Q1** | Read-only portfolio (A1) | "LeekWallet shows your Aqua portfolio" |
| **Q2** | **Approve + ship + dock (A2–A6)** ✅ | **Deploy, view and withdraw with hardware authorisation** ✅ |
| **Q3** | SwapVM decoding (A7) | + the differentiator |
| **Q4** *(stretch)* | Custom opcode (A8) | + the scoring bonus |

**Record the demo at Q2.**

## 6. What we will not claim

- We do not claim yield, returns, or that any strategy is sound. The app
  deploys what the user chose and shows what it did.
- Decoding covers a **named set of opcodes**; the rest refuse. The supported
  list goes in the docs, and so does the unsupported one.
- Testnets and forks only. No real funds.
