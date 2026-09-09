/**
 * The distribution panel: declare a dividend, then pay it, one holder at a time.
 *
 * ---------------------------------------------------------------------------
 * Why this is not part of the generic action form
 *
 * Every other privileged action is "fill in two fields, see the screen, press
 * the button". A dividend is not: it has to be reconciled against a snapshot
 * this console read, and the reconciliation is the safety property (see
 * dividend.ts). So the order here is check → declare → pay, and each stage
 * unlocks the next rather than sitting beside it.
 *
 * ---------------------------------------------------------------------------
 * The ledger is text, and that is the resumability story
 *
 * A payout is N transfers and N presses, and anything can stop it: a rejected
 * press, a closed window, a flat battery. What makes it resumable is the ledger
 * — which holders are paid, with which transaction — and what makes it survive
 * a closed window is that the ledger is shown as JSON the operator can copy and
 * paste back in. There is no hidden storage: the state that decides whether
 * somebody gets paid twice is in front of the person who owns it.
 *
 * `localStorage` was considered and rejected. It would be more convenient and it
 * would put the record of who has been paid in a place the operator does not
 * look at, cannot inspect, and would not think to check after clearing site
 * data. A payout record that can disappear silently is worse than one that has
 * to be handled.
 */

import { formatUnits } from "@leekwallet/core/chains.ts";
import { DESCRIPTOR_NOTICE } from "@leekwallet/core/erc7730.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { payNext, previewPrivileged, proposePrivileged, resolveUncertain } from "./act.ts";
import { REFUSAL_NOTICE, type SecurityFacts } from "./action.ts";
import { screenElement } from "./act-view.ts";
import {
  nextPayment, openLedger, paidSoFar, planDividend, renderDividendPlan,
  resumeDistribution, snapshotBindingCaveat,
  type DistributionLedger, type DividendPlan, type SnapshotHolder,
} from "./dividend.ts";
import { readSnapshotHolders, type RegisterView, type SnapshotRow } from "./register.ts";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const row = (label: string, control: HTMLElement): HTMLElement => {
  const line = el("div", "ats-row");
  line.appendChild(el("span", "ats-label", label));
  line.appendChild(control);
  return line;
};

const input = (label: string, placeholder = ""): HTMLInputElement => {
  const node = el("input");
  node.type = "text";
  node.placeholder = placeholder;
  node.setAttribute("aria-label", label);
  return node;
};

/** A ledger as text, and text as a ledger. Refuses anything that is not one. */
export function parseLedger(text: string): DistributionLedger | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "That is not JSON, so it is not a record of payments.";
  }
  if (typeof raw !== "object" || raw === null) return "A payment record is a JSON object.";
  const planId = (raw as Record<string, unknown>)["planId"];
  const records = (raw as Record<string, unknown>)["records"];
  if (typeof planId !== "string" || typeof records !== "object" || records === null) {
    return "A payment record needs a planId and a records object.";
  }
  return { planId, records: records as DistributionLedger["records"] };
}

/**
 * Snapshots a distribution can be planned against.
 *
 * A row whose supply or holder count is not `ok` is not offered at all. It is
 * not "offered with a warning": a distribution is planned from those two
 * numbers, and there is nothing to plan from without them.
 */
export function usableSnapshots(view: RegisterView): SnapshotRow[] {
  if (view.snapshots.state !== "ok") return [];
  return view.snapshots.value.rows.filter(
    (r) => r.totalSupply.state === "ok" && r.holderCount.state === "ok",
  );
}

/**
 * Render the panel under the register.
 *
 * `view` and `facts` come from the same read, so the snapshot list, the
 * security's decimals and the address every call is aimed at cannot come from
 * two different moments.
 */
export function renderDistributionPanel(
  root: HTMLElement, view: RegisterView, facts: SecurityFacts, context: AppContext,
): void {
  const section = el("section", "ats-panel");
  section.appendChild(el("h4", undefined, "Revenue distribution"));

  const snapshots = usableSnapshots(view);
  if (view.decimals.state !== "ok") {
    section.appendChild(el("p", "ats-notice",
      "This security's decimals could not be read, so a per-share rate cannot be " +
      "restated in shares and no distribution can be planned."));
    root.appendChild(section);
    return;
  }
  if (snapshots.length === 0) {
    section.appendChild(el("p", "ats-muted",
      "No snapshot with a readable supply and holder count. Take one with the " +
      "takeSnapshot action above, then read the register again — a distribution " +
      "is reconciled against a snapshot, never against the live register."));
    root.appendChild(section);
    return;
  }
  if (!context.propose) {
    section.appendChild(el("p", "ats-notice",
      "No device is connected. A dividend can be checked here but neither " +
      "declared nor paid without a press."));
  }

  const chooser = el("select");
  for (const s of snapshots) {
    const opt = document.createElement("option");
    opt.value = s.id.toString();
    const supply = s.totalSupply.state === "ok" ? s.totalSupply.value : 0n;
    const holders = s.holderCount.state === "ok" ? s.holderCount.value : 0n;
    opt.textContent =
      `#${s.id} — ${formatUnits(supply, view.decimals.state === "ok" ? view.decimals.value : 0)} ` +
      `shares, ${holders} holders`;
    chooser.appendChild(opt);
  }

  const token = input("Payment token address", "0x… ERC-20 the holders are paid in");
  const tokenDecimals = input("Payment token decimals", "6");
  const tokenSymbol = input("Symbol the token reports (optional)", "USDC");
  const perShare = input("Per whole share, in payment raw units", "250000");
  const statedTotal = input("Total, in payment raw units", "3500000000");
  const recordDate = input("Record date (unix seconds)");
  const executionDate = input("Payable from (unix seconds)");

  const form = el("div", "ats-panel");
  form.append(
    row("Snapshot", chooser),
    row("Payment token", token),
    row("Token decimals", tokenDecimals),
    row("Reported symbol", tokenSymbol),
    row("Per share (raw)", perShare),
    row("Total (raw)", statedTotal),
    row("Record date", recordDate),
    row("Payable from", executionDate),
  );

  const buttons = el("div", "ats-row");
  const checkButton = el("button", undefined, "Check against the snapshot");
  const declareButton = el("button", undefined, "Declare on device");
  declareButton.disabled = true;
  buttons.append(checkButton, declareButton);

  const out = el("div", "ats-panel");
  const payout = el("div", "ats-panel");
  section.append(form, buttons, out, payout);
  root.appendChild(section);

  let plan: DividendPlan | undefined;
  let ledger: DistributionLedger | undefined;

  const invalidate = (): void => {
    plan = undefined;
    ledger = undefined;
    declareButton.disabled = true;
    payout.replaceChildren();
  };
  for (const node of [token, tokenDecimals, tokenSymbol, perShare, statedTotal,
    recordDate, executionDate]) {
    node.addEventListener("input", invalidate);
  }
  chooser.addEventListener("change", invalidate);

  const uint = (node: HTMLInputElement): bigint | undefined =>
    /^\d+$/.test(node.value.trim()) ? BigInt(node.value.trim()) : undefined;

  /* ------------------------------------------------------------ the payout */

  const paintPayout = (): void => {
    payout.replaceChildren();
    if (plan === undefined || ledger === undefined) return;
    const step = nextPayment(plan, ledger);
    const done = paidSoFar(plan, ledger);
    payout.appendChild(el("h5", undefined, "Payout"));
    payout.appendChild(el("p", "ats-muted",
      `${formatUnits(done, plan.terms.token.decimals)} of ` +
      `${formatUnits(plan.total, plan.terms.token.decimals)} paid. Each holder is one ` +
      "transfer and one press; nothing here retries on its own."));

    if (step.state === "complete") {
      payout.appendChild(el("p", "ats-notice",
        `Every holder in this plan is marked paid: ${step.paid} transfers, ` +
        `${formatUnits(step.total, plan.terms.token.decimals)} in total.`));
    } else if (step.state === "blocked") {
      payout.appendChild(el("p", "ats-notice", step.why));
      /* The only way past an uncertain holder, and it needs a person who has
       * looked at the chain. Both buttons are deliberately equally easy: one of
       * them is right and this app does not know which. */
      const uncertain = plan.allocations.find(
        (a) => ledger?.records[a.address]?.state === "uncertain");
      if (uncertain !== undefined) {
        const tx = input("Transaction hash", "0x… hash you found on the explorer");
        const resolveRow = el("div", "ats-row");
        const markPaid = el("button", undefined, "It was paid — record this hash");
        const markNot = el("button", undefined, "It was not paid");
        markPaid.addEventListener("click", () => {
          if (!/^0x[0-9a-fA-F]{64}$/.test(tx.value.trim())) {
            payout.appendChild(el("p", "ats-notice",
              "A transaction hash is 32 bytes. Without one there is no evidence, " +
              "so nothing is marked paid."));
            return;
          }
          if (ledger === undefined) return;
          ledger = resolveUncertain(ledger, uncertain.address, { paid: true, tx: tx.value.trim() });
          paintPayout();
        });
        markNot.addEventListener("click", () => {
          if (ledger === undefined) return;
          ledger = resolveUncertain(ledger, uncertain.address,
            { paid: false, why: "the operator checked the chain and found no transfer" });
          paintPayout();
        });
        resolveRow.append(markPaid, markNot);
        payout.append(row("Resolve " + uncertain.address, tx), resolveRow);
      }
    } else {
      const line = el("p", undefined,
        `Next: holder ${step.index + 1} of ${plan.allocations.length}, ` +
        `${step.allocation.address}, ` +
        `${formatUnits(step.allocation.amount, plan.terms.token.decimals)} ` +
        `(${step.allocation.amount} raw units).`);
      payout.appendChild(line);
      const payButton = el("button", undefined, "Pay this holder");
      payButton.disabled = !context.propose;
      payButton.addEventListener("click", () => {
        payButton.disabled = true;
        const current = plan;
        const held = ledger;
        if (current === undefined || held === undefined) return;
        void payNext(context, current, held).then((attempt) => {
          ledger = attempt.ledger;
          paintPayout();
          payout.appendChild(el("p", "ats-notice", attempt.notice));
        });
      });
      payout.appendChild(payButton);
    }

    /* The record, as text, always visible. See this file's header: the state
     * that decides who gets paid twice belongs in the operator's hands. */
    const record = el("textarea");
    record.rows = 4;
    record.value = JSON.stringify(ledger);
    record.setAttribute("aria-label", "Record of payments");
    payout.append(el("p", "ats-muted",
      "Copy this before closing the window. Pasting it back resumes the payout " +
      "exactly where it stopped; it only resumes against this same plan."), record);

    const resumeRow = el("div", "ats-row");
    const resumeButton = el("button", undefined, "Resume from the text above");
    resumeButton.addEventListener("click", () => {
      const parsed = parseLedger(record.value);
      if (typeof parsed === "string") {
        payout.appendChild(el("p", "ats-notice", parsed));
        return;
      }
      if (plan === undefined) return;
      const resumed = resumeDistribution(plan, parsed);
      if (resumed.state === "refused") {
        payout.appendChild(el("p", "ats-notice", resumed.why));
        return;
      }
      ledger = resumed.ledger;
      paintPayout();
      payout.appendChild(el("p", "ats-muted",
        `Resumed: ${resumed.done} paid, ${resumed.remaining} to go.`));
    });
    resumeRow.appendChild(resumeButton);
    payout.appendChild(resumeRow);
  };

  /* ------------------------------------------------------------- the check */

  checkButton.addEventListener("click", () => {
    out.replaceChildren();
    invalidate();
    const chosen = snapshots.find((s) => s.id.toString() === chooser.value);
    if (chosen === undefined || chosen.totalSupply.state !== "ok"
      || chosen.holderCount.state !== "ok" || view.decimals.state !== "ok") {
      out.appendChild(el("p", "ats-notice", "That snapshot's figures are not available."));
      return;
    }
    const tokenAddress = token.value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
      out.appendChild(el("p", "ats-notice", "The payment token must be a 20-byte address."));
      return;
    }
    const decimals = uint(tokenDecimals);
    const rate = uint(perShare);
    const total = uint(statedTotal);
    const record_ = uint(recordDate);
    const execution = uint(executionDate);
    if (decimals === undefined || decimals > 255n) {
      out.appendChild(el("p", "ats-notice", "The token's decimals are a whole number, 0–255."));
      return;
    }
    if (rate === undefined || total === undefined) {
      out.appendChild(el("p", "ats-notice",
        "The per-share rate and the total are whole numbers of the payment " +
        "token's raw units. Decimals are not accepted here: the raw figure is " +
        "the one that ends up in the transaction."));
      return;
    }
    if (record_ === undefined || execution === undefined) {
      out.appendChild(el("p", "ats-notice", "Both dates are unix timestamps in whole seconds."));
      return;
    }

    checkButton.disabled = true;
    out.appendChild(el("p", "ats-muted", `Reading the holders at snapshot #${chosen.id}…`));
    void readSnapshotHolders(
      context.request, view.chainId, view.address, chosen.id,
      context.endpointHost ?? (() => undefined),
    ).then((holders) => {
      out.replaceChildren();
      if (holders.state !== "ok") {
        out.appendChild(el("p", "ats-notice",
          holders.state === "unavailable"
            ? `The holders at snapshot #${chosen.id} could not be read: ${holders.why}`
            : `This security did not answer for snapshot #${chosen.id}: ${holders.revert}`));
        return;
      }
      const shares: SnapshotHolder[] = holders.value.map((h) => ({
        address: h.address, shares: h.raw,
      }));
      const planned = planDividend(view.chainId, view.address, {
        snapshot: {
          id: chosen.id,
          totalSupply: chosen.totalSupply.state === "ok" ? chosen.totalSupply.value : 0n,
          holderCount: chosen.holderCount.state === "ok" ? chosen.holderCount.value : 0n,
          decimals: view.decimals.state === "ok" ? view.decimals.value : 0,
        },
        token: {
          address: tokenAddress,
          decimals: Number(decimals),
          reportedSymbol: tokenSymbol.value.trim() === "" ? undefined : tokenSymbol.value.trim(),
        },
        perShare: rate,
        statedTotal: total,
        recordDate: record_,
        executionDate: execution,
      }, shares);

      if (planned.state === "refused") {
        /* The audit gate, on screen. No "adjust the total for me" button: the
         * two numbers disagree and this console does not know which is right. */
        out.appendChild(el("p", "ats-notice", `Refused: ${planned.why}`));
        out.appendChild(el("p", "ats-muted", REFUSAL_NOTICE));
        return;
      }

      const summary = el("pre", "ats-screen", renderDividendPlan(planned));
      out.appendChild(summary);
      const screen = previewPrivileged(facts, { action: "setDividend", plan: planned });
      if (screen.state === "refused") {
        out.appendChild(el("p", "ats-notice", `Refused: ${screen.why}`));
        out.appendChild(el("p", "ats-muted", REFUSAL_NOTICE));
        return;
      }
      out.appendChild(screenElement(screen));
      out.appendChild(el("p", "ats-muted", DESCRIPTOR_NOTICE));
      out.appendChild(el("p", "ats-muted", snapshotBindingCaveat(chosen.id)));
      plan = planned;
      ledger = openLedger(planned);
      declareButton.disabled = !context.propose;
      paintPayout();
    }).finally(() => { checkButton.disabled = false; });
  });

  declareButton.addEventListener("click", () => {
    const current = plan;
    if (current === undefined) return;
    declareButton.disabled = true;
    void proposePrivileged(context, facts, { action: "setDividend", plan: current })
      .then((outcome) => {
        const note = el("p", "ats-notice", outcome.kind === "sent"
          ? `Declared. Transaction ${outcome.result}. The declaration moves no money: ` +
            "the payout below is what pays the holders."
          : outcome.kind === "refused" ? `Refused: ${outcome.why}` : outcome.notice);
        out.appendChild(note);
      });
  });
}
