/**
 * EIP-712 on the host side (ROADMAP T12b).
 *
 * Three jobs, and only the first is about this package's own code.
 *
 * 1. **The vectors are what they claim to be.** `eip712-vectors.ts` carries the
 *    digests that sim/test_eip712.c asserts the firmware produces. Recomputing
 *    them here with viem — an independent implementation, on documents whose
 *    `Mail` case is the EIP's own worked example — is what makes those C
 *    constants evidence rather than a recording of whatever the C happened to
 *    output the day it was written.
 * 2. **The transcription is faithful.** A dapp sends JSON; the device parses a
 *    CBOR subset with one spelling per ABI type. `toDeviceTypedData` converts
 *    driven by the declared types, and a conversion that guessed would hash
 *    something other than what the dapp meant.
 * 3. **The refusals match the firmware's.** `inspectTypedData` must refuse
 *    exactly what src/eip712.c refuses. The cases below are the same cases
 *    sim/test_eip712.c runs, deliberately.
 */

import { strict as assert } from "node:assert";
import { hashTypedData } from "viem";

import { inspectTypedData, toDeviceTypedData, describeTypedData } from "../src/eip712.ts";
import { MAIL, PERMIT, PERMIT2, VECTORS } from "./eip712-vectors.ts";

let failures = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

console.log("eip712");

/* --------------------------------------------------- 1. the vectors hold */

test("the recorded digests are the ones viem computes", () => {
  for (const v of VECTORS) {
    const got = hashTypedData({
      domain: v.domain,
      types: v.types,
      primaryType: v.primaryType,
      message: v.message,
    } as never);
    assert.equal(got, v.digest, `${v.name}`);
  }
});

test("Mail is EIP-712's own published digest", () => {
  /* Quoted from the EIP. If this line and the viem check above ever disagree,
   * the vector was edited and the C constants are stale. */
  assert.equal(MAIL.digest, "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2");
});

/* ------------------------------------------- 2. JSON → the device's wire */

/** A dapp's payload: addresses and big integers as strings, as they arrive. */
function asDappJson(v: typeof PERMIT): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    types: v.types,
    primaryType: v.primaryType,
    domain: v.domain,
    message: v.message,
  }, (_k, value) => (typeof value === "bigint" ? value.toString() : value)));
}

test("a Permit's decimal strings become the device's byte strings", () => {
  const request = toDeviceTypedData(asDappJson(PERMIT));
  const message = request["message"] as Record<string, unknown>;

  const owner = message["owner"];
  assert.ok(owner instanceof Uint8Array && owner.length === 20, "owner is not 20 bytes");

  /* 2^256-1 has no JavaScript number and no CBOR integer in this subset. It has
   * to arrive as 32 big-endian 0xff bytes or the device hashes a different
   * allowance than the dapp asked for. */
  const value = message["value"];
  assert.ok(value instanceof Uint8Array, "an infinite allowance did not become bytes");
  assert.equal(value.length, 32);
  assert.ok(value.every((b) => b === 0xff), "2^256-1 was not transcribed exactly");

  /* A small value stays an integer: both spellings are the device's, and the
   * short one costs 30 fewer bytes in a frame that is already the largest this
   * protocol carries. */
  assert.equal(message["nonce"], 0);
});

test("a bytes32 that looks like a number is still bytes", () => {
  /* The reason the conversion is driven by the declared type and never by the
   * value's shape: this salt would be a perfectly plausible integer. */
  const request = toDeviceTypedData({
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Doc: [{ name: "salt", type: "bytes32" }],
    },
    primaryType: "Doc",
    domain: { name: "Doc" },
    message: { salt: "0x" + "00".repeat(31) + "2a" },
  });
  const salt = (request["message"] as Record<string, unknown>)["salt"];
  assert.ok(salt instanceof Uint8Array && salt.length === 32, "bytes32 became something else");
});

test("a value that does not fit its declared type is refused, not masked", () => {
  assert.throws(() => toDeviceTypedData({
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Doc: [{ name: "n", type: "uint8" }],
    },
    primaryType: "Doc",
    domain: { name: "Doc" },
    message: { n: "300" },
  }), /does not fit/);
});

test("a negative integer has no spelling on the wire and is refused", () => {
  assert.throws(() => toDeviceTypedData({
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Doc: [{ name: "n", type: "int256" }],
    },
    primaryType: "Doc",
    domain: { name: "Doc" },
    message: { n: "-1" },
  }), /negative/);
});

/* ------------------------------------------------ 3. the same refusals */

test("the EIP's Mail example is accepted and flattened to its leaves", () => {
  const verdict = inspectTypedData(toDeviceTypedData(asDappJson(MAIL as never)));
  assert.equal(verdict.kind, "ok");
  if (verdict.kind !== "ok") return;
  assert.deepEqual(
    verdict.render.fields.map((f) => f.label),
    ["from.name", "from.wallet", "to.name", "to.wallet", "contents"],
  );
  assert.equal(verdict.render.chainId, 1n);
  assert.equal(verdict.render.domainName, "Ether Mail");
});

test("an unlimited Permit allowance is named, not printed", () => {
  const verdict = inspectTypedData(toDeviceTypedData(asDappJson(PERMIT)));
  assert.equal(verdict.kind, "ok");
  if (verdict.kind !== "ok") return;

  const value = verdict.render.fields.find((f) => f.label === "value");
  assert.ok(value?.unlimited, "2^256-1 did not read as unlimited");

  const deadline = verdict.render.fields.find((f) => f.label === "deadline");
  assert.ok(deadline?.isDeadline, "the deadline was not flagged as one");
  assert.ok(!deadline?.unlimited, "a deadline must never read as an unlimited amount");

  /* The wording a test can assert on, and the one thing a user must not miss:
   * seventy-eight digits scrolling past is not a number anybody reads. */
  assert.match(describeTypedData(verdict.render), /UNLIMITED value/);
});

test("a bounded allowance is not called unlimited", () => {
  const bounded = { ...PERMIT, message: { ...PERMIT.message, value: 1_000_000_000_000n } };
  const verdict = inspectTypedData(toDeviceTypedData(asDappJson(bounded)));
  assert.equal(verdict.kind, "ok");
  if (verdict.kind !== "ok") return;
  const value = verdict.render.fields.find((f) => f.label === "value");
  assert.ok(!value?.unlimited, "a bounded amount was called unlimited");
  assert.equal(value?.value, "1000000000000");
});

test("Permit2's nested struct becomes dotted leaves, and uint160 max is unlimited", () => {
  const verdict = inspectTypedData(toDeviceTypedData(asDappJson(PERMIT2)));
  assert.equal(verdict.kind, "ok");
  if (verdict.kind !== "ok") return;
  assert.deepEqual(
    verdict.render.fields.map((f) => f.label),
    ["details.token", "details.amount", "details.expiration", "details.nonce",
     "spender", "sigDeadline"],
  );
  const amount = verdict.render.fields.find((f) => f.label === "details.amount");
  assert.ok(amount?.unlimited, "type(uint160).max did not read as unlimited");
  const expiry = verdict.render.fields.find((f) => f.label === "details.expiration");
  assert.ok(expiry?.isDeadline, "an expiration was not flagged");
});

test("an array is unhashable, which no setting reopens", () => {
  /* toDeviceTypedData refuses it first, and inspectTypedData refuses it again
   * if a request ever reaches the mock by another route. Both matter: the app
   * must not promise the dapp a signature, and the mock must not accept one the
   * firmware would reject. */
  const doc = {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Batch: [{ name: "amounts", type: "uint256[]" }],
    },
    primaryType: "Batch",
    domain: { name: "Batch" },
    message: { amounts: ["1", "2"] },
  };
  assert.throws(() => toDeviceTypedData(doc), /array/);

  const verdict = inspectTypedData({
    types: doc.types as never,
    primaryType: "Batch",
    domain: { name: "Batch" },
    message: { amounts: [1, 2] as never },
  });
  assert.equal(verdict.kind, "unhashable");
});

test("a type the document never defines is unhashable", () => {
  const verdict = inspectTypedData({
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Outer: [{ name: "inner", type: "Inner" }],
    } as never,
    primaryType: "Outer",
    domain: { name: "Outer" },
    message: { inner: { x: 1 } } as never,
  });
  assert.equal(verdict.kind, "unhashable");
});

test("more leaves than the screen holds is unrenderable, not unhashable", () => {
  const names = Array.from({ length: 7 }, (_, i) => `f${i}`);
  const verdict = inspectTypedData({
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Wide: names.map((n) => ({ name: n, type: "uint256" })),
    } as never,
    primaryType: "Wide",
    domain: { name: "Wide" },
    message: Object.fromEntries(names.map((n, i) => [n, i])) as never,
  });
  /* The difference that matters: this one the owner may opt into, because the
   * digest would be real. An array is refused however the settings are set. */
  assert.equal(verdict.kind, "unrenderable");
});

test("a string the device screen cannot draw is unrenderable", () => {
  const verdict = inspectTypedData({
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Note: [{ name: "body", type: "string" }],
    } as never,
    primaryType: "Note",
    domain: { name: "Note" },
    message: { body: "approve 💸 now" },
  });
  assert.equal(verdict.kind, "unrenderable");
});

test("a request with no types is malformed, which is a different answer", () => {
  assert.equal(inspectTypedData({ primaryType: "Mail" }).kind, "malformed");
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("all eip712 tests passed");
