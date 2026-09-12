/**
 * The deploy call: its selectors, its calldata, and the two refusals.
 *
 * The load-bearing group is the first one. `LEEK_SECURITY_FACTORY` is now the
 * deployed contract, pinned here so a silent edit fails a test rather than
 * sending a deploy somewhere nobody checked — and the refusal path for an
 * ABSENT one is exercised alongside it, by passing the address in. The safety
 * argument of issue.ts is that no address produces a SENTENCE rather than
 * calldata aimed at the zero address, which would encode, preview and send
 * exactly like the real thing; that path should never fire in this build, and
 * it is tested precisely so clearing the constant stays a safe edit.
 *
 * The second group is the encoder, checked against a decoder rather than
 * against a second copy of the same arithmetic: `decodeDeploy` insists on the
 * canonical layout — offsets where an encoder must have put them, zero padding,
 * nothing trailing — so a round trip is evidence the bytes are what an ABI
 * encoder elsewhere would produce, not just self-consistent.
 */

import {
  DEVICE_CANNOT_DRAW_NOTICE, ETH_MAX_DATA, FACTORY_UNSET_NOTICE,
  ISSUE_SELECTOR, ISSUE_SIG, ISSUE_TOPIC, LEEK_SECURITY_FACTORY,
  MAX_NAME_BYTES, MAX_SYMBOL_BYTES,
  decodeDeploy, encodeDeploy, planIssue, runIssue,
} from "../src/issue.ts";
import { selectorOf } from "../src/abi.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const FACTORY = "0x1111111111111111111111111111111111111111";

group("the factory address, and what an absent one does");
{
  /* Widened to `string` deliberately: the constant's literal type makes the
   * compiler call a comparison against "" unreachable, and the check is about
   * what a future edit might put there, not about what is there today. */
  const configured: string = LEEK_SECURITY_FACTORY;
  /* Either empty, or a well-formed lower-case address. A half-typed value
   * fails here rather than in a transaction. */
  check(configured === "" || /^0x[0-9a-f]{40}$/.test(configured),
    `LEEK_SECURITY_FACTORY is neither unset nor an address: "${configured}"`);
  /* The deployed contract, pinned: it was verified on chain (see the constant's
   * own comment for the transaction and the live reads), and a silent edit to
   * an address nobody checked should fail a test rather than send a deploy
   * somewhere else. */
  check(configured === "0x3a56974075d734afa5bf7f63e34f9c3237408aed",
    `LEEK_SECURITY_FACTORY is ${configured}, not the deployed factory`);

  const refused = planIssue({ kind: "deployEquity", name: "Acme", symbol: "ACME" }, "");
  check(refused.ok === false, "an unset factory produced a plan");
  check(!refused.ok && refused.reason === FACTORY_UNSET_NOTICE,
    "the refusal is not the notice that names the constant");
  check(/LEEK_SECURITY_FACTORY/.test(FACTORY_UNSET_NOTICE),
    "the refusal does not name the constant a human must fill in");

  /* The zero address is refused SEPARATELY from the empty string, because it
   * is the failure mode a default would have produced. */
  const zero = planIssue(
    { kind: "deployEquity", name: "Acme", symbol: "ACME" },
    "0x0000000000000000000000000000000000000000",
  );
  check(zero.ok === false, "the zero address produced a plan");
  check(!zero.ok && /zero address/.test(zero.reason), "the zero address refusal does not say so");

  const junk = planIssue({ kind: "deployEquity", name: "A", symbol: "A" }, "0xnope");
  check(junk.ok === false, "a malformed factory address produced a plan");
}

group("the device draws a deploy, and the notice says what it will show");
{
  const plan = planIssue({ kind: "deployEquity", name: "Acme Equity", symbol: "ACME" }, FACTORY);
  check(plan.ok === true, "a well-formed request was refused");
  /* Was `true` until 2026-09-11. The firmware gained a decoder
   * (ats_decode_two_strings), core gained the mirror (decodeTwoStrings), the
   * device gained three pages, and both kinds went into DEVICE_DRAWN_KINDS —
   * so the wallet no longer refuses this at the seam. The field stays in the
   * shape because it is still the honest answer to "will this be refused
   * before the device sees it?". */
  check(plan.ok && plan.deviceWillDecline === false,
    "the plan still claims the wallet will decline a call the device now draws");

  /* The notice has to carry the two things a user cannot discover by pressing:
   * which strings are refusable, and that an older board has no decoder for
   * this selector and will refuse at the device instead. */
  check(/ASCII/.test(DEVICE_CANNOT_DRAW_NOTICE),
    "the notice does not say which strings the device will refuse");
  check(/2026-09-11/.test(DEVICE_CANNOT_DRAW_NOTICE),
    "the notice does not warn that a board older than the decoder refuses");
  check(/not a device screen/.test(DEVICE_CANNOT_DRAW_NOTICE),
    "the notice no longer says the preview is not an approval");
}

group("selectors and topics are derived, never typed");
{
  check(ISSUE_SELECTOR.deployEquity === selectorOf(ISSUE_SIG.deployEquity),
    "the equity selector is not keccak of its signature");
  check(ISSUE_SELECTOR.deployBond === selectorOf(ISSUE_SIG.deployBond),
    "the bond selector is not keccak of its signature");
  check(ISSUE_SELECTOR.deployEquity !== ISSUE_SELECTOR.deployBond,
    "equity and bond share a selector");
  /* Both topics are full 32-byte words and differ: a wrong one filters nothing
   * and renders as "you have issued nothing", which is the sentence this app
   * must never produce by accident. */
  for (const [k, t] of Object.entries(ISSUE_TOPIC)) {
    check(/^0x[0-9a-f]{64}$/.test(t), `${k}: the topic is not a 32-byte word`);
  }
  check(ISSUE_TOPIC.deployEquity !== ISSUE_TOPIC.deployBond, "both events share a topic");
}

group("the calldata round-trips through a canonical decoder");
{
  for (const [name, symbol] of [
    ["Acme Equity", "ACME"],
    ["a", "b"],
    ["A".repeat(MAX_NAME_BYTES), "S".repeat(MAX_SYMBOL_BYTES)],
    /* A 32-byte name, so the second offset lands exactly on a word boundary —
     * the arithmetic most likely to be off by one word. */
    ["0123456789012345678901234567890a", "SYM"],
  ] as const) {
    for (const kind of ["deployEquity", "deployBond"] as const) {
      const data = encodeDeploy(kind, name, symbol);
      const read = decodeDeploy(data);
      check(!("ok" in read), `${kind} ${name.length}/${symbol.length}: did not decode`);
      if ("ok" in read) continue;
      check(read.kind === kind, `${kind}: decoded as ${read.kind}`);
      check(read.name === name, `${kind}: the name did not round-trip`);
      check(read.symbol === symbol, `${kind}: the symbol did not round-trip`);
      check(data.startsWith(`0x${ISSUE_SELECTOR[kind]}`), `${kind}: wrong selector on the wire`);
      check((data.length - 2) % 64 === 8, `${kind}: the calldata is not selector + whole words`);
    }
  }

  /* Non-canonical layouts are refused rather than read as far as they parse. */
  const good = encodeDeploy("deployEquity", "Acme", "ACME");
  const withTrailer = `${good}00`;
  check("ok" in decodeDeploy(withTrailer), "trailing bytes were accepted");
  const wrongSelector = `0xdeadbeef${good.slice(10)}`;
  check("ok" in decodeDeploy(wrongSelector), "a foreign selector decoded as a deploy");
  check("ok" in decodeDeploy("0x1234"), "a stub of calldata decoded as a deploy");
  /* Dirty padding: the last byte of the name's padding flipped to 1. */
  const dirty = `${good.slice(0, -2)}01`;
  check("ok" in decodeDeploy(dirty), "non-zero padding was accepted");
}

group("the bounds are the contract's, and the screen's are narrower");
{
  const plan = (name: string, symbol: string) =>
    planIssue({ kind: "deployEquity", name, symbol }, FACTORY);

  check(plan("", "ACME").ok === false, "an empty name was accepted");
  check(plan("Acme", "").ok === false, "an empty symbol was accepted");
  check(plan("A".repeat(MAX_NAME_BYTES), "ACME").ok === true,
    "a name at the contract's limit was refused");
  check(plan("A".repeat(MAX_NAME_BYTES + 1), "ACME").ok === false,
    "a name past the contract's limit was accepted, and would revert after the press");
  check(plan("Acme", "S".repeat(MAX_SYMBOL_BYTES + 1)).ok === false,
    "a symbol past the contract's limit was accepted");
  /* Bytes, not characters: the contract counts bytes and so must this. */
  check(plan("é".repeat(MAX_NAME_BYTES), "ACME").ok === false,
    "a name of 64 two-byte characters was measured in characters, not bytes");
  /* Narrower than the contract on purpose: a bidi override renders one string
   * here and another on the device. */
  check(plan("Acme‮Equity", "ACME").ok === false, "a direction override was accepted");
  check(plan("Acme", "AC ME").ok === false, "a control character was accepted");
  check(plan("Acme", "ACMÉ").ok === false, "a non-ASCII symbol was accepted");

  const sized = plan("A".repeat(MAX_NAME_BYTES), "S".repeat(MAX_SYMBOL_BYTES));
  check(sized.ok && sized.dataBytes <= ETH_MAX_DATA,
    "the largest call this console builds does not fit the device's calldata limit");
  check(sized.ok && sized.dataBytes === 228,
    `the largest call is ${sized.ok ? sized.dataBytes : "?"} bytes, expected 228`);
}

group("the preview is decoded from the bytes, not echoed from the form");
{
  /* Whitespace is trimmed before encoding, so the decoded preview is the
   * trimmed string — which is what the transaction will carry. A panel that
   * echoed the field would show the untrimmed one. */
  const plan = planIssue({ kind: "deployBond", name: "  Acme Bond  ", symbol: " ACMB " }, FACTORY);
  check(plan.ok === true, "a padded name was refused");
  check(plan.ok && plan.decoded.name === "Acme Bond", "the preview is not the encoded name");
  check(plan.ok && plan.decoded.symbol === "ACMB", "the preview is not the encoded symbol");
  check(plan.ok && plan.to === FACTORY, "the plan does not point at the factory");
}

group("asking, without a device and with a refusal");
{
  const noDevice = { chainId: 296, address: FACTORY, request: async () => undefined } as
    unknown as AppContext;
  const plan = planIssue({ kind: "deployEquity", name: "Acme", symbol: "ACME" }, FACTORY);

  const run = async (): Promise<void> => {
    const cannot = await runIssue(noDevice, plan);
    check(cannot.kind === "cannot-ask", `no device gave ${cannot.kind}, not cannot-ask`);

    const refusedPlan = planIssue({ kind: "deployEquity", name: "Acme", symbol: "ACME" }, "");
    const refused = await runIssue(noDevice, refusedPlan);
    check(refused.kind === "refused", "a refused plan was still asked about");

    /* A wallet that says no gives one opaque decline, and nothing is sent. */
    const declining = {
      ...noDevice,
      propose: async () => ({ ok: false as const, text: "declined" as never }),
    } as unknown as AppContext;
    const declined = await runIssue(declining, plan);
    check(declined.kind === "declined", `a declining wallet gave ${declined.kind}`);

    const signing = {
      ...noDevice,
      propose: async () => ({ ok: true as const, kind: "call" as const, result: "0xabc" }),
    } as unknown as AppContext;
    const sent = await runIssue(signing, plan);
    check(sent.kind === "sent", `a signing wallet gave ${sent.kind}`);
    check(sent.kind === "sent" && sent.result === "0xabc", "the transaction hash was lost");

    console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
  };
  void run();
}
