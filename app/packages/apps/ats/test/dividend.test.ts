/**
 * THE PROPERTY: a distribution whose total does not equal per-share × snapshot
 * supply refuses.
 *
 * That sentence is the audit gate for C3, and it is the first group below. The
 * rest of the file is the two properties it depends on and the one it enables:
 *
 *  - the holders' balances must add up to the snapshot's supply, or "reconciles
 *    to the snapshot" is a sentence about two different registers;
 *  - every holder's amount must be a whole number of payment units, so the
 *    allocations sum to the total exactly rather than nearly;
 *  - a stopped payout resumes without paying anybody twice.
 *
 * No DOM, no network, no device. Everything here is arithmetic and a ledger.
 */

import {
  nextPayment, openLedger, paidSoFar, paymentFor, planDividend, record,
  renderDividendPlan, resumeDistribution, totalForSnapshot,
  type DividendTerms, type SnapshotHolder,
} from "../src/dividend.ts";
import { encodeDividend, payNext, resolveUncertain } from "../src/act.ts";
import { previewPrivileged } from "../src/act.ts";
import type { SecurityFacts } from "../src/action.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import type { AppProposal, ProposalOutcome } from "@leekwallet/core/app-proposal.ts";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string): void => console.log(`== ${n}`);

const CHAIN = 296;
const TOKEN = "0x00000000000000000000000000000000004e5f21";
const PAY = "0x0000000000000000000000000000000000068cda";
const ALICE = "0x000000000000000000000000000000000048a1b2";
const BOB = "0x000000000000000000000000000000000048b3c4";
const CAROL = "0x000000000000000000000000000000000048c5d6";

const FACTS: SecurityFacts = {
  chainId: CHAIN, address: TOKEN, name: "ACME Equity", decimals: 2, controlListType: true,
};

/**
 * The worked example: three holders, 1,400 whole shares between them, 25 payment
 * units per whole share. 25 × 140000 / 100 = 35,000 — the plan's own screen,
 * with the decimals of a six-decimal token left to the renderer.
 */
const HOLDERS: SnapshotHolder[] = [
  { address: ALICE, shares: 100000n },
  { address: BOB, shares: 30000n },
  { address: CAROL, shares: 10000n },
];

const terms = (over: Partial<DividendTerms> = {}): DividendTerms => ({
  snapshot: { id: 3n, totalSupply: 140000n, holderCount: 3n, decimals: 2 },
  token: { address: PAY, decimals: 6, reportedSymbol: "USDC" },
  perShare: 25n,
  statedTotal: 35000n,
  recordDate: 1893456000n,
  executionDate: 1893542400n,
  ...over,
});

const planOf = (over: Partial<DividendTerms> = {}, holders = HOLDERS) =>
  planDividend(CHAIN, TOKEN, terms(over), holders);

/* ========================================================== THE PROPERTY === */

group("THE PROPERTY: a total that is not per-share × snapshot supply refuses");
{
  const right = planOf();
  check(right.state === "plan",
    `the reconciling distribution did not plan: ${right.state === "refused" ? right.why : ""}`);
  check(right.state === "plan" && right.total === 35000n,
    "the computed total is not per-share × snapshot supply");

  /* One unit out, in both directions. Not "close enough": a dividend that is
   * one unit over has to take that unit from somewhere, and one unit under
   * leaves a holder short — and neither is visible in a rounded display. */
  for (const wrong of [34999n, 35001n, 0n, 3500000n]) {
    const off = planOf({ statedTotal: wrong });
    check(off.state === "refused", `a stated total of ${wrong} was accepted`);
    check(off.state === "refused" && off.why.includes("35000"),
      "the refusal does not say what the total should have been");
  }

  /* The same property from the other side: change the rate and keep the total,
   * which is how the mistake actually happens — the issuer edits one field. */
  const rateChanged = planOf({ perShare: 26n });
  check(rateChanged.state === "refused",
    "changing the per-share rate without the total was accepted");

  /* And with a different snapshot. Picking snapshot #2 by mistake and leaving
   * the figures from #3 is the same failure wearing a different hat. */
  const otherSnapshot = planOf({
    snapshot: { id: 2n, totalSupply: 100000n, holderCount: 3n, decimals: 2 },
  });
  check(otherSnapshot.state === "refused",
    "a total computed against a different snapshot was accepted");
}

group("THE PROPERTY holds at the encoder too, not only at the planner");
{
  /* A `DividendPlan` is a plain object, so a caller could build one by hand or
   * mutate one. The bytes are where it would matter, so the bytes recompute. */
  const plan = planOf();
  if (plan.state !== "plan") throw new Error("fixture");
  const tampered = { ...plan, total: 35001n };
  let threw = false;
  try { encodeDividend(tampered); } catch { threw = true; }
  check(threw, "a plan whose total was edited after planning still encoded");

  const tamperedTerms = {
    ...plan,
    terms: { ...plan.terms, statedTotal: 1n },
  };
  let threw2 = false;
  try { encodeDividend(tamperedTerms); } catch { threw2 = true; }
  check(threw2, "a plan whose stated total was edited after planning still encoded");

  // And the honest one still produces four words, in the contracts' order.
  const data = encodeDividend(plan);
  check(data.length === 4 * 64, `the dividend struct is ${data.length / 64} words, expected 4`);
  check(BigInt(`0x${data.slice(0, 64)}`) === 1893456000n, "word 0 is not the record date");
  check(BigInt(`0x${data.slice(64, 128)}`) === 1893542400n, "word 1 is not the execution date");
  check(BigInt(`0x${data.slice(128, 192)}`) === 35000n, "word 2 is not the total");
  check(BigInt(`0x${data.slice(192, 256)}`) === 6n, "word 3 is not the payment token's decimals");
}

/* ==================================================== reconciling and units */

group("holders' balances must add up to the snapshot's supply");
{
  const short = planOf({}, [{ address: ALICE, shares: 100000n }, { address: BOB, shares: 30000n },
    { address: CAROL, shares: 9999n }]);
  check(short.state === "refused", "a holder list that does not sum to the supply was accepted");
  check(short.state === "refused" && short.why.includes("two different registers"),
    "the refusal does not say that the two figures describe different registers");

  const missing = planOf({}, HOLDERS.slice(0, 2));
  check(missing.state === "refused", "a partial holder list was accepted");
  check(missing.state === "refused" && missing.why.includes("underpays"),
    "the refusal does not say who is hurt by a partial list");
}

group("every holder's amount is a whole number of payment units, or nothing is");
{
  // 1 unit per whole share over a holder with 0.005 shares is 0.05 units.
  const dusty = planOf(
    { perShare: 1n, statedTotal: 1400n },
    [{ address: ALICE, shares: 139999n }, { address: BOB, shares: 1n },
      { address: CAROL, shares: 0n }],
  );
  check(dusty.state === "refused", "a distribution that cannot pay a holder in whole units planned");
  check(dusty.state === "refused" && dusty.why.includes("Rounding"),
    "the refusal does not explain why rounding is not offered");

  check(paymentFor(25n, 100000n, 2) === 25000n, "the payment maths is wrong");
  check(paymentFor(25n, 1n, 2) === undefined, "an inexact payment was rounded rather than refused");
  // No floating point anywhere: this is past 2^53 and must stay exact.
  check(paymentFor(1n, 10n ** 24n, 0) === 10n ** 24n, "a large payment lost precision");
}

group("the allocations sum to exactly the total on the device screen");
{
  const plan = planOf();
  if (plan.state !== "plan") throw new Error("fixture");
  const sum = plan.allocations.reduce((a, x) => a + x.amount, 0n);
  check(sum === plan.total, `allocations sum to ${sum}, total is ${plan.total}`);
  check(plan.allocations.length === 3, "an allocation went missing");
  check(plan.allocations[0]?.amount === 25000n, "the largest holder's share is wrong");
  // Proportional: Bob holds 30% of Alice's shares and is paid 30% of her amount.
  check(plan.allocations[1]?.amount === 7500n, "the second holder is not paid proportionally");
  check(plan.allocations[2]?.amount === 2500n, "the third holder is not paid proportionally");
}

group("a zero-supply or zero-rate distribution has nothing to reconcile");
{
  check(totalForSnapshot(0n, terms().snapshot).state === "refused", "a zero rate was accepted");
  check(
    totalForSnapshot(25n, { id: 1n, totalSupply: 0n, holderCount: 0n, decimals: 2 }).state
      === "refused",
    "a snapshot with no supply was accepted",
  );
}

/* ================================================================ the screen */

group("the screen says what it knows and quotes what it does not");
{
  const plan = planOf();
  if (plan.state !== "plan") throw new Error("fixture");
  const text = renderDividendPlan(plan);
  check(text.includes("#3"), "the summary does not name the snapshot");
  check(text.includes("3 holders"), "the summary does not say how many holders");
  check(text.includes("0.035") || text.includes("35000"), "the summary does not state the total");
  /* PROTOCOL.md 6d: the symbol is the token contract's own claim about itself.
   * It may appear as a quotation, attributed, and never as the unit of a
   * number — "35000 USDC" would be this app asserting something it never
   * checked. */
  check(text.includes("unverified"), "the reported symbol is presented without its caveat");
  check(!/[\d.]+\s+USDC/.test(text), "an unverified symbol is used as the unit of an amount");
  check(text.includes(PAY), "the summary does not name the payment token's address");
  check(text.includes("binds its own snapshot"),
    "the summary hides that setDividend takes no snapshot id");

  // The device's screen is built from the calldata, by our own code, and it
  // restates the total using the scale that is IN the calldata.
  const screen = previewPrivileged(FACTS, { action: "setDividend", plan });
  check(screen.state === "screen",
    `the dividend did not render: ${screen.state === "refused" ? screen.why : ""}`);
  if (screen.state === "screen") {
    check(screen.title === "DISTRIBUTE DIVIDEND · ACME Equity",
      `the title is "${screen.title}"`);
    const total = screen.fields.find((f) => f.label === "Total");
    check(total?.value === "0.035 (35000 raw units)",
      `the total is rendered as "${total?.value}"`);
    check(screen.fields.some((f) => f.label === "Record"), "the record date is not on the screen");
    check(screen.effect.includes("transfers nothing by itself"),
      "the screen does not say that declaring a dividend moves no money");
  }
}

/* ============================================================ resumability */

/** A context whose `propose` answers as told, and counts what it was asked. */
function spy(answers: ProposalOutcome[]): { context: AppContext; asked: AppProposal[] } {
  const asked: AppProposal[] = [];
  let i = 0;
  return {
    asked,
    context: {
      chainId: CHAIN,
      address: ALICE,
      request: async () => { throw new Error("no reads"); },
      propose: async (p: AppProposal) => {
        asked.push(p);
        return answers[i++] ?? { ok: true, kind: "call", result: `0xhash${i}` };
      },
    },
  };
}

group("a partial payout resumes, and never pays the same holder twice");
{
  const plan = planOf();
  if (plan.state !== "plan") throw new Error("fixture");

  const { context, asked } = spy([]);
  let ledger = openLedger(plan);
  const first = await payNext(context, plan, ledger);
  check(first.kind === "paid", `the first payment did not go: ${first.kind}`);
  ledger = first.ledger;

  // Interrupted here: the window closes. The ledger is the only state.
  const serialised = JSON.stringify(ledger);
  const revived = JSON.parse(serialised) as typeof ledger;
  const resumed = resumeDistribution(plan, revived);
  check(resumed.state === "resumed", "a ledger that came back as JSON would not resume");
  check(resumed.state === "resumed" && resumed.done === 1 && resumed.remaining === 2,
    "the resumed run does not know how far it got");

  const step = nextPayment(plan, revived);
  check(step.state === "pay" && step.allocation.address === BOB,
    "the resumed run does not continue with the SECOND holder");

  // Run it to the end and count: three holders, three transfers, no repeats.
  let running = revived;
  for (let i = 0; i < 5; i++) {
    const attempt = await payNext(context, plan, running);
    running = attempt.ledger;
    if (attempt.kind === "complete") break;
  }
  check(asked.length === 3, `${asked.length} transfers for 3 holders`);
  const paidTo = asked.map((p) => (p.kind === "call" ? p.data.slice(34, 74) : ""));
  check(new Set(paidTo).size === 3, "the same holder was paid twice");
  check(paidSoFar(plan, running) === plan.total, "the finished payout does not sum to the total");
  check(nextPayment(plan, running).state === "complete", "the finished payout is not complete");
}

group("a ledger from another distribution refuses rather than resuming");
{
  const plan = planOf();
  const other = planOf({ perShare: 50n, statedTotal: 70000n });
  if (plan.state !== "plan" || other.state !== "plan") throw new Error("fixture");
  check(plan.planId !== other.planId, "two different distributions have the same plan id");

  const paid = record(openLedger(other), ALICE, { state: "paid", tx: "0xabc" });
  check(resumeDistribution(plan, paid).state === "refused",
    "a ledger from a different distribution was adopted");
  const step = nextPayment(plan, paid);
  check(step.state === "blocked", "a mismatched ledger produced a payment instead of a refusal");
  /* The specific danger: the mismatched ledger says Alice is paid. If it were
   * adopted, Alice would be skipped at the new rate and underpaid; if the
   * plan ids were ignored the other way round, she would be paid twice. */
  check(step.state === "blocked" && step.why.includes("twice"),
    "the refusal does not say what it is protecting against");
}

group("an unknown outcome stops the run instead of retrying it");
{
  const plan = planOf();
  if (plan.state !== "plan") throw new Error("fixture");
  /* The wallet answers with the seam's single opaque no. It covers a rejection
   * AND a connection lost after signing, and only a person can tell which — so
   * the holder is uncertain, the run blocks, and nothing is re-asked. */
  const { context, asked } = spy([{ ok: false, text: "The wallet declined this request." }]);
  const attempt = await payNext(context, plan, openLedger(plan));
  check(attempt.kind === "uncertain", `a decline was read as ${attempt.kind}`);
  check(asked.length === 1, "the payment was asked for more than once");

  const blocked = nextPayment(plan, attempt.ledger);
  check(blocked.state === "blocked", "an uncertain holder did not block the run");
  const again = await payNext(context, plan, attempt.ledger);
  check(again.kind === "blocked", "the blocked run re-asked for the uncertain payment");
  check(asked.length === 1, `the uncertain holder was asked for ${asked.length} times`);

  // A person looks at the chain and says it did not happen. Now it may be paid.
  const resolved = resolveUncertain(attempt.ledger, ALICE, { paid: false, why: "no transfer found" });
  const next = nextPayment(plan, resolved);
  check(next.state === "pay" && next.allocation.address === ALICE,
    "a holder resolved as not-paid is not offered again");

  // Or it did happen, and the hash is recorded. Then it is never offered again.
  const settled = resolveUncertain(attempt.ledger, ALICE, { paid: true, tx: "0xfeed" });
  const after = nextPayment(plan, settled);
  check(after.state === "pay" && after.allocation.address === BOB,
    "a holder resolved as paid was offered again");
}

group("a throw out of propose is uncertain, not a failure to pay");
{
  const plan = planOf();
  if (plan.state !== "plan") throw new Error("fixture");
  const context: AppContext = {
    chainId: CHAIN, address: ALICE,
    request: async () => { throw new Error("no reads"); },
    propose: async () => { throw new Error("the transport went away"); },
  };
  const attempt = await payNext(context, plan, openLedger(plan));
  check(attempt.kind === "uncertain", `a thrown propose was read as ${attempt.kind}`);
  check(nextPayment(plan, attempt.ledger).state === "blocked",
    "a thrown propose left the run runnable");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
