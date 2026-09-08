/**
 * Walking a plan past the user and the device — the first caller of
 * `AppContext.propose`.
 *
 * ---------------------------------------------------------------------------
 * The half-failure this file exists for
 *
 * A deployment is at least two transactions: a capped approval, then a ship.
 * The interesting outcome is not "it worked" and not "it failed", it is the
 * one in between — **the approval landed and the ship did not**. That leaves a
 * standing allowance to the Aqua registry with no position behind it: exposure
 * with no upside, and, worse, a state that looks like nothing happened. The
 * portfolio view will show no position, because there is none, and the user
 * will reasonably conclude they are back where they started. They are not.
 *
 * So this returns a result that names that state explicitly, with the token and
 * the exact figure left approved, and the caller renders it. It is not an error
 * string and it is not a boolean, because both of those get collapsed into
 * "something went wrong, try again" by the next person to touch the code.
 *
 * **And it does not retry.** Not once, not with a prompt. Each step costs a
 * press on hardware, and an app that re-asks after a failure is an app that
 * teaches people to press through. Worse, the second attempt of a two-step
 * sequence is not the same sequence: the approval is already set, so a naive
 * retry re-runs a step whose plan was computed against an allowance that has
 * since changed. Recovery is a new plan, built from a fresh reading, which is
 * the caller's job and the user's decision.
 *
 * ---------------------------------------------------------------------------
 * What an app learns from `propose`, and what it does not
 *
 * One refusal shape for every no: a missing descriptor, a device refusal, a
 * user pressing reject and a disconnected cable are all `{ ok: false }`, and
 * this file cannot tell them apart. That is deliberate on the seam's side
 * (app-proposal.ts) and it is the right constraint — an app that could tell a
 * rejection from a technical failure could re-ask only when re-asking might
 * work, which is how consent gets ground down. The *user* sees the real reason
 * in the shell log every time.
 *
 * The practical consequence for this file is that "the ship was rejected" and
 * "the ship could not be sent" produce the identical report, and the report is
 * therefore worded as what is TRUE of both: the approval is outstanding, the
 * position was not created, and here is what to do about it.
 */

import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { capAmountText } from "@leekwallet/core/approval-cap.ts";
import type { DeployStep } from "./deploy.ts";

/** One step's outcome, in the order they were attempted. */
export interface StepOutcome {
  step: DeployStep;
  /** The transaction hash the shell broadcast, when it got that far. */
  result?: string;
  ok: boolean;
}

export type RunOutcome =
  /** Every step signed and broadcast. */
  | { kind: "done"; steps: StepOutcome[] }
  /**
   * Nothing was signed. The first step was refused, so no state changed and
   * there is nothing to clean up — which is worth distinguishing from the one
   * below, because the advice is completely different.
   */
  | { kind: "nothing-happened"; steps: StepOutcome[]; notice: string }
  /**
   * The dangerous one: approvals landed, the ship did not.
   *
   * `outstanding` is what is now approved and unused, per token, taken from the
   * plan rather than re-read — this is a report about what THIS run did, and a
   * fresh reading would be a different (and also useful) statement that belongs
   * in the portfolio view rather than here.
   */
  | {
      kind: "approved-not-shipped";
      steps: StepOutcome[];
      outstanding: Array<{ token: string; amount: bigint }>;
      notice: string;
    }
  /** No `propose` at all: no device, or a harness. Not a failure of the plan. */
  | { kind: "cannot-ask"; notice: string };

export const NO_DEVICE_NOTICE =
  "Nothing was asked for and nothing was signed: this build has no way to " +
  "reach a device. Connect one and try again.";

export const NOTHING_HAPPENED_NOTICE =
  "The first signature did not happen, so nothing changed on chain. No " +
  "approval was granted and no position was created.";

/**
 * The sentence for the half-failure. Written out rather than assembled from
 * fragments so a reviewer can grep for it and see exactly what the user is
 * told — this is the one message in the app that has to be right.
 */
export const APPROVED_NOT_SHIPPED_NOTICE =
  "The approval went through and the position did not. That is not the same " +
  "as nothing happening: the Aqua registry can now pull the amount below from " +
  "this wallet, and there is no position on the other side of it. This app " +
  "will not retry on its own — the allowance has changed since this plan was " +
  "built, so a retry would be working from a stale reading. Either revoke the " +
  "approval, or start the deployment again and let it read the allowance " +
  "afresh.";

/**
 * Run the steps in order, stopping at the first no.
 *
 * `reason` is what the shell logs beside the app's name: one line, this app's
 * own words, never near the figures. The card and the device screen are what
 * say what the call does.
 */
export async function runSteps(
  context: AppContext,
  steps: readonly DeployStep[],
): Promise<RunOutcome> {
  const propose = context.propose;
  if (!propose) return { kind: "cannot-ask", notice: NO_DEVICE_NOTICE };

  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    const outcome = await propose({
      kind: "call",
      to: step.to,
      data: step.data,
      /* The step's own label, truncated to the seam's limit rather than
       * risking a refusal for a reason the user would never see. The seam
       * refuses a reason over 120 characters and returns the same opaque no as
       * everything else, so a long label would look like a device refusal. */
      reason: step.label.slice(0, 120),
    });
    if (!outcome.ok || outcome.kind !== "call") {
      outcomes.push({ step, ok: false });
      return report(outcomes);
    }
    outcomes.push({ step, ok: true, result: outcome.result });
  }
  return { kind: "done", steps: outcomes };
}

function report(steps: StepOutcome[]): RunOutcome {
  const landed = steps.filter((s) => s.ok);
  if (landed.length === 0) {
    return { kind: "nothing-happened", steps, notice: NOTHING_HAPPENED_NOTICE };
  }

  /* Last write wins per token: a zero-first sequence sets the allowance to zero
   * and then to the cap, and reporting both would name a figure that is no
   * longer the one standing. A sequence that stopped after the zero step
   * leaves zero outstanding, which is honest and is exactly what is reported. */
  const byToken = new Map<string, bigint>();
  for (const s of landed) {
    if (s.step.role !== "approve" || s.step.token === undefined) continue;
    byToken.set(s.step.token, s.step.amount ?? 0n);
  }
  const outstanding = [...byToken]
    .filter(([, amount]) => amount > 0n)
    .map(([token, amount]) => ({ token, amount }));

  if (outstanding.length === 0) {
    /* Approvals ran and every one of them left zero — a revoke sequence, or a
     * zero-first that stopped at the zero. Nothing is exposed, so this is the
     * benign report and not the loud one. */
    return { kind: "nothing-happened", steps, notice: NOTHING_HAPPENED_NOTICE };
  }
  return { kind: "approved-not-shipped", steps, outstanding, notice: APPROVED_NOT_SHIPPED_NOTICE };
}

/**
 * The outstanding figures as one line, for the caller to put under the notice.
 *
 * `meta` is per token and optional throughout: a token nothing knows the
 * decimals of prints raw units and says so, which is capAmountText's rule and
 * not a second one invented here.
 */
export const outstandingText = (
  outstanding: ReadonlyArray<{ token: string; amount: bigint }>,
  meta?: (token: string) => { decimals?: number; symbol?: string } | undefined,
): string =>
  outstanding
    .map(({ token, amount }) => `${capAmountText(amount, meta?.(token))} (${token})`)
    .join(", ");
