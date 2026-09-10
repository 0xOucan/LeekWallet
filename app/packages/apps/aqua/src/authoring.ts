/**
 * Authoring SwapVM programs — the write half of B3.
 *
 * `program.ts` reads a program and refuses anything it cannot read in full.
 * This module is the other direction, and it is bound by a rule that follows
 * directly from that one:
 *
 *   **We only author what we can decode.**
 *
 * Every program this module builds is walked back through `readProgram()` in
 * the tests, field for field, and any opcode not in `program.ts`'s closed
 * allowlist is unreachable from here by construction. That is not a courtesy
 * to the decoder — a strategy the host cannot decode is a strategy the DEVICE
 * refuses, so a program built outside the allowlist is a position this wallet
 * would build and then decline to sign.
 *
 * The plan this file implements, with the reasoning for every number, is
 * `docs/STRATEGIES.md`. Where the two disagree, the doc is the specification
 * and this file is the bug.
 *
 * ---------------------------------------------------------------------------
 * The program (STRATEGIES.md §2)
 *
 *   0d 05 <deadline uint40>                       expire the position
 *   0e 14 <gate token address>                    only takers holding it
 *   12 40 <sqrtPriceMin u256><sqrtPriceMax u256>  the band
 *   15 04 <fee uint32, base 1e9>                  0.30% = 3_000_000
 *   11 00                                         xycSwap, x*y=k
 *   14 08 <salt 8 bytes>                          uniqueness only
 *
 * 113 bytes, six instructions, in that order. Instruction order is
 * security-critical (spec §6.7): the same instructions in a different order
 * price differently. It is never rearranged, and the builder does not offer a
 * way to.
 *
 * ---------------------------------------------------------------------------
 * The trap this file exists to close (STRATEGIES.md §3.2)
 *
 * Opcode 18's two arguments are SQUARE ROOTS of a price in 1e18 fixed point,
 * where P is the amount of `tokenGt` per amount of `tokenLt` in RAW units.
 * There are two silent ways to get that wrong:
 *
 *   1. Passing P where sqrt(P) belongs. Prices the square of the intended
 *      range. Nothing reverts.
 *   2. Passing a human price where a raw one belongs. For WETH/USDC the
 *      decimal factor is 1e6/1e18 = 1e-12, so the error is 1e12x. Nothing
 *      reverts.
 *
 * So this module NEVER accepts a sqrt price from a caller. It accepts a human
 * mid price, the two tokens with their decimals, and a named tier, and it does
 * every step itself in exact integer arithmetic — no floating point anywhere,
 * because the number a contract will act on must not be produced by a
 * representation that rounds where nobody looked.
 *
 * The direction is derived from the ADDRESSES, never from the order the
 * caller passed the tokens in: the VM enforces tokenA < tokenB, so which token
 * is "gt" is a fact about the pair and not about the call.
 */

import { AbiError } from "@leekwallet/core/balances.ts";
import { encodeStrategy } from "./strategy.ts";

/* --------------------------------------------------------------- rationals */

/** An exact rational. Every price in this file is one of these, never a number. */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;

/**
 * Parse a decimal string into an exact rational.
 *
 * A string, not a `number`: `0.1` is not representable in binary floating
 * point, and a mid price that arrives already rounded cannot be un-rounded
 * later. The operator types digits; those digits are what is used.
 */
export function parseDecimal(text: string): Rational {
  const m = DECIMAL.exec(text.trim());
  if (m === null) throw new AbiError(`"${text}" is not a decimal number`);
  const whole = m[1] as string;
  const frac = m[2] ?? "";
  const num = BigInt(whole + frac);
  if (num === 0n) throw new AbiError("a mid price of zero prices nothing");
  return { num, den: 10n ** BigInt(frac.length) };
}

export const invert = (r: Rational): Rational => ({ num: r.den, den: r.num });

/** Integer square root, floor. Newton's method on bigints. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new AbiError("no square root of a negative");
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) >> 1n) + 1n;
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/* -------------------------------------------------------------------- tiers */

/**
 * The three risk tiers, as exact multiples of the mid price.
 *
 * Named, closed, and chosen from a list — never a free-form number entry. A
 * text box here is a text box in which somebody types a raw uint256 that
 * nobody can sanity-check, and a mistyped sqrt price does not fail loudly, it
 * silently prices a different range.
 *
 * Each band is geometrically symmetric (`hi = 1/lo`), so the two sqrt bounds
 * sit the same distance either side of sqrt(mid).
 */
export type RiskTier = "low" | "medium" | "high";

export interface TierBand {
  readonly lo: Rational;
  readonly hi: Rational;
  /** What the tier actually means. No projection of return — see below. */
  readonly summary: string;
}

/**
 * The tier copy is part of the security surface, not marketing.
 *
 * A tighter band is NOT "more yield". It is more fee density AND more
 * impermanent loss, and it earns nothing at all once the price leaves the
 * band. The word "yield" does not appear in this file, and no number here
 * projects a return: spec §12 is explicit that we describe what a program IS
 * and never predict what it will PAY.
 */
export const TIERS: Readonly<Record<RiskTier, TierBand>> = {
  low: {
    lo: { num: 1n, den: 2n }, hi: { num: 2n, den: 1n },
    summary:
      "Wide band, half the mid price to double it. Rarely out of range, so " +
      "fees are spread thin across it. Least impermanent loss of the three.",
  },
  medium: {
    lo: { num: 7n, den: 10n }, hi: { num: 10n, den: 7n },
    summary:
      "Moderate band, about -30% to +43% around the mid. Middling on both " +
      "fee density and impermanent loss.",
  },
  high: {
    lo: { num: 9n, den: 10n }, hi: { num: 10n, den: 9n },
    summary:
      "Tight band, about -10% to +11% around the mid. Densest fee capture " +
      "while the price is inside it, leaves the band soonest, and the most " +
      "impermanent loss. Outside the band it earns nothing.",
  },
};

/* --------------------------------------------------------------- sqrt price */

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export interface TokenSpec {
  readonly address: string;
  readonly decimals: number;
}

/**
 * A pair, ordered the way the VM requires and the way opcode 18 reads it.
 *
 * `tokenLt < tokenGt` by address. `P = tokenGt per tokenLt`, in raw units.
 */
export interface OrderedPair {
  readonly tokenLt: TokenSpec;
  readonly tokenGt: TokenSpec;
}

/** Order a pair by address. Caller argument order is deliberately ignored. */
export function orderPair(a: TokenSpec, b: TokenSpec): OrderedPair {
  for (const t of [a, b]) {
    if (!HEX40.test(t.address)) throw new AbiError(`"${t.address}" is not a 20-byte address`);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) {
      throw new AbiError("token decimals out of range");
    }
  }
  const x = a.address.toLowerCase();
  const y = b.address.toLowerCase();
  if (x === y) throw new AbiError("a pair needs two different tokens");
  return x < y
    ? { tokenLt: { ...a, address: x }, tokenGt: { ...b, address: y } }
    : { tokenLt: { ...b, address: y }, tokenGt: { ...a, address: x } };
}

/**
 * A mid price as the operator states it: "`price` units of `quote` per one
 * unit of `base`", both in HUMAN units.
 *
 * Stated this way round because it is the way a person actually knows a price
 * ("4000 USDC per ETH"), and because naming both ends makes the inversion this
 * module has to perform for one of the two pairs explicit rather than implied.
 */
export interface MidPrice {
  readonly base: string;
  readonly quote: string;
  readonly price: string;
}

/** The mid, normalised to `tokenGt per tokenLt` in human units, exactly. */
export function midAsGtPerLt(pair: OrderedPair, mid: MidPrice): Rational {
  const base = mid.base.toLowerCase();
  const quote = mid.quote.toLowerCase();
  const r = parseDecimal(mid.price);
  if (base === pair.tokenLt.address && quote === pair.tokenGt.address) return r;
  if (base === pair.tokenGt.address && quote === pair.tokenLt.address) return invert(r);
  throw new AbiError("the mid price does not name this pair's two tokens");
}

/**
 * The upper bound on a sqrt price this module will emit.
 *
 * Not a protocol limit — a sanity limit, and it is important to be precise
 * about how little it catches. It catches **gross** nonsense: a mid price so
 * large that the bound could not describe any real pair. It does **not** catch
 * either trap of §3.2 on its own — the raw-for-sqrt confusion moves the number
 * by about 1e4 for WETH/USDC, and the human-for-raw confusion by about 1e6,
 * and both land comfortably inside 2^160. A bound cannot distinguish a
 * plausible wrong price from a plausible right one; only a human reading the
 * band back in units they know can (§3.4), which is why `bandFor` returns
 * `loHuman`/`hiHuman` and the RUNBOOK prints them before anything is signed.
 *
 * What this constant is for, then, is the one failure a bound CAN see, plus
 * its mirror at the bottom: a bound that rounded to zero because the pair's
 * decimals swallowed the price. Refused, never clamped — a clamped bound is a
 * plausible number produced by an implausible input, which is exactly the
 * render this app exists to refuse.
 */
export const MAX_SQRT_PRICE = 1n << 160n;

/**
 * `floor(sqrt(P_raw * band) * 1e18)`, in exact integer arithmetic.
 *
 *   mid_human   = num / den                     (tokenGt per tokenLt)
 *   P_raw       = mid_human * 10^decGt / 10^decLt
 *   S           = floor(sqrt(P_raw * band * 1e36))
 *
 * Writing `P_raw * 1e36 * band` as a single rational A/B and using
 * `sqrt(A/B) = sqrt(A*B)/B` keeps every step integral — there is no
 * intermediate that has to be representable as anything but a bigint.
 */
export function sqrtPriceX18(
  pair: OrderedPair, midGtPerLt: Rational, band: Rational,
): bigint {
  if (band.num <= 0n || band.den <= 0n) throw new AbiError("a band factor must be positive");
  const A = midGtPerLt.num * band.num * 10n ** BigInt(pair.tokenGt.decimals + 36);
  const B = midGtPerLt.den * band.den * 10n ** BigInt(pair.tokenLt.decimals);
  const s = isqrt(A * B) / B;
  if (s <= 0n) {
    throw new AbiError(
      "the computed sqrt price rounded to zero — the mid price is too small " +
      "for this pair's decimals to survive, and a zero bound would price the " +
      "whole range rather than the band asked for",
    );
  }
  if (s >= MAX_SQRT_PRICE) {
    throw new AbiError(
      "the computed sqrt price is too large to describe any real pair — " +
      "refused rather than clamped. Note this bound does NOT catch a unit " +
      "mix-up of the size §3.2 describes; the human read-back does",
    );
  }
  return s;
}

/** The two bounds of a tier's band, plus the human numbers they came from. */
export interface Band {
  readonly tier: RiskTier;
  readonly sqrtPriceMin: bigint;
  readonly sqrtPriceMax: bigint;
  /** Lower/upper edge in the operator's own units, for the eyeball check. */
  readonly loHuman: Rational;
  readonly hiHuman: Rational;
}

/**
 * Compute a tier's band.
 *
 * `loHuman`/`hiHuman` are returned alongside the bounds on purpose, in the
 * operator's own price direction, because §3.4 makes the human read-back the
 * actual safety check: a person reading "2,800 to 5,714 USDC per WETH"
 * catches a 1e12 error instantly, and nobody catches it reading `0x…3f2a`.
 */
export function bandFor(pair: OrderedPair, mid: MidPrice, tier: RiskTier): Band {
  const t = TIERS[tier];
  if (t === undefined) throw new AbiError(`"${tier}" is not one of the three tiers`);
  const gtPerLt = midAsGtPerLt(pair, mid);
  const stated = parseDecimal(mid.price);
  return {
    tier,
    sqrtPriceMin: sqrtPriceX18(pair, gtPerLt, t.lo),
    sqrtPriceMax: sqrtPriceX18(pair, gtPerLt, t.hi),
    /* The operator stated the price one way round; the edges are reported the
     * same way round. Inverting them here would hand back a "band" whose ends
     * read backwards, which is a correct number that misinforms. */
    loHuman: { num: stated.num * t.lo.num, den: stated.den * t.lo.den },
    hiHuman: { num: stated.num * t.hi.num, den: stated.den * t.hi.den },
  };
}

/** A rational as a decimal string with `places` digits, floored. For display. */
export function showRational(r: Rational, places = 6): string {
  const scale = 10n ** BigInt(places);
  const v = (r.num * scale) / r.den;
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/* ------------------------------------------------------------ the assembler */

const hex = (v: bigint, bytes: number): string => {
  if (v < 0n) throw new AbiError("negative argument");
  const s = v.toString(16).padStart(bytes * 2, "0");
  if (s.length > bytes * 2) throw new AbiError(`argument does not fit ${bytes} bytes`);
  return s;
};

/** One instruction, assembled. `argsLen` is derived, never asserted by hand. */
function instr(opcode: number, argsHex: string): string {
  if (argsHex.length % 2 !== 0) throw new AbiError("args are not whole bytes");
  const len = argsHex.length / 2;
  if (len > 255) throw new AbiError("args_len must fit one byte");
  return hex(BigInt(opcode), 1) + hex(BigInt(len), 1) + argsHex;
}

/**
 * The fee, as opcode 21 reads it: a `uint32` against a denominator of **1e9**,
 * where 1e9 is 100%. So 0.30% is 3_000_000.
 *
 * Deliberately not expressed in basis points anywhere. At base 1e9 a number
 * called "bps" is wrong by five orders of magnitude, and this is the exact
 * plausible-but-wrong quantity `program.ts` refuses to render as one.
 */
export const FEE_DENOMINATOR = 1_000_000_000;
export const feeFromPercent = (percent: string): number => {
  const r = parseDecimal(percent);
  const v = (r.num * BigInt(FEE_DENOMINATOR)) / (r.den * 100n);
  if (v <= 0n || v >= BigInt(FEE_DENOMINATOR)) {
    throw new AbiError("a fee must be above 0% and below 100%");
  }
  return Number(v);
};

export interface ProgramRequest {
  readonly pair: OrderedPair;
  readonly band: Band;
  /** Unix seconds. A position with no expiry is a standing offer forever. */
  readonly deadline: bigint;
  /** The gate token — opcode 14's argument. See STRATEGIES.md §5. */
  readonly gateToken: string;
  /** Raw uint32 against 1e9. Use `feeFromPercent`. */
  readonly fee: number;
  /** Exactly 8 bytes. Distinguishes two otherwise identical strategies. */
  readonly salt: Uint8Array;
}

const MAX_UINT40 = (1n << 40n) - 1n;

/** Assemble the six-instruction program of STRATEGIES.md §2. Hex, `0x`-prefixed. */
export function buildProgram(req: ProgramRequest): string {
  if (req.deadline <= 0n || req.deadline > MAX_UINT40) {
    throw new AbiError("the deadline must be a positive uint40 of unix seconds");
  }
  if (!HEX40.test(req.gateToken)) throw new AbiError("the gate token is not a 20-byte address");
  if (!Number.isInteger(req.fee) || req.fee <= 0 || req.fee >= FEE_DENOMINATOR) {
    throw new AbiError("the fee must be a positive uint32 below 1e9");
  }
  if (req.salt.length !== 8) throw new AbiError("the salt must be exactly 8 bytes");
  if (req.band.sqrtPriceMin >= req.band.sqrtPriceMax) {
    throw new AbiError("the band's lower bound is not below its upper bound");
  }

  const saltHex = [...req.salt].map((b) => b.toString(16).padStart(2, "0")).join("");

  return "0x" +
    instr(13, hex(req.deadline, 5)) +
    instr(14, req.gateToken.slice(2).toLowerCase()) +
    instr(18, hex(req.band.sqrtPriceMin, 32) + hex(req.band.sqrtPriceMax, 32)) +
    instr(21, hex(BigInt(req.fee), 4)) +
    instr(17, "") +
    instr(20, saltHex);
}

/* ----------------------------------------------------------- the Order blob */

/**
 * `MakerTraits`, built for a program that starts right after the two token
 * addresses (spec §4).
 *
 *   bit 254        USE_AQUA_INSTEAD_OF_SIGNATURE — the position is authorised
 *                  by having been shipped to Aqua, not by a separate signature
 *   bits 223..208  programStart, the byte offset of the program within `data`
 *   bits 159..0    receiver
 *
 * Every other bit is left zero, deliberately: bit 255 SHOULD_UNWRAP, bit 253
 * ALLOW_ZERO_AMOUNT_IN and the four hook slots are all behaviour this module
 * does not author and therefore does not set. A traits word with a bit set for
 * a feature nobody chose is the same class of defect as an inferred argument
 * layout.
 */
export const PROGRAM_START = 40;

export function buildTraits(receiver: string): bigint {
  if (!HEX40.test(receiver)) throw new AbiError("the receiver is not a 20-byte address");
  return (1n << 254n) |
    (BigInt(PROGRAM_START) << 208n) |
    BigInt(receiver.toLowerCase());
}

/**
 * `abi.encode(ISwapVM.Order{maker, traits, data})` with
 * `data = tokenLt || tokenGt || program`.
 *
 * Built on `encodeStrategy()` rather than beside it, because the `Order`
 * struct is the same `(address, uint256, bytes)` layout that function already
 * writes — so the bytes this produces are, by construction, the bytes
 * `readStrategyData()` walks. That is checked in both directions in the tests
 * rather than asserted here.
 */
export function buildOrderStrategy(
  maker: string, pair: OrderedPair, program: string, receiver?: string,
): string {
  if (!HEX40.test(maker)) throw new AbiError("the maker is not a 20-byte address");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(program)) {
    throw new AbiError("the program is not whole-byte hex");
  }
  const traits = buildTraits(receiver ?? maker);
  const data = "0x" +
    pair.tokenLt.address.slice(2) +
    pair.tokenGt.address.slice(2) +
    program.slice(2).toLowerCase();
  return encodeStrategy(maker, `0x${traits.toString(16).padStart(64, "0")}`, data);
}

/* ------------------------------------------------------------- one position */

export interface PositionRequest {
  readonly maker: string;
  readonly a: TokenSpec;
  readonly b: TokenSpec;
  readonly mid: MidPrice;
  readonly tier: RiskTier;
  readonly deadline: bigint;
  readonly gateToken: string;
  /** Percent as a decimal string, e.g. "0.30". */
  readonly feePercent: string;
  readonly salt: Uint8Array;
}

export interface Position {
  readonly pair: OrderedPair;
  readonly band: Band;
  readonly program: string;
  readonly strategy: string;
  /** The human read-back of §3.4, ready to print. Not decoration. */
  readonly bandText: string;
}

/**
 * Everything one shipped position needs, from the numbers a person can state.
 *
 * The caller never supplies a sqrt price, a token order, or a traits word:
 * each of those is derived here from something a human can check, which is the
 * whole point of the module.
 */
export function buildPosition(req: PositionRequest): Position {
  const pair = orderPair(req.a, req.b);
  const band = bandFor(pair, req.mid, req.tier);
  const program = buildProgram({
    pair, band,
    deadline: req.deadline,
    gateToken: req.gateToken,
    fee: feeFromPercent(req.feePercent),
    salt: req.salt,
  });
  return {
    pair, band, program,
    strategy: buildOrderStrategy(req.maker, pair, program),
    bandText:
      `${req.tier}: ${showRational(band.loHuman)} to ${showRational(band.hiHuman)} ` +
      `${req.mid.quote} per ${req.mid.base} (mid ${req.mid.price})`,
  };
}
