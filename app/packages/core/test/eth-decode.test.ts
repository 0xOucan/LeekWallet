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

group("the wider decodable set mirrors the firmware");
{
  const A = "d8da6bf26964af9d7eed9e03e53415d37aa96045";
  const B = "112233445566778899aabbccddeeff0102030405";
  const w = (v: bigint) => v.toString(16).padStart(64, "0");
  const pad = (a: string) => "0".repeat(24) + a;

  const tf = decodeCall("0x23b872dd" + pad(A) + pad(B) + w(5n));
  check(tf.kind === CallKind.Erc20TransferFrom, `transferFrom: ${tf.kind}`);
  check(tf.address === "0x" + A && tf.second === "0x" + B, "transferFrom parties wrong");
  check(tf.amount === 5n, "transferFrom amount wrong");

  const grant = decodeCall("0xa22cb465" + pad(A) + w(1n));
  check(grant.kind === CallKind.SetApprovalForAll && grant.flag === true, "grant-all wrong");
  check(describeCall(grant).includes("ALL"), "granting every token must say so loudly");
  check(decodeCall("0xa22cb465" + pad(A) + w(0n)).flag === false, "revoke-all wrong");
  check(decodeCall("0xa22cb465" + pad(A) + w(2n)).kind === CallKind.Unknown,
    "a bool of 2 was accepted; a contract may read the raw word");

  check(decodeCall("0xd0e30db0").kind === CallKind.WethDeposit, "deposit() not recognised");
  check(decodeCall("0xd0e30db0" + w(1n)).kind === CallKind.Unknown,
    "deposit() takes no arguments");
  const un = decodeCall("0x2e1a7d4d" + w(7n));
  check(un.kind === CallKind.WethWithdraw && un.amount === 7n, "withdraw wrong");

  const mintTo = decodeCall("0x40c10f19" + pad(A) + w(100n));
  check(mintTo.kind === CallKind.MintTo && mintTo.address === "0x" + A, "mint(address,uint256)");
  check(decodeCall("0xa0712d68" + w(9n)).kind === CallKind.Mint, "mint(uint256)");

  /* safeTransferFrom is deliberately NOT in the set: identical argument shape
   * to transferFrom, but the third word is a token id on ERC-721 and an amount
   * on ERC-20, and neither side can tell which standard it is talking to. Any
   * wording would be wrong half the time. It also proves both decoders match on
   * the selector rather than on the length. */
  check(decodeCall("0x42842e0e" + pad(A) + pad(B) + w(1n)).kind === CallKind.Unknown,
    "safeTransferFrom was accepted; it is ambiguous by design");

  check(decodeCall("0x40c10f19" + pad(A) + "f".repeat(64)).unlimited !== true,
    "a mint was flagged unlimited; only an approval can be");
}

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
