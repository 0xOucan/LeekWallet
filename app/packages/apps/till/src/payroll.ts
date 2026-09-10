/**
 * The payroll run: a registry of people, one token, and one transfer each.
 *
 * ---------------------------------------------------------------------------
 * Why this is a third app rather than a button on the till
 *
 * The cashier's terminal and the waiter's phone are defined by NOT being able
 * to move money (index.ts, waiter.ts, and test/no-signing.test.ts proves it of
 * both). Payroll is the opposite: it exists to move money out of the
 * merchant's own account. Putting it behind a mode flag on the cashier screen
 * would have made "this terminal cannot spend" conditional on a boolean, and a
 * boolean is not a security boundary — a bug, a stale render or a URL is
 * enough to flip one.
 *
 * So it is a separate `MiniApp` with a separate mount, in the same package
 * because it is the same product and comes out of a release with the same
 * directory. The waiter's device mounts the waiter app and never sees this
 * one; there is nothing to flip. That is the same argument the cashier/waiter
 * split already makes in request.ts, applied once more.
 *
 * Admin mode, concretely: this app needs a device. `AppContext.propose` is
 * absent when no device is connected (mini-app.ts), and this app renders a
 * refusal in that case rather than a payroll screen with a dead button — the
 * absence is a real state and is displayed as one.
 *
 * ---------------------------------------------------------------------------
 * One proposal per transfer, because there is no batch
 *
 * Checked rather than assumed: `AppProposal` in core is `CallProposal |
 * TypedDataProposal`, one `to` and one `data` each, and `propose` returns one
 * outcome. There is no multicall in the shell's proposal path, and adding one
 * would mean either a batching contract (a new deployment this app would have
 * to trust and the device would have to describe) or a `DEVICE_DRAWN_KINDS`
 * entry, which needs firmware — `app/test/apps.test.ts` pins that set closed
 * for exactly this reason.
 *
 * A batch would also cost the property that makes this safe: with one transfer
 * per proposal, the device draws a real recipient and a real amount for every
 * payment, from the calldata, with its own decoder. A batch is one press
 * approving a blob whose contents the device cannot itself enumerate. Twelve
 * presses is worse UX and a strictly better guarantee, and the amount of money
 * involved is what UX is being traded against.
 *
 * The consequence is stated plainly on screen: a run is NOT atomic. It can
 * stop half way — a decline, a device disconnect, a revert — and the app
 * reports exactly which rows were proposed and what came back. It never
 * reports a row as paid on the strength of having proposed it.
 *
 * ---------------------------------------------------------------------------
 * The total is the thing being approved
 *
 * A person approving a payroll is approving a total, so the total is computed
 * from the parsed rows (never from a figure in the file, which is why the CSV
 * has no total column) and shown before anything is proposed. It goes through
 * `describeTokenAmount`, like every other token figure in this wallet, so the
 * scaled number cannot be rendered without the notice saying the decimals are
 * unverified — balances.ts's header is explicit that there is no function
 * returning a bare pretty number, and this file adds none.
 */

import { describeTokenAmount, encodeErc20Transfer, hintMeta, type TokenAmountView } from "@leekwallet/core/balances.ts";
import { trackedTokenAddress } from "@leekwallet/core/all-chain-balances.ts";
import { tokenHint } from "@leekwallet/core/chains.ts";
import type { AppProposal, ProposalOutcome } from "@leekwallet/core/app-proposal.ts";
import { deploymentFor, railFor, type TillToken } from "./rails.ts";
import { duplicatesIn, unitsFor, type Duplicate, type StaffMember } from "./staff.ts";

/**
 * What a payroll can be paid in.
 *
 * The till's two, plus cirBTC — Circle Wrapped Bitcoin, on the two testnets
 * core has verified addresses and decimals for (all-chain-balances.ts). It is
 * NOT cbBTC: Coinbase Wrapped BTC is a different token from a different
 * issuer, and core carries a comment about an earlier draft that read one as a
 * typo for the other and pointed Sepolia at the wrong contract. Paying staff
 * in the wrong wrapped bitcoin is that same mistake with a transfer attached,
 * so the name here is the one core's verified table uses.
 */
export type PayrollToken = TillToken | "cirBTC";

export const PAYROLL_TOKENS: readonly PayrollToken[] = ["USDC", "EURC", "cirBTC"] as const;

/** Where a token lives on a chain, or a sentence saying it does not. */
export type PayrollDeployment =
  | { ok: true; chainId: number; token: PayrollToken; address: string; decimals: number }
  | { ok: false; reason: string };

/**
 * The contract to pay through, for one token on one chain.
 *
 * USDC and EURC go through the till's own table, which comes from Circle's SDK
 * (rails.ts) — one source, so a payroll and a bill can never address different
 * contracts for the same token. cirBTC comes from core's verified deployment
 * map, and its decimals from core's token table by the same rule rails.ts
 * states: a decimals value this app kept a copy of is a decimals value that can
 * drift, and on these chains a drift is a factor of a hundred.
 */
export function payrollDeployment(chainId: number, token: PayrollToken): PayrollDeployment {
  if (token !== "cirBTC") return deploymentFor(chainId, token);
  const rail = railFor(chainId);
  if (rail === undefined) return { ok: false, reason: `This app does not pay on chain ${chainId}.` };
  const address = trackedTokenAddress("cirBTC", chainId);
  if (address === undefined) {
    return { ok: false, reason: `cirBTC has no address this wallet has verified on ${rail.name}.` };
  }
  const hint = tokenHint(chainId, address);
  if (hint === undefined) {
    return {
      ok: false,
      reason: `cirBTC on ${rail.name} has no decimals in the wallet's token table, so an amount ` +
        `cannot be scaled exactly. This app will not guess.`,
    };
  }
  return { ok: true, chainId, token, address, decimals: hint.decimals };
}

/** One transfer: a person, the exact units, and the calldata that pays them. */
export interface PayrollPayment {
  readonly member: StaffMember;
  readonly units: bigint;
  /** The token contract. The `to` of the proposal — never the recipient. */
  readonly contract: string;
  /** `transfer(recipient, units)`, encoded by core so the device decodes it. */
  readonly data: string;
  /** The unverified-token treatment for this row's figure. */
  readonly view: TokenAmountView;
}

export interface PayrollPlan {
  readonly chainId: number;
  readonly token: PayrollToken;
  readonly contract: string;
  readonly decimals: number;
  readonly payments: readonly PayrollPayment[];
  readonly totalUnits: bigint;
  /** The total, carrying its own "nobody verified these decimals" notice. */
  readonly total: TokenAmountView;
  /** Recipients paid more than once. Non-empty only if the user confirmed. */
  readonly duplicates: readonly Duplicate[];
}

export type PlanResult =
  | { ok: true; plan: PayrollPlan }
  /** `line` is the row's line in the imported file, or 0 for a whole-run refusal. */
  | { ok: false; line: number; reason: string };

/**
 * Turn a registry into a run, or refuse it.
 *
 * Refuses whole, for the reason staff.ts refuses whole: a plan missing the one
 * row that could not be scaled is a total the user did not choose.
 *
 * `from` is the address the shell is showing — the payer. It is here for one
 * check: a row that pays the payer is a no-op transfer that still costs a
 * device confirmation and a fee, and in a payroll file it is a mistake rather
 * than an instruction. The shell decides the actual signer regardless
 * (app-proposal.ts); nothing in this file can choose it.
 */
export function planPayroll(
  staff: readonly StaffMember[],
  chainId: number,
  token: PayrollToken,
  from: string,
): PlanResult {
  if (staff.length === 0) return { ok: false, line: 0, reason: `there is nobody on the payroll` };
  const deployment = payrollDeployment(chainId, token);
  if (!deployment.ok) return { ok: false, line: 0, reason: deployment.reason };

  const meta = hintMeta(chainId, deployment.address);
  const payments: PayrollPayment[] = [];
  let totalUnits = 0n;
  for (const member of staff) {
    if (member.address.toLowerCase() === from.toLowerCase()) {
      return {
        ok: false,
        line: member.line,
        reason: `${member.name} is the address that would be paying. A payroll does not pay itself.`,
      };
    }
    const units = unitsFor(member.amount, deployment.decimals);
    if (!units.ok) {
      return {
        ok: false,
        line: member.line,
        reason: `${member.name}: ${units.reason}`,
      };
    }
    totalUnits += units.units;
    payments.push({
      member,
      units: units.units,
      contract: deployment.address,
      data: encodeErc20Transfer(member.address, units.units),
      view: describeTokenAmount(deployment.address, units.units, meta),
    });
  }

  return {
    ok: true,
    plan: {
      chainId,
      token,
      contract: deployment.address,
      decimals: deployment.decimals,
      payments,
      totalUnits,
      total: describeTokenAmount(deployment.address, totalUnits, meta),
      duplicates: duplicatesIn(staff),
    },
  };
}

/* ------------------------------------------------------------- the run */

/** What happened to one row. `proposed` is in flight; nothing else is a claim. */
export type PaymentState =
  | { kind: "waiting" }
  | { kind: "proposed" }
  /**
   * The shell returned a result: a transaction hash if it broadcast, otherwise
   * the raw signed transaction. Note what this is NOT — a receipt. A hash is a
   * transaction that was accepted for broadcast, and this app does not watch
   * for its inclusion, so the word on screen is "sent", never "paid".
   */
  | { kind: "sent"; result: string }
  /**
   * The wallet said no, and an app is never told which no it was
   * (app-proposal.ts): a user's rejection and a screening refusal are one
   * value on purpose. So the run stops and says exactly that.
   */
  | { kind: "declined" }
  /** The call threw — a disconnected device, a shell error. */
  | { kind: "failed"; reason: string };

export interface RunProgress {
  readonly states: readonly PaymentState[];
  /** Index currently being proposed, or -1 when the run is not in flight. */
  readonly active: number;
  readonly done: boolean;
}

/** One line for the shell's log. App-authored text, never rendered as fact. */
function reasonFor(plan: PayrollPlan, index: number): string {
  const member = (plan.payments[index] as PayrollPayment).member;
  const text = `Payroll ${index + 1}/${plan.payments.length}: ${member.role} ${member.name}`;
  // app-proposal.ts refuses a reason longer than 120 characters. The names and
  // roles are already bounded by staff.ts; this is the belt to that braces.
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

/**
 * Propose every payment in order, stopping at the first refusal.
 *
 * Sequential, never parallel. Each call is a screen on the device and a press
 * by a human, and firing twelve of them at once would produce a queue the user
 * cannot associate with rows. Stopping at the first "no" is the other half:
 * a decline usually means the person looked at the screen and disagreed with
 * it, and marching on to propose the next eleven is how a wallet trains
 * somebody to press the button without reading.
 */
export async function runPayroll(
  plan: PayrollPlan,
  propose: (proposal: AppProposal) => Promise<ProposalOutcome>,
  onProgress: (progress: RunProgress) => void,
): Promise<RunProgress> {
  const states: PaymentState[] = plan.payments.map(() => ({ kind: "waiting" }));
  const emit = (active: number, done: boolean) =>
    onProgress({ states: states.map((s) => s), active, done });

  for (let i = 0; i < plan.payments.length; i++) {
    const payment = plan.payments[i] as PayrollPayment;
    states[i] = { kind: "proposed" };
    emit(i, false);
    let outcome: ProposalOutcome;
    try {
      outcome = await propose({
        kind: "call",
        to: payment.contract,
        data: payment.data,
        reason: reasonFor(plan, i),
      });
    } catch (e) {
      states[i] = { kind: "failed", reason: (e as Error).message };
      emit(-1, true);
      return { states, active: -1, done: true };
    }
    if (!outcome.ok) {
      states[i] = { kind: "declined" };
      emit(-1, true);
      return { states, active: -1, done: true };
    }
    /* `kind` is checked rather than assumed: a typed-data outcome here would
     * mean the shell answered a call proposal with a signature over something
     * else, and treating that as a sent payment would be this app inventing a
     * receipt. */
    states[i] = outcome.kind === "call"
      ? { kind: "sent", result: outcome.result }
      : { kind: "failed", reason: "the wallet answered with something other than a transaction" };
    if (states[i]?.kind === "failed") {
      emit(-1, true);
      return { states, active: -1, done: true };
    }
    emit(-1, false);
  }
  emit(-1, true);
  return { states, active: -1, done: true };
}
