/**
 * Asking for a privileged ATS action, and everything that happens before the
 * asking (plan §3, milestone E3).
 *
 * ---------------------------------------------------------------------------
 * The order of the three gates, which is the whole design
 *
 * An intent becomes a signature only by passing three checks in this order,
 * and each one can say no on its own:
 *
 *   1. **This file** builds calldata from the SAME action table the descriptor
 *      set is built from, so the selector it emits and the selector the
 *      descriptor matches cannot drift apart. An intent it cannot encode never
 *      becomes bytes.
 *   2. **`describePrivilegedCall`** (action.ts) renders those bytes into a
 *      screen with a consequence line, or refuses. This is the app's own
 *      refusal, taken before anything leaves the app, and it is the one the
 *      plan's §3 rule is about: *a privileged call with no descriptor must
 *      refuse*.
 *   3. **`screenProposal`** in core re-judges the same bytes independently,
 *      against descriptors this app offered as evidence, and cross-checks them
 *      against the firmware-mirroring decoder before the device draws anything.
 *
 * Gate 2 is redundant with gate 3 by construction, and it is here anyway. Not
 * as defence in depth — as a *user interface*: gate 3 answers the app with one
 * opaque "declined" and tells the user in the shell log, which is right for a
 * seam an app must not be able to probe, and useless for an issuer who wants to
 * see the screen before spending a press. Gate 2 is what lets this console show
 * the consequence line first, and it is what makes "remove a descriptor and the
 * console refuses" testable without a device.
 *
 * The one thing gate 2 must never become is an *authority*. It cannot approve
 * anything. If it produced a screen and gate 3 refuses, nothing is signed, and
 * that is the correct outcome, not a bug in gate 3.
 *
 * ---------------------------------------------------------------------------
 * No retry, and no queue
 *
 * Each of these costs a press on hardware and every one of them is
 * irreversible. So a refusal returns and stops; there is no re-ask, no "try
 * again" button wired to the same intent, and no batching of two actions behind
 * one press. Aqua's run.ts argues the same case at length for a two-step
 * deployment; here there is only ever one step, which makes it easier and no
 * less important.
 *
 * ---------------------------------------------------------------------------
 * What this file does not have
 *
 * A device, a key, a transport, or a way to reach any of them — `AppContext`
 * carries none, deliberately (mini-app.ts). It holds the ability to ask.
 */

import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { parseSignature, selectorOf } from "@leekwallet/core/erc7730.ts";
import { AbiError } from "@leekwallet/core/balances.ts";
import { addressWord, bytes32Word, word } from "./abi.ts";
import { ACTIONS, actionName } from "./descriptors.ts";
import {
  nextPayment, record, totalForSnapshot,
  type Allocation, type DistributionLedger, type DividendPlan,
} from "./dividend.ts";
import {
  describePrivilegedCall, REFUSAL_NOTICE,
  type PrivilegedRefusal, type PrivilegedScreen, type SecurityFacts,
} from "./action.ts";

/* ------------------------------------------------------------------ intents */

/**
 * One privileged action, in the console's own words rather than the ABI's.
 *
 * A discriminated union rather than `(name, args[])` so that the compiler is
 * what stops a caller from asking for `lock` with two arguments, and so that
 * `amount` is a `bigint` at every point it exists. The argument ORDER here is
 * the readable one; the encoder below puts it in the contracts' order, which
 * for `lock` is not the same — see descriptors.ts.
 */
export type PrivilegedIntent =
  | { action: "grantRole"; role: string; account: string }
  | { action: "revokeRole"; role: string; account: string }
  | { action: "revokeKyc"; account: string }
  | { action: "pause" }
  | { action: "unpause" }
  | { action: "freezePartialTokens"; account: string; amount: bigint }
  | { action: "unfreezePartialTokens"; account: string; amount: bigint }
  | { action: "setAddressFrozen"; account: string; frozen: boolean }
  | { action: "lock"; account: string; amount: bigint; until: bigint }
  | { action: "setMaxSupply"; cap: bigint }
  | { action: "mint"; to: string; amount: bigint }
  | { action: "addToControlList"; account: string }
  | { action: "removeFromControlList"; account: string }
  | { action: "takeSnapshot" }
  /**
   * Declare a dividend.
   *
   * Carries a whole `DividendPlan` rather than four numbers, and that is the
   * safety property in the type system: `planDividend` is the only constructor
   * of one, and it refuses any distribution whose total does not equal
   * per-share × snapshot supply. `encodeDividend` re-runs the same arithmetic
   * on the plan it is handed, so a plan built by hand still cannot become
   * calldata with an unchecked total.
   */
  | { action: "setDividend"; plan: DividendPlan };

/** The names a caller may ask for, derived from the action table, not typed twice. */
export const PRIVILEGED_ACTIONS: readonly string[] = ACTIONS.map(actionName);

/* ----------------------------------------------------------------- encoding */

/**
 * The canonical signature of an action, taken from the descriptor table.
 *
 * Deliberately not a second list of signatures. `ACTIONS` is where a signature
 * is written down; if this file kept its own copy, a corrected signature would
 * have to be corrected twice and the version that was missed would produce
 * calldata no descriptor matches — a call that refuses for a reason that looks
 * like a descriptor bug and is not.
 */
function canonicalOf(action: string): string | undefined {
  for (const spec of ACTIONS) {
    if (actionName(spec) !== action) continue;
    const parsed = parseSignature(spec.key);
    if (parsed === null) return undefined;
    return parsed.canonical;
  }
  return undefined;
}

/**
 * Calldata for an intent, or a thrown `AbiError`.
 *
 * Throws rather than returning a failure because every input here is already
 * screened by the caller's form and a malformed address at this depth is a
 * programming mistake, not a user's. `proposePrivileged` turns the throw into a
 * refusal so nothing escapes as an exception.
 */
export function encodePrivileged(intent: PrivilegedIntent): string {
  const canonical = canonicalOf(intent.action);
  if (canonical === undefined) {
    throw new AbiError(`${intent.action} is not in this console's action table`);
  }
  const head = `0x${selectorOf(canonical)}`;

  switch (intent.action) {
    case "grantRole":
    case "revokeRole":
      return head + bytes32Word(intent.role) + addressWord(intent.account);
    case "revokeKyc":
    case "addToControlList":
    case "removeFromControlList":
      return head + addressWord(intent.account);
    case "pause":
    case "unpause":
      return head;
    case "freezePartialTokens":
    case "unfreezePartialTokens":
      return head + addressWord(intent.account) + word(intent.amount);
    case "setAddressFrozen":
      return head + addressWord(intent.account) + word(intent.frozen ? 1n : 0n);
    case "lock":
      // Amount, then holder, then expiry. The contracts' order.
      return head + word(intent.amount) + addressWord(intent.account) + word(intent.until);
    case "setMaxSupply":
      return head + word(intent.cap);
    case "mint":
      return head + addressWord(intent.to) + word(intent.amount);
    case "takeSnapshot":
      return head;
    case "setDividend":
      return head + encodeDividend(intent.plan);
  }
}

/**
 * The four words of an `IDividendTypes.Dividend`, in the contracts' order.
 *
 * The struct's components are all static, so they sit in the head one after
 * another exactly as four separate arguments would: no offset, no length, and
 * nothing for a decoder to follow. That is why this call has a descriptor at
 * all — see descriptors.ts.
 *
 * The total is RECOMPUTED here from the snapshot rather than copied out of the
 * plan. A plan is only produced by `planDividend`, which already refused any
 * total that did not equal per-share × snapshot supply; recomputing costs a
 * multiplication and closes the one remaining route to a wrong number on a
 * device screen, which is a caller that assembled the object itself.
 */
export function encodeDividend(plan: DividendPlan): string {
  const t = plan.terms;
  const computed = totalForSnapshot(t.perShare, t.snapshot);
  if (computed.state !== "ok") throw new AbiError(computed.why);
  if (computed.total !== plan.total || computed.total !== t.statedTotal) {
    throw new AbiError(
      `this dividend's total (${plan.total}) is not per-share × snapshot supply ` +
      `(${computed.total}), so it will not be encoded`,
    );
  }
  if (t.token.decimals < 0 || t.token.decimals > 255) {
    throw new AbiError("the payment token's decimals do not fit in a uint8");
  }
  return word(t.recordDate) + word(t.executionDate) + word(computed.total)
    + word(BigInt(t.token.decimals));
}

/* ------------------------------------------------------------------ asking */

/**
 * What the console learns from one attempt.
 *
 * `refused` and `declined` are separate, and the difference is which side said
 * no. `refused` is OURS, before anything left the app, and it carries the
 * reason because we are the ones who know it. `declined` is the seam's single
 * opaque no — a missing descriptor in core, a device refusal, a user pressing
 * reject, an unplugged cable — and it carries no reason on purpose: an app that
 * could tell those apart could search or re-ask. The user sees the real one in
 * the shell log every time. See app-proposal.ts.
 */
export type ActOutcome =
  /** Signed and broadcast. `result` is the transaction hash. */
  | { kind: "sent"; result: string; screen: PrivilegedScreen }
  /** This console refused. Nothing was asked for, and retrying refuses again. */
  | { kind: "refused"; why: string; notice: string; selector?: string }
  /** The wallet said no, for a reason it will not tell an app. */
  | { kind: "declined"; notice: string; screen: PrivilegedScreen }
  /** No `propose` at all: no device connected, or a test harness. */
  | { kind: "cannot-ask"; notice: string };

export const NO_DEVICE_NOTICE =
  "Nothing was asked for and nothing was signed: this build has no way to " +
  "reach a device. Connect one and try again.";

export const DECLINED_NOTICE =
  "The wallet did not sign this. That covers a rejection on the device, a " +
  "wallet that could not describe the call, and a device that is no longer " +
  "connected — an app is not told which, and the reason is in the wallet's " +
  "own log. Nothing was sent.";

/**
 * The screen an intent would produce, without asking for anything.
 *
 * Separate from `proposePrivileged` so the console can show the consequence
 * line and wait, rather than spending a press to find out what the press is
 * for. It is the same call the proposal makes, so what is previewed is what is
 * proposed.
 */
export function previewPrivileged(
  facts: SecurityFacts,
  intent: PrivilegedIntent,
): PrivilegedScreen | PrivilegedRefusal {
  let data: string;
  try {
    data = encodePrivileged(intent);
  } catch (e) {
    return { state: "refused", why: `that action could not be encoded: ${(e as Error).message}` };
  }
  return describePrivilegedCall(facts, data);
}

/**
 * Render the action, then ask the wallet to put it in front of the user.
 *
 * `facts` must come from a register read rather than from the form: the
 * security's name on the screen, its decimals, and the direction of its control
 * list are all facts about the contract, and taking any of them from the UI
 * would let the screen describe a security other than the one being changed.
 */
export async function proposePrivileged(
  context: AppContext,
  facts: SecurityFacts,
  intent: PrivilegedIntent,
): Promise<ActOutcome> {
  const rendering = previewPrivileged(facts, intent);
  if (rendering.state === "refused") {
    return {
      kind: "refused",
      why: rendering.why,
      notice: REFUSAL_NOTICE,
      ...(rendering.selector !== undefined ? { selector: rendering.selector } : {}),
    };
  }

  const propose = context.propose;
  if (!propose) return { kind: "cannot-ask", notice: NO_DEVICE_NOTICE };

  const outcome = await propose({
    kind: "call",
    to: facts.address,
    data: encodePrivileged(intent),
    /* The app's one logged line, and it is a label, not a description: the
     * card and the device say what the call does. Bounded well under the
     * seam's 120 characters, because a reason too long is refused with the
     * same opaque no as a device rejection and would read as one. */
    reason: `issuer console: ${rendering.title}`.slice(0, 120),
  });

  if (!outcome.ok || outcome.kind !== "call") {
    return { kind: "declined", notice: DECLINED_NOTICE, screen: rendering };
  }
  return { kind: "sent", result: outcome.result, screen: rendering };
}

/* ------------------------------------------------------- paying the holders */

/**
 * The payout leg, and why it is separate from everything above.
 *
 * `setDividend` declares; it moves nothing. Paying is N ERC-20 transfers of
 * some other token, one approval each, and none of them is an ATS call at all
 * — so none of them goes through `describePrivilegedCall`, and none of them is
 * described by this app's descriptors. Core screens them exactly as it screens
 * any other transfer: with a descriptor for that token, or not at all. If the
 * payment token has none, the wallet declines and the payout cannot proceed
 * from here. That is the descriptor rule applying to us, and it is worked
 * around nowhere in this file.
 */
export const PAYMENT_SIGNATURE = "transfer(address,uint256)";

/** What one attempted payment did to the run. */
export interface PaymentAttempt {
  /**
   * `paid` — a hash came back. `uncertain` — we asked and do not know.
   * `blocked` / `complete` / `cannot-ask` — nothing was asked.
   */
  kind: "paid" | "uncertain" | "blocked" | "complete" | "cannot-ask";
  /** The ledger AFTER this attempt. Always keep this one; the old is stale. */
  ledger: DistributionLedger;
  /** Which holder, when one was attempted. */
  allocation?: Allocation;
  /** Transaction hash, when one came back. */
  result?: string;
  notice: string;
}

export const PAYMENT_UNCERTAIN_NOTICE =
  "The wallet did not return a transaction hash. That covers a rejection on " +
  "the device, a wallet that would not describe the transfer, and a connection " +
  "lost after signing — an app is not told which, and the last of those may " +
  "have paid. This holder is now marked uncertain and the run has stopped: " +
  "check the address on an explorer, then mark it paid or not paid. This app " +
  "will not retry on its own, because retrying a transfer that did land is how " +
  "a holder gets paid twice.";

/**
 * Pay the next holder in the plan, once.
 *
 * One holder per call, deliberately. A loop that pays fourteen holders from one
 * press is one approval for fourteen irreversible transfers, which is the
 * batching this file's header refuses; and a loop that pays them from fourteen
 * presses is this function, called fourteen times, with the ledger written down
 * in between. The ledger is what makes the run resumable, so it has to exist
 * between the presses rather than inside a loop.
 */
export async function payNext(
  context: AppContext,
  plan: DividendPlan,
  ledger: DistributionLedger,
): Promise<PaymentAttempt> {
  const step = nextPayment(plan, ledger);
  if (step.state === "complete") {
    return {
      kind: "complete", ledger,
      notice: `All ${step.paid} holders are marked paid, totalling ${step.total} raw units.`,
    };
  }
  if (step.state === "blocked") return { kind: "blocked", ledger, notice: step.why };

  const propose = context.propose;
  if (!propose) return { kind: "cannot-ask", ledger, notice: NO_DEVICE_NOTICE };

  const a = step.allocation;
  const data = `0x${selectorOf(PAYMENT_SIGNATURE)}${addressWord(a.address)}${word(a.amount)}`;
  let outcome;
  try {
    outcome = await propose({
      kind: "call",
      to: plan.terms.token.address,
      data,
      reason: `dividend ${plan.planId.slice(0, 10)}: holder ${step.index + 1}`.slice(0, 120),
    });
  } catch (e) {
    /* A throw is the worst case and gets the most conservative reading: the
     * request may have reached the device, and the device may have signed. */
    return {
      kind: "uncertain",
      ledger: record(ledger, a.address,
        { state: "uncertain", why: String((e as Error)?.message ?? e) }),
      allocation: a,
      notice: PAYMENT_UNCERTAIN_NOTICE,
    };
  }

  if (!outcome.ok || outcome.kind !== "call") {
    /* A decline is NOT read as "not paid", even though a user pressing reject
     * is much the commonest cause. The seam gives one opaque no for a
     * rejection, an undescribable transfer and a connection lost after
     * signing, and only the last of those may have moved money. Reading the
     * common case would be right most of the time and would double-pay in
     * exactly the case that costs money, so the run stops and a person looks. */
    return {
      kind: "uncertain",
      ledger: record(ledger, a.address, { state: "uncertain", why: "the wallet returned no hash" }),
      allocation: a,
      notice: PAYMENT_UNCERTAIN_NOTICE,
    };
  }
  return {
    kind: "paid",
    ledger: record(ledger, a.address, { state: "paid", tx: outcome.result }),
    allocation: a,
    result: outcome.result,
    notice: `Paid ${a.amount} raw units to ${a.address}. Transaction ${outcome.result}.`,
  };
}

/**
 * Resolve an uncertain holder, by hand, with the chain in front of you.
 *
 * The only way past a `blocked` run, and it takes a person: "paid" needs the
 * transaction hash they found, "not paid" needs them to have looked. Neither is
 * something this app can determine — it holds no receipts and has no way to
 * read one — so both are inputs rather than inferences.
 */
export function resolveUncertain(
  ledger: DistributionLedger,
  address: string,
  resolution: { paid: true; tx: string } | { paid: false; why: string },
): DistributionLedger {
  return record(
    ledger, address,
    resolution.paid
      ? { state: "paid", tx: resolution.tx }
      : { state: "not-paid", why: resolution.why },
  );
}
