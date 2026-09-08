/**
 * The privileged path from an intent to a press, and the four ways it stops.
 *
 * The assertion that matters is the last group: with one format deleted from
 * the descriptor set, the console refuses and NOTHING reaches `propose`. Not
 * "propose is called and the wallet declines" — the app itself does not ask.
 * That is the plan's §3 rule (H4), and it is checked by counting calls to a
 * `propose` that would otherwise say yes to everything.
 *
 * No DOM, no device, no network. `propose` is a stub, which is the whole point:
 * an app holds the ability to ask and nothing else, so a stub is a complete
 * substitute for the wallet from this side of the seam.
 */

import type { AppContext } from "@leekwallet/core/mini-app.ts";
import type { AppProposal, ProposalOutcome } from "@leekwallet/core/app-proposal.ts";
import { selectorOf } from "@leekwallet/core/erc7730.ts";
import {
  encodePrivileged, previewPrivileged, proposePrivileged,
  DECLINED_NOTICE, NO_DEVICE_NOTICE, type PrivilegedIntent,
} from "../src/act.ts";
import { describePrivilegedCall, type SecurityFacts } from "../src/action.ts";
import { atsDescriptorJson, ACTIONS } from "../src/descriptors.ts";
import { ATS_APP } from "../src/index.ts";
import { parseDescriptor } from "@leekwallet/core/erc7730.ts";
import { screenProposal } from "@leekwallet/core/app-proposal.ts";
import { DEFAULT_DESCRIPTORS } from "@leekwallet/core/tx-interpret.ts";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string): void => console.log(`== ${n}`);

const CHAIN = 296;
const TOKEN = "0x00000000000000000000000000000000004e5f21";
const ALICE = "0x000000000000000000000000000000000048a1b2";
const ISSUER = "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f";

const FACTS: SecurityFacts = {
  chainId: CHAIN, address: TOKEN, name: "ACME Equity", decimals: 2, controlListType: true,
};

/** A context whose `propose` records what it was asked and always says yes. */
function spyContext(): { context: AppContext; asked: AppProposal[] } {
  const asked: AppProposal[] = [];
  const context: AppContext = {
    chainId: CHAIN,
    address: ALICE,
    request: async () => { throw new Error("no reads in this test"); },
    propose: async (p: AppProposal): Promise<ProposalOutcome> => {
      asked.push(p);
      return { ok: true, kind: "call", result: "0xdeadbeef" };
    },
  };
  return { context, asked };
}

/* ------------------------------------------------------------------ encoding */

group("calldata is built from the same table the descriptors are built from");
{
  const data = encodePrivileged({ action: "grantRole", role: ISSUER, account: ALICE });
  check(data.startsWith(`0x${selectorOf("grantRole(bytes32,address)")}`),
    "grantRole calldata does not begin with the grantRole selector");
  check(data.length === 2 + 8 + 128, `grantRole calldata is ${data.length} chars, expected 138`);

  /* The reason this test exists: the contracts take the amount FIRST, and the
   * intent takes it second because that is how a person says it. A regression
   * that "tidied" the encoder into intent order would produce a selector no ATS
   * contract has, and every lock would refuse for a reason nobody could find. */
  const lock = encodePrivileged({
    action: "lock", account: ALICE, amount: 500n, until: 1893456000n,
  });
  check(lock.startsWith(`0x${selectorOf("lock(uint256,address,uint256)")}`),
    "lock calldata does not use the contracts' argument order");
  check(lock.slice(10, 74) === (500n).toString(16).padStart(64, "0"),
    "the first word of a lock is not the amount");

  // Every action in the table must be encodable; an action that is not is a
  // screen the console offers and cannot produce.
  const intents: PrivilegedIntent[] = [
    { action: "grantRole", role: ISSUER, account: ALICE },
    { action: "revokeRole", role: ISSUER, account: ALICE },
    { action: "revokeKyc", account: ALICE },
    { action: "pause" },
    { action: "unpause" },
    { action: "freezePartialTokens", account: ALICE, amount: 1n },
    { action: "unfreezePartialTokens", account: ALICE, amount: 1n },
    { action: "setAddressFrozen", account: ALICE, frozen: true },
    { action: "lock", account: ALICE, amount: 1n, until: 2n },
    { action: "setMaxSupply", cap: 1000n },
    { action: "mint", to: ALICE, amount: 5n },
    { action: "addToControlList", account: ALICE },
    { action: "removeFromControlList", account: ALICE },
  ];
  check(intents.length === ACTIONS.length,
    `${intents.length} intents for ${ACTIONS.length} actions: one of them has no test`);
  for (const intent of intents) {
    const rendering = previewPrivileged(FACTS, intent);
    check(rendering.state === "screen",
      `${intent.action} did not produce a screen: ` +
      `${rendering.state === "refused" ? rendering.why : ""}`);
  }
}

group("a bad address never becomes calldata");
{
  const rendering = previewPrivileged(FACTS, { action: "revokeKyc", account: "0xnope" });
  check(rendering.state === "refused", "a malformed address produced a screen");
}

/* ------------------------------------------------------------------- asking */

group("a rendered action reaches propose exactly once, with our own bytes");
{
  const { context, asked } = spyContext();
  const intent: PrivilegedIntent = { action: "pause" };
  const outcome = await proposePrivileged(context, FACTS, intent);
  check(outcome.kind === "sent", `pause did not send: ${outcome.kind}`);
  check(asked.length === 1, `propose was called ${asked.length} times`);
  const proposal = asked[0];
  check(proposal?.kind === "call" && proposal.to === TOKEN,
    "the proposal was not addressed to the security that was read");
  check(proposal?.kind === "call" && proposal.data === encodePrivileged(intent),
    "the bytes proposed are not the bytes that were described");
  /* The app's reason is a label for the log, never a description of the call,
   * and the seam refuses one over 120 characters with the same opaque no as a
   * device rejection — so a long one would look like a user pressing reject. */
  check((proposal?.reason.length ?? 999) <= 120, "the app's reason exceeds the seam's limit");
}

group("a wallet that says no is reported as a decline, not as a refusal");
{
  const context: AppContext = {
    chainId: CHAIN,
    address: ALICE,
    request: async () => { throw new Error("no reads"); },
    propose: async () => ({ ok: false, text: "The wallet declined this request." } as ProposalOutcome),
  };
  const outcome = await proposePrivileged(context, FACTS, { action: "unpause" });
  check(outcome.kind === "declined", `expected declined, got ${outcome.kind}`);
  check(outcome.kind === "declined" && outcome.notice === DECLINED_NOTICE,
    "the decline notice was not the reviewed sentence");
}

group("no propose at all is a state, not a failure");
{
  const context: AppContext = {
    chainId: CHAIN, address: ALICE,
    request: async () => { throw new Error("no reads"); },
  };
  const outcome = await proposePrivileged(context, FACTS, { action: "pause" });
  check(outcome.kind === "cannot-ask", `expected cannot-ask, got ${outcome.kind}`);
  check(outcome.kind === "cannot-ask" && outcome.notice === NO_DEVICE_NOTICE,
    "the no-device notice was not the reviewed sentence");
}

/* ------------------------------------------------------- the rule, enforced */

group("H4: with the descriptor removed, the console refuses and never asks");
{
  /* The descriptor set minus one format. Built by deleting the key from the
   * JSON rather than by mocking a function, so what is being tested is the
   * real path: no descriptor matches, so there is no screen, so there is
   * nothing to approve. */
  const json = atsDescriptorJson(CHAIN, TOKEN) as {
    display: { formats: Record<string, unknown> };
  };
  const removed = Object.keys(json.display.formats)
    .find((k) => k.startsWith("pause(")) as string;
  delete json.display.formats[removed];
  const reduced = parseDescriptor(json, "test/reduced");
  check(reduced !== null, "the reduced descriptor document does not parse");

  const data = encodePrivileged({ action: "pause" });
  const rendering = describePrivilegedCall(FACTS, data, reduced === null ? [] : [reduced]);
  check(rendering.state === "refused", "a call with no descriptor produced a screen");
  check(rendering.state === "refused" && rendering.selector === data.slice(0, 10),
    "the refusal does not name the selector it could not describe");
  /* Every OTHER action must still work. A refusal that took the whole console
   * down with it would pass the assertion above and be a different bug. */
  const other = describePrivilegedCall(
    FACTS, encodePrivileged({ action: "unpause" }), reduced === null ? [] : [reduced]);
  check(other.state === "screen", "removing one descriptor disabled an unrelated action");
}

group("H4, at the seam: a refused rendering means propose is never called");
{
  /* `proposePrivileged` renders before it asks, so an intent this console
   * cannot describe must not reach the wallet at all — the wallet would refuse
   * it too, but a request that is never made cannot be approved by a tired
   * person pressing a button. */
  const { context, asked } = spyContext();
  const outcome = await proposePrivileged(context, FACTS, {
    action: "revokeKyc", account: "not-an-address",
  });
  check(outcome.kind === "refused", `expected refused, got ${outcome.kind}`);
  check(asked.length === 0, `propose was called ${asked.length} times for a refused action`);
}

group("a control list whose direction was never read refuses both edits");
{
  const blind: SecurityFacts = { chainId: CHAIN, address: TOKEN, name: "ACME Equity" };
  for (const action of ["addToControlList", "removeFromControlList"] as const) {
    const rendering = previewPrivileged(blind, { action, account: ALICE });
    check(rendering.state === "refused",
      `${action} rendered a screen without knowing whether the list permits or bars`);
  }
}

group("the frozen flag is rendered as a state, and read from the bytes");
{
  /* The brief's own example screen is a freeze, and this is the call where a
   * single bit inverts the sentence. Both directions are asserted, because a
   * screen that said "FROZEN" for an unfreeze would be the worst failure this
   * app can have: an approve button under a sentence describing the opposite
   * act. */
  const frozen = previewPrivileged(FACTS,
    { action: "setAddressFrozen", account: ALICE, frozen: true });
  check(frozen.state === "screen" && frozen.effect.includes("blocks every transfer"),
    `freezing must say what it blocks: ${frozen.state === "screen" ? frozen.effect : frozen.why}`);
  check(frozen.state === "screen" &&
    frozen.fields.some((f) => f.label === "Set to" && f.value === "FROZEN"),
    "the frozen flag is not rendered as a named state");

  const thawed = previewPrivileged(FACTS,
    { action: "setAddressFrozen", account: ALICE, frozen: false });
  check(thawed.state === "screen" && thawed.effect.includes("transfer again"),
    "unfreezing must say the holder can move again: " +
    `${thawed.state === "screen" ? thawed.effect : thawed.why}`);
  check(thawed.state === "screen" &&
    thawed.fields.some((f) => f.label === "Set to" && f.value === "not frozen"),
    "the unfrozen state is not named");

  /* A word that is neither 0 nor 1 is not a bool. Reachable only from calldata
   * this console did not build, which is exactly when it matters. */
  const junk = describePrivilegedCall(FACTS,
    `0x${selectorOf("setAddressFrozen(address,bool)")}` +
    ALICE.slice(2).padStart(64, "0") + "2".padStart(64, "0"));
  check(junk.state === "refused", "a frozen flag of 2 was rendered as a bool");
}

/* ------------------------------------------------- the other side of the seam */

group("core accepts these descriptors and refuses without them");
{
  /* The wiring, proved without a device. `screenProposal` is the gate the shell
   * puts every app proposal through, and it judges independently of this app:
   * every argument must render, and the descriptor's reading must not disagree
   * with the firmware-mirroring decoder about what the calldata says. An app
   * offering a descriptor is offering EVIDENCE; this is core deciding.
   *
   * Both directions are asserted, and the second is the one that matters. ATS
   * calls have static arguments, so they can have descriptors and therefore
   * must — `DEVICE_DRAWN_KINDS` is not for them and is deliberately untouched.
   * With no descriptor offered, core refuses, which is what would happen if
   * this app tried to route around the descriptor rule. */
  const offered = ATS_APP.descriptors?.(CHAIN, TOKEN) ?? [];
  check(offered.length > 0, "the app offers no descriptors for its own security");

  const cases: PrivilegedIntent[] = [
    { action: "grantRole", role: ISSUER, account: ALICE },
    { action: "pause" },
    { action: "revokeKyc", account: ALICE },
  ];
  for (const intent of cases) {
    const proposal: AppProposal = {
      kind: "call", to: TOKEN, data: encodePrivileged(intent), reason: "test",
    };
    const withDescriptors = screenProposal(proposal, {
      chainId: CHAIN, from: ALICE, descriptors: [...DEFAULT_DESCRIPTORS, ...offered],
    });
    check(withDescriptors.kind === "ok",
      `core refused ${intent.action} with the app's descriptors: ` +
      `${withDescriptors.kind === "refused" ? withDescriptors.why : ""}`);

    const without = screenProposal(proposal, {
      chainId: CHAIN, from: ALICE, descriptors: DEFAULT_DESCRIPTORS,
    });
    check(without.kind === "refused",
      `core accepted ${intent.action} with NO descriptor; the rule has been lost`);
  }

  /* Chain scoping. The same bytes at the same address on a different chain are
   * a different call, and a descriptor built for 296 must not describe it. */
  const wrongChain = screenProposal(
    { kind: "call", to: TOKEN, data: encodePrivileged({ action: "pause" }), reason: "test" },
    { chainId: 1, from: ALICE, descriptors: [...DEFAULT_DESCRIPTORS, ...offered] },
  );
  check(wrongChain.kind === "refused", "a chain-296 descriptor described a mainnet call");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
