/**
 * SwapVM program decoding — B3.
 *
 * The point of this milestone is refusal, not display: "an unknown opcode
 * starts refusing to render." A SwapVM program is bytecode a maker composes
 * once, signed once via `ship`, and every future swap against that liquidity
 * runs it. So the device screen has to describe what the program *is*, in
 * full, or not describe it at all — see docs/AQUA-B3-SPEC.md §6.2/§6.6 for the
 * argument this module is built to.
 *
 * ---------------------------------------------------------------------------
 * The bytecode format (spec §2, `ContextLib.runLoop`, `src/libs/VM.sol`,
 * `github.com/1inch/swap-vm` commit `4918338`)
 *
 *   [opcode: 1 byte][args_len: 1 byte][args: args_len bytes] ...
 *
 * No framing, no header, no version byte, no terminator — the stream just
 * ends when its own length runs out. A stream whose last instruction's args
 * would run past that length is what the VM itself reverts as
 * `RunLoopExceedProgramLength`; we mirror that as `truncated`, never
 * zero-padded.
 *
 * ---------------------------------------------------------------------------
 * The opcode table (spec §3, SETTLED ON-CHAIN 2026-09-10)
 *
 * The deployed `AquaSwapVMRouter` v1.0.2 numbers its instructions by DENSE
 * INDEX, not by the `Opcode` enum in `OpcodeList.sol` (`XYCSwap = 0x50`,
 * `Decay = 0x9c`) — that enum is a different version's numbering, and an
 * earlier version of this table shipped it. It was wrong, and it refused every
 * real Aqua strategy on Base.
 *
 * What settles it is not source at an arbitrary commit but bytes the deployed
 * router has accepted: two live maker strategies read back from `Shipped`
 * events on Base mainnet (8453) both walk as
 *
 *   op 18 (0x12) argslen 64   xycConcentrateGrowLiquidity2D
 *   op 21 (0x15) argslen  4   flatFeeAmountInXD
 *   op 17 (0x11) argslen  0   xycSwapXD
 *   op 20 (0x14) argslen  8   salt
 *
 * and 1inch's documented dApp program is `0x21 0x14 <20-byte KycNFT> 0x11
 * 0x00` — opcode 33 then opcode 17. Both are in the shared calldata vectors,
 * so a regression to any other numbering fails the suite rather than shipping.
 *
 * The table this module renders, with the argument width each opcode's own
 * parser reads (spec §3):
 *
 *   13 (0x0d) deadline                        5 bytes  [uint40]
 *   14 (0x0e) onlyTakerTokenBalanceNonZero   20 bytes  [address]
 *   15 (0x0f) onlyTakerTokenBalanceGte       52 bytes  [address, uint256]
 *   16 (0x10) onlyTakerTokenSupplyShareGte   28 bytes  [address, uint64]
 *   17 (0x11) xycSwapXD                       0 bytes
 *   18 (0x12) xycConcentrateGrowLiquidity2D  64 bytes  [uint256, uint256]
 *   19 (0x13) decayXD                         2 bytes  [uint16]
 *   20 (0x14) salt                           any       opaque, never read
 *   21 (0x15) flatFeeAmountInXD               4 bytes  [uint32], base 1e9
 *   31 (0x1f) peggedSwapGrowPriceRange2D    160 bytes  [5 × uint256]
 *   33 (0x21) onlyTxOriginTokenBalanceNonZero 20 bytes [address]
 *
 * `flatFeeAmountInXD` is FOUR bytes, not three, and its denominator is 1e9 —
 * 1e9 is 100%, so 0.30% is 3_000_000. It is never labelled "bps": a 1e9-base
 * number called bps is off by five orders of magnitude, which is precisely the
 * plausible-but-wrong render this module exists to refuse.
 *
 * `salt` carries no width claim at all, because its `exec()` never reads its
 * args — there is no field being interpreted, only bytes carried for
 * uniqueness.
 *
 * Deliberately NOT in the table, and refused:
 *
 *   27–30  protocolFeeAmountInXD and its three variants — v1 sets them zero,
 *          and their args are conditional on per-receiver flag bits this pass
 *          does not decode (spec §6.4). Exactly the shape that reads
 *          plausibly while being wrong.
 *   10 (0x0a) jump, 11 (0x0b) jumpIfTokenIn, 12 (0x0c) jumpIfTokenOut and
 *   32 (0x20) extruction — control flow and external pricing (spec §6.3). A
 *          jump means the linear list this module would produce is not the
 *          list that executes; `extruction` hands the swap registers to
 *          arbitrary maker-chosen bytecode this module cannot read by
 *          construction. They get their own refusal kind,
 *          `has-control-flow`, distinct from `unknown-opcode`, so a reviewer
 *          can tell "we know exactly what this is and still won't render it"
 *          apart from "we have never heard of this byte".
 *
 * Indices 0–9 and 22–26 are reserved no-ops on the router and are unknown
 * here. Anything past the table reverts `Panic(0x32)` on chain; here it is an
 * `unknown-opcode` refusal, which is the same answer with a better message.
 *
 * ---------------------------------------------------------------------------
 * "Understood" (spec §6.2)
 *
 * An instruction is understood only when its opcode is in the table above,
 * its `args_len` equals that opcode's fixed width EXACTLY (never "at least"
 * — a `deadline` with six bytes is refused, not truncated to five), and
 * every field this module renders is derived by its own arithmetic. A
 * program is understood only when every instruction in it is understood,
 * the stream consumes the program's bytes exactly, and it contains no
 * control flow. There is no partial result: if any instruction fails, the
 * instruction list is never built (spec §6.6) — `readProgram` either returns
 * every instruction or none.
 */

import { readStrategyData, type StrategyRefusal } from "./strategy.ts";
import { AQUA_SWAPVM_ROUTER } from "./registry.ts";

/* ------------------------------------------------------------------ table */

/** One entry per opcode this module claims to understand. */
interface OpcodeSpec {
  readonly name: string;
  /**
   * Exact required `args_len`, or `null` when the opcode's own `exec()` never
   * reads its args at all (salt) — in which case any length is understood,
   * because there is no field being interpreted, only bytes carried for
   * uniqueness.
   */
  readonly argsLen: number | null;
}

/** The closed, literal allowlist. See the file header for how each width was verified. */
const OPCODES: Readonly<Record<number, OpcodeSpec>> = {
  13: { name: "deadline", argsLen: 5 },
  14: { name: "onlyTakerTokenBalanceNonZero", argsLen: 20 },
  15: { name: "onlyTakerTokenBalanceGte", argsLen: 52 },
  16: { name: "onlyTakerTokenSupplyShareGte", argsLen: 28 },
  17: { name: "xycSwapXD", argsLen: 0 },
  18: { name: "xycConcentrateGrowLiquidity2D", argsLen: 64 },
  19: { name: "decayXD", argsLen: 2 },
  20: { name: "salt", argsLen: null },
  21: { name: "flatFeeAmountInXD", argsLen: 4 },
  31: { name: "peggedSwapGrowPriceRange2D", argsLen: 160 },
  33: { name: "onlyTxOriginTokenBalanceNonZero", argsLen: 20 },
};

/** Real Aqua-dispatched opcodes, deliberately excluded — see file header. */
const CONTROL_FLOW: Readonly<Record<number, string>> = {
  10: "jump",
  11: "jumpIfTokenIn",
  12: "jumpIfTokenOut",
  32: "extruction",
};

/**
 * A cap on instruction count, independent of `args_len` (max 255 per
 * instruction, but the stream itself has no length limit of its own — that
 * comes from the ABI `bytes` carrying it). This is a host-side circuit
 * breaker against an adversarial or malformed program forcing an unbounded
 * walk, set generously above what any real Aqua strategy uses: spec §5 says
 * `AquaXYCAmmStrategy`/`AquaPeggedAmmStrategy` build at most six instructions.
 *
 * This equals `ETH_AQUA_MAX_INSTRUCTIONS` in `src/eth-decode.h`, and must
 * keep equalling it: the host's accepted set has to be a subset of the
 * device's, never wider. The shared calldata vectors
 * (`app/packages/core/test/eth-decode-vectors.json`) are what now catch a
 * disagreement, so changing one bound without the other fails the suite
 * rather than drifting quietly.
 */
export const AQUA_MAX_INSTRUCTIONS = 16;

/* ------------------------------------------------------------- instructions */

export type InstructionFields =
  | { readonly name: "deadline"; readonly deadline: bigint }
  | { readonly name: "onlyTakerTokenBalanceNonZero"; readonly token: string }
  | { readonly name: "onlyTakerTokenBalanceGte"; readonly token: string; readonly amount: bigint }
  | { readonly name: "onlyTakerTokenSupplyShareGte"; readonly token: string; readonly share: bigint }
  | { readonly name: "onlyTxOriginTokenBalanceNonZero"; readonly token: string }
  | { readonly name: "xycSwapXD" }
  | {
      readonly name: "xycConcentrateGrowLiquidity2D";
      readonly sqrtPriceMin: bigint; readonly sqrtPriceMax: bigint;
    }
  | { readonly name: "decayXD"; readonly period: number }
  | { readonly name: "salt"; readonly salt: Uint8Array }
  /**
   * `fee` is a raw uint32 against a denominator of 1e9, where 1e9 is 100% —
   * so 3_000_000 is 0.30%. It is deliberately not called `feeBps`: this is
   * not a basis-point number and naming it one would be wrong by five orders
   * of magnitude. Callers that want a percentage should divide by 1e7.
   */
  | { readonly name: "flatFeeAmountInXD"; readonly fee: number }
  | {
      readonly name: "peggedSwapGrowPriceRange2D";
      readonly x0: bigint; readonly y0: bigint; readonly linearWidth: bigint;
      readonly rateA: bigint; readonly rateB: bigint;
    };

export interface Instruction {
  /** The wire byte, so a caller need not re-derive it from `fields.name`. */
  readonly opcode: number;
  /** The byte offset of the opcode within the program, for diagnostics. */
  readonly offset: number;
  /** Exactly `args_len` bytes, verbatim, for anything that wants the raw form. */
  readonly args: Uint8Array;
  readonly fields: InstructionFields;
}

/** Why a program could not be read in full. Every one is a refusal, never a warning. */
export type ProgramRefusal =
  /** Opcode byte not in our table (§3). Carries the byte and its offset. */
  | { readonly kind: "unknown-opcode"; readonly opcode: number; readonly offset: number }
  /** `args_len` did not equal the opcode's fixed width, exactly. */
  | {
      readonly kind: "bad-args-length"; readonly opcode: number; readonly name: string;
      readonly offset: number; readonly expected: number; readonly actual: number;
    }
  /** The last instruction's args (or its two-byte header) run past the program end. */
  | { readonly kind: "truncated"; readonly offset: number }
  /** A jump or `Extruction` is present — real opcode, deliberately refused (§6.3). */
  | { readonly kind: "has-control-flow"; readonly opcode: number; readonly name: string; readonly offset: number }
  /** Zero-length program. */
  | { readonly kind: "empty" }
  /** More instructions than `AQUA_MAX_INSTRUCTIONS`. */
  | { readonly kind: "too-long"; readonly count: number }
  /** The `app` argument of `ship` is not the SwapVM router — not a program failure at all. */
  | { readonly kind: "not-swapvm" };

export type ProgramReading =
  | { readonly ok: true; readonly instructions: readonly Instruction[] }
  | { readonly ok: false; readonly refusal: ProgramRefusal };

function parseFields(name: string, args: Uint8Array): InstructionFields {
  const u = (from: number, to: number) => {
    let v = 0n;
    for (let i = from; i < to; i++) v = (v << 8n) | BigInt(args[i] as number);
    return v;
  };
  const addr = (from: number) => "0x" + toHex(args.subarray(from, from + 20));

  switch (name) {
    case "deadline":
      return { name, deadline: u(0, 5) };
    case "onlyTakerTokenBalanceNonZero":
    case "onlyTxOriginTokenBalanceNonZero":
      return { name, token: addr(0) };
    case "onlyTakerTokenBalanceGte":
      return { name, token: addr(0), amount: u(20, 52) };
    case "onlyTakerTokenSupplyShareGte":
      return { name, token: addr(0), share: u(20, 28) };
    case "xycSwapXD":
      return { name };
    case "xycConcentrateGrowLiquidity2D":
      return { name, sqrtPriceMin: u(0, 32), sqrtPriceMax: u(32, 64) };
    case "decayXD":
      return { name, period: Number(u(0, 2)) };
    case "salt":
      return { name, salt: args };
    case "flatFeeAmountInXD":
      return { name, fee: Number(u(0, 4)) };
    case "peggedSwapGrowPriceRange2D":
      return {
        name,
        x0: u(0, 32), y0: u(32, 64), linearWidth: u(64, 96),
        rateA: u(96, 128), rateB: u(128, 160),
      };
    default:
      /* Unreachable: every name that reaches here came out of OPCODES above. */
      throw new Error(`no field parser for ${name}`);
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Walk a SwapVM program and either read every instruction in it, or refuse.
 *
 * Pure. No I/O, no allocation kept alive past the call, no partial result:
 * the instruction array is only ever returned complete (spec §6.6).
 */
export function readProgram(program: Uint8Array): ProgramReading {
  if (program.length === 0) return { ok: false, refusal: { kind: "empty" } };

  const instructions: Instruction[] = [];
  let pc = 0;

  while (pc < program.length) {
    if (pc + 2 > program.length) {
      return { ok: false, refusal: { kind: "truncated", offset: pc } };
    }
    const opcode = program[pc] as number;
    const argsLen = program[pc + 1] as number;
    const offset = pc;
    pc += 2;

    if (opcode in CONTROL_FLOW) {
      return {
        ok: false,
        refusal: { kind: "has-control-flow", opcode, name: CONTROL_FLOW[opcode] as string, offset },
      };
    }

    const spec = OPCODES[opcode];
    if (spec === undefined) {
      return { ok: false, refusal: { kind: "unknown-opcode", opcode, offset } };
    }
    if (spec.argsLen !== null && argsLen !== spec.argsLen) {
      return {
        ok: false,
        refusal: {
          kind: "bad-args-length", opcode, name: spec.name, offset,
          expected: spec.argsLen, actual: argsLen,
        },
      };
    }

    if (pc + argsLen > program.length) {
      return { ok: false, refusal: { kind: "truncated", offset } };
    }
    const args = program.subarray(pc, pc + argsLen);
    pc += argsLen;

    if (instructions.length >= AQUA_MAX_INSTRUCTIONS) {
      return { ok: false, refusal: { kind: "too-long", count: instructions.length + 1 } };
    }
    instructions.push({ opcode, offset, args, fields: parseFields(spec.name, args) });
  }

  return { ok: true, instructions };
}

/* --------------------------------------------------------- the refusal boundary */

export type OrderProgramReading =
  | { readonly ok: true; readonly instructions: readonly Instruction[] }
  | { readonly ok: false; readonly refusal: ProgramRefusal | StrategyRefusal };

/**
 * The refusal boundary of spec §6.6, in one function: read a strategy as a
 * SwapVM Order and decode its program, but only when `app` — the same `app`
 * argument the ship calldata carries — is the SwapVM router this build knows
 * about.
 *
 * For any other app, this is not a B3 refusal at all: `not-swapvm` means
 * "program decoding was never attempted", not "the strategy is broken".
 * B2's behaviour for non-SwapVM apps is exactly what it was before this file
 * existed — callers must not treat `not-swapvm` as a reason to block a sign.
 */
export function readOrderProgram(strategy: string, app: string): OrderProgramReading {
  if (app.toLowerCase() !== AQUA_SWAPVM_ROUTER) {
    return { ok: false, refusal: { kind: "not-swapvm" } };
  }

  const data = readStrategyData(strategy);
  if (!data.ok) return data;

  const programStart = Number((data.value.traits >> 208n) & 0xffffn);
  if (programStart > data.value.data.length) {
    return {
      ok: false,
      refusal: { kind: "malformed", why: "programStart runs past the strategy's data" },
    };
  }
  const program = data.value.data.subarray(programStart);

  return readProgram(program);
}
