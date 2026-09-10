/**
 * Authoring tests.
 *
 * The load-bearing group is "round-trips through the decoder": every program
 * this module builds is walked back through `readProgram()` and compared field
 * for field. That is what enforces authoring.ts's one rule — **we only author
 * what we can decode** — and it is what would catch an opcode, an argument
 * width or an instruction order drifting apart from `program.ts`. Since the
 * firmware walker shares that table through the calldata vectors, drifting
 * from `program.ts` is the same thing as drifting from the device, which would
 * mean building a position this wallet then declines to sign.
 *
 * The second group is the two pricing traps of STRATEGIES.md §3.2. They are
 * tested numerically rather than structurally because both produce a plausible
 * number: a sqrt price wrong by 1e12 looks exactly like a sqrt price, and no
 * type or length check can tell them apart. Only arithmetic can.
 */

import {
  TIERS, MAX_SQRT_PRICE, PROGRAM_START, FEE_DENOMINATOR,
  parseDecimal, invert, isqrt, orderPair, midAsGtPerLt, sqrtPriceX18,
  bandFor, showRational, feeFromPercent, buildProgram, buildTraits,
  buildPosition, type TokenSpec, type RiskTier,
} from "../src/authoring.ts";
import { readProgram, readOrderProgram } from "../src/program.ts";
import { readStrategy, readStrategyData } from "../src/strategy.ts";
import { AQUA_SWAPVM_ROUTER } from "../src/registry.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const threw = (fn: () => unknown, pattern: RegExp): boolean => {
  try { fn(); return false; } catch (e) { return pattern.test(String(e)); }
};
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)) ===
  JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from((h.slice(2).match(/../g) ?? []), (b) => parseInt(b, 16));
const bytesToHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/* The three Base tokens of STRATEGIES.md §1 with the decimals they actually
 * have. Written out rather than imported from a token list, so a change over
 * there cannot silently move a price by a factor of a million over here. */
const WETH: TokenSpec = { address: "0x4200000000000000000000000000000000000006", decimals: 18 };
const USDC: TokenSpec = { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 };
const CBBTC: TokenSpec = { address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8 };

const MAKER = "0xbdeb381a7c77040bf2a99e2990c116774ccb339f";
const GATE = "0x00000000000000000000000000000000000000aa";
const SALT = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

const ethMid = { base: WETH.address, quote: USDC.address, price: "4000" };
const btcMid = { base: CBBTC.address, quote: USDC.address, price: "110000" };

const position = (tier: RiskTier, a = WETH, b = USDC, mid = ethMid) =>
  buildPosition({
    maker: MAKER, a, b, mid, tier,
    deadline: 1_800_000_000n, gateToken: GATE, feePercent: "0.30", salt: SALT,
  });

/* ------------------------------------------------------------- arithmetic */

group("decimals are parsed exactly, never through a float");
{
  check(same(parseDecimal("4000"), { num: 4000n, den: 1n }), "4000");
  check(same(parseDecimal("0.30"), { num: 30n, den: 100n }), "0.30");
  /* 0.1 has no exact binary float. Taking a string is what keeps these
   * digits the digits the contract is priced from. */
  check(same(parseDecimal("0.1"), { num: 1n, den: 10n }), "0.1");
  check(threw(() => parseDecimal("0"), /prices nothing/), "zero refused");
  check(threw(() => parseDecimal("4e3"), /not a decimal/), "exponent refused");
  check(threw(() => parseDecimal("-1"), /not a decimal/), "negative refused");
  check(same(invert({ num: 110000n, den: 1n }), { num: 1n, den: 110000n }), "invert");
}

group("integer square root is exact and floored");
{
  check(isqrt(0n) === 0n && isqrt(1n) === 1n, "0 and 1");
  check(isqrt(24n) === 4n && isqrt(25n) === 5n, "floor at the boundary");
  check(isqrt(10n ** 40n) === 10n ** 20n, "a big exact square");
  for (const n of [2n, 3n, 99n, 12345678901234567890n, (1n << 200n) + 7n]) {
    const r = isqrt(n);
    check(r * r <= n && (r + 1n) * (r + 1n) > n, `bracket at ${n}`);
  }
}

/* ---------------------------------------------------------- pair ordering */

group("a pair is ordered by address, not by the order the caller passed it");
{
  check(orderPair(USDC, WETH).tokenLt.address === WETH.address, "USDC,WETH");
  check(orderPair(WETH, USDC).tokenLt.address === WETH.address, "WETH,USDC");
  check(orderPair(CBBTC, USDC).tokenLt.address === USDC.address, "cbBTC,USDC");
  check(orderPair(USDC, CBBTC).tokenGt.address === CBBTC.address, "USDC,cbBTC");
  check(threw(() => orderPair(USDC, USDC), /two different/), "same token refused");
}

group("a mid price is normalised to gt-per-lt in either direction, exactly");
{
  const p = orderPair(WETH, USDC);
  /* WETH is tokenLt and USDC tokenGt, so "USDC per WETH" is already the
   * gt-per-lt direction and passes through unchanged. */
  check(same(midAsGtPerLt(p, ethMid), { num: 4000n, den: 1n }), "already gt-per-lt");
  /* Stated the other way round it must invert -- exactly, with no rounding. */
  check(
    same(midAsGtPerLt(p, { base: USDC.address, quote: WETH.address, price: "0.00025" }),
      { num: 100000n, den: 25n }),
    "inverted",
  );
  check(
    threw(() => midAsGtPerLt(p, btcMid), /does not name this pair/),
    "a mid naming another pair is refused",
  );
}

/* ------------------------------------------- sqrt price, and the two traps */

group("sqrt prices land on the order of magnitude STRATEGIES.md 3.3 predicts");
{
  const eth = orderPair(WETH, USDC);
  const btc = orderPair(USDC, CBBTC);
  const one = { num: 1n, den: 1n };

  /* P_raw = 4000 * 1e6 / 1e18 = 4e-9; sqrt = 6.3246e-5; x1e18 = 6.32e13. */
  const s = sqrtPriceX18(eth, midAsGtPerLt(eth, ethMid), one);
  check(s > 60_000_000_000_000n && s < 70_000_000_000_000n, `WETH/USDC sqrt = ${s}`);

  /* P_raw = (1/110000) * 1e8 / 1e6 = 9.09e-4; sqrt = 0.03015; x1e18 = 3.0e16. */
  const t = sqrtPriceX18(btc, midAsGtPerLt(btc, btcMid), one);
  check(t > 29_000_000_000_000_000n && t < 31_000_000_000_000_000n, `USDC/cbBTC sqrt = ${t}`);

  /* Squaring recovers the raw price: s^2 / 1e36 == 4e-9. Asserted as a tight
   * relative bracket rather than an equality, because `isqrt` floors and the
   * exact square is irrational -- an equality here would be a test that only
   * passes by luck of rounding. */
  check(s * s > 39_999n * 10n ** 23n && s * s < 40_001n * 10n ** 23n, `s^2 = ${s * s}`);
}

group("TRAP 1: a raw price is not a sqrt price, and the two are far apart");
{
  const eth = orderPair(WETH, USDC);
  const s = sqrtPriceX18(eth, midAsGtPerLt(eth, ethMid), { num: 1n, den: 1n });
  const rawX18 = (4n * 10n ** 18n) / 10n ** 9n;   /* P_raw * 1e18, the wrong number */
  /* Confusing them prices the square of the intended range and nothing
   * reverts. Pinning the ratio rather than "a big number" is the point: a
   * test that only asserted magnitude would pass on either value. Note how
   * SMALL the gap is -- about 1.6e4, not the 1e12 one might assume -- which
   * is exactly why MAX_SQRT_PRICE cannot catch this and a human read-back
   * has to. */
  check(s / rawX18 > 1_000n && s / rawX18 < 100_000n, `ratio ${s / rawX18}`);
}

group("TRAP 2: decimals are applied, and the pair's direction decides which way");
{
  const eth = orderPair(WETH, USDC);   /* 1e6 / 1e18 = 1e-12 */
  const btc = orderPair(USDC, CBBTC);  /* 1e8 / 1e6  = 1e+2  */
  const one = { num: 1n, den: 1n };
  const a = sqrtPriceX18(eth, one, one);
  const b = sqrtPriceX18(btc, one, one);
  /* Same numeric mid, opposite decimal skew. If decimals were ignored both
   * would be identical; they are seven orders of magnitude apart. */
  check(a !== b, "decimals change the answer");
  check(b / a > 10n ** 6n, `skew ratio ${b / a}`);
}

group("an implausible bound is refused, never clamped or rounded");
{
  const eth = orderPair(WETH, USDC);
  const one = { num: 1n, den: 1n };
  check(
    threw(() => sqrtPriceX18(eth, { num: 1n, den: 10n ** 60n }, one), /rounded to zero/),
    "all decimals lost",
  );
  check(
    threw(() => sqrtPriceX18(eth, { num: 10n ** 100n, den: 1n }, one), /too large/),
    "grossly oversized mid",
  );
  /* And the honest converse: the bound does NOT catch a unit mix-up. Using
   * the HUMAN mid (4000) as if it were the raw price is a real, silent error
   * and it sails straight through, ~1e6 too large and far under 2^160. The
   * comment on MAX_SQRT_PRICE says so; this pins that it stays true, so
   * nobody later mistakes the bound for the check that catches §3.2. */
  const wrong = sqrtPriceX18(
    { tokenLt: { ...WETH, decimals: 0 }, tokenGt: { ...USDC, decimals: 0 } },
    { num: 4000n, den: 1n }, one,
  );
  check(wrong < MAX_SQRT_PRICE, `a unit mix-up is NOT caught by the bound: ${wrong}`);
  check(MAX_SQRT_PRICE === 1n << 160n, "the sanity bound is pinned");
}

/* ----------------------------------------------------------- the three tiers */

group("the tiers are a closed set of three, each geometrically symmetric");
{
  check(Object.keys(TIERS).sort().join(",") === "high,low,medium", "exactly three");
  for (const [name, t] of Object.entries(TIERS)) {
    /* hi = 1/lo, so both bounds sit the same multiplicative distance from
     * the mid and sqrt(mid) sits in the middle of the two sqrt bounds. */
    check(t.hi.num * t.lo.num === t.hi.den * t.lo.den, `${name} symmetric`);
  }
}

group("low is the widest band and high the tightest");
{
  const eth = orderPair(WETH, USDC);
  const [low, med, high] = (["low", "medium", "high"] as const).map((t) => bandFor(eth, ethMid, t));
  check(low!.sqrtPriceMin < med!.sqrtPriceMin, "min: low below medium");
  check(med!.sqrtPriceMin < high!.sqrtPriceMin, "min: medium below high");
  check(low!.sqrtPriceMax > med!.sqrtPriceMax, "max: low above medium");
  check(med!.sqrtPriceMax > high!.sqrtPriceMax, "max: medium above high");
  for (const b of [low!, med!, high!]) {
    check(b.sqrtPriceMin < b.sqrtPriceMax, `${b.tier} ordered`);
  }
}

group("the human read-back is in the direction the operator stated the mid");
{
  const b = bandFor(orderPair(WETH, USDC), ethMid, "medium");
  /* 4000 x 0.7 = 2800 and 4000 x 10/7 = 5714.28..., in USDC per WETH. This
   * is the check of §3.4 that a person actually performs: a 1e12 error is
   * obvious here and invisible in the hex. */
  check(showRational(b.loHuman, 2) === "2800", `lo = ${showRational(b.loHuman, 2)}`);
  check(showRational(b.hiHuman, 2) === "5714.28", `hi = ${showRational(b.hiHuman, 2)}`);
}

group("no tier promises a return");
{
  for (const [name, t] of Object.entries(TIERS)) {
    check(!/yield|apr|apy|profit|guarantee/i.test(t.summary), `${name} makes no projection`);
  }
  /* The tight band must say the two things it is easiest to leave out. */
  check(/impermanent loss/.test(TIERS.high.summary), "high names impermanent loss");
  check(/earns nothing/.test(TIERS.high.summary), "high says out-of-range earns nothing");
}

/* --------------------------------------------------------------- the fee */

group("the fee is against 1e9, not against basis points");
{
  check(FEE_DENOMINATOR === 1_000_000_000, "denominator");
  check(feeFromPercent("0.30") === 3_000_000, `0.30% = ${feeFromPercent("0.30")}`);
  check(feeFromPercent("1") === 10_000_000, "1%");
  /* As bps, 0.30% would be 30. Five orders of magnitude away -- the exact
   * mistake the constant is named to prevent. */
  check(feeFromPercent("0.30") !== 30, "not bps");
  check(threw(() => feeFromPercent("100"), /fee/), "100% refused");
  check(threw(() => feeFromPercent("0"), /prices nothing|fee/), "0% refused");
}

/* ----------------------------------------------------------- the program */

group("the program is the 113 bytes of STRATEGIES.md 2, in that order");
{
  const p = position("medium");
  check((p.program.length - 2) / 2 === 113, `${(p.program.length - 2) / 2} bytes`);
  const r = readProgram(hexToBytes(p.program));
  check(r.ok, "decodes");
  if (r.ok) {
    check(r.instructions.map((i) => i.opcode).join(",") === "13,14,18,21,17,20", "opcode order");
  }
}

group("every tier round-trips through the decoder, field for field");
{
  for (const tier of ["low", "medium", "high"] as const) {
    const p = position(tier);
    const r = readProgram(hexToBytes(p.program));
    check(r.ok, `${tier} decodes`);
    if (!r.ok) continue;
    const f = r.instructions.map((i) => i.fields);
    check(same(f[0], { name: "deadline", deadline: 1_800_000_000n }), `${tier} deadline`);
    check(same(f[1], { name: "onlyTakerTokenBalanceNonZero", token: GATE }), `${tier} gate`);
    check(
      same(f[2], {
        name: "xycConcentrateGrowLiquidity2D",
        sqrtPriceMin: p.band.sqrtPriceMin, sqrtPriceMax: p.band.sqrtPriceMax,
      }),
      `${tier} band survives the round trip`,
    );
    check(same(f[3], { name: "flatFeeAmountInXD", fee: 3_000_000 }), `${tier} fee`);
    check(same(f[4], { name: "xycSwapXD" }), `${tier} xycSwap`);
    check(same(f[5], { name: "salt", salt: SALT }), `${tier} salt`);
  }
}

group("nothing outside the decoder's allowlist is ever authored");
{
  const allowed = new Set([13, 14, 15, 16, 17, 18, 19, 20, 21, 31, 33]);
  const r = readProgram(hexToBytes(position("low").program));
  check(r.ok, "decodes");
  if (r.ok) {
    for (const i of r.instructions) check(allowed.has(i.opcode), `opcode ${i.opcode} allowed`);
  }
}

group("a malformed request is refused rather than encoded");
{
  const pair = orderPair(WETH, USDC);
  const band = bandFor(pair, ethMid, "low");
  const base = { pair, band, deadline: 1_800_000_000n, gateToken: GATE, fee: 3_000_000, salt: SALT };
  check(threw(() => buildProgram({ ...base, deadline: 0n }), /deadline/), "zero deadline");
  check(threw(() => buildProgram({ ...base, deadline: 1n << 41n }), /deadline/), "deadline overflows uint40");
  check(threw(() => buildProgram({ ...base, gateToken: "0xdead" }), /gate token/), "bad gate");
  check(threw(() => buildProgram({ ...base, fee: 0 }), /fee/), "zero fee");
  check(threw(() => buildProgram({ ...base, fee: FEE_DENOMINATOR }), /fee/), "100% fee");
  check(threw(() => buildProgram({ ...base, salt: new Uint8Array(7) }), /8 bytes/), "short salt");
  check(
    threw(() => buildProgram({ ...base, band: { ...band, sqrtPriceMin: band.sqrtPriceMax } }),
      /not below/),
    "inverted band",
  );
}

/* ------------------------------------------------------- the Order blob */

group("traits set exactly the three fields they mean to, and no others");
{
  const t = buildTraits(MAKER);
  check(((t >> 254n) & 1n) === 1n, "USE_AQUA_INSTEAD_OF_SIGNATURE");
  check(((t >> 255n) & 1n) === 0n, "SHOULD_UNWRAP left clear");
  check(((t >> 253n) & 1n) === 0n, "ALLOW_ZERO_AMOUNT_IN left clear");
  check(((t >> 245n) & 0xffn) === 0n, "all four hook slots left clear");
  check(((t >> 208n) & 0xffffn) === BigInt(PROGRAM_START), "programStart = 40");
  check((t & ((1n << 160n) - 1n)) === BigInt(MAKER), "receiver");
}

group("the strategy names the maker, so strategy.ts refuses none of our own bytes");
{
  const r = readStrategy(position("high").strategy);
  check(r.ok && r.maker === MAKER, `got ${JSON.stringify(r)}`);
}

group("the two token addresses sit exactly where programStart says they end");
{
  const p = position("medium");
  const d = readStrategyData(p.strategy);
  check(d.ok, "readStrategyData");
  if (d.ok) {
    check(Number((d.value.traits >> 208n) & 0xffffn) === PROGRAM_START, "programStart");
    check(bytesToHex(d.value.data.subarray(0, 20)) === WETH.address.slice(2), "tokenLt");
    check(bytesToHex(d.value.data.subarray(20, 40)) === USDC.address.slice(2), "tokenGt");
    check(`0x${bytesToHex(d.value.data.subarray(PROGRAM_START))}` === p.program, "program slice");
  }
}

group("a shipped position decodes end to end through readOrderProgram");
{
  for (const tier of ["low", "medium", "high"] as const) {
    const r = readOrderProgram(position(tier).strategy, AQUA_SWAPVM_ROUTER);
    check(r.ok && r.instructions.length === 6, `${tier}: ${JSON.stringify(r.ok)}`);
  }
  /* The refusal boundary of spec §6.6 is unchanged by anything here. */
  const other = readOrderProgram(position("low").strategy, GATE);
  check(!other.ok && other.refusal.kind === "not-swapvm", "non-router app still not-swapvm");
}

/* ------------------------------------------------------- both positions */

group("P1 USDC/WETH and P2 USDC/cbBTC both build and both decode");
{
  const p1 = position("medium");
  const p2 = position("medium", USDC, CBBTC, btcMid);
  check(p1.pair.tokenLt.address === WETH.address, "P1 ordered WETH < USDC");
  check(p2.pair.tokenLt.address === USDC.address, "P2 ordered USDC < cbBTC");
  check(p2.pair.tokenGt.address === CBBTC.address, "P2 tokenGt is cbBTC");
  for (const p of [p1, p2]) {
    check(readOrderProgram(p.strategy, AQUA_SWAPVM_ROUTER).ok, "decodes");
  }
  check(p1.strategy !== p2.strategy, "different pairs, different registry slots");
}

group("each tier gets a distinct strategy, so the registry slots cannot collide");
{
  const all = (["low", "medium", "high"] as const).map((t) => position(t).strategy);
  check(new Set(all).size === 3, "three distinct strategies");
  /* And a different salt is enough on its own, which is what salt is for. */
  const a = buildPosition({
    maker: MAKER, a: WETH, b: USDC, mid: ethMid, tier: "low",
    deadline: 1_800_000_000n, gateToken: GATE, feePercent: "0.30",
    salt: Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]),
  });
  check(a.strategy !== all[0], "salt alone distinguishes two identical positions");
}

group("the band prints in terms a person can check by eye");
{
  check(/^medium: 2800 to 5714\./.test(position("medium").bandText), position("medium").bandText);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
if (failures > 0) process.exit(1);
