/**
 * Decodable-set tests (T50), host side.
 *
 * These mirror sim/test_eth_decode.c case for case, by hand — and hand-mirrored
 * cases are exactly the thing docs/MIRROR-GAP.md found was never actually
 * compared. The block at the bottom of this file (see "shared calldata
 * vectors") is what closes that: it replays a corpus recorded from the real
 * eth_decode_call() and asserts this decoder agrees on every entry, refusals
 * included. The cases above stay, both as fast unit tests of intent and
 * because a mismatch there names the behaviour in prose a vector cannot.
 */

import { readFileSync } from "node:fs";

import { keccak_256 } from "@noble/hashes/sha3";

import {
  AQUA_MAX_LEGS, CallKind, decodeCall, describeCall, isDecodable,
} from "../src/eth-decode.ts";
import { selectorOf } from "../src/allowances.ts";

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

  /* safeTransferFrom is in the table now, and it is still not transferFrom:
   * identical argument shape, different selector, and its third argument is
   * named tokenId rather than described as an amount. The device says the same
   * — the generic screen prints declared names and refuses to editorialise —
   * and the case still proves both decoders match on the selector rather than
   * on the length. */
  const safe = decodeCall("0x42842e0e" + pad(A) + pad(B) + w(1n));
  check(safe.kind === CallKind.Generic, "safeTransferFrom was refused");
  check(safe.args?.[2]?.name === "tokenId", "the third argument is not a token id");
  check(decodeCall("0x42842e0e" + pad(A) + pad(B)).kind === CallKind.Unknown,
    "a short safeTransferFrom was accepted");

  check(decodeCall("0x40c10f19" + pad(A) + "f".repeat(64)).unlimited !== true,
    "a mint was flagged unlimited; only an approval can be");
}

/* ------------------------------------------- the self-verifying table (T12c) */

const B = "112233445566778899aabbccddeeff0102030405";

/* Selectors are HASHED here, never typed, for the same reason the firmware
 * hashes them: a hand-copied selector encodes cleanly and fails silently. */
const sel = (sig: string) =>
  [...keccak_256(new TextEncoder().encode(sig)).subarray(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const sigCall = (sig: string, words: string[]) => "0x" + sel(sig) + words.join("");
const wAddr = (a: string) => "0".repeat(24) + a;
const wNum = (v: bigint) => v.toString(16).padStart(64, "0");

group("Aave supply decodes into four named arguments");
{
  const SUPPLY = "supply(address,uint256,address,uint16)";
  /* The selector the session that prompted this work refused. */
  check(sel(SUPPLY) === "617ba037", `supply's selector is ${sel(SUPPLY)}`);

  const d = decodeCall(sigCall(SUPPLY, [wAddr(ADDR), wNum(1000000n), wAddr(B), wNum(0n)]));
  check(d.kind === CallKind.Generic, "supply refused");
  check(d.functionName === "supply", `function name ${d.functionName}`);
  check(d.args?.length === 4, `argument count ${d.args?.length}`);
  check(d.args?.[0]?.value === "0x" + ADDR, "asset wrong");
  check(d.args?.[1]?.value === 1000000n, "amount wrong");
  check(d.args?.[2]?.name === "onBehalfOf", "third argument misnamed");
  check(describeCall(d) === "supply", `label is ${describeCall(d)}`);
}

group("a signature altered by one character matches nothing");
for (const sig of [
  "supply(address,uint256,address,uint16)",
  "borrow(address,uint256,uint256,uint16,address)",
  "repay(address,uint256,uint256,address)",
  "approve(address,address,uint160,uint48)",
]) {
  const arity = sig.slice(sig.indexOf("(") + 1, -1).split(",").length;
  const words = Array.from({ length: arity }, () => wNum(0n));
  check(decodeCall(sigCall(sig, words)).kind === CallKind.Generic,
    `${sig}: the row does not match its own hash`);

  /* The calldata a host would send for a signature altered by one character.
   * It hashes elsewhere, so it matches nothing and is refused — which is the
   * whole reason the table needs no trusted descriptor behind it. */
  const altered = sig.slice(0, -2) + (sig.at(-2) === "x" ? "y" : "x") + ")";
  check(decodeCall(sigCall(altered, words)).kind === CallKind.Unknown,
    `${sig}: altered to ${altered} and still decoded`);
}

group("a generic argument that is not its declared type is refused");
{
  const SUPPLY = "supply(address,uint256,address,uint16)";
  check(
    decodeCall(sigCall(SUPPLY, [wAddr(ADDR), wNum(1n), "1" + "0".repeat(23) + B, wNum(0n)]))
      .kind === CallKind.Unknown,
    "dirty padding on onBehalfOf accepted",
  );
  check(
    decodeCall(sigCall(SUPPLY, [wAddr(ADDR), wNum(1n), wAddr(B), wNum(0x10000n)]))
      .kind === CallKind.Unknown,
    "a uint16 wider than sixteen bits accepted",
  );
  check(
    decodeCall(sigCall(SUPPLY, [wAddr(ADDR), wNum(1n), wAddr(B), wNum(0n), wNum(0n)]))
      .kind === CallKind.Unknown,
    "trailing bytes after supply accepted",
  );
}

group("an unlimited allowance is judged against its own type's width");
{
  const P2 = "approve(address,address,uint160,uint48)";
  const d = decodeCall(sigCall(P2, [
    wAddr(ADDR), wAddr(B), wNum((1n << 160n) - 1n), wNum((1n << 48n) - 1n),
  ]));
  check(d.kind === CallKind.Generic, "Permit2 approve refused");
  check(d.args?.[2]?.unlimited === true, "a uint160 max allowance not flagged");
  /* A uint48 with every bit set is a far-future date, not an infinity. */
  check(d.args?.[3]?.unlimited !== true, "a uint48 expiration flagged unlimited");
  const below = decodeCall(sigCall(P2, [
    wAddr(ADDR), wAddr(B), wNum((1n << 152n) - 1n), wNum(0n),
  ]));
  check(below.args?.[2]?.unlimited === false, "2^152-1 flagged unlimited");
}

group("a call carrying a dynamic argument is still refused");
check(
  decodeCall(sigCall("safeTransferFrom(address,address,uint256,bytes)", [
    wAddr(ADDR), wAddr(B), wNum(7n), wNum(0x80n),
  ])).kind === CallKind.Unknown,
  "a call with a bytes argument was decoded",
);

/* --------------------------------------------------------------- Aqua (Q2)
 *
 * The calldata is built here rather than imported from the Aqua app: core must
 * not depend on an app, and a test that used the app's encoder would be
 * checking that the encoder agrees with itself. The layout below is the
 * canonical one, written out, which is also what the firmware's own suite
 * builds -- and the shared calldata vectors below (see "shared calldata
 * vectors (T50)") are what actually prove the two agree, Aqua included.
 */
const shipCalldata = (
  app: string, maker: string, tokens: string[], amounts: bigint[],
  opts: { head?: string; strategyTail?: string } = {},
): string => {
  const w = (hex: string) => hex.padStart(64, "0");
  const strategy = (opts.head ?? w("20")) + w(maker) + w("7") + (opts.strategyTail ?? "");
  const lenS = strategy.length / 2;
  const padded = Math.ceil(lenS / 32) * 32;
  const offS = 4 * 32;
  const offT = offS + 32 + padded;
  const offA = offT + 32 + tokens.length * 32;
  return "0x" + selectorOf("ship(address,bytes,address[],uint256[])") +
    w(app) + w(offS.toString(16)) + w(offT.toString(16)) + w(offA.toString(16)) +
    w(lenS.toString(16)) + strategy.padEnd(padded * 2, "0") +
    w(tokens.length.toString(16)) + tokens.map((t) => w(t)).join("") +
    w(amounts.length.toString(16)) + amounts.map((a) => w(a.toString(16))).join("");
};

const dockCalldata = (app: string, hash: string, tokens: string[]): string => {
  const w = (hex: string) => hex.padStart(64, "0");
  return "0x" + selectorOf("dock(address,bytes32,address[])") +
    w(app) + hash + w((3 * 32).toString(16)) +
    w(tokens.length.toString(16)) + tokens.map((t) => w(t)).join("");
};

const AQUA_APP = "228e82831afac5dd9ebde3489e9e18ae9c7bcbf4";
const MAKER = "39d2bae5eaeda9283535ddc98f1991c81ed5cd7e";

group("Aqua ship decodes its app, its maker, its hash and every leg");
{
  const data = shipCalldata(AQUA_APP, MAKER, [ADDR, B], [1000000n, 250n]);
  const d = decodeCall(data);
  check(d.kind === CallKind.AquaShip, `ship refused (${d.kind})`);
  check(d.aqua?.app === "0x" + AQUA_APP, `app ${d.aqua?.app}`);
  check(d.aqua?.maker === "0x" + MAKER, `maker ${d.aqua?.maker}`);
  check(d.aqua?.legs.length === 2, `${d.aqua?.legs.length} legs`);
  check(d.aqua?.legs[1]?.token === "0x" + B, `leg 1 token ${d.aqua?.legs[1]?.token}`);
  check(d.aqua?.legs[0]?.amount === 1000000n, `leg 0 amount ${d.aqua?.legs[0]?.amount}`);

  /* The hash is over the strategy bytes alone -- the key the registry files
   * the position under, and what the portfolio view will match on. */
  const strategy = d.aqua?.strategy ?? "0x";
  const bytes = new Uint8Array(
    (strategy.slice(2).match(/../g) ?? []).map((h) => Number.parseInt(h, 16)),
  );
  const expect = "0x" + [...keccak_256(bytes)]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
  check(d.aqua?.strategyHash === expect, `strategy hash ${d.aqua?.strategyHash}`);
  check(isDecodable({ to: "0x" + ADDR, data }).ok, "ship refused at the transaction gate");
}

group("Aqua dock decodes, and carries no maker and no amounts");
{
  const hash = "ab".repeat(32);
  const d = decodeCall(dockCalldata(AQUA_APP, hash, [ADDR]));
  check(d.kind === CallKind.AquaDock, `dock refused (${d.kind})`);
  check(d.aqua?.strategyHash === "0x" + hash, `dock hash ${d.aqua?.strategyHash}`);
  /* A dock names a hash, not a strategy: there is nothing in the calldata to
   * read a maker out of, and inventing one would be the worst kind of label. */
  check(d.aqua?.maker === undefined, "dock claimed a maker it never saw");
  check(d.aqua?.legs[0]?.amount === undefined, "dock produced an amount");
}

group("Aqua refuses every encoding but the canonical one");
{
  const good = shipCalldata(AQUA_APP, MAKER, [ADDR], [5n]);
  check(decodeCall(good).kind === CallKind.AquaShip, "the baseline call does not decode");

  check(decodeCall(good + "01").kind === CallKind.Unknown, "trailing byte accepted");
  check(decodeCall(good.slice(0, -2)).kind === CallKind.Unknown, "truncated call accepted");

  /* A strategy with no 0x20 tuple head: perfectly well-formed ABI, and no way
   * to say whose position this would be. Refused for that reason alone -- the
   * firmware refuses the same bytes, and mock-conformance pins it. */
  check(
    decodeCall(shipCalldata(AQUA_APP, MAKER, [ADDR], [5n], { head: "40".padStart(64, "0") }))
      .kind === CallKind.Unknown,
    "a strategy with no readable maker accepted",
  );

  /* Legs and amounts of different lengths: a leg with no amount, or an amount
   * with no leg. Either way a page would be missing. */
  /* The amounts-length word is the second-to-last: one leg, but the array in
   * front of it now claims two. */
  const mismatched = good.slice(0, -128) + "2".padStart(64, "0") + good.slice(-64);
  check(decodeCall(mismatched).kind === CallKind.Unknown,
    "an amounts array of a different length accepted");

  /* More legs than the device has pages for. Refused, not summarised. */
  const many = Array.from({ length: AQUA_MAX_LEGS + 1 }, () => ADDR);
  check(
    decodeCall(shipCalldata(AQUA_APP, MAKER, many, many.map(() => 1n))).kind
      === CallKind.Unknown,
    "more legs than the device can draw accepted",
  );
}

group("transaction-level gate");
check(isDecodable({
  to: "0x" + ADDR,
  data: sigCall("supply(address,uint256,address,uint16)",
    [wAddr(ADDR), wNum(1n), wAddr(B), wNum(0n)]),
}).ok, "supply refused at the transaction gate");
check(isDecodable({ to: "0x" + ADDR }).ok, "plain transfer refused");
check(!isDecodable({ to: undefined, data: "0x60806040" }).ok, "contract creation accepted");
check(isDecodable({ to: "0x" + ADDR, data: call(SEL_APPROVE, ADDR, 7n) }).ok, "approval refused");
check(
  !isDecodable({ to: "0x" + ADDR, data: call("deadbeef", ADDR, 7n) }).ok,
  "unknown selector accepted",
);

/* --------------------------------------------- shared calldata vectors (T50)
 *
 * Recorded by `sim/test_eth_decode.c --emit-vectors` from the REAL
 * eth_decode_call(), regenerated by `make -C sim eth-decode-conformance`
 * (wired into scripts/check.sh ahead of this suite) and replayed here rather
 * than checked in and trusted — see docs/MIRROR-GAP.md and the matching
 * reasoning above ETH_DECODE_VECTORS in sim/Makefile. Every group above this
 * one is a hand-written mirror of a hand-written C test; this is what actually
 * proves the two decoders agree, entry by entry, including every refusal.
 */
interface EthDecodeArgVector {
  name: string;
  type: string;
  value: string | boolean;
  unlimited: boolean;
}
interface EthDecodeLegVector { token: string; amount: string | null }
interface EthDecodeVector {
  name: string;
  dataHex: string;
  accepted: boolean;
  kind?: string;
  address?: string | null;
  second?: string | null;
  amount?: string | null;
  unlimited?: boolean;
  flag?: boolean | null;
  generic?: { signature: string; functionName: string; args: EthDecodeArgVector[] } | null;
  ats?: { name: string | null; symbol: string | null } | null;
  aqua?: {
    app: string; maker: string | null; hash: string; legs: EthDecodeLegVector[];
    /** The walked SwapVM program, or null when the app is not the router. */
    program: EthDecodeInstructionVector[] | null;
  } | null;
}

interface EthDecodeInstructionVector {
  opcode: number;
  name: string;
  argsLen: number;
  value: string | null;
}

const ethDecodeVectors: EthDecodeVector[] = JSON.parse(
  readFileSync(new URL("./eth-decode-vectors.json", import.meta.url), "utf8"),
);

group("shared calldata vectors agree with the firmware");
check(ethDecodeVectors.length > 0, "the vector file is empty");
{
  const refusals = ethDecodeVectors.filter((v) => !v.accepted).length;
  console.log(`  ${ethDecodeVectors.length} vectors, ${refusals} refusals`);
}

for (const v of ethDecodeVectors) {
  const d = decodeCall("0x" + v.dataHex);

  if (!v.accepted) {
    // The refusal IS the assertion: a call the firmware refused that this
    // decoder accepts is exactly the drift docs/MIRROR-GAP.md was written
    // about, and the one a happy-path-only suite would never catch.
    check(d.kind === CallKind.Unknown,
      `${v.name}: firmware refused, TS decoded as ${d.kind}`);
    continue;
  }

  check(d.kind !== CallKind.Unknown, `${v.name}: firmware accepted, TS refused`);
  check(d.kind === v.kind, `${v.name}: kind ${d.kind} != firmware's ${v.kind}`);
  check((d.address ?? null) === (v.address ?? null),
    `${v.name}: address ${d.address} != firmware's ${v.address}`);
  check((d.second ?? null) === (v.second ?? null),
    `${v.name}: second ${d.second} != firmware's ${v.second}`);
  check((d.amount === undefined ? null : d.amount.toString()) === (v.amount ?? null),
    `${v.name}: amount ${d.amount} != firmware's ${v.amount}`);
  check(Boolean(d.unlimited) === Boolean(v.unlimited),
    `${v.name}: unlimited ${d.unlimited} != firmware's ${v.unlimited}`);
  check((d.flag ?? null) === (v.flag ?? null),
    `${v.name}: flag ${d.flag} != firmware's ${v.flag}`);

  if (v.generic) {
    check(d.signature === v.generic.signature,
      `${v.name}: signature ${d.signature} != firmware's ${v.generic.signature}`);
    check(d.functionName === v.generic.functionName,
      `${v.name}: functionName ${d.functionName} != firmware's ${v.generic.functionName}`);
    check((d.args?.length ?? -1) === v.generic.args.length,
      `${v.name}: ${d.args?.length} args, firmware has ${v.generic.args.length}`);
    v.generic.args.forEach((a, i) => {
      const arg = d.args?.[i];
      check(arg?.name === a.name, `${v.name}: arg ${i} name ${arg?.name} != ${a.name}`);
      check(arg?.type === a.type, `${v.name}: arg ${i} type ${arg?.type} != ${a.type}`);
      const expected: string | boolean | bigint =
        typeof a.value === "boolean" || a.value.startsWith("0x") ? a.value : BigInt(a.value);
      check(arg?.value === expected,
        `${v.name}: arg ${i} value ${arg?.value} != firmware's ${a.value}`);
      check(Boolean(arg?.unlimited) === Boolean(a.unlimited),
        `${v.name}: arg ${i} unlimited ${arg?.unlimited} != ${a.unlimited}`);
    });
  } else {
    check(d.args === undefined, `${v.name}: TS produced args the firmware did not`);
  }

  if (v.aqua) {
    check(d.aqua?.app === v.aqua.app, `${v.name}: aqua app ${d.aqua?.app} != ${v.aqua.app}`);
    check((d.aqua?.maker ?? null) === (v.aqua.maker ?? null),
      `${v.name}: aqua maker ${d.aqua?.maker} != ${v.aqua.maker}`);
    check(d.aqua?.strategyHash === v.aqua.hash,
      `${v.name}: aqua strategyHash ${d.aqua?.strategyHash} != ${v.aqua.hash}`);
    check(d.aqua?.legs.length === v.aqua.legs.length,
      `${v.name}: ${d.aqua?.legs.length} legs, firmware has ${v.aqua.legs.length}`);
    v.aqua.legs.forEach((leg, i) => {
      const got = d.aqua?.legs[i];
      check(got?.token === leg.token, `${v.name}: leg ${i} token ${got?.token} != ${leg.token}`);
      check(
        (got?.amount === undefined ? null : got.amount.toString()) === (leg.amount ?? null),
        `${v.name}: leg ${i} amount ${got?.amount} != firmware's ${leg.amount}`,
      );
    });
    /* The program, instruction for instruction. "Accepted" alone would let
     * the two decoders agree to render a program while disagreeing about what
     * every instruction in it is — which is exactly the shape of the wrong
     * opcode table this corpus now pins against. */
    if (v.aqua.program) {
      check((d.aqua?.program?.length ?? -1) === v.aqua.program.length,
        `${v.name}: ${d.aqua?.program?.length} instructions, firmware has ${v.aqua.program.length}`);
      v.aqua.program.forEach((instr, i) => {
        const got = d.aqua?.program?.[i];
        check(got?.opcode === instr.opcode,
          `${v.name}: instruction ${i} opcode ${got?.opcode} != ${instr.opcode}`);
        check(got?.name === instr.name,
          `${v.name}: instruction ${i} name ${got?.name} != ${instr.name}`);
        check(got?.args.length === instr.argsLen,
          `${v.name}: instruction ${i} args_len ${got?.args.length} != ${instr.argsLen}`);
      });
    } else {
      check(d.aqua?.program === undefined,
        `${v.name}: TS walked a program the firmware did not`);
    }
  } else {
    check(d.aqua === undefined, `${v.name}: TS produced an aqua field the firmware did not`);
  }

  /* The two strings of an ATS issuance, compared for CONTENT.
   *
   * "Accepted" alone would let both decoders agree to render an issuance while
   * disagreeing about what name it writes on chain -- and for this call the
   * name and symbol are not a summary of the decision, they are all of it. The
   * refusal cases matter as much: each is a way the glass and the calldata
   * could disagree (a control byte, a right-to-left override, an invisible
   * leading space, a string one byte over the factory's own bound), and a
   * mirror that accepted any of them would draw something the device rejects. */
  if (v.ats) {
    check(d.ats?.name === v.ats.name,
      `${v.name}: ats name ${d.ats?.name} != firmware's ${v.ats.name}`);
    check(d.ats?.symbol === v.ats.symbol,
      `${v.name}: ats symbol ${d.ats?.symbol} != firmware's ${v.ats.symbol}`);
  } else {
    check(d.ats === undefined, `${v.name}: TS produced an ats field the firmware did not`);
  }
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
