# B3 — SwapVM program decoding

Milestone B3 of `docs/HACKATHON-MILESTONES.md`. The point of this milestone is
**refusal**, not display: "an unknown opcode starts refusing to render." A
program this wallet does not fully understand must be refused, never summarised.

Everything below is checked against source. Claims that are *not* checked are
marked **UNCONFIRMED** and collected in §10, which is a list of things to
establish before writing code, not a list of things to guess.

## 1. What SwapVM is, in the two sentences that matter here

A SwapVM *program* is bytecode. A maker composes instructions; a router contract
(`AquaSwapVMRouter`) implements the opcodes and runs the program when a taker
swaps. The maker signs the program once — via Aqua, by shipping it — and every
future swap against that liquidity executes it.

That is why it belongs on the device screen. A `ship` today authorises every
swap the program will ever permit. The maker's exposure is *approval ×
strategy*; B3 is the "× strategy" half.

## 2. The bytecode format — CONFIRMED

Source: `ContextLib.runLoop`, `src/libs/VM.sol`, `github.com/1inch/swap-vm`
(commit `4918338`).

```solidity
while (pcs < length) {
    let word := calldataload(add(programBytes.offset, pcs))
    opcode := shr(248, word)                      // byte 0
    let argsLength := and(shr(240, word), 0xff)   // byte 1
    pcs := add(pcs, 2)
    args.offset := add(programBytes.offset, pcs)
    args.length := argsLength
    pcs := add(pcs, argsLength)
    if (pcs > length) revert RunLoopExceedProgramLength(pcs, length);
}
```

| Field | Width | Notes |
|---|---|---|
| opcode | **1 byte** | |
| args_len | **1 byte** | Not 2, not 4. Max 255. |
| args | `args_len` bytes | Opaque to the loop; each opcode parses its own. |

- **Framing:** none. No magic, no header, no version byte. The program is a bare
  instruction stream; its outer length comes from the ABI `bytes` carrying it.
- **Termination:** the loop ends when `pc == length`. `Stop` exists
  (`src/instructions/Controls.sol`) but is **not** in the Aqua dispatcher (§5),
  so on the Aqua router `Stop` reverts as an unknown opcode.
- **Truncation:** the VM reverts `RunLoopExceedProgramLength`. Our decoder
  mirrors this: truncated is refused, never zero-padded.
- **Args encoding:** packed big-endian, positional, variable-width. No ABI
  padding. `src/libs/InstructionArgs.sol` reads `asU16`, `asU40`, `asAddress`
  at fixed byte offsets. A `bool` is a *bit*, MSB-first within a byte.
- `InstructionBuilder.patchLength` enforces `args_len < 256`.

The repo's working note is **correct on framing** and must be kept. It is
**wrong on opcode numbers** (§3).

## 3. The opcode table — SETTLED ON-CHAIN (2026-09-10)

**Two earlier answers in this file were wrong. This one is measured.**

The deployed `AquaSwapVMRouter` v1.0.2 uses the **dense-index** scheme, not the
`Opcode` enum. Confirmed by decoding real `Shipped` events from the Aqua
registry on **Base mainnet (8453)** — live maker strategies, not source and not
documentation:

```
op 18 (0x12) argslen 64   XYCConcentrateGrowLiquidity2D
op 21 (0x15) argslen  4   flatFeeAmountInXD
op 17 (0x11) argslen  0   xycSwapXD
op 20 (0x14) argslen  8   salt
```

1inch's own docs give the same table and document a real dApp program as
`0x21 0x14 <20-byte KycNFT> 0x11 0x00`.

| Byte | Dec | Name | args | Supported? |
|---|---|---|---|---|
| `0x0a` | 10 | jump | 2 | **no — control flow** |
| `0x0b` | 11 | jumpIfTokenIn | 22 | **no — control flow** |
| `0x0c` | 12 | jumpIfTokenOut | 22 | **no — control flow** |
| `0x0d` | 13 | deadline | 5 | yes |
| `0x0e` | 14 | onlyTakerTokenBalanceNonZero | 20 | yes |
| `0x0f` | 15 | onlyTakerTokenBalanceGte | 52 | yes |
| `0x10` | 16 | onlyTakerTokenSupplyShareGte | 28 | yes |
| `0x11` | 17 | xycSwapXD | 0 | yes |
| `0x12` | 18 | xycConcentrateGrowLiquidity2D | 64 | yes |
| `0x13` | 19 | decayXD | 2 | yes |
| `0x14` | 20 | salt | 8 (or any) | yes |
| `0x15` | 21 | flatFeeAmountInXD | **4** | yes |
| `0x1b` | 27 | protocolFeeAmountInXD | 24 | no — v1 sets it 0 |
| `0x1c` | 28 | aquaProtocolFeeAmountInXD | 24 | no |
| `0x1d` | 29 | dynamicProtocolFeeAmountInXD | 20 | no |
| `0x1e` | 30 | aquaDynamicProtocolFeeAmountInXD | 20 | no |
| `0x1f` | 31 | peggedSwapGrowPriceRange2D | 160 | yes |
| `0x20` | 32 | extruction | 20+N | **no — external pricing** |
| `0x21` | 33 | onlyTxOriginTokenBalanceNonZero | 20 | yes |

Indices 0–9 and 22–26 are reserved and map to a no-op `_notInstruction`.
An index past the table reverts with `Panic(0x32)`, **not** a named error.

### 3a. Why the earlier answers were wrong

The `Opcode` enum in `OpcodeList.sol` (`XYCSwap = 0x50`, `Decay = 0x9c`) is a
*different version's* numbering. `AquaOpcodes.sol` at that commit dispatches on
enum values; the deployed v1.0.2 dispatches on dense indices. Reading source at
an arbitrary commit cannot settle what a deployed contract does — only the
deployed contract, or bytes it has accepted, can.

Bytecode disassembly does not settle it either: the router is 20,541 bytes with
11 delegatecalls and no dispatch constants at that address (§10.10).

**The method that works: decode a real `Shipped` event on a live Aqua chain.**

### 3b. Do not trust 1inch's TypeScript enum

Their docs warn that `test/utils/SwapVMHelpers.ts` lists two concentrate
entries where the router registers one, shifting everything after it by one.
Derive opcodes from the deployed set or from observed programs.

## 4. Where the program lives — CONFIRMED

For a position shipped to the SwapVM router, the Aqua `strategy` bytes are
`abi.encode(ISwapVM.Order)`:

```solidity
struct Order { address maker; MakerTraits traits; bytes data; }
```

Verified by `swap-vm/test/OrderRegistrator.t.sol:163`:

```solidity
assertEq(aqua.ship(address(swapVM), abi.encode(order), tokens, amounts), swapVM.hash(order));
```

**So the Aqua strategy hash the device already draws IS the SwapVM `orderHash`.**
One identifier, not two.

| Offset | Bytes | Meaning |
|---|---|---|
| `0x00` | 32 | `0x20` — head of the dynamic tuple |
| `0x20` | 32 | `maker`, left-padded |
| `0x40` | 32 | `traits`, packed `uint256` |
| `0x60` | 32 | `0x60` — in-struct offset of `data` |
| `0x80` | 32 | `data.length` |
| `0xa0` | … | `data`, right-padded |

This is exactly the shape `readStrategy()` and `aqua_strategy_maker()` already
require. B3 does not change that rule; it continues past it.

Inside `data` (`MakerTraitsLib.build`):

```
data = tokenA(20) || tokenB(20) || [4 hook slices] || program
```

- `programStart = (traits >> 208) & 0xffff`
- `program = data[programStart .. data.length]`
- `tokenA = data[0..20]`, `tokenB = data[20..40]`, `tokenA < tokenB` enforced.

Relevant `traits` bits: 255 `SHOULD_UNWRAP`, **254 `USE_AQUA_INSTEAD_OF_SIGNATURE`**,
253 `ALLOW_ZERO_AMOUNT_IN`, 252–249 hook presence, 248–245 hook target,
224–160 the four 16-bit slice indexes, 159–0 `receiver`.

## 5. The Aqua instruction set is small — CONFIRMED

`src/opcodes/AquaOpcodes.sol` dispatches **16** opcodes and reverts
`UnknownOpcode(opcode)` otherwise:

`Jump, JumpIfTokenIn, JumpIfTokenOut, Deadline, OnlyTakerTokenBalanceNonZero,
OnlyTakerTokenBalanceGte, OnlyTakerTokenSupplyShareGte, XYCSwap,
XYCConcentrateSwap, Decay, Salt, FeeFlatIn, FeeProtocol, PeggedSwap, Extruction,
OnlyTxOriginTokenBalanceNonZero`.

Refused *on chain*: `Stop`, `Revert`, `StaticBalances`, `DynamicBalances`,
`LimitSwap`, all invalidators, all debug opcodes, `JumpIfDirection`, the
whitelists, min-rate and Dutch-auction families.

**Version drift:** the SDK's `instructions/index.d.ts` claims "29 opcodes" and
exposes builders the contract source does not dispatch. Contract and SDK are at
different versions — another reason §10.1 is decided by **deployed bytecode**.

Real strategies are narrower still. `AquaXYCAmmStrategy` and
`AquaPeggedAmmStrategy` build at most six instructions in a fixed order:

```
[onlyTxOriginTokenBalanceNonZero?] [aquaProtocolFeeAmountIn?]
[concentrateGrowLiquidity2D? | -] [decayXD?] [flatFeeAmountIn?]
xycSwap | peggedSwap  [salt?]
```

## 6. What we build

### 6.1 Shape

One new module, `app/packages/apps/aqua/src/program.ts` — pure, no new runtime
dependency, no I/O:

```ts
export type ProgramReading =
  | { ok: true; instructions: readonly Instruction[] }
  | { ok: false; refusal: ProgramRefusal };

export function readProgram(program: Uint8Array): ProgramReading;
```

plus an extension of `readStrategy()` to walk the `Order` struct to `traits` and
the program slice. `readStrategy`'s existing contract is **not weakened**. B3
adds fields; it removes no check.

### 6.2 The rule for "understood"

An instruction is **understood** only when all of:

1. Its opcode byte is in our table — a **closed literal list in our source**,
   a subset of the deployed router's dispatch set.
2. The opcode's argument layout is a **fixed byte length** we know, and
   `args_len` equals it **exactly** — not "at least". A `Deadline` with
   `args_len = 6` is refused; `Deadline` is `uint40`, five bytes.
3. Every rendered field is derived by our own arithmetic — no default, no
   fallback, no "unknown" placeholder.

A **program** is understood only when every instruction is understood, the
stream consumes the program's bytes exactly, and there is no control flow (§6.3).
Anything else is a refusal. There is no third state.

### 6.3 Control flow is refused, deliberately

`Jump`, `JumpIfTokenIn`, `JumpIfTokenOut` and `Extruction` are in the Aqua
dispatch set and **will not be in our understood set**.

- A jump means the linear list on the screen is not the list that executes. A
  screen showing a sequence the VM will not follow is precisely the
  "authoritative and wrong" screen the audit gate names.
- `Extruction` delegates the swap registers to an arbitrary maker-chosen
  contract; the program's meaning then lives in someone else's bytecode. It is
  unrenderable by construction. SwapVM's own `docs/PROGRAMS.md` warns such
  programs "can contain hidden logical flaws and unsafe edge paths".

A documented exclusion, not an oversight.

### 6.4 The initial supported set

Pending §10.1 for the numbers, the **names**: `XYCSwap`, `XYCConcentrateSwap`,
`PeggedSwap`, `Decay`, `FeeFlatIn`, `Salt`, `Deadline`,
`OnlyTakerTokenBalanceNonZero`, `OnlyTxOriginTokenBalanceNonZero`.

`FeeProtocol` is **excluded from the first pass**: variable-length args
conditional on per-receiver flag bits — exactly the layout that reads plausibly
while being wrong. If a real strategy needs it, add it with its own fixtures,
never by relaxing rule 6.2.2.

### 6.5 Refusal kinds

| Kind | Cause |
|---|---|
| `unknown-opcode` | Opcode byte not in our table. Carries the byte. |
| `bad-args-length` | `args_len` ≠ the opcode's fixed length. |
| `truncated` | Last instruction's args run past the program end. |
| `has-control-flow` | A jump or `Extruction` is present. |
| `empty` | Zero-length program. |
| `too-long` | More than `AQUA_MAX_INSTRUCTIONS`. |
| `not-swapvm` | The `app` in the `ship` call is not the SwapVM router. |

### 6.6 The refusal boundary

- **A strategy that is not a SwapVM Order is not a B3 refusal.** Aqua strategies
  are app-defined. Program decoding is attempted **only** when the `app`
  argument of `ship` equals the known `AquaSwapVMRouter` for that chain. For any
  other app, B2's behaviour is unchanged. Refusing every non-SwapVM app would
  break a working flow for no safety gain.
- **When the app IS the SwapVM router, a program we cannot fully read refuses
  the whole signature** — not the instruction, not the page: the transaction.
- **There is no partial render.** No "3 of 5 instructions", no "… and 2 more",
  no "unknown opcode 0x??" row. If any instruction fails, the list is never
  constructed.

### 6.7 What the user sees

On refusal, one screen, no approve button:

> **This strategy's program contains an instruction this wallet does not
> understand.** A shipped strategy authorises every future swap its program
> permits, so a program that cannot be read in full cannot be described
> honestly — and a partial description of bytecode is worse than none, because
> it looks like a complete one. The device applies the same rule and would
> refuse it too. Nothing is signed.

Plus the refusal kind in plain words ("instruction `0xNN` at byte 12 is not one
of the nine this wallet reads") and the program's hex, so it can be inspected
elsewhere.

On success, one row per instruction, **in program order**. The SwapVM
whitepaper (§5.5, *Canonical instruction ordering*) is explicit about why that
is not a presentation choice:

> Instruction order within a program is security-critical. The same
> instructions in a different order can change pricing, settlement amounts,
> and economic outcomes.

So the list is never sorted, grouped, or deduplicated for readability. It is
the program's own order or it is wrong. The same section notes the instruction
set "is designed to grow continuously, with new instructions being added",
which is the whitepaper confirming §11: an outdated decoder must refuse an
unfamiliar opcode, because new ones will keep arriving.

On success, one row per instruction:

```
  XYCSwap            constant product, x·y=k
  Decay      300     virtual balances decay over 5 min
  FeeFlatIn  50      taker pays 0.50% of input
  Salt       0x…01   uniqueness only, no effect on price
```

Token symbols are **not** in the program (`tokenA`/`tokenB` are raw addresses).
Per `docs/UI-L3-SPEC.md` §4, a symbol is not a fact: render the address, or a
symbol drawn from `chains.ts` only.

## 7. Device agreement

`DEVICE_DRAWN_KINDS` already contains `AquaShip`, which means a bespoke decoder
in `src/eth-decode.c`, a mirror in `eth-decode.ts`, and a page in `src/ui.c`.
B3 extends all three or it extends none:

1. `src/eth-decode.c` — a program walker beside `aqua_strategy_maker()`, same
   table, same refusals. **No allocation**: record per-instruction offsets into
   the existing calldata buffer as `aqua_token_off[]` already does, and add
   `ETH_AQUA_MAX_INSTRUCTIONS` beside `ETH_AQUA_MAX_LEGS`. A program with more
   instructions is refused, not truncated.
2. `app/packages/core/src/eth-decode.ts` — the line-for-line mirror.
3. `src/ui.c` — one page per instruction, in program order.

The host module may be richer in wording, **never in acceptance**: the set of
programs it renders must be a subset of what the firmware renders. **Nothing
currently proves that** — `make -C sim conformance` emits protocol frames, not
calldata vectors, and the two decoders are never compared on the same input.
See `docs/MIRROR-GAP.md`. Building the shared calldata-vector file is part of
finishing B3, not a separate nicety.

## 8. The SDK stays out of `dist/`

Binding: `docs/SDK-POLICY.md`.

`@1inch/aqua-sdk@0.3.1` has **no SwapVM support at all**, so no decoder can be
had from the package we already have. `@1inch/swap-vm-sdk` (0.4.1) does have
one, under `LicenseRef-Degensoft-SwapVM-1.1` — the same family as the Aqua
licence whose §1.7 puts linking inside "Modification". §10.4: read it clause by
clause before adoption. The default, and the presumption:

- **devDependency of `@leekwallet/app-aqua` only**, used only in
  `test/sdk-parity.test.ts`.
- The existing assertion *"the SDK stays out of everything that ships"* greps
  for `/["']@1inch\//`, which already matches the new package. Verify it still
  fires; do not narrow it.
- Two independent decoders compared byte for byte is a stronger claim than one.

Even if §10.4 finds bundling permitted, we still do not bundle — rule 2 of
`SDK-POLICY.md`: what the device shows is decoded by us.

## 9. Testing without a mainnet fork

The repo's notes suspect SwapVM needs a mainnet fork. **It does not have to.**

The deployed router is mainnet-only (`AQUA_SWAP_VM_CONTRACT_ADDRESSES` lists 16
mainnets, no Sepolia). But `swap-vm/DEPLOY.md` has a first-class Sepolia path
(Hardhat Ignition, `ignition/parameters/chain-11155111.json`, constructor
`(aqua, weth, owner, name, version)`).

**Plan: deploy our own `AquaSwapVMRouter` on Sepolia against a Sepolia Aqua
registry and ship real strategies to it.** This keeps the testnet-only rule
intact and is *better* evidence than a fork, because the transactions are public.

1. **Unit** — `program.test.ts`, fixtures hand-built from §2 and §4. Every
   refusal kind has a case. No network.
2. **Parity** — `sdk-parity.test.ts` gains a section: programs built by
   `AquaProgramBuilder`, decoded by it and by `readProgram`, compared field by
   field; plus an SDK-built `Order` fed through `decodeCall`. No network.
3. **On-chain** — three real programs shipped on Sepolia, read back from the
   `Shipped` event, decoded.

The unknown-opcode case is **provable without any of that**: hand-build a
program with a byte not in our table and assert the refusal. That is the
milestone's headline claim and it costs one unit test.

## 10. Must be verified, not assumed

| # | Claim | Status | How to settle it |
|---|---|---|---|
| 10.1 | Which opcode numbering applies | **RESOLVED — §3** | The rules permit redeploying SwapVM, so we deploy commit `4918338` and the enum value is the wire byte by construction, as its own dispatcher and `OpcodeEnumCheck.t.sol` both show. Re-extract if the commit or router address changes. |
| 10.2 | The 16-opcode dispatch set matches the deployment | UNCONFIRMED | Same probe, one instruction per candidate opcode. The SDK claiming 29 is direct evidence of drift. |
| 10.3 | Commit `4918338` is what is deployed | UNCONFIRMED | Compare deployed bytecode against a local build. |
| 10.4 | The SwapVM licence carries the same bundling bar | UNCONFIRMED | Read `swap-vm/LICENSES/SwapVM-1.1.txt` clause by clause; record in `THIRD-PARTY-LICENSES.md`. Presume encumbered until read. |
| 10.5 | Every SwapVM strategy has the `0x20` head | Confirmed *for this app* | `abi.encode(Order)` with `bytes data` is a dynamic tuple. But see 10.6. |
| 10.6 | Non-SwapVM Aqua apps also have a `0x20` head | **UNCONFIRMED — counter-evidence** | The `aqua-sdk` README's XYCSwap example encodes an **all-static** tuple, which viem inlines with **no** head word; `readStrategy` would refuse it as `not-a-tuple`. Safe failure, but B2 may already refuse a legitimate shape. Track as a B2 follow-up, not a B3 blocker. |
| 10.7 | `programStart = (traits >> 208) & 0xffff` | Derived, not executed | Assert in `program.test.ts` against an SDK-built `Order`, both directions. |
| 10.8 | Aqua is deployed on Sepolia | UNCONFIRMED | Confirm before §9 layer 3. |
| 10.9 | No program-level version declaration | Confirmed by absence | Nothing in `runLoop` or `Order` carries a version. Versioning is per router deployment (EIP-712 domain), invisible to a program's bytes. |
| 10.10 | The mainnet router can be disassembled for the dispatch constants | **DISPROVED — measured** | `eth_getCode` on `0x111111338c5091e8440b67b168bae16a668ac0de` returns **20,541 bytes** containing **no opcode dispatch constants** (the only `PUSH1 x EQ` values are `0x02`, `0x20`, `0x40` — ABI/memory constants) and **11 `DELEGATECALL`s**. Its EIP-1967 implementation slot is **zero**, so it is not a standard proxy. The dispatch lives behind a delegation this scan does not follow. Resolve the delegation targets first if this route is retried; otherwise use 10.1's Sepolia probe. |

## 11. Versioning: how an old decoder behaves against a new program

There is no version byte, so **our decoder cannot detect that a program is newer
than it.** A newly allocated opcode would simply be an unfamiliar byte.

This is survivable only because of §6.2: our table is a **closed allowlist**, so
a new opcode is an unknown opcode, and an unknown opcode is a refusal. The
failure mode of an outdated decoder is *refusing a valid new strategy* —
annoying, and safe. The reverse must never happen, and the allowlist prevents it.

1. **Never decode by exclusion.** No "if it is not a jump, it is safe to render."
2. **The router address is part of the version.** Our table is valid for one
   deployment. If `AQUA_SWAP_VM_CONTRACT_ADDRESSES` changes for a chain, §10.1
   and §10.2 must be re-run before the table is reused. Pin the address in
   `registry.ts` so a change is a diff.

## 12. Out of scope

- B4's custom opcode. Only after this ships.
- `FeeProtocol` decoding (§6.4).
- Jumps, `Extruction`, and any renderer for them (§6.3).
- Quoting or simulating a program's output. We describe what a program *is*,
  never predict what it will *pay*.
- Changing `ship`/`dock` encoding, `strategy.ts`'s maker rule, or B2's flow for
  non-SwapVM apps.

## 13. Done means

```
pnpm --dir app typecheck
pnpm --dir app test
pnpm --dir app build
make -C sim conformance && pnpm --dir app test
./scripts/check.sh
```

all green, plus:

- `program.test.ts` covers **every** refusal kind in §6.5, including an unknown
  opcode, a wrong `args_len`, and a truncated tail.
- `sdk-parity.test.ts` gains a SwapVM section, and its "the SDK stays out of
  everything that ships" check still passes with the new devDependency.
- `grep -rn "@1inch/" app/packages/apps/aqua/src/` returns nothing.
- Bundle growth under 10 KB. The decoder is a table and a loop.
- `src/eth-decode.c` refuses the same programs, proven by a shared calldata-
  vector file replayed in the TS suite (`docs/MIRROR-GAP.md`) — not by the
  protocol conformance vectors, which do not cover this.
- Three programs shipped on Sepolia decode correctly, photographed.
- **One photographed refusal screen for an unknown opcode, next to the program
  that caused it. This photograph is the milestone.**
- The wrong opcode numbers in `docs/HACKATHON-MILESTONES.md` §B3 and
  `docs/apps/AQUA-1INCH.md` step 4 are corrected or marked unconfirmed.
- §10.1 is answered in this file, with the evidence, before any table ships.
