/**
 * Capping an approval — encoding, decimals, and the zero-first sequence.
 *
 * Three properties carry the file, and they are the three ways this feature
 * could quietly do something other than what the user asked.
 *
 * The first is that the re-encoded calldata decodes back, through the SAME
 * decoder the firmware mirrors, to the amount that was typed. That round trip
 * is the whole safety argument: the device draws what it decodes, so if these
 * bytes decode to the capped figure here they draw as the capped figure there.
 *
 * The second is decimals. 500 USDT is 500000000 and not 500, and an input with
 * more fractional digits than the token claims must be REFUSED rather than
 * truncated — truncation silently approves a number nobody typed.
 *
 * The third is the zero-first sequence, which exists because Tether reverts on
 * a non-zero to non-zero approve. Two failure modes are tested: planning one
 * transaction where two are needed (the silent revert), and planning two where
 * one would do (an extra confirmation and extra gas for nothing).
 */

import { CallKind, decodeCall } from "../src/eth-decode.ts";
import { SELECTOR_ERC20_APPROVE, SELECTOR_PERMIT2_APPROVE } from "../src/allowances.ts";
import { PERMIT2_ADDRESS } from "../src/rules.ts";
import {
  ALLOWANCE_UNREADABLE_NOTICE, APPROVAL_EDIT_NOTICE, inspectApproval, parseCapAmount,
  planCap, ZERO_FIRST_NOTICE, type ApprovalCall,
} from "../src/approval-cap.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const threw = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SPENDER = "0x1111111111111111111111111111111111111111";
const UINT256_MAX = (1n << 256n) - 1n;

const w = (n: bigint) => n.toString(16).padStart(64, "0");
const aw = (a: string) => "0".repeat(24) + a.slice(2).toLowerCase();
const approveData = (spender: string, amount: bigint) =>
  `0x${SELECTOR_ERC20_APPROVE}${aw(spender)}${w(amount)}`;

/* ------------------------------------------------------------------------ */

group("inspection: what counts as a cappable approval");
{
  const unlimited = inspectApproval({ to: USDT, data: approveData(SPENDER, UINT256_MAX) });
  check(unlimited?.standard === "erc20", "an ERC-20 approve was not recognised");
  check(unlimited?.token.toLowerCase() === USDT.toLowerCase(),
    "the token is the contract being called, not an argument");
  check(unlimited?.spender.toLowerCase() === SPENDER.toLowerCase(), "wrong spender");
  check(unlimited?.amount === UINT256_MAX, "wrong amount");
  // The verdict comes from eth-decode.ts, which mirrors the firmware. This
  // asserts it arrives, not that a second threshold agrees with it.
  check(unlimited?.unlimited === true, "uint256.max did not come back as unlimited");

  const capped = inspectApproval({ to: USDT, data: approveData(SPENDER, 500_000_000n) });
  check(capped?.unlimited === false, "500 USDT was called unlimited");

  // Everything that is not an approval, refused rather than half-read.
  check(inspectApproval({ to: USDT, data: "0x" }) === undefined, "empty calldata was cappable");
  check(inspectApproval({ to: USDT, data: "0xa9059cbb" + aw(SPENDER) + w(1n) }) === undefined,
    "a transfer was offered an approval cap");
  check(inspectApproval({ data: approveData(SPENDER, 1n) }) === undefined,
    "contract creation was cappable");
  check(inspectApproval({ to: USDT, data: approveData(SPENDER, 1n) + "00" }) === undefined,
    "trailing bytes past the arguments were accepted");
}

group("inspection: Permit2's four-argument approve");
{
  const data = `0x${SELECTOR_PERMIT2_APPROVE}${aw(USDT)}${aw(SPENDER)}` +
    `${w((1n << 160n) - 1n)}${w(2000000000n)}`;
  const call = inspectApproval({ to: PERMIT2_ADDRESS, data });
  check(call?.standard === "permit2", "Permit2's approve was not recognised");
  check(call?.token.toLowerCase() === USDT.toLowerCase(), "Permit2 token argument misread");
  check(call?.spender.toLowerCase() === SPENDER.toLowerCase(), "Permit2 spender misread");
  check(call?.unlimited === true, "a uint160 at full width is not being called unlimited");
  check(call?.expiration === 2000000000n, "the expiration was not carried");

  // The same four bytes anywhere else are a function this app has never read.
  check(inspectApproval({ to: USDT, data }) === undefined,
    "Permit2's selector was accepted on a contract that is not Permit2");
  // A uint160 field that does not fit its width is not a return Permit2 made.
  const overflow = `0x${SELECTOR_PERMIT2_APPROVE}${aw(USDT)}${aw(SPENDER)}` +
    `${w(1n << 200n)}${w(0n)}`;
  check(inspectApproval({ to: PERMIT2_ADDRESS, data: overflow }) === undefined,
    "an amount wider than uint160 was accepted");
}

group("decimals: token units in, base units out");
{
  check(parseCapAmount("500", 6, 256) === 500_000_000n, "500 USDT is not 500000000 base units");
  check(parseCapAmount("500", 18, 256) === 500_000_000_000_000_000_000n, "18-decimal scaling wrong");
  check(parseCapAmount("0.5", 6, 256) === 500_000n, "a fractional amount did not scale");
  check(parseCapAmount("0", 6, 256) === 0n, "zero is a legitimate cap");

  // Refused, not truncated. This is the whole point of the constraint.
  check(threw(() => parseCapAmount("500.1234567", 6, 256)),
    "seven fractional digits were accepted against a 6-decimal token");
  check(threw(() => parseCapAmount("1e18", 6, 256)), "exponent notation was accepted");
  check(threw(() => parseCapAmount("-5", 6, 256)), "a negative amount was accepted");
  check(threw(() => parseCapAmount("", 6, 256)), "an empty amount was accepted");
  check(threw(() => parseCapAmount("500 USDT", 6, 256)), "a unit suffix was accepted");
  // Width is enforced per approval shape: what fits a uint256 need not fit 160.
  check(threw(() => parseCapAmount("1000000000000000000000000000000000000000000000000", 18, 160)),
    "an amount past uint160 was accepted for a Permit2 approval");
}

group("encoding: the capped calldata decodes back to the capped figure");
{
  const call = inspectApproval({ to: USDT, data: approveData(SPENDER, UINT256_MAX) }) as ApprovalCall;
  const plan = planCap(call, parseCapAmount("500", 6, 256), 0n);
  check(plan.steps.length === 1, "a cap over a zero allowance needs one transaction");

  const back = decodeCall(plan.steps[0]?.data);
  check(back.kind === CallKind.Erc20Approve, "the re-encoded call is not an approve any more");
  check(back.address?.toLowerCase() === SPENDER.toLowerCase(), "the spender changed in the edit");
  check(back.amount === 500_000_000n, `the device would see ${back.amount}, not 500000000`);
  check(back.unlimited === false, "the capped call still reads as unlimited");
}

group("the zero-first sequence");
{
  const call = inspectApproval({ to: USDT, data: approveData(SPENDER, UINT256_MAX) }) as ApprovalCall;

  // A live non-zero allowance: two transactions, zero then the cap.
  const seq = planCap(call, 500_000_000n, 1_000_000n);
  check(seq.zeroFirst, "a non-zero to non-zero change was planned as one transaction");
  check(seq.steps.length === 2, `expected two steps, got ${seq.steps.length}`);
  check(seq.steps[0]?.amount === 0n, "the first step is not the zero");
  check(decodeCall(seq.steps[0]?.data).amount === 0n, "the first step does not encode zero");
  check(seq.steps[1]?.amount === 500_000_000n, "the second step is not the cap");
  check(decodeCall(seq.steps[1]?.data).amount === 500_000_000n, "the second step encodes wrong");
  check(seq.notices.includes(ZERO_FIRST_NOTICE), "the sequence was not explained");

  // Nothing outstanding: one transaction, and no extra confirmation asked for.
  check(planCap(call, 500_000_000n, 0n).zeroFirst === false,
    "a zero allowance was given the zero-first dance anyway");

  // Setting to zero IS the zero step; never two of them.
  check(planCap(call, 0n, 1_000_000n).zeroFirst === false,
    "revoking to zero was planned as two transactions");

  // Unreadable is not zero. Assuming zero is exactly the silent revert.
  const blind = planCap(call, 500_000_000n, undefined);
  check(blind.zeroFirst === false, "an unread allowance was treated as non-zero");
  check(blind.notices.includes(ALLOWANCE_UNREADABLE_NOTICE),
    "an unread allowance was not declared to the user");

  // Permit2 overwrites unconditionally; the dance is an ERC-20 behaviour.
  const p2data = `0x${SELECTOR_PERMIT2_APPROVE}${aw(USDT)}${aw(SPENDER)}${w((1n << 160n) - 1n)}${w(99n)}`;
  const p2 = inspectApproval({ to: PERMIT2_ADDRESS, data: p2data }) as ApprovalCall;
  const p2plan = planCap(p2, 500_000_000n, 1_000_000n);
  check(p2plan.zeroFirst === false, "Permit2 was given the zero-first sequence");
  check(p2plan.steps[0]?.data.slice(2 + 8 + 64 + 64) === `${w(500_000_000n)}${w(99n)}`,
    "the Permit2 edit did not preserve the dapp's expiration");
}

group("every plan says the dapp's request is being changed");
{
  const call = inspectApproval({ to: USDT, data: approveData(SPENDER, UINT256_MAX) }) as ApprovalCall;
  for (const [amount, current] of [[0n, 0n], [1n, 0n], [500n, 5n], [7n, undefined]] as const) {
    const plan = planCap(call, amount, current);
    check(plan.notices[0] === APPROVAL_EDIT_NOTICE,
      "a plan was produced without the notice that the dapp's request changed");
  }
  // And none of them claims the result is safe.
  check(!APPROVAL_EDIT_NOTICE.toLowerCase().includes("safe approval"),
    "the edit notice claims safety");
  check(APPROVAL_EDIT_NOTICE.includes("device"), "the edit notice does not point at the device");

  check(threw(() => planCap(call, -1n, 0n)), "a negative cap was planned");
  check(threw(() => planCap(call, 1n << 256n, 0n)), "a cap past uint256 was planned");
}

/* ------------------------------------------------------------------------ */

console.log(failures === 0 ? "\napproval-cap: all checks passed" : `\napproval-cap: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
