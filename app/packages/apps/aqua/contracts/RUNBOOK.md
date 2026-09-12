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
| **Funder / deployer / taker** | `0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45` | 0.005 ETH · 4.04 USDC · 0.0002 WETH · 0.00000765 cbBTC |
| **Maker** — the LeekWallet device | `0xbDEB381a7c77040bf2a99E2990C116774CCb339f` | 0.002 ETH · 2.50 USDC · **0.004 WETH · 0.00012 cbBTC** |
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
# Already imported if you ran the Hedera runbook -- `cast wallet list` to check.
cast wallet import monad-deployer --interactive
# paste the deployer's key at the prompt; it goes into ~/.foundry/keystores
```

Every command below uses `--account monad-deployer`. **The maker never appears
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

## Step 0 — RESOLVED 2026-09-10, skip it

**This check has been run and it passed.** A real opcode-18 program on Base
carries `4.685e13` and `5.179e13`, which under the documented reading is a band
of ~2,190–2,680 USDC per ETH — the predicted magnitude for WETH/USDC. A
raw-for-sqrt error would move the number ~1e4 and a human-for-raw error ~1e6,
so either would land nowhere near. Recorded in `../docs/STRATEGIES.md`.

The tiers are shippable. **Go to step 1.** The original instructions are kept
below only so the method is reproducible if the router address ever changes.

<details><summary>original step 0</summary>

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

</details>

---

## Step 1 — funding  ✅ ALREADY DONE (verified 2026-09-10)

**Skip the transfers below unless a balance check disagrees.** The maker was
funded directly and holds more than this section originally planned for:

```
device / maker    0.002 ETH   2.50 USDC   0.004 WETH   0.00012 cbBTC
deployer / taker  0.005 ETH   4.04 USDC   0.0002 WETH  0.00000765 cbBTC
```

Confirm before relying on it:

```bash
cast balance "$MAKER" --rpc-url "$BASE_RPC"
cast call "$USDC"  "balanceOf(address)(uint256)" "$MAKER" --rpc-url "$BASE_RPC"   # 2500000
cast call "$WETH"  "balanceOf(address)(uint256)" "$MAKER" --rpc-url "$BASE_RPC"   # 4000000000000000
cast call "$CBBTC" "balanceOf(address)(uint256)" "$MAKER" --rpc-url "$BASE_RPC"   # 12000
```

### What changed, and why it matters

This section used to say the maker held nothing and that **P2 (USDC/cbBTC)
would be one-sided**. That is no longer true: the maker holds 0.00012 cbBTC, so
**both pairs can be shipped two-sided.**

That is not a cosmetic improvement. A one-sided position can only trade in one
direction — the maker gives what it shipped and receives the other token — so a
USDC-only P2 would have required the **taker** to pay cbBTC, and the taker holds
none. It would have been unfillable. Two-sided, the taker pays USDC on either
pair, which is the direction it is funded for.

### Does the taker need more?

**No.** It fills by paying USDC and holds 4.04, against a fill of ~0.25. Its
0.005 ETH covers the gate deploy, an approval and a swap several times over on
Base.

It would only need cbBTC or WETH to fill in the *other* direction — buying USDC
from the maker rather than selling it. Nothing in this runbook does that.

### Which tier to fund

Unchanged, and still the important judgement: **fund one tier per pair, not
three.** 2.5 USDC split three ways is three positions too small for anyone to
fill, each needing its own ship transaction and its own slice of a fixed
approval.

1. **`medium` on P1 (USDC/WETH)** — the band is checkable by eye against a price
   you know. If you ship only one thing, ship this.
2. **`medium` on P2 (USDC/cbBTC)** — now genuinely two-sided, so it is a real
   market rather than a demonstration.
3. **`high` on P1** — only to put a second band on chain for comparison.

`low` remains not worth it at this size: half-the-mid to double-the-mid over
1 USDC behaves indistinguishably from an unconcentrated position.

---

## Step 2 — deploy the gate token

The gate is what keeps the position off bots without asking anyone's
permission. The **holder is the taker**, i.e. the deployer — not the maker.
See STRATEGIES.md §5 and `AUDIT-REPORT.md`.

**First time in this directory, install the dependencies.** `lib/` is
gitignored -- deps are installed, not committed -- so a fresh checkout has no
`forge-std` and every command fails with `Source "forge-std/Test.sol" not
found`:

```bash
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
```

```bash
forge test                       # 21 passed, 20,000 fuzz runs, before you deploy

export GATE_HOLDER="$DEPLOYER"
forge script script/DeployGateToken.s.sol \
  --rpc-url "$BASE_RPC" --account monad-deployer \
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
export GATE=0x8ed185f95d62a60cc3cf2688ffe3a250b3a8262b   # verified: Sourcify + Basescan
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

> **The mids below are prices, not constants.** They were correct at
> 2026-09-10 (ETH $2,462.02, BTC $77,218.10). Re-check spot before you plan.
> A `medium` band is 0.7x to 1.43x the mid, so a mid that is stale by more
> than ~30% puts spot *outside* the band, and the position becomes a standing
> offer to trade at off-market prices — free money for the first arbitrageur.
> The band line is the check; it only works if you compare it to today's price.

Get a mid price from an **off-chain reference** — a DEX spot price is not an
oracle, and a band centred on a manipulable number hands the manipulator the
band (STRATEGIES.md §3.4).

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  script/plan-position.mjs \
  --pair weth-usdc --tier medium --mid 2462 \
  --maker "$MAKER" --gate "$GATE" --deadline-hours 2 \
  --leg usdc:1000000 --leg weth:406168000000000
```

Expected shape:

```
pair            weth-usdc  (tokenLt WETH, tokenGt USDC)
tier            medium
band            medium: 1723.4 to 3517.142857 USDC per WETH (mid 2462)
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

For P2, the same with `--pair usdc-cbbtc --mid 77218 --leg usdc:1000000
--leg cbbtc:1295` — **two-sided**, since the maker now holds cbBTC. Note the
decimals: cbBTC is 8, so `1295` is 0.00001295 cbBTC. At $77,218/BTC that is $1.00, matching the 1 USDC leg. The same digits in WETH units
would be 6000 wei, effectively nothing.

---

## Step 4 — the approval, on the device

**Bounded, sized to the position. Never unlimited** — `src/deploy.ts` refuses
to encode an unlimited approval and this step does not route around it.

Exact numbers, for P1 + P2 together:

| Token | Approve to registry | = | For |
|---|---|---|---|
| USDC | `2000000` | 2.000000 USDC | P1 + P2, 1 USDC each |
| WETH | `406168000000000` | 0.000406168 WETH | P1, $1.00 at $2,462/ETH |
| cbBTC | `1295` | 0.00001295 cbBTC | P2, $1.00 at $77,218/BTC |

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

The maker holds all three tokens (step 1), so **both pairs plan two-sided**.
Were a side empty, the picker would say ONE-SIDED in those words rather than
drawing a market that only exists in one direction without mentioning it. A
pair with nothing on either side is refused outright: no plan, no button.

Verify from chain state:

```bash
cast call "$USDC" "allowance(address,address)(uint256)" "$MAKER" "$REGISTRY" --rpc-url "$BASE_RPC"
# 2000000 -- and NOT 115792089237316195423570985008687907853269984665640564039457584007913129639935
cast call "$WETH" "allowance(address,address)(uint256)" "$MAKER" "$REGISTRY" --rpc-url "$BASE_RPC"
# 406168000000000
cast call "$CBBTC" "allowance(address,address)(uint256)" "$MAKER" "$REGISTRY" --rpc-url "$BASE_RPC"
# 1295
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

> **Firmware floor: the ship must fit `ETH_MAX_DATA`.** A two-leg ship is 676
> bytes of calldata; a one-leg ship is 612. The limit was 640 -- between the
> two -- so hardware refused every two-sided position with `device error
> 0x0001: calldata too large to display`, *after* the approvals had already
> landed. Raised to 768 on 2026-09-10 (`src/eth-tx.h`, mirrored in
> `mock-device.ts`). A board flashed before that cannot ship a two-sided
> position, and the failure looks like a device refusal rather than a version
> problem. A three-leg ship would exceed 768 and needs `PROTOCOL_MAX_FRAME`
> raised first.

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
# Filling with ~0.23 USDC of the deployer's own funds.
# The ROUTER, not the registry: with 0x0040 the router does the transferFrom.
cast send --rpc-url "$BASE_RPC" --account monad-deployer \
  "$USDC" "approve(address,uint256)" "$ROUTER" 250000
```

> **VERIFIED ON CHAIN 2026-09-10.** The signature and encoding below were read
> from the router's Sourcify-verified source and exercised in a real fill
> (`0x8478c356…`). Three things this runbook previously got wrong, each of
> which cost a failed attempt:
>
> 1. **`quote`/`swap` take `tokenIn` and `tokenOut` as explicit parameters.**
>    The old 3-argument signature does not exist on the router: calling it
>    reverts with no data, which looks like a program failure and is not.
> 2. **The taker-traits header is `bytes22`, not 23.** `TakerTraits.parse`
>    reads `bytes22(data)` and treats the rest as taker data, and the flags are
>    the LAST TWO bytes of that header (`abi.encodePacked(uint160 slicesIndexes,
>    uint16 flags, ...)`). A 23-byte value shifts every flag out of the header,
>    so the router reads `0x0000` and every flag you set is silently ignored.
> 3. **`USE_TRANSFER_FROM_AND_AQUA_PUSH = 0x0040` must be set.** Without it the
>    router takes the branch that assumes the taker has ALREADY pushed into
>    Aqua, and reverts `AquaBalanceInsufficientAfterTakerPush(bal, preBal,
>    amount, 0)` — that trailing `0` is `amountNetPulled`, i.e. "nothing
>    arrived". With `0x0040` the router does `transferFrom(taker -> router)`
>    then `AQUA.push`, **so the taker's approval goes to the ROUTER, not the
>    registry.**
>
> **`amount` is `amountOut`** unless `IS_EXACT_IN (0x0001)` is set. Setting
> `0x0041` makes the router read your WETH figure as a USDC input and panic on
> overflow.
>
> **`quote` does NOT prove a swap will succeed.** It is a staticcall over the
> *program* — gate, band, deadline, arithmetic — and knows nothing about
> allowances or the taker's ability to pay. It returned a clean, plausible
> price through every one of the failures above. Gas estimation is what
> actually caught them, which is why `cast send` is safe to attempt: a revert
> at estimation costs nothing.

```bash
# 22 bytes = 44 hex chars. Flags in the last two: 0x0040 = useTransferFromAndAquaPush.
export TT=0x00000000000000000000000000000000000000000040

# amount is the WETH you want OUT. --from matters: the gate (opcode 14) checks
# the CALLER's balance, and address zero holds no gate token.
cast call --from "$DEPLOYER" --rpc-url "$BASE_RPC" "$ROUTER" \
  "quote((address,uint256,bytes),address,address,uint256,bytes)(uint256,uint256,bytes32)" \
  "$ORDER" "$USDC" "$WETH" 90000000000000 "$TT"
```

`<traits>` and `<data>` are the second and third fields of the `Order`. Do not
count words by hand — `script/order-fields.mjs` does it and refuses if its
parse does not re-encode to the input it was given:

```bash
node script/order-fields.mjs "$STRATEGY"
# prints maker / traits / data, and the (maker,traits,data) tuple to paste
```

(Spec §4 gives the offsets it uses: word 2 is `traits`, `data` begins at word 5.)

- **`quote` returns two non-zero amounts** → the program ran, the gate passed,
  the band contains the price. Send it:

  ```bash
  cast send --rpc-url "$BASE_RPC" --account monad-deployer "$ROUTER" \
    "swap((address,uint256,bytes),address,address,uint256,bytes)" \
    "$ORDER" "$USDC" "$WETH" 90000000000000 "$TT"
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


---

## Base RPC: pick one that answers historical state

`cast send` makes one archive-style lookup (`eth_getBalance` at a specific
block). Several public Base endpoints serve `latest` happily and refuse that
one, which surfaces as an HTTP 403 mid-send:

```
Error: HTTP error 403 ... {"message":"Archive requests require a personal token"}
```

Measured 2026-09-10 against the seven methods a send needs — `eth_chainId`,
`eth_getTransactionCount`, `eth_gasPrice`, `eth_feeHistory`,
`eth_getBlockByNumber`, `eth_estimateGas`, and `eth_getBalance` **at an old
block**:

| Endpoint | Result |
|---|---|
| `https://mainnet.base.org` | **all seven OK** — use this |
| `https://developer-access-mainnet.base.org` | all seven OK — fallback |
| `https://base-rpc.publicnode.com` | fails `eth_getBalance` at a block only |
| `https://base.meowrpc.com` | fails five of seven |
| `https://base.llamarpc.com` | returns HTML, not JSON |

Latency rankings on public RPC lists are not a guide here: the fastest endpoint
measured was also one that cannot answer a send. publicnode remains fine for
reads, and every `eth_call` in this project has used it without trouble.
