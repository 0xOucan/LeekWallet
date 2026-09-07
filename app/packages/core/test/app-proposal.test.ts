/**
 * The mini-app proposal seam.
 *
 * What is under test is a refusal, not a feature. Three properties, in
 * descending order of what it costs to lose one:
 *
 * 1. **No descriptor, no signature.** The load-bearing test removes the
 *    descriptor that makes a call describable and asserts the identical call is
 *    then refused. If that ever passes with the descriptor gone, an app can ask
 *    for a signature over calldata nothing can put into words.
 * 2. **An app cannot choose who signs or on what chain.** `from` and `chainId`
 *    come from the shell's context; a proposal object carrying them anyway must
 *    not influence the result.
 * 3. **Every no looks the same to the app.** The outcome an app receives is one
 *    constant, and the reason travels only in the shell-side `why`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROPOSAL_DECLINED, declined, screenProposal,
  type AppProposal, type ScreenContext,
} from "../src/app-proposal.ts";
import { BUNDLED_DESCRIPTORS } from "../src/erc7730-bundled.ts";
import { PERMIT } from "./eip712-vectors.ts";

const STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const VITALIK = "d8da6bf26964af9d7eed9e03e53415d37aa96045";
const SHELL_FROM = "0x1111111111111111111111111111111111111111";

const word = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: string) => "0".repeat(24) + a;

/** The stETH transfer the bundled set describes. */
const TRANSFER: AppProposal = {
  kind: "call",
  to: STETH,
  data: "0x" + "a9059cbb" + addrWord(VITALIK) + word(1500n),
  reason: "settle the round",
};

const context = (over: Partial<ScreenContext> = {}): ScreenContext => ({
  chainId: 1,
  from: SHELL_FROM,
  descriptors: BUNDLED_DESCRIPTORS,
  ...over,
});

/* ------------------------------------------------- 1. the descriptor gate */

test("a described call is screened through", () => {
  const result = screenProposal(TRANSFER, context());
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok" || result.screened.kind !== "call") return;
  assert.equal(result.screened.descriptor.intent, "Transfer stETH");
  /* Advisory and unverified travel with the match rather than being asserted by
   * whoever renders it. A caller that wanted to print the labels as facts would
   * have to type past these two. */
  assert.equal(result.screened.descriptor.unverified, true);
  assert.equal(result.screened.descriptor.advisory, true);
});

test("removing the descriptor refuses the identical call", () => {
  /* The whole seam in one assertion. Same bytes, same chain, same contract —
   * the only difference is that nothing in the build can say what the call
   * does, and that is sufficient to refuse. */
  const without = BUNDLED_DESCRIPTORS.filter(
    (d) => !d.deployments.some((dep) => dep.address === STETH && dep.chainId === 1),
  );
  assert.ok(without.length < BUNDLED_DESCRIPTORS.length, "the fixture removed no descriptor");

  const result = screenProposal(TRANSFER, context({ descriptors: without }));
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") return;
  assert.match(result.why, /descriptor/);
});

test("an empty descriptor set refuses everything", () => {
  assert.equal(screenProposal(TRANSFER, context({ descriptors: [] })).kind, "refused");
});

test("the right call on the wrong chain is refused", () => {
  // A descriptor is chain-scoped: the same address elsewhere is another
  // contract, and describing it with these labels would be a lie about which
  // network the signature is valid on.
  assert.equal(screenProposal(TRANSFER, context({ chainId: 137 })).kind, "refused");
});

test("calldata with a trailing byte is refused", () => {
  const smuggled: AppProposal = { ...TRANSFER, data: TRANSFER.kind === "call" ? TRANSFER.data + "00" : "" };
  assert.equal(screenProposal(smuggled, context()).kind, "refused");
});

test("a bare value transfer is refused: nothing describes empty calldata", () => {
  assert.equal(
    screenProposal({ kind: "call", to: STETH, data: "0x", reason: "tip" }, context()).kind,
    "refused",
  );
});

test("contract creation is not proposable", () => {
  const result = screenProposal(
    { kind: "call", to: "", data: "0x6080", reason: "deploy" },
    context(),
  );
  assert.equal(result.kind, "refused");
});

test("a proposal with no reason is refused", () => {
  assert.equal(screenProposal({ ...TRANSFER, reason: "  " }, context()).kind, "refused");
});

/* ------------------------------------- 2. what the app does not get to set */

test("the signer is the shell's address, never the proposal's", () => {
  /* An app cannot express `from` in the type. This is the runtime half: a
   * proposal object that carries one anyway — from JSON, from a cast, from a
   * future field — must not reach the signer. An app that could pick `from`
   * could ask a user to sign as an account they are not looking at. */
  const sneaky = { ...TRANSFER, from: "0x2222222222222222222222222222222222222222" } as AppProposal;
  const result = screenProposal(sneaky, context());
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.screened.from, SHELL_FROM);
});

test("the chain is the shell's, never the proposal's", () => {
  const sneaky = { ...TRANSFER, chainId: 137 } as AppProposal;
  const result = screenProposal(sneaky, context({ chainId: 1 }));
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.screened.chainId, 1);
});

test("no address selected means nothing can be proposed", () => {
  assert.equal(screenProposal(TRANSFER, context({ from: "" })).kind, "refused");
});

/* -------------------------------------------------------- 3. typed data */

/** A dapp-shaped document: everything a string, as JSON delivers it. */
const asJson = (v: typeof PERMIT): Record<string, unknown> =>
  JSON.parse(JSON.stringify(
    { types: v.types, primaryType: v.primaryType, domain: v.domain, message: v.message },
    (_k, value) => (typeof value === "bigint" ? value.toString() : value),
  ));

test("a Permit the device can show is screened through", () => {
  const result = screenProposal(
    { kind: "typed-data", document: asJson(PERMIT), reason: "approve the swap" },
    context(),
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok" || result.screened.kind !== "typed-data") return;
  /* The summary is the device's own, from the same mirror the device runs, so
   * the card cannot describe the document differently from the screen the user
   * is asked to compare it against. */
  assert.ok(result.screened.summary.length > 0);
  assert.equal(result.screened.from, SHELL_FROM);
});

test("a document the device cannot hash is refused", () => {
  const result = screenProposal(
    {
      kind: "typed-data",
      reason: "sign the batch",
      document: {
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Batch: [{ name: "ids", type: "uint256[]" }],
        },
        primaryType: "Batch",
        domain: { name: "Batch" },
        message: { ids: ["1", "2"] },
      },
    },
    context(),
  );
  assert.equal(result.kind, "refused");
});

test("a document that is not typed data at all is refused, not thrown", () => {
  const result = screenProposal(
    { kind: "typed-data", document: { hello: "world" }, reason: "sign this" },
    context(),
  );
  assert.equal(result.kind, "refused");
});

/* ------------------------------------------------- 4. one no, every time */

test("the app's refusal carries no reason", () => {
  const no = declined();
  assert.equal(no.ok, false);
  if (no.ok) return;
  assert.equal(no.text, PROPOSAL_DECLINED);
  /* The point of the constant: a user-reject and a screening refusal are the
   * same value, so an app cannot search for a describable payload by watching
   * which no it got, and cannot tell a rejection apart in order to re-ask. The
   * reason exists — it goes to the user's log, in `why`. */
  const refused = screenProposal(TRANSFER, context({ descriptors: [] }));
  assert.equal(refused.kind, "refused");
  if (refused.kind !== "refused") return;
  assert.ok(!PROPOSAL_DECLINED.includes(refused.why));
});
