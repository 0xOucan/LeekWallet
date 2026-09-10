/**
 * Print one position's program, strategy and band, from numbers a person can
 * state — the step the RUNBOOK runs before anything is signed.
 *
 * It is deliberately a THIN wrapper over `src/authoring.ts`: this script must
 * never compute a price, an opcode or a byte of its own, or the thing the
 * tests check and the thing the operator ships would be two different
 * implementations. Everything printed here comes out of the same module the
 * device's decoder is tested against, and the program is walked back through
 * `readOrderProgram()` before it is printed. If that walk fails, nothing is
 * printed at all: a program this repo cannot decode is one the device will
 * refuse, and printing it would only produce a signature request that dies on
 * the hardware.
 *
 * The human read-back is the point of the output, not decoration. STRATEGIES.md
 * §3.4: a person reading "band: 2800 to 5714.28 USDC per WETH" catches a
 * decimals error instantly, and nobody catches it reading a uint256.
 *
 *   node --experimental-strip-types script/plan-position.mjs \
 *     --pair weth-usdc --tier medium --mid 4000 \
 *     --gate 0x... --maker 0x... --deadline-hours 2
 */

import { randomBytes } from "node:crypto";
import { buildPosition, feeFromPercent } from "../../src/authoring.ts";
import { readOrderProgram } from "../../src/program.ts";
import { encodeShip, strategyHash, AQUA_SWAPVM_ROUTER, AQUA_REGISTRY } from "../../src/registry.ts";

/* Base mainnet, 8453. Written out rather than imported from a token list: a
 * change over there must not silently move a price by a factor of a million.
 * Supplies measured 2026-09-10 -- cbBTC is the wrapped BTC on Base by a wide
 * margin (45,692 BTC against WBTC's 65 and tBTC's 46). */
const TOKENS = {
  weth:  { address: "0x4200000000000000000000000000000000000006", decimals: 18, symbol: "WETH" },
  usdc:  { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6,  symbol: "USDC" },
  cbbtc: { address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8,  symbol: "cbBTC" },
};

/** The two pairs of STRATEGIES.md §1. A closed set, not a free-form entry. */
const PAIRS = {
  "weth-usdc":  { a: "weth",  b: "usdc",  midBase: "weth",  midQuote: "usdc" },
  "usdc-cbbtc": { a: "usdc",  b: "cbbtc", midBase: "cbbtc", midQuote: "usdc" },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return process.argv[i + 1];
}

const pairName = arg("pair");
const pair = PAIRS[pairName];
if (pair === undefined) {
  throw new Error(`--pair must be one of: ${Object.keys(PAIRS).join(", ")}`);
}

const tier = arg("tier");
if (!["low", "medium", "high"].includes(tier)) {
  throw new Error("--tier must be low, medium or high");
}

const maker = arg("maker");
const gateToken = arg("gate");
const mid = arg("mid");
const feePercent = arg("fee", "0.30");
const hours = Number(arg("deadline-hours", "2"));
if (!Number.isFinite(hours) || hours <= 0) throw new Error("--deadline-hours must be positive");

/* The clock is read once, here, and the value is printed. A deadline the
 * operator cannot see is a deadline they cannot check against the wall. */
const now = BigInt(Math.floor(Date.now() / 1000));
const deadline = now + BigInt(Math.round(hours * 3600));

const salt = new Uint8Array(randomBytes(8));

const position = buildPosition({
  maker,
  a: TOKENS[pair.a],
  b: TOKENS[pair.b],
  mid: {
    base: TOKENS[pair.midBase].address,
    quote: TOKENS[pair.midQuote].address,
    price: mid,
  },
  tier,
  deadline,
  gateToken,
  feePercent,
  salt,
});

/* The gate. Nothing is printed unless the device's own rule accepts it. */
const reading = readOrderProgram(position.strategy, AQUA_SWAPVM_ROUTER);
if (!reading.ok) {
  console.error("REFUSED -- this program does not decode, so the device would");
  console.error("refuse to sign it. Nothing printed.");
  console.error(JSON.stringify(reading.refusal, null, 2));
  process.exit(1);
}

const sym = (a) =>
  Object.values(TOKENS).find((t) => t.address === a)?.symbol ?? a;

console.log(`pair            ${pairName}  (tokenLt ${sym(position.pair.tokenLt.address)}, ` +
  `tokenGt ${sym(position.pair.tokenGt.address)})`);
console.log(`tier            ${tier}`);
/* The addresses in bandText are replaced with symbols for the read-back only.
 * authoring.ts deliberately speaks in addresses -- UI-L3-SPEC §4: a symbol is
 * not a fact -- but this script's whole job is the human check, and the
 * substitution is from the closed table above, never from a contract. */
const bandText = Object.values(TOKENS)
  .reduce((t, tok) => t.replaceAll(tok.address, tok.symbol), position.bandText);
console.log(`band            ${bandText}`);
console.log(`                ^ CHECK THIS BY EYE. A decimals error is obvious here`);
console.log(`                  and invisible in the hex below.`);
console.log(`deadline        ${deadline}  (${new Date(Number(deadline) * 1000).toISOString()})`);
console.log(`gate token      ${gateToken}`);
console.log(`fee             ${feePercent}%  = ${feeFromPercent(feePercent)} against 1e9, NOT bps`);
console.log(`salt            0x${Buffer.from(salt).toString("hex")}`);
console.log("");
console.log("instructions, in program order (order is security-critical):");
for (const i of reading.instructions) {
  console.log(`  @${String(i.offset).padStart(3)}  op ${String(i.opcode).padStart(2)}  ${i.fields.name}`);
}
console.log("");
console.log(`program         ${position.program}`);
console.log(`strategy        ${position.strategy}`);
console.log(`strategyHash    ${strategyHash(position.strategy)}`);
console.log("");
console.log(`registry        ${AQUA_REGISTRY}`);
console.log(`app (router)    ${AQUA_SWAPVM_ROUTER}`);
console.log("");
console.log("ship calldata, one leg per --leg <token>:<rawAmount>:");
const legs = process.argv
  .flatMap((v, i) => (v === "--leg" ? [process.argv[i + 1]] : []))
  .filter(Boolean)
  .map((spec) => {
    const [token, amount] = spec.split(":");
    const t = TOKENS[token] ?? { address: token };
    return { token: t.address, amount: BigInt(amount) };
  });
if (legs.length === 0) {
  console.log("  (none given -- pass --leg usdc:1000000 --leg weth:200000000000000)");
} else {
  for (const l of legs) console.log(`  ${sym(l.token)}  ${l.amount} raw`);
  console.log("");
  console.log(encodeShip(AQUA_SWAPVM_ROUTER, position.strategy, legs));
}
