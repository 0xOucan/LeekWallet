/**
 * SwapVM program decoding tests — B3.
 *
 * The milestone's whole claim is refusal, so every refusal kind in
 * docs/AQUA-B3-SPEC.md §6.5 gets its own case, and three of them are named in
 * the milestone's own "done means": an unknown opcode, a wrong `args_len`,
 * and a truncated tail. The happy-path decode exists only as the baseline
 * those refusals are a departure from — see deploy.test.ts's header for the
 * same argument about `wrong-maker`.
 */

import {
  AQUA_MAX_INSTRUCTIONS, readOrderProgram, readProgram, type Instruction,
} from "../src/program.ts";
import { encodeStrategy, readStrategyData } from "../src/strategy.ts";
import { AQUA_SWAPVM_ROUTER } from "../src/registry.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

/* ------------------------------------------------------------------ bytes */

const hex = (parts: string[]): Uint8Array =>
  Uint8Array.from((parts.join("").match(/../g) ?? []).map((b) => parseInt(b, 16)));

const byte = (n: number): string => n.toString(16).padStart(2, "0");
/** A big-endian value, `width` bytes wide, as hex. */
const be = (v: bigint | number, width: number): string =>
  (typeof v === "bigint" ? v : BigInt(v)).toString(16).padStart(width * 2, "0");

/** One instruction: opcode, args_len (defaults to the args' own length), args. */
const inst = (opcode: number, args: string, argsLen?: number): string =>
  byte(opcode) + byte(argsLen ?? args.length / 2) + args;

const TOKEN_A = "1111111111111111111111111111111111111111";
const TOKEN_B = "2222222222222222222222222222222222222222";

/* ---------------------------------------------------------------- readProgram */

group("empty program is refused");
{
  const r = readProgram(new Uint8Array(0));
  check(!r.ok && r.refusal.kind === "empty", `got ${JSON.stringify(r)}`);
}

group("unknown opcode is refused, carrying the byte");
{
  /* 0x99 is not in the table, not control flow, not reserved by name here —
   * just a byte the Aqua router would itself revert UnknownOpcode(0x99) on. */
  const program = hex([inst(0x99, "", 0)]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "unknown-opcode" && r.refusal.opcode === 0x99,
    `got ${JSON.stringify(r)}`);
  check(!r.ok && r.refusal.kind === "unknown-opcode" && r.refusal.offset === 0,
    "offset should point at the opcode byte");
}

group("wrong args_len is refused, never rounded or truncated");
{
  /* deadline is uint40 -- five bytes. Six is refused even though it differs
   * by only one byte and even though the VM's own loop would have no trouble
   * skipping it. */
  const program = hex([inst(13, be(0, 6))]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "bad-args-length"
    && r.refusal.expected === 5 && r.refusal.actual === 6,
    `got ${JSON.stringify(r)}`);
}

group("args_len less than the fixed width is refused the same way");
{
  const program = hex([inst(13, be(0, 4))]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "bad-args-length" && r.refusal.actual === 4,
    `got ${JSON.stringify(r)}`);
}

group("a truncated tail is refused, never zero-padded");
{
  /* args_len claims 20 bytes (a valid onlyTakerTokenBalanceNonZero encoding)
   * but only 10 remain. The VM itself reverts RunLoopExceedProgramLength for
   * exactly this program; we refuse rather than treat the missing bytes as
   * zero. */
  const program = hex([byte(14), byte(20), "00".repeat(10)]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "truncated" && r.refusal.offset === 0,
    `got ${JSON.stringify(r)}`);
}

group("a program that ends mid-header is truncated");
{
  /* A single trailing byte: not enough for opcode + args_len. */
  const program = hex(["11"]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "truncated", `got ${JSON.stringify(r)}`);
}

group("jump is refused as control flow, not as unknown");
{
  const program = hex([inst(10, "0000")]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "has-control-flow" && r.refusal.opcode === 10
    && r.refusal.name === "jump", `got ${JSON.stringify(r)}`);
}

group("extruction is refused as control flow");
{
  const program = hex([inst(32, "aabbccdd")]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "has-control-flow" && r.refusal.opcode === 32
    && r.refusal.name === "extruction", `got ${JSON.stringify(r)}`);
}

group("jumpIfTokenIn and jumpIfTokenOut are refused as control flow");
{
  for (const op of [11, 12]) {
    const r = readProgram(hex([inst(op, "00")]));
    check(!r.ok && r.refusal.kind === "has-control-flow" && r.refusal.opcode === op,
      `opcode 0x${op.toString(16)} got ${JSON.stringify(r)}`);
  }
}

group("control flow inside an otherwise-valid program still refuses the whole thing");
{
  /* Not "3 of 4 instructions" — a jump after two good instructions refuses
   * the program, no partial list. */
  const program = hex([inst(17, "", 0), inst(10, "0000"), inst(19, be(300, 2))]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "has-control-flow" && r.refusal.offset === 2,
    `got ${JSON.stringify(r)}`);
}

group("the four protocol-fee opcodes (27-30) are excluded this pass and refuse as unknown");
{
  /* Real opcodes the router dispatches, deliberately not in our table: v1
   * sets them to zero, and their args are conditional on per-receiver flag
   * bits this pass does not decode (spec §6.4). They must refuse exactly like
   * a byte the router has never heard of — our table, not the router's, is
   * what decides "understood". */
  for (const op of [27, 28, 29, 30]) {
    const r = readProgram(hex([inst(op, "00".repeat(20))]));
    check(!r.ok && r.refusal.kind === "unknown-opcode" && r.refusal.opcode === op,
      `opcode ${op}: got ${JSON.stringify(r)}`);
  }
}

group("the enum numbering this table used to ship is now refused wholesale");
{
  /* The regression that mattered: `XYCSwap = 0x50`, `Decay = 0x9c` and the
   * rest are a different router version's numbering, and shipping them made
   * this decoder refuse every real Aqua strategy. They are unknown bytes now
   * — a program using them is not a program the deployed router runs. */
  for (const op of [0x02, 0x20, 0x23, 0x26, 0x50, 0x51, 0x58, 0x70, 0x9c]) {
    const r = readProgram(hex([inst(op, "", 0)]));
    check(!r.ok && (r.refusal.kind === "unknown-opcode"
      || (r.refusal.kind === "has-control-flow" && op === 0x20)),
      `old enum opcode 0x${op.toString(16)}: got ${JSON.stringify(r)}`);
  }
}

group("more instructions than AQUA_MAX_INSTRUCTIONS is refused as too-long");
{
  const parts = Array.from({ length: AQUA_MAX_INSTRUCTIONS + 1 }, () => inst(17, "", 0));
  const r = readProgram(hex(parts));
  check(!r.ok && r.refusal.kind === "too-long", `got ${JSON.stringify(r)}`);
}

group("exactly AQUA_MAX_INSTRUCTIONS instructions is accepted");
{
  const parts = Array.from({ length: AQUA_MAX_INSTRUCTIONS }, () => inst(17, "", 0));
  const r = readProgram(hex(parts));
  check(r.ok && r.instructions.length === AQUA_MAX_INSTRUCTIONS, `got ${JSON.stringify(r)}`);
}

group("every one of the eleven supported opcodes decodes, with byte-exact fields");
{
  const program = hex([
    inst(13, be(1_700_000_000, 5)),                 // deadline: uint40
    inst(14, TOKEN_A),                              // onlyTakerTokenBalanceNonZero
    inst(15, TOKEN_A + be(7, 32)),                  // onlyTakerTokenBalanceGte
    inst(16, TOKEN_B + be(9, 8)),                   // onlyTakerTokenSupplyShareGte
    inst(17, "", 0),                                // xycSwapXD: no args
    inst(18, be(1n << 96n, 32) + be(2n << 96n, 32)), // xycConcentrateGrowLiquidity2D
    inst(19, be(300, 2)),                           // decayXD: uint16
    inst(20, "01"),                                 // salt: opaque, any length
    inst(21, be(3_000_000, 4)),                     // flatFeeAmountInXD: uint32
    inst(31, be(1, 32) + be(2, 32) + be(3, 32) + be(4, 32) + be(5, 32)), // peggedSwapGrowPriceRange2D
    inst(33, TOKEN_B),                              // onlyTxOriginTokenBalanceNonZero
  ]);

  const r = readProgram(program);
  if (!r.ok) {
    check(false, `expected all eleven to decode, got refusal ${JSON.stringify(r)}`);
  } else {
    const names = r.instructions.map((i) => i.fields.name);
    check(names.join(",") ===
      "deadline,onlyTakerTokenBalanceNonZero,onlyTakerTokenBalanceGte," +
      "onlyTakerTokenSupplyShareGte,xycSwapXD,xycConcentrateGrowLiquidity2D," +
      "decayXD,salt,flatFeeAmountInXD,peggedSwapGrowPriceRange2D," +
      "onlyTxOriginTokenBalanceNonZero",
      `order/names: ${names.join(",")}`);

    const byName = <T extends Instruction["fields"]["name"]>(name: T) =>
      r.instructions.find((i) => i.fields.name === name)?.fields as
        Extract<Instruction["fields"], { name: T }>;

    check(byName("deadline").deadline === 1_700_000_000n, "deadline value");
    check(byName("onlyTakerTokenBalanceNonZero").token === `0x${TOKEN_A}`, "taker token");
    check(byName("onlyTxOriginTokenBalanceNonZero").token === `0x${TOKEN_B}`, "tx.origin token");
    check(byName("onlyTakerTokenBalanceGte").token === `0x${TOKEN_A}`, "Gte token");
    /* No threshold assertion for 15/16: the split between the address and the
     * value is inferred, not observed, so the decoder deliberately does not
     * produce it. Asserting a value we chose not to decode would re-introduce
     * the claim through the test. */
    check(byName("onlyTakerTokenSupplyShareGte").token === `0x${TOKEN_B}`, "share token");

    check(byName("xycConcentrateGrowLiquidity2D").sqrtPriceMin === 1n << 96n, "sqrtPriceMin");
    check(byName("xycConcentrateGrowLiquidity2D").sqrtPriceMax === 2n << 96n, "sqrtPriceMax");
    const pegged = byName("peggedSwapGrowPriceRange2D");
    check(pegged.x0 === 1n && pegged.y0 === 2n && pegged.linearWidth === 3n
      && pegged.rateA === 4n && pegged.rateB === 5n,
      `pegged fields: ${pegged.x0},${pegged.y0},${pegged.linearWidth},${pegged.rateA},${pegged.rateB}`);
    /* 1e9 is 100%, so 3_000_000 is 0.30% — not 3_000_000 bps, and not 30. */
    check(byName("flatFeeAmountInXD").fee === 3_000_000, "flatFeeAmountInXD value");
    check(byName("flatFeeAmountInXD").fee / 1e7 === 0.3, "flatFeeAmountInXD as a percentage");
    check(byName("decayXD").period === 300, "decayXD value");
  }
}

group("flatFeeAmountInXD is four bytes, not three");
{
  /* The width that was wrong in the shipped table. Three bytes is refused,
   * and it is refused as a length error rather than silently read short. */
  const r = readProgram(hex([inst(21, be(3_000_000, 3))]));
  check(!r.ok && r.refusal.kind === "bad-args-length"
    && r.refusal.expected === 4 && r.refusal.actual === 3, `got ${JSON.stringify(r)}`);
}

group("the two real Base mainnet programs decode");
{
  /* The acceptance test for this table: both are maker strategies actually
   * shipped to the Aqua router on Base (8453), their programs taken verbatim
   * from their `Shipped` events. Under the old enum numbering both refused. */
  const real = [
    "124000000000000000000000000000000000000000000000000000002a9b524df9f5"
    + "00000000000000000000000000000000000000000000000000002f1a7f64ee31"
    + "1504000f42401100140800065b2214efcaf8",
    "12400000000000000000000000000000000000000000000000000000effc6a26fc02"
    + "00000000000000000000000000000000000000000000000000010950830fe641"
    + "1504000f42401100140800065b2214efcaf9",
  ];
  for (const [n, hexProgram] of real.entries()) {
    const r = readProgram(hex([hexProgram]));
    if (!r.ok) { check(false, `real program ${n}: ${JSON.stringify(r)}`); continue; }
    const shape = r.instructions.map((i) => `${i.opcode}/${i.args.length}`).join(" ");
    check(shape === "18/64 21/4 17/0 20/8", `real program ${n} shape: ${shape}`);
    const fee = r.instructions.find((i) => i.fields.name === "flatFeeAmountInXD")?.fields;
    check(fee?.name === "flatFeeAmountInXD" && fee.fee === 1_000_000,
      `real program ${n} fee: ${JSON.stringify(fee)}`);
  }
}

group("1inch's documented dApp program decodes");
{
  /* `0x21 0x14 <20-byte KycNFT> 0x11 0x00` — opcode 33 then opcode 17. */
  const r = readProgram(hex([inst(33, TOKEN_A), inst(17, "", 0)]));
  check(r.ok && r.instructions.length === 2, `got ${JSON.stringify(r)}`);
  if (r.ok) {
    check(r.instructions[0]?.fields.name === "onlyTxOriginTokenBalanceNonZero", "instruction 0");
    check(r.instructions[1]?.fields.name === "xycSwapXD", "instruction 1");
  }
}

group("salt accepts any args_len -- it is opaque, never interpreted");
{
  for (const argsHex of ["", "aa", "aabbccddeeff00112233"]) {
    const r = readProgram(hex([inst(20, argsHex)]));
    check(r.ok, `salt with ${argsHex.length / 2} byte(s) should decode: ${JSON.stringify(r)}`);
  }
}

group("the stream must consume the program's bytes exactly");
{
  /* One valid instruction, then one stray byte that is not a full header. */
  const program = hex([inst(17, "", 0), "01"]);
  const r = readProgram(program);
  check(!r.ok && r.refusal.kind === "truncated", `got ${JSON.stringify(r)}`);
}

/* ---------------------------------------------------- the refusal boundary */

const MAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OTHER_APP = "0x228e82831afac5dd9ebde3489e9e18ae9c7bcbf4";

/** `traits` with only the program-start slice index (bits 208-223) set. */
const traitsFor = (programStart: number): string => `0x${be(BigInt(programStart) << 208n, 32)}`;

group("a strategy shipped to a non-SwapVM app is not-swapvm, not a program refusal");
{
  const data = `0x${TOKEN_A}${TOKEN_B}${inst(17, "", 0)}`;
  const strategy = encodeStrategy(MAKER, traitsFor(40), data);
  const r = readOrderProgram(strategy, OTHER_APP);
  check(!r.ok && r.refusal.kind === "not-swapvm", `got ${JSON.stringify(r)}`);
}

group("readOrderProgram decodes a real SwapVM-shaped strategy end to end");
{
  const program = inst(17, "", 0) + inst(19, be(300, 2));
  const data = `${TOKEN_A}${TOKEN_B}${program}`;
  const strategy = encodeStrategy(MAKER, traitsFor(40), `0x${data}`);

  const r = readOrderProgram(strategy, AQUA_SWAPVM_ROUTER);
  check(r.ok && r.instructions.length === 2, `got ${JSON.stringify(r)}`);
  if (r.ok) {
    check(r.instructions[0]?.fields.name === "xycSwapXD", "instruction 0");
    check(r.instructions[1]?.fields.name === "decayXD", "instruction 1");
  }
}

group("readOrderProgram's app check is case-insensitive");
{
  const data = `0x${TOKEN_A}${TOKEN_B}${inst(17, "", 0)}`;
  const strategy = encodeStrategy(MAKER, traitsFor(40), data);
  const r = readOrderProgram(strategy, AQUA_SWAPVM_ROUTER.toUpperCase().replace("0X", "0x"));
  check(r.ok, `got ${JSON.stringify(r)}`);
}

group("readOrderProgram still refuses a wrong-maker-shaped strategy the way readStrategy does");
{
  /* Not a program failure at all -- readStrategyData calls readStrategy()
   * first and its refusal (here: too short to hold a head and an address)
   * passes straight through, proving B3 did not relax that check. */
  const r = readOrderProgram("0x00", AQUA_SWAPVM_ROUTER);
  check(!r.ok && r.refusal.kind === "malformed", `got ${JSON.stringify(r)}`);
}

group("readOrderProgram refuses when programStart runs past the strategy's data");
{
  const data = `0x${TOKEN_A}${TOKEN_B}`; // 40 bytes total
  const strategy = encodeStrategy(MAKER, traitsFor(9999), data);
  const r = readOrderProgram(strategy, AQUA_SWAPVM_ROUTER);
  check(!r.ok && r.refusal.kind === "malformed", `got ${JSON.stringify(r)}`);
}

group("readOrderProgram refuses control flow the same as readProgram");
{
  const data = `${TOKEN_A}${TOKEN_B}${inst(10, "0000")}`;
  const strategy = encodeStrategy(MAKER, traitsFor(40), `0x${data}`);
  const r = readOrderProgram(strategy, AQUA_SWAPVM_ROUTER);
  check(!r.ok && r.refusal.kind === "has-control-flow", `got ${JSON.stringify(r)}`);
}

/* -------------------------------------------------------- readStrategyData */

group("readStrategyData reads traits and slices data the way encodeStrategy wrote them");
{
  const data = `${TOKEN_A}${TOKEN_B}`;
  const strategy = encodeStrategy(MAKER, traitsFor(40), `0x${data}`);
  const r = readStrategyData(strategy);
  check(r.ok && r.value.traits === (40n << 208n), `traits: ${r.ok ? r.value.traits : ""}`);
  check(r.ok && r.value.data.length === 40, "data length");
  check(r.ok && r.value.maker.toLowerCase() === MAKER.toLowerCase(), "maker survives");
}

group("readStrategyData refuses a strategy too short to hold traits and data");
{
  /* Passes readStrategy() (head + maker) but has nothing past it. */
  const strategy = `0x${"00".repeat(31)}20${"00".repeat(31)}${MAKER.slice(2).toLowerCase()}`;
  const r = readStrategyData(strategy);
  check(!r.ok && r.refusal.kind === "malformed", `got ${JSON.stringify(r)}`);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
if (failures > 0) process.exit(1);
