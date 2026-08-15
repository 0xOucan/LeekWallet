/**
 * Multicall3 batching tests.
 *
 * The one property worth the whole file: a token that failed to answer and a
 * token holding zero must never come out of here looking the same. Everything
 * else — the calldata layout, the bounds checks, the chunking — exists to keep
 * that distinction true when the data is hostile rather than merely unusual.
 *
 * So, in order:
 *
 * 1. `aggregate3` calldata is byte-exact against a hand-laid-out expectation.
 *    Wrong-but-well-formed calldata decodes to *different calls*, not an error.
 * 2. A round trip: encode a batch, answer it, get the same balances back in the
 *    same order as a run of single `balanceOf` calls would have produced.
 * 3. success:false stays distinguishable from a zero word, at every level.
 * 4. Truncated, over-long and absurd-offset returns are refused rather than
 *    read as far as they parse — a partially decoded array misattributes every
 *    balance after the damage.
 * 5. Chunking splits at the boundary and rejoins in the original order, and one
 *    dead chunk does not erase the others.
 */

import { decodeUint256Return, type EthRequest } from "../src/balances.ts";
import {
  chunk, decodeAggregate3Return, encodeAggregate3, encodeBalanceOfBatch,
  fetchTokenBalancesBatched, MULTICALL3_ADDRESS, MULTICALL3_OVERRIDES, MULTICALL_CHUNK_SIZE,
  multicall3Address, SELECTOR_AGGREGATE3, type Aggregate3Result,
} from "../src/multicall.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const threw = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const w = (n: bigint): string => n.toString(16).padStart(64, "0");
const addrWord = (a: string): string => "0".repeat(24) + a.slice(2).toLowerCase();
const uint = (n: bigint): string => "0x" + w(n);

/** Encode a `(bool,bytes)[]` the way a well-behaved Multicall3 would. */
function encodeResults(results: readonly Aggregate3Result[]): string {
  const bodies = results.map((r) => {
    const body = r.returnData.slice(2);
    const len = body.length / 2;
    return w(r.success ? 1n : 0n) + w(0x40n) + w(BigInt(len)) +
      body.padEnd(Math.ceil(len / 32) * 64, "0");
  });
  let cursor = BigInt(bodies.length) * 32n;
  let offsets = "";
  for (const body of bodies) { offsets += w(cursor); cursor += BigInt(body.length / 2); }
  return "0x" + w(0x20n) + w(BigInt(bodies.length)) + offsets + bodies.join("");
}

group("the multicall address is one constant, with room for an exception");
{
  check(MULTICALL3_ADDRESS === "0xcA11bde05977b3631167028862bE2a173976CA11", "canonical address changed");
  check(multicall3Address(1) === MULTICALL3_ADDRESS, "mainnet does not use the canonical address");
  check(multicall3Address(8453) === MULTICALL3_ADDRESS, "an unlisted chain invented an address");
  check(typeof MULTICALL3_OVERRIDES === "object", "the override map is not a map");
  for (const [id, address] of Object.entries(MULTICALL3_OVERRIDES)) {
    check(/^0x[0-9a-fA-F]{40}$/.test(address), `override for ${id} is not an address`);
  }
}

group("aggregate3 calldata is byte-exact");
{
  const data = encodeAggregate3([
    { target: USDC, allowFailure: true, callData: "0x70a08231" + addrWord(VITALIK) },
  ]);
  // One head word (offset 0x20), length 1, one element offset (0x20 — one
  // offset word precedes the element), then the element: target, allowFailure,
  // bytes offset 0x60, bytes length 36, 36 bytes padded to 64.
  const inner = "70a08231" + addrWord(VITALIK);
  const expected = "0x" + SELECTOR_AGGREGATE3 + w(0x20n) + w(1n) + w(0x20n) +
    addrWord(USDC) + w(1n) + w(0x60n) + w(36n) + inner.padEnd(128, "0");
  check(data === expected, `single-call calldata:\n    ${data}\n    ${expected}`);
  check(data.startsWith("0x82ad56cb"), "aggregate3 selector is wrong");

  // Two calls: the second element offset must account for the first element's
  // whole length (4 words: target, flag, bytes offset, bytes length + 2 data
  // words) — the arithmetic that silently produces valid-looking nonsense.
  const two = encodeAggregate3([
    { target: USDC, allowFailure: true, callData: "0x70a08231" + addrWord(VITALIK) },
    { target: DAI, allowFailure: false, callData: "0x" },
  ]);
  const firstBody = addrWord(USDC) + w(1n) + w(0x60n) + w(36n) + inner.padEnd(128, "0");
  const secondBody = addrWord(DAI) + w(0n) + w(0x60n) + w(0n);
  const twoExpected = "0x" + SELECTOR_AGGREGATE3 + w(0x20n) + w(2n) +
    w(0x40n) + w(0x40n + BigInt(firstBody.length / 2)) + firstBody + secondBody;
  check(two === twoExpected, `two-call calldata:\n    ${two}\n    ${twoExpected}`);
  check(two.includes(w(0n) + w(0x60n) + w(0n)), "allowFailure:false was not encoded as 0");

  // An empty batch is still valid calldata, not a crash.
  check(encodeAggregate3([]) === "0x" + SELECTOR_AGGREGATE3 + w(0x20n) + w(0n), "empty batch");

  check(threw(() => encodeAggregate3([{ target: "0x12", allowFailure: true, callData: "0x" }])),
    "a malformed target was encoded");
  check(threw(() => encodeAggregate3([{ target: USDC, allowFailure: true, callData: "0xabc" }])),
    "odd-length calldata was encoded");
  check(threw(() => encodeAggregate3([{ target: USDC, allowFailure: true, callData: "zz" }])),
    "non-hex calldata was encoded");
}

group("the balance batch always sets allowFailure");
{
  // One airdropped honeypot that reverts must not erase every other balance in
  // the wallet, so every entry is built with allowFailure true. Assert it over
  // the encoding rather than the input, because that is what the node sees.
  const data = encodeBalanceOfBatch(VITALIK, [USDC, DAI, "0x" + "11".repeat(20)]);
  const flags = [...data.matchAll(new RegExp(addrWord(USDC).slice(24) + "|x", "g"))];
  check(flags.length >= 1, "the token address is missing from the batch");
  for (const token of [USDC, DAI]) {
    const at = data.indexOf(addrWord(token));
    check(at > 0, `${token} missing from the batch`);
    check(data.slice(at + 64, at + 128) === w(1n), `allowFailure not set for ${token}`);
  }
  check(threw(() => encodeBalanceOfBatch("0xdead", [USDC])), "a malformed owner was encoded");
}

group("a batch round-trips, and a failed entry is not a zero balance");
{
  const encoded = encodeResults([
    { success: true, returnData: uint(2500000n) },
    { success: true, returnData: uint(0n) },
    { success: false, returnData: "0x" },
  ]);
  const results = decodeAggregate3Return(encoded);
  check(results.length === 3, `decoded ${results.length} results`);
  check(results[0]?.success === true && decodeUint256Return(results[0].returnData) === 2500000n, "balance round trip");

  // The distinction the whole module exists for: entry 1 holds zero, entry 2
  // never answered. Same "no tokens to show" on screen, entirely different
  // sentence next to it, and nothing here may collapse them.
  check(results[1]?.success === true, "a real zero balance was marked failed");
  check(decodeUint256Return(results[1]?.returnData ?? "0x") === 0n, "a real zero did not decode to 0");
  check(results[2]?.success === false, "a reverting call was marked successful");
  check(results[2]?.returnData === "0x", "a failed call carried invented return data");
  check(
    JSON.stringify(results[1]) !== JSON.stringify(results[2]),
    "a zero balance and a failed call decoded identically",
  );

  // A revert reason rides along on the failed entry without becoming a number.
  const withReason = decodeAggregate3Return(encodeResults([
    { success: false, returnData: "0x08c379a0" + w(32n) },
  ]));
  check(withReason[0]?.success === false, "a revert with a reason was read as success");
  check(withReason[0]?.returnData === "0x08c379a0" + w(32n), "the revert reason was mangled");
}

group("hostile return data is refused, never half-read");
{
  const good = encodeResults([
    { success: true, returnData: uint(1n) }, { success: true, returnData: uint(2n) },
  ]);
  check(decodeAggregate3Return(good).length === 2, "the well-formed fixture does not decode");

  check(threw(() => decodeAggregate3Return("0x")), "an empty return decoded to an empty array");
  check(threw(() => decodeAggregate3Return("0xabc")), "odd-length hex decoded");
  check(threw(() => decodeAggregate3Return("not hex")), "a non-hex return decoded");
  check(threw(() => decodeAggregate3Return(null)), "null decoded");
  check(threw(() => decodeAggregate3Return(12345)), "a number decoded");

  // Truncated at every word boundary: none of these may yield a short array.
  for (let cut = 2; cut < good.length; cut += 64) {
    const short = good.slice(0, cut);
    let decoded: Aggregate3Result[] | undefined;
    try { decoded = decodeAggregate3Return(short); } catch { decoded = undefined; }
    check(decoded === undefined || decoded.length === 2,
      `a return truncated to ${(cut - 2) / 2} bytes decoded to ${decoded?.length} results`);
  }
  // The last word gone entirely: the array claims two results and one is cut.
  check(threw(() => decodeAggregate3Return(good.slice(0, good.length - 64))), "a truncated tail decoded");

  // Absurd offsets. 2^255 in an offset word would, unchecked, turn into NaN
  // arithmetic or a subarray() that quietly returns nothing.
  const huge = w(1n << 255n);
  check(threw(() => decodeAggregate3Return("0x" + huge + w(1n))), "an absurd array offset decoded");
  check(threw(() => decodeAggregate3Return("0x" + w(0x20n) + w(1n) + huge + w(0n).repeat(3))),
    "an absurd element offset decoded");
  // A length claiming more entries than the buffer could physically hold.
  check(threw(() => decodeAggregate3Return("0x" + w(0x20n) + w(1000n))), "an inflated array length decoded");
  // A returnData length past the end of the buffer.
  const overrun = "0x" + w(0x20n) + w(1n) + w(0x20n) + w(1n) + w(0x40n) + w(4096n);
  check(threw(() => decodeAggregate3Return(overrun)), "an overrunning returnData length decoded");
  // A success flag that is neither 0 nor 1 is not a bool; accepting it as truthy
  // would let a crafted return mark a call that never happened as answered.
  const badBool = "0x" + w(0x20n) + w(1n) + w(0x20n) + w(7n) + w(0x40n) + w(0n);
  check(threw(() => decodeAggregate3Return(badBool)), "a non-boolean success flag decoded");
}

group("chunking splits and rejoins in the original order");
{
  check(MULTICALL_CHUNK_SIZE === 100, `chunk size changed: ${MULTICALL_CHUNK_SIZE}`);
  check(chunk([1, 2, 3, 4, 5], 2).length === 3, "5 items in 2s is not 3 chunks");
  check(JSON.stringify(chunk([1, 2, 3, 4, 5], 2)) === "[[1,2],[3,4],[5]]", "chunk boundaries");
  check(chunk([], 10).length === 0, "an empty list produced a chunk");
  check(chunk([1, 2], 10).length === 1, "a short list was split");
  check(threw(() => chunk([1], 0)), "a zero chunk size was accepted");
  check(threw(() => chunk([1], -1)), "a negative chunk size was accepted");

  // 250 tokens, chunk size 100: three requests, 250 answers, in order. The
  // balance of token i is i, so a reordering or a lost chunk is visible.
  const tokens = Array.from({ length: 250 }, (_, i) => "0x" + i.toString(16).padStart(40, "0"));
  const seen: string[][] = [];
  const request: EthRequest = async (args) => {
    const data = String((args.params as [{ data: string }])[0].data);
    // Recover which tokens this chunk asked about, from the calldata itself.
    const count = Number(BigInt("0x" + data.slice(10 + 64, 10 + 128)));
    const mine: string[] = [];
    for (let i = 0; i < count; i++) {
      // Each element is 6 words: target, allowFailure, bytes offset, bytes
      // length, and 36 bytes of balanceOf calldata padded to two words.
      const at = 10 + 128 + count * 64 + i * (6 * 64);
      mine.push("0x" + data.slice(at + 24, at + 64));
    }
    seen.push(mine);
    return encodeResults(mine.map((t) => ({
      success: true, returnData: uint(BigInt(Number.parseInt(t.slice(2), 16))),
    })));
  };

  const out = await fetchTokenBalancesBatched(request, 1, VITALIK, tokens);
  check(seen.length === 3, `250 tokens took ${seen.length} requests`);
  check(seen[0]?.length === 100 && seen[2]?.length === 50, "the chunks are not 100/100/50");
  check(out.length === 250, `got ${out.length} results for 250 tokens`);
  let ordered = true;
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (!r || r.ok !== true || r.raw !== BigInt(i) || r.token !== tokens[i]) ordered = false;
  }
  check(ordered, "results came back out of order or against the wrong token");
}

group("one bad chunk, one bad token, and the rest still arrive");
{
  const tokens = [USDC, DAI, "0x" + "22".repeat(20), "0x" + "33".repeat(20)];
  const request: EthRequest = async () => encodeResults([
    { success: true, returnData: uint(7n) },
    { success: false, returnData: "0x" },      // reverting honeypot
    { success: true, returnData: uint(0n) },   // a genuine zero
    { success: true, returnData: "0x1234" },   // answered, but not a uint256
  ]);
  const out = await fetchTokenBalancesBatched(request, 1, VITALIK, tokens);
  check(out.length === 4, `expected 4 results, got ${out.length}`);
  check(out[0]?.ok === true && out[0].raw === 7n, "the good balance was lost to its neighbours");
  // The reverting token and the zero-balance token must not agree.
  check(out[1]?.ok === false && out[1].reason === "call-failed", "a reverting token was not marked failed");
  check(out[2]?.ok === true && out[2].raw === 0n, "a genuine zero was marked failed");
  check(out[3]?.ok === false && out[3].reason === "undecodable", "a garbage answer became a number");
  check(!JSON.stringify(out[1]).includes("raw"), "a failed token carried a number");

  // A chunk the node rejects outright loses only its own tokens.
  const flaky: EthRequest = async (args) => {
    const data = String((args.params as [{ data: string }])[0].data);
    if (data.includes(DAI.slice(2))) throw new Error("execution reverted");
    return encodeResults([{ success: true, returnData: uint(9n) }]);
  };
  const mixed = await fetchTokenBalancesBatched(flaky, 1, VITALIK, [USDC, DAI], 1);
  check(mixed.length === 2, "a failed chunk dropped its tokens entirely");
  check(mixed[0]?.ok === true && mixed[0].raw === 9n, "a live chunk was lost with the dead one");
  check(mixed[1]?.ok === false && mixed[1].reason === "batch-failed", "a dead chunk was not reported");

  // A multicall answering about a different number of calls than it was asked
  // cannot be aligned to the token list, so nothing from it is believed.
  const miscounting: EthRequest = async () => encodeResults([{ success: true, returnData: uint(1n) }]);
  const misaligned = await fetchTokenBalancesBatched(miscounting, 1, VITALIK, tokens);
  check(misaligned.length === 4, "a miscounted batch changed the result length");
  check(misaligned.every((r) => r.ok === false), "a miscounted batch was zipped onto the wrong tokens");

  // No tokens: no requests at all.
  let called = 0;
  const counting: EthRequest = async () => { called++; return "0x"; };
  check((await fetchTokenBalancesBatched(counting, 1, VITALIK, [])).length === 0, "an empty list produced results");
  check(called === 0, "an empty list still hit the network");
  // And a bad owner is refused before anything is disclosed to an operator.
  let rejected = false;
  try { await fetchTokenBalancesBatched(counting, 1, "0xdead", [USDC]); } catch { rejected = true; }
  check(rejected && called === 0, "a malformed owner reached the network");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
