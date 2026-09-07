/**
 * What the waiter and the customer read while a bill is open.
 *
 * Pure model first, DOM second, exactly as view.ts and Aqua's view.ts are
 * split, and for the reason that matters here more than anywhere else in this
 * app: **the property being defended is a property of the words**. "We could
 * not reach this chain" and "nothing has arrived on this chain" have to be
 * different sentences, not the same sentence in two colours, because a waiter
 * reads a screen at arm's length in a noisy room and a customer reads it upside
 * down. A CSS class cannot carry that difference and a discriminated union
 * that both render as "unpaid" defends nothing.
 *
 * So every string a chain row can produce is built here, in node-testable code,
 * and test/watch-view.test.ts asserts on the rendered text of an outage next to
 * the rendered text of a genuine absence.
 *
 * The headline follows the same rule one level up. There is no combination of
 * reports that produces "not paid" while any chain is unknown: the strongest
 * statement we are entitled to then is "not seen yet, and we could not check
 * N chains" — which is what a customer claiming to have paid needs to hear.
 */

import { formatUnits } from "@leekwallet/core/chains.ts";
import { confirmationsFor, deploymentFor, railFor } from "./rails.ts";
import {
  isConfirmed,
  type ChainReport, type Payment, type WatchFailure, type WatchSnapshot, type WatchTarget,
} from "./watch.ts";

/**
 * How a payment line should read.
 *
 * `unknown` is a member of this union and nothing below maps it to `none`.
 * That is the milestone, stated as a type so that it cannot be got right in
 * one renderer and forgotten in the next.
 */
export type WatchTone = "paid" | "seen" | "none" | "unknown" | "unpayable";

export interface WatchRow {
  chainId: number;
  name: string;
  /** The sentence itself. This is the thing tests assert on. */
  text: string;
  tone: WatchTone;
  /** Blocks looked at, or who answered. Never the answer itself. */
  detail?: string;
}

export interface WatchView {
  /** The one line the customer is shown. */
  headline: string;
  headlineTone: WatchTone;
  rows: WatchRow[];
  notices: string[];
}

const REASONS: Readonly<Record<WatchFailure, string>> = {
  "no-endpoint": "this terminal has no endpoint for it, so nobody was asked",
  "head-unreadable": "the endpoint would not say what block it is on",
  "logs-unavailable": "the log query failed",
  undecodable: "what came back did not decode as a Transfer",
};

const chainName = (chainId: number): string => railFor(chainId)?.name ?? `chain ${chainId}`;

/**
 * "327.2117 USDC".
 *
 * Decimals come from core's token table via rails.ts, never from a local
 * constant — on Arc the same chain has an 18-decimal native unit and a
 * 6-decimal ERC-20, and a copy of "6" here would be the one number rails.ts
 * proves you cannot copy. With no entry there is no scaled figure to print,
 * only the integer that actually came off the chain.
 */
function amountText(target: WatchTarget, chainId: number, units: bigint): string {
  const deployment = deploymentFor(chainId, target.token);
  return deployment.ok
    ? `${formatUnits(units, deployment.decimals)} ${target.token}`
    : `${units} raw units`;
}

function paidRow(target: WatchTarget, report: ChainReport & { kind: "matched" }): WatchRow {
  const payments = report.payments;
  const deepest = payments.reduce((a, b) => (a.confirmations >= b.confirmations ? a : b), payments[0] as Payment);
  const need = confirmationsFor(report.chainId);
  const amount = amountText(target, report.chainId, deepest.amount);
  if (isConfirmed(deepest)) {
    return {
      chainId: report.chainId,
      name: chainName(report.chainId),
      text: `PAID — ${amount} received`,
      tone: "paid",
      detail: `block ${deepest.blockNumber}, ${deepest.confirmations} confirmation(s), tx ${deepest.txHash}`,
    };
  }
  return {
    chainId: report.chainId,
    name: chainName(report.chainId),
    /* Deliberately not PAID yet, and deliberately not "no payment" either.
     * The customer's transaction exists; it is not deep enough to promise. */
    text: `Payment seen — ${amount}, waiting for ${need} confirmations (${deepest.confirmations} so far)`,
    tone: "seen",
    detail: `block ${deepest.blockNumber}, tx ${deepest.txHash}`,
  };
}

function unmatchedNote(report: ChainReport): string | undefined {
  const others = "unmatched" in report ? report.unmatched : undefined;
  if (others === undefined || others.length === 0) return undefined;
  /* Somebody paid this merchant an amount that is not this bill. Almost always
   * a customer who retyped the total and dropped the sub-cent marker — which is
   * money received, and must never read as "no payment". */
  return `${others.length} other transfer(s) to this address in the window, for a different amount`;
}

export function watchRow(target: WatchTarget, report: ChainReport): WatchRow {
  const name = chainName(report.chainId);
  const base = { chainId: report.chainId, name };
  if (report.kind === "matched") {
    const row = paidRow(target, report);
    const note = unmatchedNote(report);
    return note === undefined ? row : { ...row, detail: `${row.detail ?? ""} · ${note}` };
  }
  if (report.kind === "unpayable") {
    /* Not an outage and not an absence: nobody could have paid here. Saying
     * "no payment" would be true and useless, and would put a chain that was
     * never offered next to chains that were. */
    return { ...base, text: `Not offered here — ${report.reason}`, tone: "unpayable" };
  }
  if (report.kind === "unknown") {
    return {
      ...base,
      /* The sentence this file exists for. It contains no form of the word
       * "no payment", and it says out loud what the difference means. */
      text: `Unknown — we could not check this chain: ${REASONS[report.reason]}. ` +
        `A payment here would not be visible to us. This is not the same as unpaid.`,
      tone: "unknown",
      ...(report.window === undefined
        ? {}
        : { detail: `last looked at blocks ${report.window.fromBlock}–${report.window.toBlock}` }),
    };
  }
  const note = unmatchedNote(report);
  return {
    ...base,
    text: "No payment yet — checked and nothing has arrived",
    tone: "none",
    detail: `blocks ${report.window.fromBlock}–${report.window.toBlock} checked` +
      (report.endpointHost === undefined ? "" : ` via ${report.endpointHost}`) +
      (note === undefined ? "" : ` · ${note}`),
  };
}

/**
 * The whole watcher panel, as data.
 *
 * The headline is the only line most people read, so it is where the rule has
 * to hold hardest: "not paid" is sayable only when every chain that could take
 * this bill was actually checked.
 */
export function watchView(target: WatchTarget, snapshot: WatchSnapshot): WatchView {
  const rows = snapshot.reports.map((report) => watchRow(target, report));
  const paid = rows.filter((r) => r.tone === "paid");
  const seen = rows.filter((r) => r.tone === "seen");
  const unknown = rows.filter((r) => r.tone === "unknown");
  const checked = rows.filter((r) => r.tone === "none");

  let headline: string;
  let headlineTone: WatchTone;
  if (paid.length > 0) {
    headline = `PAID on ${paid.map((r) => r.name).join(", ")}.`;
    headlineTone = "paid";
  } else if (seen.length > 0) {
    headline = `Payment seen on ${seen.map((r) => r.name).join(", ")}, waiting for confirmations.`;
    headlineTone = "seen";
  } else if (snapshot.polls === 0) {
    headline = "Not looked yet.";
    headlineTone = "unknown";
  } else if (unknown.length > 0) {
    /* Never "not paid". We did not finish looking, and the customer standing
     * at the till may well have paid on one of the chains in this count. */
    headline = `Nothing seen on the ${checked.length} chain(s) we could check, and ` +
      `${unknown.length} chain(s) could not be checked. Do not tell the customer the payment failed.`;
    headlineTone = "unknown";
  } else if (checked.length === 0) {
    headline = "No chain in this bill could be checked.";
    headlineTone = "unknown";
  } else {
    headline = `No payment yet on any of the ${checked.length} chain(s) offered.`;
    headlineTone = "none";
  }

  const notices = [
    `A chain that could not be reached is shown as unknown, never as unpaid. ` +
      `Money can arrive on a chain this terminal cannot see.`,
    `Payments are matched by the exact amount, including the hundredths of a cent. ` +
      `A transfer for a different amount is listed but does not settle this bill.`,
    `Once a payment is confirmed it stays confirmed here, even if a later check ` +
      `fails. Takings are reconciled against the chain at shift close.`,
  ];
  return { headline, headlineTone, rows, notices };
}

/* -------------------------------------------------------------------- DOM */

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Draw the watcher panel, replacing whatever was there.
 *
 * `textContent` throughout: transaction hashes and sender addresses come from
 * an unverified RPC operator and none of it is markup.
 */
export function renderWatch(root: HTMLElement, view: WatchView): void {
  root.replaceChildren();
  root.className = "till-watch";

  root.append(el("p", `till-watch-headline till-watch-${view.headlineTone}`, view.headline));

  const list = el("div", "till-watch-rows");
  for (const row of view.rows) {
    const line = el("div", `till-watch-row till-watch-${row.tone}`);
    line.append(el("span", "till-watch-chain", row.name), el("span", "till-watch-state", row.text));
    if (row.detail !== undefined) line.append(el("span", "till-watch-detail", row.detail));
    list.append(line);
  }
  root.append(list);

  const notices = el("div", "till-notices");
  for (const note of view.notices) notices.append(el("p", undefined, note));
  root.append(notices);
}
