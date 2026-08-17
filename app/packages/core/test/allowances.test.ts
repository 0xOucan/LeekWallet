/**
 * Approval hygiene tests.
 *
 * Two properties carry the file.
 *
 * The first is the one multicall.ts states and this module inverts the stakes
 * of: a pair whose call FAILED and a pair with no allowance must never look the
 * same. There, a failed call rendered as zero shows a balance the user does not
 * have; here it tells them an exposure is closed when it is open, and they act
 * on that by doing nothing.
 *
 * The second is that the selectors are right. Every one is derived from its
 * signature with keccak rather than copied, and the two that have well-known
 * published values are pinned below — a wrong selector encodes cleanly,
 * `allowFailure` swallows the revert, and the mistake surfaces as "no
 * allowances found", which reads as good news.
 *
 * Then: the remedies are unsigned transactions and nothing here signs or sends.
 */

import type { EthRequest } from "../src/balances.ts";
import {
  ALLOWANCE_NOTICE, buildQueries, decodePermit2Allowance, encodeErc20Allowance,
  encodeErc20Approve, encodePermit2Allowance, encodePermit2InvalidateNonces,
  encodePermit2Lockdown, fetchAllowances, invalidateNoncesTx, isOutstanding,
  permit2LockdownTx, revokeErc20Tx, selectorOf, SELECTOR_ERC20_ALLOWANCE,
  SELECTOR_ERC20_APPROVE, SELECTOR_PERMIT2_ALLOWANCE, UINT48_MAX, type AllowanceQuery,
} from "../src/allowances.ts";
import { PERMIT2_ADDRESS } from "../src/rules.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const threw = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

const ALICE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC = "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const SPENDER = "0x1111111111111111111111111111111111111111";

const w = (n: bigint) => n.toString(16).padStart(64, "0");
const aw = (a: string) => "0".repeat(24) + a.slice(2).toLowerCase();

/* ------------------------------------------------------------------------ */

group("selectors, derived and pinned");
{
  // The published ERC-20 four-bytes. If keccak or the signature string were
  // wrong, these are the two that would prove it.
  check(SELECTOR_ERC20_ALLOWANCE === "dd62ed3e", `allowance selector is ${SELECTOR_ERC20_ALLOWANCE}`);
  check(SELECTOR_ERC20_APPROVE === "095ea7b3", `approve selector is ${SELECTOR_ERC20_APPROVE}`);
  check(selectorOf("transfer(address,uint256)") === "a9059cbb", "transfer selector does not derive");
  // Permit2's three-address allowance is a different function from ERC-20's.
  check(SELECTOR_PERMIT2_ALLOWANCE !== SELECTOR_ERC20_ALLOWANCE,
    "the Permit2 and ERC-20 allowance selectors collided");
}

group("calldata layouts");
{
  check(encodeErc20Allowance(ALICE, SPENDER) === `0x${SELECTOR_ERC20_ALLOWANCE}${aw(ALICE)}${aw(SPENDER)}`,
    "the ERC-20 allowance calldata is not owner then spender");
  check(encodeErc20Approve(SPENDER, 0n) === `0x${SELECTOR_ERC20_APPROVE}${aw(SPENDER)}${w(0n)}`,
    "the revoke calldata is not approve(spender, 0)");
  check(encodePermit2Allowance(ALICE, USDC, SPENDER)
    === `0x${SELECTOR_PERMIT2_ALLOWANCE}${aw(ALICE)}${aw(USDC)}${aw(SPENDER)}`,
    "the Permit2 allowance calldata is not owner, token, spender");

  /* A dynamic array of STATIC tuples: offset, length, then the pairs inline
   * with no per-element offsets. Wrong-but-well-formed calldata here revokes
   * different pairs than intended rather than failing. */
  const lockdown = encodePermit2Lockdown([{ token: USDC, spender: SPENDER }, { token: DAI, spender: SPENDER }]);
  check(lockdown === `0x${selectorOf("lockdown((address,address)[])")}${w(0x20n)}${w(2n)}` +
    `${aw(USDC)}${aw(SPENDER)}${aw(DAI)}${aw(SPENDER)}`,
    "the lockdown array layout is wrong");

  check(encodePermit2InvalidateNonces(USDC, SPENDER, 5n)
    === `0x${selectorOf("invalidateNonces(address,address,uint48)")}${aw(USDC)}${aw(SPENDER)}${w(5n)}`,
    "the invalidateNonces calldata is wrong");
  check(threw(() => encodePermit2InvalidateNonces(USDC, SPENDER, UINT48_MAX + 1n)),
    "a nonce past uint48 was encoded anyway");
  check(threw(() => encodeErc20Allowance("0xdead", SPENDER)), "a malformed owner was encoded");
}

group("the Permit2 allowance return");
{
  const good = `0x${w(1000n)}${w(1893456000n)}${w(3n)}`;
  const a = decodePermit2Allowance(good);
  check(a.amount === 1000n && a.expiration === 1893456000n && a.nonce === 3n,
    "the three Permit2 words decoded wrongly");
  // Masking a field that overflows its declared width would report a plausible
  // allowance derived from a return nobody legitimate produced.
  check(threw(() => decodePermit2Allowance(`0x${w(1n)}${w((1n << 48n))}${w(0n)}`)),
    "an expiration past uint48 was masked instead of refused");
  check(threw(() => decodePermit2Allowance(`0x${w(1n)}${w(1n)}`)), "a two-word return decoded");
  check(threw(() => decodePermit2Allowance("0x")), "an empty return decoded");
}

group("query construction");
{
  const queries = buildQueries([USDC], [SPENDER, PERMIT2_ADDRESS]);
  const kinds = queries.map((q) => `${q.spender}:${q.via}`);
  check(kinds.includes(`${SPENDER}:erc20`) && kinds.includes(`${SPENDER}:permit2`),
    "a spender is not asked about on both paths");
  // Permit2's allowance to itself is meaningless; the ERC-20 approval that
  // lets Permit2 move the token at all is not.
  check(kinds.includes(`${PERMIT2_ADDRESS}:erc20`), "the ERC-20 approval to Permit2 is not asked about");
  check(!kinds.includes(`${PERMIT2_ADDRESS}:permit2`), "Permit2 was asked for its allowance to itself");
}

group("reading allowances: a failure is not a zero");
await (async () => {
  const queries: AllowanceQuery[] = [
    { token: USDC, spender: SPENDER, via: "erc20" },
    { token: USDC, spender: SPENDER, via: "permit2" },
    { token: DAI, spender: SPENDER, via: "erc20" },
  ];

  /* aggregate3 return: offset, length, per-element offsets, then each element
   * as (success, offset-to-bytes, length, data). Hand-built so the decoder is
   * tested against a layout, not against its own encoder. The inner offset is
   * 0x40 and not 0x60: a `Result` has two head words, where the `Call3` the
   * request encoder builds has three. */
  const element = (success: boolean, data: string): string =>
    w(success ? 1n : 0n) + w(0x40n) + w(BigInt(data.length / 2)) +
    data.padEnd(Math.ceil(data.length / 64) * 64, "0");

  const aggregate = (elements: string[]): string => {
    let cursor = BigInt(elements.length) * 32n;
    let offsets = "";
    for (const e of elements) { offsets += w(cursor); cursor += BigInt(e.length / 2); }
    return `0x${w(0x20n)}${w(BigInt(elements.length))}${offsets}${elements.join("")}`;
  };

  const request: EthRequest = async () => aggregate([
    element(true, w((1n << 256n) - 1n)),                    // unlimited ERC-20
    element(true, w(0n) + w(0n) + w(0n)),                   // Permit2, nothing
    element(false, ""),                                     // the call failed
  ]);

  const results = await fetchAllowances(request, 1, ALICE, queries);
  check(results.length === 3, "the result count does not match the query count");
  check(results[0]?.ok === true && results[0].unlimited, "an unlimited ERC-20 allowance was not named as such");
  check(results[1]?.ok === true && results[1].amount === 0n && results[1].nonce === 0n,
    "the Permit2 triple did not decode");
  // The whole point: this is not "no allowance".
  check(results[2]?.ok === false && results[2].reason === "call-failed",
    "a failed call was reported as a zero allowance");
  check(!isOutstanding(results[2] as never), "a failed call counted as outstanding");
  check(isOutstanding(results[0] as never), "an unlimited allowance did not count as outstanding");

  // A batch that never came back marks only its own pairs, and marks them.
  const dead: EthRequest = async () => { throw new Error("no endpoint answered"); };
  const failed = await fetchAllowances(dead, 1, ALICE, queries);
  check(failed.length === 3 && failed.every((r) => !r.ok), "a dead batch produced usable-looking results");

  // A miscounted batch is discarded wholesale: positional matching is the only
  // thing tying an answer to a pair.
  const miscounting: EthRequest = async () => aggregate([element(true, w(1n))]);
  const misaligned = await fetchAllowances(miscounting, 1, ALICE, queries);
  check(misaligned.length === 3 && misaligned.every((r) => !r.ok), "a miscounted batch was zipped onto the wrong pairs");

  let asked = 0;
  const counting: EthRequest = async () => { asked++; return "0x"; };
  check((await fetchAllowances(counting, 1, ALICE, [])).length === 0, "an empty query list produced results");
  check(asked === 0, "an empty query list still hit the network");
  let rejected = false;
  try { await fetchAllowances(counting, 1, "0xdead", queries); } catch { rejected = true; }
  check(rejected && asked === 0, "a malformed owner reached the network");
})();

group("remedies are unsigned transactions, and nothing else");
{
  const revoke = revokeErc20Tx(USDC, SPENDER);
  check(revoke.to === USDC && revoke.value === 0n, "the revoke is not a zero-value call to the token");
  check(revoke.data === encodeErc20Approve(SPENDER, 0n), "the revoke does not set the allowance to zero");
  check(/invalidateNonces/.test(revoke.why), "the revoke does not say it leaves signed permits alive");

  const lockdown = permit2LockdownTx([{ token: USDC, spender: SPENDER }]);
  check(lockdown.to === PERMIT2_ADDRESS, "lockdown is not addressed to Permit2");
  check(threw(() => permit2LockdownTx([])), "an empty lockdown was built");

  const invalidate = invalidateNoncesTx(USDC, SPENDER, 3n);
  // One past the current nonce: the smallest step that invalidates the
  // outstanding signature. Permit2 bounds the jump anyway.
  check(invalidate.data === encodePermit2InvalidateNonces(USDC, SPENDER, 4n),
    "invalidateNonces did not advance the nonce by exactly one");
  check(/not been submitted yet/.test(invalidate.why),
    "the remedy does not say it only works before the drain lands");
  check(threw(() => invalidateNoncesTx(USDC, SPENDER, UINT48_MAX)),
    "a nonce at the ceiling was advanced past it");

  check(/not a complete list/.test(ALLOWANCE_NOTICE),
    "the notice no longer says the list is a floor rather than a census");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
