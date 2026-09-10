# Aqua strategies on Base mainnet — what we author, and why

Status: **plan, written before anything was deployed.** The user has budgeted
**one round of deployments**, so every number, every opcode and every refusal
below is decided here first and the code is written to match this file rather
than the other way round.

Binding inputs: `docs/AQUA-B3-SPEC.md` §3 (the settled opcode table),
`docs/SDK-POLICY.md`, `app/packages/apps/README.md` (contracts live under the
app), and the two ethskills checklists (security, audit) applied in §5 and in
`../contracts/AUDIT-REPORT.md`.

Chain: **Base mainnet, 8453.** Registry
`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`, SwapVM router
`0x111111338c5091e8440b67b168bae16a668ac0de` (v1.0.2).
Maker/device `0xbDEB381a7c77040bf2a99E2990C116774CCb339f`, deployer
`0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45`.

---

## 0. The budget, first, because it decides the rest

The maker holds **~2 USDC and ~0.0002 WETH on Base.** Nothing below is sized
above that, and no plan here assumes a token the maker does not hold. That is
also why there is no cbBTC leg in the *funded* half of the USDC/cbBTC position:
the maker holds no cbBTC, so that position is shipped one-sided in USDC.

| Position | Legs shipped | Approval |
|---|---|---|
| P1 USDC/WETH | 1.00 USDC + 0.00020 WETH | exactly those two amounts |
| P2 USDC/cbBTC | 1.00 USDC, cbBTC leg zero | exactly 1.00 USDC |

Total USDC approved to the registry: **2.00 USDC.** Total WETH: **0.0002.**
No unlimited approval, ever — `deploy.ts` refuses to encode one and that
refusal is not relaxed here. Note the arithmetic `portfolio.ts` states:
exposure is `allowance × shipped strategies`, so the 2.00 USDC allowance is
reachable by *either* position. It is capped at the total on purpose, and both
positions are docked immediately after the demo (§5).

---

## 1. The pairs

**USDT is dropped entirely, and so is the pegged pair.** Two reasons, either of
which is sufficient:

1. **The market.** Base USDC supply is 4.27B; Base USDT is 25.7M — about 170×
   thinner. A pegged pool is an unconditional promise to swap near 1:1 across a
   band, with no oracle and no awareness of where the pair is actually trading.
   On a thin local market the local price can diverge from the global one, and
   the only party who notices is the taker arbitraging the maker. A pegged
   USDC/USDT position on Base is a standing offer to be picked off. Do not ship
   it.
2. **The layout.** `peggedSwapGrowPriceRange2D` (opcode 31) takes 160 bytes as
   five `uint256`s that our decoder renders as `x0, y0, linearWidth, rateA,
   rateB`. Those *names* are all we have; no observed live program on Base
   exercises the opcode, so choosing five real values would be authoring
   against an inferred meaning. That is the exact thing commit `c5f3dc3`
   ("Do not decode a threshold whose layout is inferred") settled for opcodes
   15/16, and the rule cuts the same way when we are the author rather than the
   reader. **We do not author an opcode whose argument semantics we have only
   read about.**

So the set is exactly two pairs:

| Pair | tokenLt (lower address) | tokenGt (higher address) |
|---|---|---|
| **P1** | WETH `0x4200000000000000000000000000000000000006` (18 dp) | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 dp) |
| **P2** | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 dp) | cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8 dp) |

`tokenA < tokenB` is enforced by the VM (spec §4), so the ordering is a
property of the addresses and **not** of the order the user typed them in. The
builder derives it from the addresses and ignores caller order — see §3.2's
direction trap.

cbBTC is the wrapped BTC on Base by a wide margin: 45,692 BTC of supply against
WBTC's 65 and tBTC's 46. It is the only sensible BTC leg here.

---

## 2. The programs

Both positions, in all three tiers, are the same six instructions in this
order. Every opcode is already in `program.ts`'s closed allowlist and already
in the firmware walker's — **nothing here needs a new opcode, a decoder change,
or a firmware change.** That is deliberate: authoring inside the existing
accepted set keeps the host's set a subset of the device's for free.

```
0d 05 <deadline: uint40>                      expire the position
0e 14 <gate token: address>                   only takers holding the gate token
12 40 <sqrtPriceMin: uint256><sqrtPriceMax>   the band  (tier-dependent)
15 04 <fee: uint32, base 1e9>                 0.30% = 3_000_000
11 00                                         xycSwap, x*y=k
14 08 <salt: 8 bytes>                         uniqueness only
```

Total: 7 + 22 + 66 + 6 + 2 + 10 = **113 bytes.** Six instructions, well under
`AQUA_MAX_INSTRUCTIONS` (16) and under `ETH_AQUA_MAX_INSTRUCTIONS`. The order
matches the fixed order spec §5 records for `AquaXYCAmmStrategy`: guards, then
the pricing modifiers, then the swap, then the salt. Instruction order is
security-critical (spec §6.7) and is never rearranged for readability.

`decayXD` (19) is **not** included. It is in our allowlist and it would decode,
but a decaying price on a 1-USDC position with a 2-hour deadline changes
nothing a user could observe, and every instruction on the screen is one more
sentence the user has to be right about. Left out on purpose, not by oversight.

The strategy blob is `abi.encode(ISwapVM.Order{maker, traits, data})` with

```
data   = tokenLt(20) || tokenGt(20) || program        (no hook slices)
traits = (1 << 254)            USE_AQUA_INSTEAD_OF_SIGNATURE
       | (40 << 208)           programStart = 40, past the two token addresses
       | uint160(receiver)     receiver = the maker
```

which is exactly the shape `readStrategyData()` requires and
`readOrderProgram()` walks. Builder and decoder are tested against each other
in both directions: **everything we author must decode, or we do not author
it.**

### 2.1 Worked bytes — P1, MEDIUM tier

Illustrative only; the real bounds are computed from the mid price read at ship
time (§3.4). With gate token `G` and salt `S`:

```
0d05 <ship_ts + 7200>
0e14 GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG
1240 <sqrtPriceMin 32B> <sqrtPriceMax 32B>
1504 002dc6c0
1100
1408 SSSSSSSSSSSSSSSS
```

`002dc6c0` is 3_000_000 against a denominator of **1e9**, i.e. 0.30%. It is
never called "bps": at base 1e9 a number labelled bps is wrong by five orders
of magnitude, which is exactly the plausible-and-wrong render `program.ts`
exists to refuse.

---

## 3. The three risk tiers

The user's framing — "according to the gaps of the orders" — is the width of
the price band, and it maps onto `xycConcentrateGrowLiquidity2D` (opcode 18)
directly. Three **named** tiers, chosen from a list. No free-form number entry:
a text box here is a text box in which a user types a raw uint256 nobody can
sanity-check, and a mistyped sqrt price does not fail loudly — it silently
prices a different range.

| Tier | Band (multiples of mid) | What it actually means |
|---|---|---|
| `low` | **x0.50 … x2.00** | Rarely out of range. Fees spread thin over a wide band. Least impermanent loss. |
| `medium` | **x0.70 … x1.4286** | Moderate on both counts. |
| `high` | **x0.90 … x1.1111** | Densest fee capture *while in range*. Leaves the range soonest. Most impermanent loss. |

Each band is geometrically symmetric about the mid (`hi = 1/lo`), so the two
sqrt bounds sit the same distance either side of `sqrt(mid)`.

### 3.1 What the UI must say, and must not

The tier copy is honest or it is not shipped:

- A tighter band is **not "more yield."** It is more fee density **and** more
  impermanent loss, and it earns **nothing** once the price leaves the band.
- The word "yield" does not appear, and no number is projected. Per spec §12 we
  describe what a program *is* and never predict what it will *pay*.
- Out of range is the normal state of a tight band, not a fault.

### 3.2 The encoding, and the trap in it

Opcode 18's two arguments are **square roots of a price, in 1e18 fixed point**,
where

```
P = amount of tokenGt per amount of tokenLt, in RAW units
```

Two independent ways to get this wrong, and both are silent:

1. **Raw price where a sqrt price belongs.** Passing `P` instead of `sqrt(P)`
   prices a range that is the square of the intended one. Nothing reverts.
2. **Human units where raw units belong.** `P_raw = P_human × 10^decGt /
   10^decLt`. For WETH→USDC that factor is `1e6/1e18 = 1e-12`; getting it wrong
   is a **1e12** price error. Same class as the ATS report's weibar trap.

So the builder never takes a sqrt price from a caller. It takes a **human mid
price** plus the two tokens, derives direction from the addresses, and does all
of it in exact integer arithmetic:

```
mid = m / 10^e                     (a decimal string, parsed exactly)
P_raw * 1e36 = N / D               N = m * lo_num * 10^(decGt + 36)
                                   D = 10^(e + decLt) * lo_den
S = isqrt(N * D) / D               floor, bigint throughout
```

No floating point anywhere — "no floating point" is a rule about the number the
contract will act on, and it binds the host that computes it just as much as
the Solidity. The band factor is applied to the **price**, before the square
root, as an exact rational.

### 3.3 Order-of-magnitude sanity, so a wrong answer is visible

| Pair | mid (human) | P_raw | sqrtP x 1e18 |
|---|---|---|---|
| P1 WETH→USDC | 4,000 USDC/WETH | 4e-9 | ~6.3e13 |
| P2 USDC→cbBTC | 110,000 USDC/BTC | 9.1e-4 | ~3.0e16 |

The builder asserts both bounds are non-zero and strictly ordered, and refuses
a bound outside `[1, 2^160)`.

**Be precise about how little that bound catches.** It catches a `0` — the
classic all-decimals-lost outcome — and it catches gross nonsense. It does
**not** catch either trap above: for WETH/USDC the raw-for-sqrt confusion moves
the number by about 1e4 and the human-for-raw confusion by about 1e6, and both
land comfortably inside 2^160. That is asserted as a test, not left as a hope,
so nobody later mistakes the bound for the check.

The check that actually catches §3.2 is a person reading the band back in units
they know — §3.4 — which is why `bandFor` returns `loHuman`/`hiHuman` and the
RUNBOOK prints them before anything is signed.

### 3.4 Where the mid price comes from

**Not from the chain, and never from a DEX spot price.** A spot price is not an
oracle, and a maker who centres a band on a manipulable number has handed the
manipulator the band. The mid is entered by the operator in the RUNBOOK from an
off-chain reference, and the RUNBOOK prints the resulting bounds back **in
human terms** for the operator to eyeball before anything is signed. A human
reading "band: 2,800 – 5,714 USDC per WETH" catches a 1e12 error instantly;
nobody catches it reading `0x0000…3f2a`.

---

## 4. DCA — the honest answer

**DCA is not on the Aqua router.** `_twap` belongs to the limit-order router;
the deployed Aqua set is Controls, XYCSwap, XYCConcentrate, Decay, Fee,
PeggedSwap, Extruction. Nothing in it schedules anything.

### (a) A modified SwapVM router — **rejected, and the reason is not size**

The hackathon rules permit "redeployments of a modified SwapVM contract" and
score SwapVM use higher, so this is the option that scores best. Two things
were measured before rejecting it, because both were being asserted without
evidence.

#### Measurement 1: there is no `_twap` to port

The strongest form of this option is not "write a new opcode" but "register an
instruction 1inch already wrote and audited". That was the plan, and it does
not survive contact with the repository.

```
$ git -C swap-vm log --oneline -1
afd99c4 Merge pull request #186 ...
$ grep -rni "twap" swap-vm/ --exclude-dir=node_modules --exclude-dir=.git | wc -l
0
```

**`1inch/swap-vm` at HEAD contains no `TWAPSwap.sol` and no occurrence of the
string "twap" anywhere.** `contracts/instructions/` holds Balances,
BaseFeeAdjuster, Controls, Debug, Decay, DutchAuction, Extruction, FeeFlat,
FeeProtocol, Invalidators, Jumps, LimitSwap, MinRate, OraclePriceAdjuster,
PeggedSwap, PiecewiseLinearScale, SeriesEpochManager, TokenValidators,
Whitelist, XYCConcentrate, XYCSwap — and neither `Opcodes.sol` nor
`LimitOpcodes.sol` dispatches anything TWAP-shaped.

So the premise "port audited 1inch code rather than author novel swap math"
is **false as stated**. `LimitSwap` exists; the scheduling instruction that
would sit on top of it does not. Choosing this option means authoring the swap
math ourselves after all, which was the thing it was supposed to avoid.

#### Measurement 2: EIP-170 is *not* the blocker

Worth measuring anyway, since it was the number said to decide everything, and
because a negative result here would have ended the discussion. Built from the
same checkout with the project's own profile (`solc 0.8.30`, `via_ir`,
`optimizer_runs = 700`), runtime bytecode against the 24,576-byte limit:

| Contract | Runtime size | Margin |
|---|---|---|
| `AquaSwapVMRouter` (as deployed) | **21,037** | 3,539 |
| `SwapVMRouter` (the full opcode set) | **28,021** | **−3,445 — does not fit** |
| `LimitSwapVMRouter` | 21,338 | 3,238 |
| probe: Aqua + `LimitSwap` + `LimitSwapFullAmount` | **21,463** | 3,113 |
| probe: the above + `InvalidateBit`/`InvalidateTokenIn`/`InvalidateTokenOut` + `ValidateSeriesEpoch` | **22,715** | **1,861** |

Two things follow. The full `Opcodes` set genuinely does not fit — which
confirms 1inch's stated reason for `AquaOpcodes` being a curated subset. And
the scheduled-order stack costs about **1.7 KB**, leaving **1,861 bytes** of
headroom. **It fits.** Size is not what stops this.

#### What does stop it, in increasing order of seriousness

1. **The work is authoring, not porting** (measurement 1). Write the
   instruction, deploy a router to Base mainnet, and extend *three* decoders —
   `program.ts`, `eth-decode.ts` and `src/eth-decode.c` — plus the shared
   calldata vectors and a UI page. The firmware half is not optional: an opcode
   the device cannot walk is a strategy the device refuses, so a custom opcode
   with no firmware support produces a position this wallet will not sign.
2. **The argument encoding breaks an assumption every other opcode holds.** A
   `_twap`-shaped instruction takes `abi.encode(TwapArgs)` — 192 bytes, six
   ABI-encoded words. Every opcode our decoders read is **packed**,
   positional, variable-width (spec §2). The fixed-length rule still works
   (192 exactly), but none of the packed-args helpers do, on the host or in the
   firmware. That is a second, separate parser in C, in the file whose whole
   discipline is that it never guesses a layout.
3. **Audit surface.** The auditable unit is not our instruction, it is the
   router that holds pull rights against the maker's ERC-20 allowance. That is
   a review of ~21 KB of someone else's bytecode plus our diff, for a 2 USDC
   demo.
4. **It breaks a security property we hold deliberately.** Spec §11.2: *"the
   router address is part of the version. Our table is valid for one
   deployment."* `AQUA_SWAPVM_ROUTER` is pinned so a change is a diff. A custom
   router means pinning a second address — doubling the surface the opcode
   table is claimed valid for — or loosening the pin. Weakening the check that
   makes the decoder trustworthy, in order to demo a feature.
5. **It is not real.** A strategy shipped to our own router is not an Aqua
   position; it is a position in a contract we deployed that nobody else takes.
   "Real strategies on Base mainnet" is the goal, and this option quietly stops
   meeting it.

The obvious escape — use `extruction` (opcode 32) to point at our own pricing
contract, no router fork needed — is **foreclosed by our own rule**, and it is
worth writing down because it is the first idea everyone has. Spec §6.3:
extruction hands the swap registers to arbitrary maker-chosen bytecode, so the
program's meaning lives somewhere the device cannot read. `program.ts` refuses
it as `has-control-flow`. We would have to delete that refusal to use it. No.

### (b) An off-chain keeper that docks and re-ships on a schedule — **recommended, and built**

1inch's own documented keeper / re-ship pattern. No new opcode, no router, no
decoder change, no firmware change, and every slice it produces is a real Aqua
position on the real router.

The caveat, stated plainly because it is the interesting part: **a keeper
cannot sign.** Every `ship` is a maker signature, and here the maker key is on
a device behind a button. So there are two shapes and only one is compatible
with this project:

- *Unattended DCA* requires a hot key with standing authority to ship — exactly
  what this wallet exists not to have. **Refused.**
- *Attended DCA* — the scheduler prepares slice `n`'s approval + ship calldata
  and waits; the user presses the button. The schedule is real, the automation
  is real, and the authority is still a physical press.

So what we would ship is **attended DCA**, and we would call it that. Calling
something that needs a press "automated DCA" is the same class of error as
calling a 1e9-base number "bps": it reads correctly and it is not true.

Cost: a scheduler module in `aqua/src` plus UI. No contracts, no firmware, no
router. It composes with the tiers rather than competing with them.

**Built, in `src/dca.ts`, and available — but not demonstrated.** The
distinction is the whole point and the module says so in three places (its own
header, `UNPROVEN_NOTICE`, and a test that fails if the notice is dropped):

- **What is true.** It is pure and unit tested; tranches sum to the total
  exactly; each tranche gets distinct strategy bytes so registry slots cannot
  collide; each tranche's `deadline` matches its own window; and every tranche's
  program decodes through `readOrderProgram()`, which is the same rule the
  device applies.
- **What is not true.** No tranche from this planner has ever been shipped on a
  live chain, filled, or docked. "Available" is not "proven", and this project
  has already had to withdraw three claims that outran their evidence.

`plan()` returns `attended: true` as a **field** rather than as a comment, so a
caller cannot render the schedule without having seen it, and `MAX_TRANCHES` is
24 because every tranche is one press on the device — a schedule longer than a
person will attend is one that stops part way with approvals still standing.

**The economics, stated rather than hidden.** 1inch's guidance puts a sensible
`minTradeAmountOut` at roughly 1000× the gas cost of the fill in output-token
terms, which on an L2 is hundreds of dollars per tranche. The maker holds ~2
USDC. Tranches from that are worth fractions of a cent — below any dust guard's
purpose and below the gas to fill them. So `planDca()` computes
`economic: false` whenever a tranche falls under `minTrancheOut` and attaches
`UNECONOMIC_NOTICE`. The mechanism is demonstrable at this size; the economics
are not, and the module is not permitted to imply otherwise. Fund more, or
lengthen the interval, if you want tranches anyone would take.

### (c) Not doing it — what this round actually does

Two positions ship, with tiers, and **no DCA claim is made anywhere in the UI**,
because there is nothing behind it yet.

One thing that must **not** be done in the meantime: `decayXD` produces an
offer that improves over time, so a decayed position does fill progressively,
and it is tempting to call that DCA. It is not. DCA is a fixed notional per
interval regardless of price; a decaying offer is a Dutch auction that fills
fastest exactly when the price is worst for the maker. Labelling one as the
other would put a plausible, wrong sentence on a screen the user relies on.

---

## 5. Risk controls for real funds

| Control | How | Why |
|---|---|---|
| **Expiry** | `deadline` (13), **ship time + 2h** | A shipped strategy authorises every swap it will ever permit. A position with no expiry is a standing offer forever. Two hours is the demo window. |
| **Not open to bots** | `onlyTakerTokenBalanceNonZero` (14) pointed at **`GateToken`**, an ERC-20 we deploy whose entire supply is minted to the maker's own taker address | Keeps the pool permissionless in the protocol sense — no KycNFT gate, no resolver, anyone *may* call — while in practice only an address holding the gate token can fill. Every other gate needs somebody else's permission; this one needs ours and nobody else's. |
| **Bounded approval** | `approve(registry, exact position size)` per token | `deploy.ts` already refuses unlimited. The cap is the amount with zero headroom, because here the wallet *is* the dapp (see its header). |
| **Docked immediately** | `dock()` right after the demo, both positions, all legs | The deadline is a backstop, not the plan. Docking is what actually ends the authority. |
| **No oracle** | mid entered by the operator, printed back in human units | A DEX spot price is not an oracle. See §3.4. |
| **Salt** | 8 random bytes per position | Two identical strategies hash identically and collide in `_balances[maker][app][hash][token]`. The salt is what makes P1-low and P1-high distinct slots. Price-neutral by construction — `salt`'s `exec()` never reads its args. |

`GateToken` is the only Solidity in this deliverable, and it is deliberately the
smallest contract that can exist: fixed supply, minted once in the constructor
to one address, no owner, no mint, no burn, no hooks, no upgrade path. Its
audit report is `../contracts/AUDIT-REPORT.md`.

---

## 6. What I think is wrong with this plan

Listed because a plan with no known weaknesses has not been read carefully
enough.

1. **Opcode 18's argument semantics are the weakest link, and they are an open
   question.** Spec §3 records that live Base strategies carry `op 18 argslen
   64`, which settles the *width*. It does not settle that the two words are
   `sqrt(P) x 1e18` with `P = tokenGt/tokenLt` in raw units — that comes from
   documentation, and §1's own rule says we do not author against an inferred
   layout. **So the RUNBOOK's first step reads the args of a real live opcode-18
   program off Base and checks our computed bounds land in the same order of
   magnitude.** If they do not, P1 and P2 fall back to plain `xycSwap` (17, zero
   args, nothing to get wrong) and the tiers are shelved. This is the one open
   question that can stop the deployment, and it is checked before it, not
   after.
2. **Two hours may be too short, or too long.** Nobody may fill a gated 1 USDC
   position at all, in which case the demo shows a correct position that never
   traded. That is an honest outcome and better than widening the gate.
3. **A one-sided cbBTC position is a strange AMM.** With zero cbBTC, P2 offers
   USDC for cbBTC in one direction only. It is a valid Aqua position and it
   decodes and renders correctly, which is what this milestone is about, but it
   is not a market.
4. **The gate token is a centralisation the pool does not advertise.** Anyone
   reading the program sees opcode 14 and a token address; nobody can tell from
   that whether the token is widely held. It is not — the supply is ours. That
   is the intent, and it is written down here so the pool is never later
   described as "permissionless" without the qualifier.
5. **`AQUA_MAX_LEGS` is 4 and we use 2.** Fine today. A tier set that later
   wants a third token hits a device limit, not a host one.
6. **Micro amounts make some failures invisible.** At 1 USDC, a 1e12 pricing
   error costs almost nothing and would therefore not be noticed by the loss.
   The order-of-magnitude assertions in §3.3 exist precisely because the money
   is too small to be the alarm.
