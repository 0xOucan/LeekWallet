/**
 * Decodable-set tests (T50), host side.
 *
 * These mirror sim/test_eth_decode.c case for case. The point of the mirroring
 * is the mock: if this decoder ever accepts something the C one refuses, the
 * mock starts certifying transactions the device will reject, which is the
 * exact failure mode the "mock must never be more permissive" rule exists for.
 */

import { CallKind, decodeCall, describeCall, isDecodable } from "../src/eth-decode.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const SEL_TRANSFER = "a9059cbb";
const SEL_APPROVE = "095ea7b3";
const ADDR = "d8da6bf26964af9d7eed9e03e53415d37aa96045";

const call = (selector: string, addr: string, amount: bigint | string) => {
  const word = typeof amount === "string" ? amount : amount.toString(16).padStart(64, "0");
  return "0x" + selector + "0".repeat(24) + addr + word;
};

group("empty calldata is a native transfer");
check(decodeCall(undefined).kind === CallKind.Empty, "undefined not empty");
check(decodeCall("0x").kind === CallKind.Empty, "0x not empty");
check(decodeCall(new Uint8Array(0)).kind === CallKind.Empty, "empty bytes not empty");

group("erc-20 transfer decodes");
{
  const d = decodeCall(call(SEL_TRANSFER, ADDR, 1500000n));
  check(d.kind === CallKind.Erc20Transfer, "not a transfer");
  check(d.address === "0x" + ADDR, `recipient ${d.address}`);
  check(d.amount === 1500000n, `amount ${d.amount}`);
  check(d.unlimited === false, "transfer flagged unlimited");
}

group("bounded approval is not flagged");
{
  const d = decodeCall(call(SEL_APPROVE, ADDR, 1n));
  check(d.kind === CallKind.Erc20Approve, "not an approval");
  check(d.unlimited === false, "a 1-unit approval read as unlimited");
}

group("unlimited approvals are flagged");
for (const [label, word] of [
  ["2^256-1", "f".repeat(64)],
  ["2^255", "8" + "0".repeat(63)],
  ["2^256-1 with high bit", "8" + "f".repeat(63)],
] as const) {
  const d = decodeCall(call(SEL_APPROVE, ADDR, word));
  check(d.kind === CallKind.Erc20Approve, `${label}: not an approval`);
  check(d.unlimited === true, `${label}: not flagged`);
  check(describeCall(d).includes("UNLIMITED"), `${label}: label does not warn`);
}
check(
  decodeCall(call(SEL_APPROVE, ADDR, "7" + "f".repeat(63))).unlimited === false,
  "2^255-1 flagged unlimited",
);

group("anything outside the set is refused");
check(decodeCall(call("23b872dd", ADDR, 1n)).kind === CallKind.Unknown, "transferFrom accepted");
check(decodeCall("0x" + SEL_TRANSFER).kind === CallKind.Unknown, "selector-only accepted");
check(
  decodeCall(call(SEL_TRANSFER, ADDR, 1n) + "abcd").kind === CallKind.Unknown,
  "trailing bytes accepted",
);
check(
  decodeCall(call(SEL_TRANSFER, ADDR, 1n).slice(0, -2)).kind === CallKind.Unknown,
  "short call accepted",
);
// Bytes hidden in the address padding, where no screen looks.
check(
  decodeCall("0x" + SEL_TRANSFER + "01" + "0".repeat(22) + ADDR + "0".repeat(64)).kind ===
    CallKind.Unknown,
  "dirty address padding accepted",
);
check(decodeCall("0xzz").kind === CallKind.Unknown, "non-hex accepted");

group("transaction-level gate");
check(isDecodable({ to: "0x" + ADDR }).ok, "plain transfer refused");
check(!isDecodable({ to: undefined, data: "0x60806040" }).ok, "contract creation accepted");
check(isDecodable({ to: "0x" + ADDR, data: call(SEL_APPROVE, ADDR, 7n) }).ok, "approval refused");
check(
  !isDecodable({ to: "0x" + ADDR, data: call("deadbeef", ADDR, 7n) }).ok,
  "unknown selector accepted",
);

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
