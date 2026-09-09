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
 * The opcode table (spec §3, RESOLVED)
 *
 * Pinned to commit `4918338` of `1inch/swap-vm`, deployed by us — the wire
 * byte IS the `Opcode` enum value at that commit, verified against
 * `src/opcodes/AquaOpcodes.sol`'s own dispatch chain. If the deployed
 * router's commit or address ever changes, this table must be re-extracted
 * before it is trusted again (spec §3a, §11).
 *
 * Every argument width below was read out of the individual
 * `src/instructions/*.sol` file that builds and parses it — not guessed, not
 * inferred from a name:
 *
 *   Salt (0x02)                          - opaque; `exec()` never reads args,
 *                                          so no width claim is made at all.
 *                                          Controls.sol.
 *   Deadline (0x20)                      - [uint40 deadline], 5 bytes.
 *                                          Controls.sol.
 *   OnlyTakerTokenBalanceNonZero (0x23)  - [address token], 20 bytes.
 *                                          TokenValidators.sol.
 *   OnlyTxOriginTokenBalanceNonZero(0x26)- [address token], 20 bytes.
 *                                          TokenValidators.sol.
 *   XYCSwap (0x50)                       - no args, 0 bytes. XYCSwap.sol.
 *   XYCConcentrateSwap (0x51)            - [uint256 sqrtPriceMin,
 *                                          uint256 sqrtPriceMax], 64 bytes.
 *                                          XYCConcentrate.sol.
 *   PeggedSwap (0x58)                    - [uint256 x0, uint256 y0,
 *                                          uint256 linearWidth,
 *                                          uint256 rateA, uint256 rateB],
 *                                          160 bytes. PeggedSwap.sol.
 *   FeeFlatIn (0x70)                     - [uint24 feeBps], 3 bytes, against
 *                                          a denominator of 1e7 (not the usual
 *                                          1e4). FeeFlat.sol.
 *   Decay (0x9c)                         - [uint16 period], 2 bytes.
 *                                          Decay.sol.
 *
 * `OnlyTakerTokenBalanceGte` (0x24) and `OnlyTakerTokenSupplyShareGte` (0x25)
 * are real opcodes the Aqua router dispatches, but they are deliberately NOT
 * in this table — the nine names in spec §6.4 are the whole initial set. A
 * program using them is refused as `unknown-opcode`, exactly like a byte the
 * router itself would revert on, because "in the router's dispatch set" and
 * "in the set this wallet renders" are different claims and only the second
 * one is what this module promises.
 *
 * `FeeProtocol` (0x80) is excluded on purpose (spec §6.4): its args are
 * variable-length, conditional on per-receiver flag bits this pass does not
 * decode, and that is exactly the shape that reads plausibly while being
 * wrong.
 *
 * `Jump` (0x03), `Extruction` (0x04), `JumpIfTokenIn` (0x31) and
 * `JumpIfTokenOut` (0x32) are control flow: real opcodes the router
 * dispatches, deliberately refused rather than added to the table at all
 * (spec §6.3). A jump means the linear list this module would produce is not
 * the list that executes, and `Extruction` hands the swap registers to
 * arbitrary maker-chosen bytecode this module cannot read by construction.
 * They get their own refusal kind, `has-control-flow`, distinct from
 * `unknown-opcode`, because a reviewer should be able to tell "we know
 * exactly what this is and still won't render it" apart from "we have never
 * heard of this byte".
 *
 * ---------------------------------------------------------------------------
 * "Understood" (spec §6.2)
 *
 * An instruction is understood only when its opcode is in the table above,
 * its `args_len` equals that opcode's fixed width EXACTLY (never "at least"
 * — a `Deadline` with six bytes is refused, not truncated to five), and
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
   * reads its args at all (Salt) — in which case any length is understood,
   * because there is no field being interpreted, only bytes carried for
   * uniqueness.
   */
  readonly argsLen: number | null;
}

/** The closed, literal allowlist. See the file header for how each width was verified. */
const OPCODES: Readonly<Record<number, OpcodeSpec>> = {
  0x02: { name: "Salt", argsLen: null },
  0x20: { name: "Deadline", argsLen: 5 },
  0x23: { name: "OnlyTakerTokenBalanceNonZero", argsLen: 20 },
  0x26: { name: "OnlyTxOriginTokenBalanceNonZero", argsLen: 20 },
  0x50: { name: "XYCSwap", argsLen: 0 },
  0x51: { name: "XYCConcentrateSwap", argsLen: 64 },
  0x58: { name: "PeggedSwap", argsLen: 160 },
  0x70: { name: "FeeFlatIn", argsLen: 3 },
  0x9c: { name: "Decay", argsLen: 2 },
};

/** Real Aqua-dispatched opcodes, deliberately excluded — see file header. */
const CONTROL_FLOW: Readonly<Record<number, string>> = {
  0x03: "Jump",
  0x04: "Extruction",
  0x31: "JumpIfTokenIn",
  0x32: "JumpIfTokenOut",
};

/**
 * A cap on instruction count, independent of `args_len` (max 255 per
 * instruction, but the stream itself has no length limit of its own — that
 * comes from the ABI `bytes` carrying it). This is a host-side circuit
 * breaker against an adversarial or malformed program forcing an unbounded
 * walk, set generously above what any real Aqua strategy uses: spec §5 says
 * `AquaXYCAmmStrategy`/`AquaPeggedAmmStrategy` build at most six instructions.
 *
 * Provisional: spec §7 puts a matching `ETH_AQUA_MAX_INSTRUCTIONS` on the
 * firmware side, out of scope for this pass. When the firmware walker ships,
 * this constant must equal it — the host's accepted set has to be a subset of
 * the device's, never wider.
 */
export const AQUA_MAX_INSTRUCTIONS = 16;

/* ------------------------------------------------------------- instructions */

export type InstructionFields =
  | { readonly name: "Salt"; readonly salt: Uint8Array }
  | { readonly name: "Deadline"; readonly deadline: bigint }
  | { readonly name: "OnlyTakerTokenBalanceNonZero"; readonly token: string }
  | { readonly name: "OnlyTxOriginTokenBalanceNonZero"; readonly token: string }
  | { readonly name: "XYCSwap" }
  | { readonly name: "XYCConcentrateSwap"; readonly sqrtPriceMin: bigint; readonly sqrtPriceMax: bigint }
  | {
      readonly name: "PeggedSwap";
      readonly x0: bigint; readonly y0: bigint; readonly linearWidth: bigint;
      readonly rateA: bigint; readonly rateB: bigint;
    }
  | { readonly name: "FeeFlatIn"; readonly feeBps: number }
  | { readonly name: "Decay"; readonly period: number };

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
    case "Salt":
      return { name, salt: args };
    case "Deadline":
      return { name, deadline: u(0, 5) };
    case "OnlyTakerTokenBalanceNonZero":
      return { name, token: addr(0) };
    case "OnlyTxOriginTokenBalanceNonZero":
      return { name, token: addr(0) };
    case "XYCSwap":
      return { name };
    case "XYCConcentrateSwap":
      return { name, sqrtPriceMin: u(0, 32), sqrtPriceMax: u(32, 64) };
    case "PeggedSwap":
      return {
        name,
        x0: u(0, 32), y0: u(32, 64), linearWidth: u(64, 96),
        rateA: u(96, 128), rateB: u(128, 160),
      };
    case "FeeFlatIn":
      return { name, feeBps: Number(u(0, 3)) };
    case "Decay":
      return { name, period: Number(u(0, 2)) };
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
