/**
 * ABI layer tests.
 *
 * The properties worth a file:
 *
 * 1. Selectors match the ones a Solidity compiler would produce. Checked
 *    against four values computed independently (from the compiled artifacts
 *    of @hashgraph/asset-tokenization-contracts 8.0.0), because everything
 *    else here is only correct if the calls go to the right functions.
 * 2. The role table is well-formed and has no duplicates — a duplicated or
 *    truncated role id reads as a role with no members, which is what an
 *    unheld role also looks like.
 * 3. Decoders refuse hostile data rather than reading as far as it parses.
 * 4. A bool that is neither 0 nor 1 is refused, not coerced. "Nonzero is true"
 *    would let a crafted word mark a stranger as KYC'd.
 */

import {
  decodeAddressArray, decodeBool, decodeHolderBalanceArray, decodeString,
  decodeUint, decodeUint8, encode, sanitiseText, SELECTOR, selectorOf, word,
} from "../src/abi.ts";
import { ROLES, roleInfo, roleLabel } from "../src/roles.ts";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string): void => console.log(`== ${n}`);
const threw = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

group("selectors match the compiled contracts");
{
  /* Cross-checked against the 4byte-known values for the ERC-20 surface, which
   * are the ones an independent source can confirm. If these four are right
   * the keccak path is right, and the ATS-specific signatures were copied from
   * the artifacts rather than guessed. */
  check(SELECTOR.balanceOf === "70a08231", `balanceOf: ${SELECTOR.balanceOf}`);
  check(SELECTOR.totalSupply === "18160ddd", `totalSupply: ${SELECTOR.totalSupply}`);
  check(SELECTOR.decimals === "313ce567", `decimals: ${SELECTOR.decimals}`);
  check(SELECTOR.symbol === "95d89b41", `symbol: ${SELECTOR.symbol}`);
  // paused() is the OpenZeppelin standard and equally well known.
  check(SELECTOR.paused === "5c975abb", `paused: ${SELECTOR.paused}`);
  check(selectorOf("hasRole(bytes32,address)") === "91d14854", "hasRole selector");

  // Distinctness. Two signatures colliding would silently call one function
  // for the other, and there are 24 of them.
  const seen = new Set(Object.values(SELECTOR));
  check(seen.size === Object.keys(SELECTOR).length, "two signatures share a selector");
}

group("calldata is selector plus static words");
{
  check(encode("totalSupply") === "0x18160ddd", "no-arg call is bare selector");
  check(
    encode("balanceOf", [`${"0".repeat(24)}d8da6bf26964af9d7eed9e03e53415d37aa96045`]) ===
      "0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
    "one-address call",
  );
  check(word(0n).length === 64, "a word is 32 bytes");
  check(threw(() => word(-1n)), "a negative uint256 is refused");
  check(threw(() => word(1n << 256n)), "an oversized uint256 is refused");
}

group("the role table is usable as a key");
{
  check(ROLES.length === 37, `expected 37 roles, got ${ROLES.length}`);
  const ids = new Set(ROLES.map((r) => r.id));
  check(ids.size === ROLES.length, "two roles share an id");
  const names = new Set(ROLES.map((r) => r.name));
  check(names.size === ROLES.length, "two roles share a name");
  for (const r of ROLES) {
    check(/^0x[0-9a-f]{64}$/.test(r.id), `role ${r.name} is not a full bytes32: ${r.id}`);
  }
  check(roleInfo("0x" + "0".repeat(64))?.name === "DefaultAdmin", "admin role resolves");
  // An unknown id must NOT get a name. A confident wrong label is worse than
  // hex — same rule as an unrecognised chain in chains.ts.
  const unknown = `0x${"ab".repeat(32)}`;
  check(roleInfo(unknown) === undefined, "an unknown role id was given a name");
  check(roleLabel(unknown).includes("…"), "an unknown role should render as hex");
  check(ROLES.some((r) => r.privileged), "no role is marked privileged");
}

group("uint and bool decoding refuses what it cannot trust");
{
  check(decodeUint(`0x${word(42n)}`) === 42n, "a uint round-trips");
  check(threw(() => decodeUint("0x")), "an empty return is not a uint");
  check(threw(() => decodeUint(`0x${word(1n)}${word(1n)}`)), "two words are not a uint");
  check(threw(() => decodeUint("0xzz")), "non-hex is refused");

  check(decodeBool(`0x${word(1n)}`) === true, "1 is true");
  check(decodeBool(`0x${word(0n)}`) === false, "0 is false");
  check(threw(() => decodeBool(`0x${word(2n)}`)), "2 must not decode as a bool");
  check(threw(() => decodeBool(`0x${word((1n << 255n))}`)), "a high bit must not read as true");

  check(decodeUint8(`0x${word(255n)}`) === 255, "a uint8 at its maximum");
  check(threw(() => decodeUint8(`0x${word(256n)}`)), "a uint8 is range-checked, not truncated");
}

group("address arrays are refused rather than half-read");
{
  const a = "d8da6bf26964af9d7eed9e03e53415d37aa96045";
  const b = "ca11bde05977b3631167028862be2a173976ca11";
  const good = `0x${word(32n)}${word(2n)}${"0".repeat(24)}${a}${"0".repeat(24)}${b}`;
  const out = decodeAddressArray(good);
  check(out.length === 2 && out[0] === `0x${a}` && out[1] === `0x${b}`, "two addresses round-trip");

  check(decodeAddressArray(`0x${word(32n)}${word(0n)}`).length === 0, "an empty array is empty");

  // Truncation: the length says two, the data holds one.
  check(
    threw(() => decodeAddressArray(`0x${word(32n)}${word(2n)}${"0".repeat(24)}${a}`)),
    "a truncated array must be refused, not half-read",
  );
  // Dirty high bytes: not an address the EVM would have produced.
  check(
    threw(() => decodeAddressArray(`0x${word(32n)}${word(1n)}${"f".repeat(24)}${a}`)),
    "an address word with dirty high bytes must be refused",
  );
  // An absurd offset must not become a subarray that quietly returns nothing.
  check(threw(() => decodeAddressArray(`0x${word(1n << 200n)}${word(1n)}`)),
        "an out-of-range offset must be refused");
}

group("holder/balance rows are refused rather than misattributed");
{
  const a = "d8da6bf26964af9d7eed9e03e53415d37aa96045";
  const b = "ca11bde05977b3631167028862be2a173976ca11";
  const good = `0x${word(32n)}${word(2n)}` +
    `${"0".repeat(24)}${a}${word(5n)}${"0".repeat(24)}${b}${word(7n)}`;
  const rows = decodeHolderBalanceArray(good);
  check(rows.length === 2, "two rows decode");
  check(rows[0]?.address === `0x${a}` && rows[0]?.raw === 5n, "first row pairs correctly");
  check(rows[1]?.address === `0x${b}` && rows[1]?.raw === 7n, "second row pairs correctly");
  // One row short. Reading it as far as it parses would leave the caller
  // believing a two-holder snapshot had one holder.
  check(
    threw(() => decodeHolderBalanceArray(`0x${word(32n)}${word(2n)}${"0".repeat(24)}${a}${word(5n)}`)),
    "a missing row must fail the whole array",
  );
}

group("contract-supplied text cannot repaint the line it sits on");
{
  const enc = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let body = "";
    for (const x of bytes) body += x.toString(16).padStart(2, "0");
    return `0x${word(32n)}${word(BigInt(bytes.length))}` +
      body.padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  };
  check(decodeString(enc("ACME Equity")) === "ACME Equity", "a plain name round-trips");
  check(decodeString(enc("")) === undefined, "an empty name is undefined, not \"\"");
  check(decodeString(enc("A‮B")) === "AB", "a bidi override is stripped");
  check(decodeString(enc("A\nB")) === "AB", "a newline is stripped");
  check(decodeString("0x") === undefined, "no data is undefined");
  check((decodeString(enc("x".repeat(200)), 16) ?? "").length === 17, "long text is capped and marked");
  check(sanitiseText("   ", 8) === undefined, "whitespace only is undefined");
}

console.log(failures === 0 ? "PASSED (0 failures)" : `FAILED (${failures})`);
if (failures > 0) process.exit(1);
