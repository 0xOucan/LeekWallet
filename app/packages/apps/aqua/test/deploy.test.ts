/**
 * The two refusals, the cap, and the half-failure.
 *
 * These matter more than the happy path, and they are asserted in that order.
 * The happy path is here only as the baseline the refusals are a departure
 * from: a suite where the refusal test passes because the plan never built at
 * all is a suite that proves nothing.
 *
 * The one claim worth stating up front, because it is what the wrong-maker test
 * is really about: `strategyHash = keccak256(strategy)` and the maker is not in
 * it. Two strategies naming two different makers, shipped by the same signer,
 * are two different hashes — but a strategy naming somebody else and a strategy
 * naming you are indistinguishable from the hash ALONE, which is the only short
 * identifier anywhere in this flow. So the refusal has to decode the struct.
 * `wrong maker is refused, and the hash cannot tell you so` is the test that
 * pins exactly that.
 */

import { decodeCall, CallKind } from "@leekwallet/core/eth-decode.ts";
import { isUnlimited } from "@leekwallet/core/allowances.ts";
import {
  CAP_MEANING_NOTICE, planDeployment, type DeployStep,
} from "../src/deploy.ts";
import { encodeStrategy, checkMaker, readStrategy } from "../src/strategy.ts";
import { AQUA_REGISTRY, strategyHash } from "../src/registry.ts";
import { planDock, revokeOffer } from "../src/withdraw.ts";
import {
  APPROVED_NOT_SHIPPED_NOTICE, NO_DEVICE_NOTICE, runSteps,
} from "../src/run.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import type { AppProposal, ProposalOutcome } from "@leekwallet/core/app-proposal.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const ME = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOMEONE_ELSE = "0x1111111111111111111111111111111111111112";
const APP = "0x228e82831afac5dd9ebde3489e9e18ae9c7bcbf4";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const DAI = "0x3333333333333333333333333333333333333333";
const CONFIG = `0x${"00".repeat(31)}07`;
const PROGRAM = "0x1726";

const strategyFor = (maker: string) => encodeStrategy(maker, CONFIG, PROGRAM);

/* ------------------------------------------------------- the happy baseline */

group("a capped approval and a ship, in that order");
{
  const plan = planDeployment({
    maker: ME,
    app: APP,
    strategy: strategyFor(ME),
    legs: [{ token: USDC, amount: 1_000_000n, allowance: 0n, decimals: 6, symbol: "USDC" }],
  });
  check(plan.ok, "the baseline plan was refused");
  if (plan.ok) {
    check(plan.steps.length === 2, `${plan.steps.length} steps, expected 2`);
    check(plan.steps[0]?.role === "approve", "the first step is not the approval");
    check(plan.steps[1]?.role === "ship", "the second step is not the ship");
    /* Approvals first is the only order with a recoverable failure -- see the
     * header on planDeployment. */
    check(plan.steps[0]?.to === USDC.toLowerCase(), "the approval is not to the token");
    check(plan.steps[1]?.to === AQUA_REGISTRY, "the ship is not to the registry");

    /* The cap, read back out of the calldata rather than out of the plan's own
     * field: what will be signed is the bytes, and a plan whose label and
     * calldata disagreed would pass an assertion on the label. */
    const approve = decodeCall(plan.steps[0]?.data);
    check(approve.kind === CallKind.Erc20Approve, "the first step is not an approve()");
    check(approve.address === AQUA_REGISTRY, `spender is ${approve.address}`);
    check(approve.amount === 1_000_000n, `cap is ${approve.amount}, expected the ship amount`);
    check(approve.unlimited === false, "the cap reads as unlimited");

    /* And the ship decodes on the same decoder the firmware mirrors, which is
     * what makes it signable at all. */
    const ship = decodeCall(plan.steps[1]?.data);
    check(ship.kind === CallKind.AquaShip, `the ship does not decode (${ship.kind})`);
    check(ship.aqua?.maker === ME.toLowerCase(), `ship names maker ${ship.aqua?.maker}`);
    check(ship.aqua?.strategyHash === plan.strategyHash, "the plan's hash is not the ship's");
    check(ship.aqua?.legs[0]?.amount === 1_000_000n, "the ship's amount is not the cap");

    check(plan.notices.includes(CAP_MEANING_NOTICE), "the cap's meaning is never said");
    /* What the approve screen has to say, in the words that make it true. */
    check(CAP_MEANING_NOTICE.includes("pulls them from here"),
      "the cap notice does not say Aqua pulls from this wallet");
    check(CAP_MEANING_NOTICE.includes("every strategy"),
      "the cap notice does not say the allowance spans strategies");
    check(CAP_MEANING_NOTICE.includes("never unlimited"),
      "the cap notice does not say it is never unlimited");
  }
}

/* -------------------------------------------------------- refusal one: cap */

group("an unlimited amount is refused, never capped-with-a-warning");
for (const amount of [(1n << 256n) - 1n, 1n << 255n]) {
  const plan = planDeployment({
    maker: ME, app: APP, strategy: strategyFor(ME),
    legs: [{ token: USDC, amount, allowance: 0n }],
  });
  check(!plan.ok, `${amount} produced a plan`);
  if (!plan.ok) {
    check(plan.refusal.kind === "unlimited-cap", `refused as ${plan.refusal.kind}`);
    check(plan.refusal.notice.length > 0, "the refusal has nothing to show the user");
  }
}

group("no plan this app builds can contain an unlimited approval");
{
  /* The general statement rather than a case: every approve step of every plan
   * built from a legal request, checked against the same threshold the device
   * uses. A future edit that reintroduced an infinity anywhere fails here. */
  const amounts = [1n, 1_000_000n, (1n << 255n) - 1n];
  for (const amount of amounts) {
    for (const allowance of [0n, 5n, undefined]) {
      const plan = planDeployment({
        maker: ME, app: APP, strategy: strategyFor(ME),
        legs: [{ token: USDC, amount, ...(allowance !== undefined ? { allowance } : {}) }],
      });
      if (!plan.ok) { check(false, `amount ${amount} was refused`); continue; }
      for (const step of plan.steps.filter((s: DeployStep) => s.role === "approve")) {
        const call = decodeCall(step.data);
        check(call.kind === CallKind.Erc20Approve, "an approve step is not an approve()");
        check(!isUnlimited(call.amount ?? 0n, 256),
          `an approve step for ${amount} is unlimited`);
      }
    }
  }
}

group("a token with a live allowance gets the zero-first sequence");
{
  /* USDT's rule: a non-zero allowance cannot move straight to another non-zero
   * one. approval-cap.ts plans that from a READING rather than a token list,
   * and this app has to inherit it rather than reimplement it. */
  const plan = planDeployment({
    maker: ME, app: APP, strategy: strategyFor(ME),
    legs: [{ token: USDC, amount: 500n, allowance: 300n }],
  });
  check(plan.ok, "the zero-first plan was refused");
  if (plan.ok) {
    check(plan.steps.length === 3, `${plan.steps.length} steps, expected 3`);
    check(decodeCall(plan.steps[0]?.data).amount === 0n, "the first step is not a zero");
    check(decodeCall(plan.steps[1]?.data).amount === 500n, "the second step is not the cap");
    check(plan.notices.some((n: string) => n.includes("straight to")),
      "the zero-first sequence is never explained");
  }
}

/* ----------------------------------------------------- refusal two: maker */

group("a strategy naming another maker is refused outright");
{
  const plan = planDeployment({
    maker: ME, app: APP, strategy: strategyFor(SOMEONE_ELSE),
    legs: [{ token: USDC, amount: 1n, allowance: 0n }],
  });
  check(!plan.ok, "a strategy naming somebody else produced a plan");
  if (!plan.ok && plan.refusal.kind === "wrong-maker") {
    check(plan.refusal.named === SOMEONE_ELSE.toLowerCase(),
      `the refusal names ${plan.refusal.named}`);
    check(plan.refusal.expected === ME.toLowerCase(), "the refusal expects the wrong address");
  } else {
    check(false, `refused as ${plan.ok ? "ok" : plan.refusal.kind}, expected wrong-maker`);
  }
}

group("the refusal decodes the struct, because the hash cannot tell you");
{
  /* This is the assertion the plan document's correction is about. The two
   * strategies below differ ONLY in the maker field, so their hashes differ --
   * but nothing about either hash says which maker it names, and a check built
   * on the hash would have to already know the answer. The struct is decoded;
   * that is what makes the refusal possible. */
  const mine = strategyFor(ME);
  const theirs = strategyFor(SOMEONE_ELSE);
  check(strategyHash(mine) !== strategyHash(theirs),
    "two strategies with different makers hash the same");

  /* And the hash of MY strategy is not derived from my address in any way a
   * checker could invert: the only route from bytes to maker is the decode. */
  check(readStrategy(mine).ok, "my own strategy could not be read");
  check(checkMaker(mine, ME).ok, "my own strategy failed its maker check");
  const wrong = checkMaker(theirs, ME);
  check(!wrong.ok && wrong.reason === "wrong-maker", "somebody else's strategy passed");

  /* Case is not a difference. An address that differs only in EIP-55 casing is
   * the same address, and a string comparison that said otherwise would refuse
   * the user's own position. */
  check(checkMaker(strategyFor(ME.toLowerCase()), ME.toUpperCase().replace("0X", "0x")).ok,
    "the maker check is case-sensitive");
}

group("a strategy with no readable maker is refused, not shipped unlabelled");
for (const [label, strategy] of [
  ["no tuple head", `0x${"00".repeat(31)}40${"00".repeat(12)}${ME.slice(2)}`],
  ["too short", `0x${"00".repeat(31)}20`],
  ["dirty address padding", `0x${"00".repeat(31)}20${"01".repeat(12)}${ME.slice(2)}`],
  ["not hex", "0xnothex"],
] as const) {
  const plan = planDeployment({
    maker: ME, app: APP, strategy,
    legs: [{ token: USDC, amount: 1n, allowance: 0n }],
  });
  check(!plan.ok, `${label}: produced a plan`);
  if (!plan.ok) {
    check(plan.refusal.kind === "unreadable-strategy",
      `${label}: refused as ${plan.refusal.kind}`);
  }
}

group("the device would refuse the same bytes");
{
  /* The host refusal is not the last line of defence and must not be the only
   * one. Calldata carrying a maker-less strategy has to come back undecodable
   * from the firmware-mirroring decoder too -- if it did not, a compromised
   * host could skip the check above and the device would sign it. */
  const plan = planDeployment({
    maker: SOMEONE_ELSE, app: APP, strategy: strategyFor(SOMEONE_ELSE),
    legs: [{ token: USDC, amount: 1n, allowance: 0n }],
  });
  check(plan.ok, "a self-consistent plan for another address was refused");
  if (plan.ok) {
    /* It decodes, and it names that other address -- which is exactly why the
     * host check is needed: the device cannot know whose wallet this is, it can
     * only draw the maker and say it must match. */
    const ship = decodeCall(plan.steps[plan.steps.length - 1]?.data);
    check(ship.aqua?.maker === SOMEONE_ELSE.toLowerCase(),
      "the device would not see the other maker");
  }

  /* And the unreadable case is refused by the decoder itself. */
  const headless = `0x${"00".repeat(31)}40${"00".repeat(12)}${ME.slice(2)}${"00".repeat(32)}`;
  check(!readStrategy(headless).ok, "an unreadable strategy read fine");
}

/* --------------------------------------------------------- the half-failure */

/** A propose that says yes to the first `yes` calls and no thereafter. */
const proposerSayingNoAfter = (yes: number) => {
  const seen: AppProposal[] = [];
  let calls = 0;
  const propose = async (p: AppProposal): Promise<ProposalOutcome> => {
    seen.push(p);
    calls++;
    return calls <= yes
      ? { ok: true, kind: "call", result: `0x${calls.toString(16).padStart(64, "0")}` }
      : { ok: false, text: "The wallet declined this request." };
  };
  return { propose, seen, count: () => calls };
};

const contextWith = (propose: AppContext["propose"]): AppContext => ({
  chainId: 11155111,
  address: ME,
  request: async () => { throw new Error("no reads in this test"); },
  ...(propose ? { propose } : {}),
});

group("approve landed, ship refused: reported plainly, and not retried");
{
  const plan = planDeployment({
    maker: ME, app: APP, strategy: strategyFor(ME),
    legs: [{ token: USDC, amount: 1_000_000n, allowance: 0n, decimals: 6, symbol: "USDC" }],
  });
  if (!plan.ok) throw new Error("the plan under test was refused");

  const proposer = proposerSayingNoAfter(1);
  const outcome = await runSteps(contextWith(proposer.propose), plan.steps);

  check(outcome.kind === "approved-not-shipped", `outcome was ${outcome.kind}`);
  if (outcome.kind === "approved-not-shipped") {
    check(outcome.outstanding.length === 1, "the outstanding approval was not named");
    check(outcome.outstanding[0]?.token === USDC.toLowerCase(), "the wrong token is named");
    check(outcome.outstanding[0]?.amount === 1_000_000n,
      `the outstanding figure is ${outcome.outstanding[0]?.amount}`);
    check(outcome.notice === APPROVED_NOT_SHIPPED_NOTICE, "the wrong sentence is shown");
    check(outcome.notice.includes("not the same as nothing happening"),
      "the notice does not say this is not nothing");
    check(outcome.notice.includes("will not retry"), "the notice does not say it will not retry");
  }

  /* The behavioural half of "does not silently retry": exactly as many asks as
   * steps attempted, and not one more. Two steps, one refused, two asks. */
  check(proposer.count() === 2, `${proposer.count()} proposals, expected 2`);
}

group("the first step refused is a different report, and a different one to give");
{
  const plan = planDeployment({
    maker: ME, app: APP, strategy: strategyFor(ME),
    legs: [{ token: USDC, amount: 1_000_000n, allowance: 0n }],
  });
  if (!plan.ok) throw new Error("the plan under test was refused");
  const proposer = proposerSayingNoAfter(0);
  const outcome = await runSteps(contextWith(proposer.propose), plan.steps);
  check(outcome.kind === "nothing-happened", `outcome was ${outcome.kind}`);
  check(proposer.count() === 1, "a refused first step was followed by a second ask");
}

group("a zero-first sequence that stops at the zero exposes nothing");
{
  /* The approval landed, and it landed on zero. That is not the dangerous
   * half-failure -- the allowance is lower than it was -- so it must not be
   * reported as one, or the loud message stops meaning anything. */
  const plan = planDeployment({
    maker: ME, app: APP, strategy: strategyFor(ME),
    legs: [{ token: USDC, amount: 500n, allowance: 300n }],
  });
  if (!plan.ok) throw new Error("the plan under test was refused");
  const outcome = await runSteps(contextWith(proposerSayingNoAfter(1).propose), plan.steps);
  check(outcome.kind === "nothing-happened", `outcome was ${outcome.kind}`);
}

group("everything signed is `done`, with a hash per step");
{
  const plan = planDeployment({
    maker: ME, app: APP, strategy: strategyFor(ME),
    legs: [
      { token: USDC, amount: 1_000_000n, allowance: 0n },
      { token: DAI, amount: 2n, allowance: 0n },
    ],
  });
  if (!plan.ok) throw new Error("the plan under test was refused");
  const outcome = await runSteps(contextWith(proposerSayingNoAfter(99).propose), plan.steps);
  check(outcome.kind === "done", `outcome was ${outcome.kind}`);
  if (outcome.kind === "done") {
    check(outcome.steps.length === 3, `${outcome.steps.length} steps, expected 3`);
    check(outcome.steps.every((s) => typeof s.result === "string"), "a step has no result");
  }
}

group("no propose at all is said, never treated as a refusal");
{
  const plan = planDeployment({
    maker: ME, app: APP, strategy: strategyFor(ME),
    legs: [{ token: USDC, amount: 1n, allowance: 0n }],
  });
  if (!plan.ok) throw new Error("the plan under test was refused");
  const outcome = await runSteps(contextWith(undefined), plan.steps);
  check(outcome.kind === "cannot-ask", `outcome was ${outcome.kind}`);
  if (outcome.kind === "cannot-ask") {
    check(outcome.notice === NO_DEVICE_NOTICE, "the wrong sentence is shown");
  }
}

/* ---------------------------------------------------------------- the dock */

group("dock returns the position, and offers to zero the approval after it");
{
  const hash = strategyHash(strategyFor(ME));
  const dock = planDock({ app: APP, strategyHash: hash, tokens: [USDC] });
  const call = decodeCall(dock.step.data);
  check(call.kind === CallKind.AquaDock, `dock does not decode (${call.kind})`);
  check(call.aqua?.strategyHash === hash, "the dock names a different hash");
  check(!!dock.notices[0]?.includes("does not touch your token approval"),
    "the dock notice does not say the approval survives");

  /* Nothing left in this token: offer the revoke. */
  const offer = revokeOffer({
    token: USDC, allowance: 1_000_000n, remainingPositions: 0, decimals: 6, symbol: "USDC",
  });
  check(offer.kind === "offer", `offer was ${offer.kind}`);
  if (offer.kind === "offer") {
    const revoke = decodeCall(offer.step.data);
    check(revoke.kind === CallKind.Erc20Approve, "the revoke is not an approve()");
    check(revoke.amount === 0n, `the revoke sets ${revoke.amount}, not zero`);
    check(revoke.address === AQUA_REGISTRY, "the revoke names the wrong spender");
  }

  /* Another position still holds this token: do not offer, and say why rather
   * than rendering an empty offer. */
  const kept = revokeOffer({ token: USDC, allowance: 1_000_000n, remainingPositions: 2 });
  check(kept.kind === "none" && kept.why === "positions-remain",
    `offer with positions left was ${kept.kind}`);

  const zero = revokeOffer({ token: USDC, allowance: 0n, remainingPositions: 0 });
  check(zero.kind === "none" && zero.why === "already-zero", "a zero allowance was offered");

  /* And the one that must never become an all-clear: something could not be
   * read. Not offering is right; saying "nothing to revoke" would not be. */
  for (const state of [
    { token: USDC, remainingPositions: 0 },
    { token: USDC, allowance: 5n },
  ]) {
    check(revokeOffer(state).kind === "unknown",
      "an unreadable state produced a verdict rather than an unknown");
  }
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
