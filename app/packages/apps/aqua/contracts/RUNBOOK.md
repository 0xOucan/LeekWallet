# RUNBOOK — shipping real Aqua positions on Base mainnet

End to end, with exact commands and expected output at every step. Someone who
was not in the conversation that produced this should be able to follow it.

The plan behind every number here is `../docs/STRATEGIES.md`. Read §0 (the
budget) and §6 (what is wrong with the plan) before you start; **§6.1 is a
check that can stop the deployment, and it is step 0 below.**

---

## Cast of addresses

| Role | Address | Holds |
|---|---|---|
| **Funder / deployer / taker** | `0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45` | 0.002 ETH, 2.04 USDC, 0.000201 WETH on Base |
| **Maker** — the LeekWallet device | `0xbDEB381a7c77040bf2a99E2990C116774CCb339f` | **nothing on Base yet** |
| Aqua registry | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` | — |
| SwapVM router (the `app`) | `0x111111338c5091e8440b67b168bae16a668ac0de` | — |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 decimals |
| WETH | `0x4200000000000000000000000000000000000006` | 18 decimals |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 decimals |

One address funds and fills; the other makes. **They must be different** — a
maker filling its own position accomplishes nothing and pays fees to do it.

## Never put a private key on a command line

A key in `argv` is a key in your shell history, in the process table, and in
whatever your shell logs. Import once, then reference by name:

```bash
cast wallet import base-deployer --interactive
# paste the deployer's key at the prompt; it goes into ~/.foundry/keystores
```

Every command below uses `--account base-deployer`. **The maker never appears
in a `cast` command at all** — the maker is the device, and its transactions
are approved by pressing a button.

## Environment

```bash
export BASE_RPC="https://mainnet.base.org"      # or your own endpoint
export DEPLOYER=0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45
export MAKER=0xbDEB381a7c77040bf2a99E2990C116774CCb339f
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export WETH=0x4200000000000000000000000000000000000006
export CBBTC=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf
export REGISTRY=0x1111113ccf1426a8e30e2bff5e005d929bf6a90a
export ROUTER=0x111111338c5091e8440b67b168bae16a668ac0de

cd app/packages/apps/aqua/contracts
```

Sanity: `cast chain-id --rpc-url "$BASE_RPC"` must print **8453**. If it prints
anything else, stop — every address above is Base-only.

---

## Step 0 — the check that can stop everything

**Do not skip this.** STRATEGIES.md §6.1 / AUDIT-REPORT §6.1: the *width* of
opcode 18's arguments is settled on-chain (64 bytes), but the claim that they
are `sqrt(P) × 1e18` with `P = tokenGt/tokenLt` in raw units comes from
documentation, not from bytes we have observed. This repository's rule is that
we do not act on an inferred layout.

Read a real live opcode-18 program off Base and compare orders of magnitude:

```bash
# Every Aqua Shipped event. NOTE: none of Aqua's event parameters are indexed,
# so this cannot be filtered by maker -- see src/registry.ts. Narrow the block
# range to keep the response sane.
cast logs --rpc-url "$BASE_RPC" \
  --address "$REGISTRY" \
  'Shipped(address,address,bytes32,bytes)' \
  --from-block $(( $(cast block-number --rpc-url "$BASE_RPC") - 200000 )) \
  | head -100
```

Take a `strategy` blob whose program contains `1240` (opcode 18, args_len 64),
and read the two 32-byte words after it. **What you are checking:** for a
WETH/USDC-shaped pair those words should be around `6e13`; for a USDC/BTC-shaped
pair around `3e16` (STRATEGIES.md §3.3). If instead they are around `4e18` or
`2^96`-scaled, the layout is not what we assumed.

- **Magnitudes agree** → continue to step 1.
- **They do not** → **stop.** Drop opcode 18 from the program, ship plain
  `xycSwap` (opcode 17, zero args, nothing to get wrong), and shelve the tiers.
  Record what you saw in STRATEGIES.md §6.1 before anything is deployed.

---

## Step 1 — funding

The maker holds nothing. The funder holds 0.002 ETH, 2.04 USDC and 0.000201
WETH, and that is the entire budget.

### What the maker needs, and why

| Item | Amount | Why exactly this |
|---|---|---|
| ETH (gas) | **0.0008 ETH** | the maker signs 4 transactions: 2 approvals, 2 ships, plus 2 docks later = 6. Base is cheap; 0.0008 is generous headroom for six sub-$0.01 transactions and leaves the funder able to pay for its own deploy and fills. |
| USDC | **2.000000** (`2000000` raw) | 1.00 into P1, 1.00 into P2 |
| WETH | **0.0002** (`200000000000000` raw) | the whole WETH balance, into P1 |

That is the *entire* USDC balance minus dust and the *entire* WETH balance. The
funder keeps ~0.04 USDC and ~0.0012 ETH for gas on the deploy and the fills.

### Can all three tiers be funded? No.

**No. Fund one tier.** 2 USDC across three tiers is 0.66 USDC per tier per
pair, and each tier is a separate strategy needing its own ship transaction and
its own share of a fixed approval. Splitting the budget three ways produces
three positions too small for anyone to fill and triples the gas.

**Order of preference, if you want to see more than one:**

1. **`medium` on P1 (USDC/WETH)** — the only two-sided position, the only one
   with a real market on both legs, and the one whose band a person can check
   by eye against a price they know. **Fund this first. If you fund only one
   thing, fund this.**
2. **`medium` on P2 (USDC/cbBTC)** — one-sided (the maker holds no cbBTC), so
   it is a valid position that decodes and renders but is not a market. Worth
   shipping to show the second pair.
3. **`high` on P1** — only if you want a second tier visibly on chain to
   compare bands. Take its USDC from P2's allocation, not from P1's.

`low` is not recommended at this size: a band from half the mid to double it,
over 1 USDC, is indistinguishable in behaviour from an unconcentrated position.

### Commands

```bash
# ETH for gas
cast send --rpc-url "$BASE_RPC" --account base-deployer \
  "$MAKER" --value 0.0008ether

# USDC: 2.000000
cast send --rpc-url "$BASE_RPC" --account base-deployer \
  "$USDC" "transfer(address,uint256)" "$MAKER" 2000000

# WETH: 0.0002
cast send --rpc-url "$BASE_RPC" --account base-deployer \
  "$WETH" "transfer(address,uint256)" "$MAKER" 200000000000000
```

**Verify — from chain state, not from our UI:**

```bash
cast balance "$MAKER" --rpc-url "$BASE_RPC"                                    # >= 800000000000000
cast call "$USDC" "balanceOf(address)(uint256)" "$MAKER" --rpc-url "$BASE_RPC" # 2000000
cast call "$WETH" "balanceOf(address)(uint256)" "$MAKER" --rpc-url "$BASE_RPC" # 200000000000000
```

---

## Step 2 — deploy the gate token

The gate is what keeps the position off bots without asking anyone's
permission. The **holder is the taker**, i.e. the deployer — not the maker.
See STRATEGIES.md §5 and `AUDIT-REPORT.md`.

```bash
forge test                       # 21 passed, 20,000 fuzz runs, before you deploy

export GATE_HOLDER="$DEPLOYER"
forge script script/DeployGateToken.s.sol \
  --rpc-url "$BASE_RPC" --account base-deployer \
  --broadcast --verify
```

Expected tail:

```
GateToken      : 0x....
holder         : 0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45
supply         : 1000
holder balance : 1000
```

```bash
export GATE=0x<the address printed above>
# The only property with any on-chain effect:
cast call "$GATE" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$BASE_RPC"  # 1000, non-zero
cast call "$GATE" "balanceOf(address)(uint256)" "$MAKER"    --rpc-url "$BASE_RPC"  # 0
```

If the maker's balance is **not** zero, you minted to the wrong address: the
maker would then be able to fill its own position and the gate proves nothing.
There is no mint — redeploy.

---

## Step 3 — plan the position, and read the band back by eye

Nothing is signed in this step. It prints bytes and, more importantly, prints
the band in units a person understands.

Get a mid price from an **off-chain reference** — a DEX spot price is not an
oracle, and a band centred on a manipulable number hands the manipulator the
band (STRATEGIES.md §3.4).

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  script/plan-position.mjs \
  --pair weth-usdc --tier medium --mid 4000 \
  --maker "$MAKER" --gate "$GATE" --deadline-hours 2 \
  --leg usdc:1000000 --leg weth:200000000000000
```

Expected shape:

```
pair            weth-usdc  (tokenLt WETH, tokenGt USDC)
tier            medium
band            medium: 2800 to 5714.285714 USDC per WETH (mid 4000)
                ^ CHECK THIS BY EYE. ...
deadline        1789066619  (2026-09-10T18:56:59.000Z)
fee             0.30%  = 3000000 against 1e9, NOT bps
instructions, in program order (order is security-critical):
  @  0  op 13  deadline
  @  7  op 14  onlyTakerTokenBalanceNonZero
  @ 29  op 18  xycConcentrateGrowLiquidity2D
  @ 95  op 21  flatFeeAmountInXD
  @101  op 17  xycSwapXD
  @103  op 20  salt
program         0x0d05...
strategy        0x0000...0020...
strategyHash    0x...
0xf50b870f...                      <- the ship calldata
```

**THE CHECK: does the band line read like a price you recognise?** "2800 to
5714 USDC per WETH" around a mid of 4000 is right. "0.0000000028 to
0.0000000057" or "2.8e15 to 5.7e15" is a decimals error, and it is the one
failure the code cannot catch for you (AUDIT-REPORT §6.1, and the comment on
`MAX_SQRT_PRICE`, which is explicit that the bound does *not* catch this).

Also check the deadline is about two hours from now, in your local wall clock.

Save the outputs:

```bash
export STRATEGY=0x...      # the `strategy` line
export SHIP=0xf50b870f...  # the ship calldata
export SHASH=0x...         # strategyHash -- you need this to dock
```

For P2, the same with `--pair usdc-cbbtc --mid 110000 --leg usdc:1000000`
(one-sided: the maker holds no cbBTC).

---

## Step 4 — the approval, on the device

**Bounded, sized to the position. Never unlimited** — `src/deploy.ts` refuses
to encode an unlimited approval and this step does not route around it.

Exact numbers, for P1 + P2 together:

| Token | Approve to registry | = |
|---|---|---|
| USDC | `2000000` | 2.000000 USDC |
| WETH | `200000000000000` | 0.0002 WETH |

Note the arithmetic the portfolio states: exposure is `allowance × shipped
strategies`, so a 2 USDC allowance is reachable by *either* position. It is
capped at the total on purpose, and both positions are docked in step 8.

Do this **in the companion app**, on the Aqua screen, with the device attached.
Steps 3 to 5 of this runbook are one screen there now — "Ship a position", above
the raw strategy form (`src/author-view.ts`, planning in `src/tier-plan.ts`):

1. Open Aqua on Base. The portfolio shows the standing allowance per token.
2. Pick the pair and the tier. All three tier descriptions are on screen at
   once; none of them projects a return, and none of them ever will.
3. Type the mid price. **The band read-back appears in the units you stated it
   in — check it by eye, exactly as in step 3 above.** The picker reads the
   wallet's real balance for each side and refuses a leg larger than it, so a
   position that could not be filled is never planned.
4. The app builds `approve` + `ship` as one plan, with the approval capped at
   the position's own amount.
5. Approve the `approve` step on the device. **The device screen must show the
   exact figure above** — if it shows an unlimited or a different amount, reject
   it on the device and stop.

The maker currently holds USDC and neither WETH nor cbBTC, so both pairs plan as
ONE-SIDED, and the picker says so in those words rather than drawing a market
that only exists in one direction without mentioning it. A pair with nothing on
either side is refused outright: no plan, no button.

Verify from chain state:

```bash
cast call "$USDC" "allowance(address,address)(uint256)" "$MAKER" "$REGISTRY" --rpc-url "$BASE_RPC"
# 2000000 -- and NOT 115792089237316195423570985008687907853269984665640564039457584007913129639935
cast call "$WETH" "allowance(address,address)(uint256)" "$MAKER" "$REGISTRY" --rpc-url "$BASE_RPC"
# 200000000000000
```

---

## Step 5 — ship

Still in the companion, still on the device — the same screen as step 4; the
plan is one press per step, in order. The device decodes the calldata itself
(`src/eth-decode.c`) and draws one page per instruction, in program order.

The `approve` step is an ordinary ERC-20 call, so it needs an ERC-7730
descriptor or the wallet declines it before the device sees anything. Core
bundles none for any Base mainnet token, so the app supplies one for these three
addresses and no others (`src/tokens.ts`); core still judges it.

**What the device must show, and what to do if it does not:**

- Six instruction pages, in the order printed in step 3. If the device shows a
  **refusal screen** instead, do not look for a way around it — a program the
  device cannot read in full is refused as a whole transaction, deliberately
  (`docs/AQUA-B3-SPEC.md` §6.6/§6.7). Something disagrees between the host and
  the firmware; that is a bug to fix, not a prompt to retry.
- The maker on the strategy must be **this device's own address**. A strategy
  naming a different maker is refused outright, not warned about.

**What success looks like on chain.** One `Shipped` and one `Pushed` per token:

```bash
export TX=0x<the ship transaction hash>
cast receipt "$TX" --rpc-url "$BASE_RPC" | head -20        # status 1

# Shipped(maker, app, strategyHash, strategy) -- one
# Pushed(maker, app, strategyHash, token, amount) -- one per leg
cast receipt "$TX" --rpc-url "$BASE_RPC" --json \
  | jq -r '.logs[] | "\(.address)  \(.topics[0])"'
```

Topics to match (all events, no indexed parameters — so exactly one topic
each):

| Event | topic0 |
|---|---|
| `Shipped` | `cast keccak "Shipped(address,address,bytes32,bytes)"` |
| `Pushed` | `cast keccak "Pushed(address,address,bytes32,address,uint256)"` |

**What the companion should display afterwards:** the position appears in the
portfolio as **active**, with `tokensCount` equal to the number of legs and a
per-token amount equal to what you shipped. If it shows *docked* or *absent*,
the ship did not land — those are three distinguishable states and the app
draws them differently on purpose (`src/registry.ts`).

---

## Step 6 — verify from chain state, not from our UI

The registry read that answers for every state without reverting:

```bash
cast call "$REGISTRY" \
  "rawBalances(address,address,bytes32,address)(uint248,uint8)" \
  "$MAKER" "$ROUTER" "$SHASH" "$USDC" --rpc-url "$BASE_RPC"
```

| Result | Means |
|---|---|
| `1000000, 2` | **healthy** — active, 1.00 USDC credited, a 2-token strategy |
| `x, 0` | **absent** — no such position, ever. The ship did not land |
| `x, 255` | **docked** — closed by the maker on purpose |
| revert | nobody answered. An RPC problem, not a position problem |

Do **not** use `safeBalances` here: it reverts for any token not in an active
strategy, which collapses "docked", "never existed" and "unreachable node" into
one indistinguishable failure.

**Healthy versus under-funded.** The registry number is a *credit*; what can
actually be pulled is bounded by the ERC-20 allowance. A position is
under-funded when the credit exceeds either the allowance or the maker's actual
balance:

```bash
cast call "$USDC" "balanceOf(address)(uint256)" "$MAKER"   --rpc-url "$BASE_RPC"
cast call "$USDC" "allowance(address,address)(uint256)" "$MAKER" "$REGISTRY" --rpc-url "$BASE_RPC"
```

Healthy: `balance >= credit` **and** `allowance >= credit`. The companion's
funding monitor draws exactly this comparison, and shows an under-funded
position in the danger tone rather than as a plain number — a credit the maker
cannot honour is a position that reverts when someone tries to fill it.

---

## Step 7 — fill it

This is the on-chain token transfer the prize asks for. It runs from the
**deployer**, which is the address holding the gate token.

The taker must first approve the router for what it is spending:

```bash
# Filling with 0.25 USDC of the deployer's own funds
cast send --rpc-url "$BASE_RPC" --account base-deployer \
  "$USDC" "approve(address,uint256)" "$ROUTER" 250000
```

> ⚠️ **The taker-traits encoding below is NOT verified against the deployed
> router.** It is derived from `1inch/swap-vm` at `afd99c4`
> (`contracts/libs/TakerTraits.sol`): a 22-byte big-endian header whose low 16
> bits are flags — `IS_EXACT_IN = 0x0001`, `IS_FIRST_TRANSFER_FROM_TAKER =
> 0x0020`, `IS_A_TO_B = 0x0080` — followed by taker data (empty here, so all
> four slice offsets are zero). **Always `quote` first.** `quote` is a
> `staticcall`: it costs nothing and it reverts if any of this is wrong.

```bash
# 0x0021 = exactIn | firstTransferFromTaker, B->A (spending USDC = tokenGt on P1)
export TT=0x0000000000000000000000000000000000000000000021

cast call --rpc-url "$BASE_RPC" "$ROUTER" \
  "quote((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)" \
  "($MAKER,<traits>,<data>)" 250000 "$TT"
```

`<traits>` and `<data>` are the second and third fields of the `Order` — read
them out of the `strategy` blob printed in step 3 (spec §4 gives the offsets:
word 2 is `traits`, and `data` begins at word 5).

- **`quote` returns two non-zero amounts** → the program ran, the gate passed,
  the band contains the price. Send it:

  ```bash
  cast send --rpc-url "$BASE_RPC" --account base-deployer "$ROUTER" \
    "swap((address,uint256,bytes),uint256,bytes)" \
    "($MAKER,<traits>,<data>)" 250000 "$TT"
  ```

- **`quote` reverts** → see step 9. Do not send a transaction to find out why;
  the static call already told you, for free.

Verify the transfer actually happened, from balances rather than from a UI:

```bash
cast call "$WETH" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$BASE_RPC"  # up
cast call "$USDC" "balanceOf(address)(uint256)" "$MAKER"    --rpc-url "$BASE_RPC"  # up
```

---

## Step 8 — dock, immediately

The two-hour deadline is a backstop, **not the plan**. Docking is what actually
ends the authority; until then the position remains a standing offer that every
future swap may take.

In the companion, on the Aqua screen, choose Dock. The device draws one page
per token. Confirm.

```bash
cast call "$REGISTRY" \
  "rawBalances(address,address,bytes32,address)(uint248,uint8)" \
  "$MAKER" "$ROUTER" "$SHASH" "$USDC" --rpc-url "$BASE_RPC"
# tokensCount == 255 -> docked
```

Then drop the allowances, which docking does **not** do:

```bash
# On the device, via the companion. Set to zero, both tokens.
cast call "$USDC" "allowance(address,address)(uint256)" "$MAKER" "$REGISTRY" --rpc-url "$BASE_RPC"  # 0
cast call "$WETH" "allowance(address,address)(uint256)" "$MAKER" "$REGISTRY" --rpc-url "$BASE_RPC"  # 0
```

A standing allowance with no position behind it is the one state in this flow
that still costs money after everyone has walked away.

---

## Step 9 — what can go wrong, in order of likelihood

### 1. `quote` reverts and you cannot tell why *(most likely)*

Work down this list; each is a one-line check.

| Cause | Check | Fix |
|---|---|---|
| The taker does not hold the gate token | `cast call "$GATE" "balanceOf(address)(uint256)" "$DEPLOYER"` | fill from the address that holds it |
| The deadline has passed | compare `date +%s` to the deadline from step 3 | re-plan and re-ship; a 2-hour window is short |
| The price is outside the band | compare the current mid to the band line from step 3 | expected for `high`; the tier is doing its job |
| Wrong taker-traits flags | flip `IS_A_TO_B` (`0x0080`) — you may have the direction backwards | try `0x00a1` instead of `0x0021` |
| Taker has not approved the router | `cast call "$USDC" "allowance(address,address)(uint256)" "$DEPLOYER" "$ROUTER"` | approve |

### 2. The device refuses the ship

**Do not look for a way around this.** A program the device cannot read in full
refuses the whole transaction, by design. It means the host and the firmware
disagree about the program — a bug to fix in `src/eth-decode.c` or
`src/program.ts`, with a shared calldata vector added so it cannot recur.

### 3. The band is wrong by a factor of a million

You skipped the eyeball check in step 3, or step 0 found the layout is not what
we assumed. At 1 USDC the loss is negligible, which is exactly why the money
cannot be the alarm (STRATEGIES.md §6.6). Dock, re-plan, re-ship.

### 4. `rawBalances` says `absent` after a ship that succeeded

You are querying the wrong `strategyHash`, or the wrong `app`. The hash is
`keccak256(strategy)` over the **exact** bytes shipped — a re-run of
`plan-position.mjs` generates a **new random salt** and therefore a different
hash. Use the `SHASH` you saved, or read the `Shipped` event back.

### 5. Nobody fills it

Entirely possible and not a failure. A gated 1 USDC position is worth less than
the gas to fill it for anyone but you, which is why step 7 fills it yourself.
The position is correct and renders correctly; it simply has no market.

### 6. Out of gas on the maker

The device holds only what step 1 sent. Six transactions at Base prices is
comfortably inside 0.0008 ETH, but a docking round after a fee spike is where
it would bite. Top up from the funder; do not skip the dock to save gas.

---

## What is not in this runbook

**DCA.** `../src/dca.ts` plans an *attended* schedule — real tranches, each one
still requiring a press on the device — and it is unit tested. **It has never
been shipped on a live chain, and this runbook does not ship it.** See
STRATEGIES.md §4 for why the alternative (a modified SwapVM router) was
rejected even though it measurably fits under EIP-170, and for the economics,
which do not work at 2 USDC and are not claimed to.
