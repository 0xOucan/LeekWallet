/**
 * The payroll screen: the registry, the file it came from, the total, and the
 * run.
 *
 * ---------------------------------------------------------------------------
 * What the screen has to make impossible
 *
 * Someone is about to approve a list of strangers' addresses receiving money.
 * Three mistakes are easy to make and all of them are unrecoverable:
 *
 *  1. Approving a **total** they did not expect. So the total is the largest
 *     thing on the screen, computed from the rows (never read from the file),
 *     rendered through `describeTokenAmount` with the notice that says nobody
 *     verified the token's decimals, and shown before the run can be armed.
 *     THREE totals, since tips arrived: salary, tips, and the sum. A payroll
 *     with tips in it is two approvals of two different kinds of money (see
 *     staff.ts), and a screen showing only the blended figure would ask for
 *     one approval covering both — the exact conflation the two transactions
 *     exist to prevent. The parts are drawn above the total, not under it.
 *  2. Believing a **label**. `name` and `role` come from a file the host read;
 *     the device has never seen them and cannot attest to them. The screen
 *     therefore prints the address on the same line as the name, every time,
 *     and says in words that the device will show the address and not the
 *     name. A payroll UI that showed "Ana — 500 USDC" and nothing else would
 *     be inviting the user to check the one field an attacker controls.
 *  3. Losing track of **which leg of which person** succeeded. The run is
 *     sequential and not atomic, so "Ana: salary sent, tips declined" is a
 *     state it can genuinely end in, and it is the state an accountant has to
 *     be able to read off the screen. Every row therefore carries two amounts
 *     and two independent states, and neither is ever summarised into one.
 *
 * ---------------------------------------------------------------------------
 * View model first, DOM second
 *
 * `payrollView` is a pure function from state to the strings that will be
 * rendered, so the assertions in test/payroll-view.test.ts are about what a
 * person would read rather than about a DOM. Same split as view.ts and
 * watch-view.ts, for the same reason.
 */

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";
import { TOKEN_SCALE_NOTICE, type TokenAmountView } from "@leekwallet/core/balances.ts";
import { chainLabel } from "@leekwallet/core/chains.ts";
import { TILL_CSS } from "./css.ts";
import { TILL_CHAIN_IDS } from "./rails.ts";
import {
  importStaffCsv, staffFromFields, MAX_STAFF, type Duplicate, type StaffMember,
} from "./staff.ts";
import {
  PAYROLL_TOKENS, planPayroll, runPayroll,
  type PayrollPlan, type PayrollToken, type PaymentState, type RunProgress,
} from "./payroll.ts";

/**
 * One person, as a row on the screen: two legs, each with its own state.
 *
 * The legs are not summed here and there is deliberately no `totalText` on a
 * row. A row that showed "1,412.50" with the split hidden underneath would put
 * back, on the only screen a human reads, exactly the conflation the two
 * transactions exist to prevent.
 */
export interface StaffRowView {
  readonly name: string;
  readonly role: string;
  /** Always shown. The only field that decides where the money goes. */
  readonly address: string;
  /** Raw units, always; the scaled figure only where it exists. */
  readonly salaryText: string;
  readonly salaryRawText: string;
  readonly salaryState: string;
  /** Empty when this person earned no tips — then there is no tips transfer. */
  readonly tipsText: string;
  readonly tipsRawText: string;
  readonly tipsState: string;
}

export interface PayrollView {
  readonly chainName: string;
  readonly token: PayrollToken;
  readonly count: number;
  readonly rows: readonly StaffRowView[];
  /** How many transfers the run is, which is not the head-count. */
  readonly legCount: number;
  /**
   * The three figures, all shown, none of them derivable from the screen
   * without the other two. Empty when there is nothing plannable.
   */
  readonly salaryTotalText: string;
  readonly salaryTotalRawText: string;
  readonly tipsTotalText: string;
  readonly tipsTotalRawText: string;
  /** The prominent figure: what actually leaves the account. */
  readonly totalText: string;
  readonly totalRawText: string;
  /** Why there is no total, when there is none. */
  readonly problem?: string;
  readonly notices: readonly string[];
  /** True only when a plan exists and the run has not started. */
  readonly armable: boolean;
}

/** How a figure is written when the scaled form exists, and when it does not. */
function amountText(view: TokenAmountView, token: PayrollToken): string {
  return view.scaled === undefined
    ? `${view.rawText} raw units (decimals unknown)`
    : `${view.scaled.text} ${token}`;
}

function stateText(state: PaymentState | undefined): string {
  switch (state?.kind) {
    case undefined:
    case "waiting": return "";
    case "proposed": return "waiting for the device";
    /* "sent", never "paid": a hash is a transaction accepted for broadcast,
     * and this app does not watch for its inclusion. The cashier's side has a
     * whole module for the difference (watch.ts) and this one does not, so it
     * must not borrow the stronger word. */
    case "sent": return `sent: ${state.result.slice(0, 12)}…`;
    case "declined": return "declined — the run stopped here";
    case "failed": return `failed: ${state.reason.slice(0, 60)}`;
  }
}

export interface PayrollState {
  staff: StaffMember[];
  token: PayrollToken;
  chainId: number;
  from: string;
  /** Set once a run is under way; rows read their state from it. */
  progress: RunProgress | undefined;
  running: boolean;
}

export function payrollView(state: PayrollState): PayrollView {
  const chainName = chainLabel(state.chainId);
  const planned = planPayroll(state.staff, state.chainId, state.token, state.from);
  const notices: string[] = [
    `Names and roles come from the file you imported. Nothing has checked them, ` +
      `and the device will show the ADDRESS, not the name — compare those.`,
    `Salary and tips are sent as SEPARATE transactions, one screen and one ` +
      `confirmation each. They are different money — a wage and money held for ` +
      `the staff who earned it — and one blended transfer could never be read ` +
      `apart again on-chain. Check both totals below: they are not the same figure.`,
    `Each payment is a separate transaction and a separate confirmation on the ` +
      `device. A run is not atomic: it can stop part way, and legs already sent ` +
      `stay sent — one person's salary can be sent while their tips are not.`,
    TOKEN_SCALE_NOTICE,
  ];

  if (!planned.ok) {
    return {
      chainName,
      token: state.token,
      count: state.staff.length,
      /* The unplannable case still shows both figures AS WRITTEN in the file.
       * Falling back to one number here would mean the screen a user sees while
       * fixing a bad row is the one screen that hides the split. */
      rows: state.staff.map((m) => ({
        name: m.name, role: m.role, address: m.address,
        salaryText: `${m.salary.text} ${state.token}`, salaryRawText: "", salaryState: "",
        tipsText: m.tips === undefined ? "" : `${m.tips.text} ${state.token}`,
        tipsRawText: "", tipsState: "",
      })),
      legCount: 0,
      salaryTotalText: "",
      salaryTotalRawText: "",
      tipsTotalText: "",
      tipsTotalRawText: "",
      totalText: "",
      totalRawText: "",
      problem: planned.line > 0 ? `Line ${planned.line}: ${planned.reason}` : planned.reason,
      notices,
      armable: false,
    };
  }

  const { plan } = planned;
  if (plan.duplicates.length > 0) {
    notices.unshift(duplicateNotice(plan.duplicates));
  }

  /* One row per PERSON, built from the flat list of legs, so that the screen is
   * organised the way the payroll is — by who is being paid — while the run
   * underneath is organised the way the device is, by proposal. `memberIndex`
   * is what joins them; matching on name or address would collapse the two rows
   * of a confirmed duplicate into one. */
  const rows: StaffRowView[] = state.staff.map((member) => ({
    name: member.name, role: member.role, address: member.address,
    salaryText: "", salaryRawText: "", salaryState: "",
    tipsText: "", tipsRawText: "", tipsState: "",
  }));
  for (let i = 0; i < plan.payments.length; i++) {
    const payment = plan.payments[i] as (typeof plan.payments)[number];
    const row = rows[payment.memberIndex] as StaffRowView;
    const text = amountText(payment.view, state.token);
    const legState = stateText(state.progress?.states[i]);
    rows[payment.memberIndex] = payment.leg === "salary"
      ? { ...row, salaryText: text, salaryRawText: payment.view.rawText, salaryState: legState }
      : { ...row, tipsText: text, tipsRawText: payment.view.rawText, tipsState: legState };
  }

  return {
    chainName,
    token: state.token,
    count: state.staff.length,
    rows,
    legCount: plan.payments.length,
    salaryTotalText: amountText(plan.salaryTotal, state.token),
    salaryTotalRawText: plan.salaryTotal.rawText,
    tipsTotalText: amountText(plan.tipsTotal, state.token),
    tipsTotalRawText: plan.tipsTotal.rawText,
    totalText: amountText(plan.total, state.token),
    totalRawText: plan.total.rawText,
    notices,
    armable: !state.running && state.progress === undefined,
  };
}

/** The sentence a confirmed duplicate earns, with the count in it. */
export function duplicateNotice(duplicates: readonly Duplicate[]): string {
  const rows = duplicates.reduce((n, d) => n + d.lines.length, 0);
  return (
    `${duplicates.length} recipient${duplicates.length === 1 ? " is" : "s are"} paid more than ` +
    `once in this run (${rows} rows). You confirmed that; it is not a mistake this app corrected.`
  );
}

/* ------------------------------------------------------------------- DOM */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function renderPayroll(root: HTMLElement, view: PayrollView): void {
  const panel = el("div", "till-payroll");

  const head = el("p", "till-payroll-head",
    view.problem === undefined
      ? `${view.count} on the payroll · ${view.legCount} transactions · ` +
        `${view.token} on ${view.chainName}`
      : `${view.count} on the payroll · ${view.token} on ${view.chainName}`);
  panel.append(head);

  if (view.problem !== undefined) {
    panel.append(el("p", "till-error", view.problem));
  } else {
    /* Three figures, and the two parts are drawn BEFORE the grand total rather
     * than as a footnote under it. Reading order is the argument: somebody who
     * stops reading after the big number has still seen what it is made of. */
    const total = el("div", "till-payroll-total");
    const part = (label: string, text: string, raw: string) => {
      total.append(el("p", "till-waiter-label", label));
      total.append(el("p", "till-payroll-subtotal", text));
      total.append(el("p", "till-waiter-bill", `${raw} raw units`));
    };
    part("Salary", view.salaryTotalText, view.salaryTotalRawText);
    part("Tips", view.tipsTotalText, view.tipsTotalRawText);
    total.append(el("p", "till-waiter-label", "Total to send"));
    total.append(el("p", "till-waiter-total", view.totalText));
    total.append(el("p", "till-waiter-bill", `${view.totalRawText} raw units`));
    panel.append(total);
  }

  const list = el("div", "till-payroll-rows");
  for (const row of view.rows) {
    const line = el("div", "till-payroll-row");
    line.append(el("span", "till-payroll-who", `${row.name} · ${row.role}`));
    line.append(el("span", "till-payroll-addr", row.address));
    const leg = (label: string, text: string, state: string) => {
      const span = el("span", "till-payroll-amount", `${label} ${text}`);
      line.append(span);
      if (state !== "") line.append(el("span", "till-payroll-state", `${label} ${state}`));
    };
    leg("salary", row.salaryText, row.salaryState);
    /* No tips line at all where there are none — not "tips 0". A zero on the
     * screen invites the reader to look for a transaction that will not exist. */
    if (row.tipsText !== "") leg("tips", row.tipsText, row.tipsState);
    list.append(line);
  }
  panel.append(list);

  const notices = el("div", "till-notices");
  for (const notice of view.notices) notices.append(el("p", undefined, notice));
  panel.append(notices);

  root.replaceChildren(panel);
}

/* ------------------------------------------------------------------- app */

/**
 * The payroll app.
 *
 * Admin mode is the mount itself: this is a separate `MiniApp` from the
 * cashier's and the waiter's, so a device that mounts one of those has no code
 * path to this one. And it needs a device — without `propose` there is nothing
 * it can do, and it says so instead of drawing a screen with a dead button.
 */
export const TILL_PAYROLL_APP: MiniApp = {
  id: "till-payroll",
  name: "La Caja — Payroll",
  summary:
    "Pay the staff: import a CSV of salaries and tips, check all three totals, " +
    "and confirm every transfer on the device — salary and tips are sent separately.",
  chainIds: TILL_CHAIN_IDS,
  css: TILL_CSS,
  async mount(root: HTMLElement, context: AppContext) {
    root.replaceChildren();
    const panel = el("div", "till");
    root.append(panel);

    const propose = context.propose;
    if (propose === undefined) {
      /* Not a disabled button. A payroll screen with nothing behind it invites
       * somebody to fill it in and discover at the end that it was never going
       * anywhere. */
      panel.append(el("p", "till-error",
        "Payroll needs the wallet device connected: every payment is confirmed on it. " +
        "Connect the device and open this again."));
      return;
    }

    const state: PayrollState = {
      staff: [],
      token: "USDC",
      chainId: context.chainId,
      from: context.address,
      progress: undefined,
      running: false,
    };
    let allowDuplicates = false;

    const controls = el("div", "till-keypad");
    const tokenPicker = el("select");
    tokenPicker.setAttribute("aria-label", "Currency");
    for (const token of PAYROLL_TOKENS) {
      const option = el("option");
      option.value = token;
      option.textContent = token;
      tokenPicker.append(option);
    }
    controls.append(tokenPicker);

    const file = el("input");
    file.type = "file";
    file.accept = ".csv,text/csv,text/plain";
    file.setAttribute("aria-label", "Payroll CSV");
    controls.append(file);

    const duplicates = el("input");
    duplicates.type = "checkbox";
    duplicates.setAttribute("aria-label", "Allow an address to be paid twice");
    const duplicateLabel = el("label", "till-payroll-dupes");
    duplicateLabel.append(duplicates, document.createTextNode(" allow a repeated address"));
    controls.append(duplicateLabel);
    panel.append(controls);

    const paste = el("textarea");
    paste.className = "till-payroll-paste";
    paste.setAttribute("aria-label", "Paste a payroll CSV");
    paste.placeholder =
      "name,role,address,salary,tips\nAna,waiter,0x…,1250.00,162.50";
    panel.append(paste);

    const importButton = el("button", "till-payroll-import", "Import these rows");
    importButton.type = "button";
    const clearButton = el("button", "till-payroll-clear", "Clear the payroll");
    clearButton.type = "button";
    const runButton = el("button", "till-payroll-run", "Review and send");
    runButton.type = "button";
    const actions = el("div", "till-actions");
    actions.append(importButton, clearButton, runButton);
    panel.append(actions);

    const addForm = el("div", "till-payroll-add");
    const fields = (["name", "role", "address", "salary", "tips"] as const).map((which) => {
      const input = el("input");
      input.type = "text";
      input.placeholder = which;
      input.setAttribute("aria-label", `New ${which}`);
      addForm.append(input);
      return [which, input] as const;
    });
    const addButton = el("button", undefined, "Add one person");
    addButton.type = "button";
    addForm.append(addButton);
    panel.append(addForm);

    const error = el("p", "till-error");
    panel.append(error);
    const output = el("div");
    panel.append(output);

    const redraw = () => renderPayroll(output, payrollView(state));

    const importText = (text: string) => {
      const result = importStaffCsv(text, { allowDuplicates });
      if (!result.ok) {
        /* The line number is the whole point of the message: a file is edited
         * by going to a line, and "row 7 is bad" over a file with a header and
         * blank lines is not a line number. */
        error.textContent = result.line > 0
          ? `Line ${result.line}: ${result.reason} — nothing was imported.`
          : `${result.reason} — nothing was imported.`;
        return;
      }
      // Replaces rather than appends: an import is a payroll, not an addition
      // to one, and appending is how a file gets paid twice.
      state.staff = [...result.staff];
      state.progress = undefined;
      error.textContent = result.duplicates.length > 0 ? duplicateNotice(result.duplicates) : "";
      redraw();
    };

    tokenPicker.addEventListener("change", () => {
      state.token = tokenPicker.value as PayrollToken;
      redraw();
    });
    duplicates.addEventListener("change", () => { allowDuplicates = duplicates.checked; });
    importButton.addEventListener("click", () => importText(paste.value));
    clearButton.addEventListener("click", () => {
      state.staff = [];
      state.progress = undefined;
      error.textContent = "";
      redraw();
    });
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      if (chosen === undefined) return;
      void chosen.text().then(importText, (e: Error) => {
        error.textContent = `That file could not be read: ${e.message}`;
      });
    });
    addButton.addEventListener("click", () => {
      const entered = {
        name: (fields[0]?.[1].value ?? ""),
        role: (fields[1]?.[1].value ?? ""),
        address: (fields[2]?.[1].value ?? ""),
        salary: (fields[3]?.[1].value ?? ""),
        // Left blank for somebody who earned none; `staffFromFields` reads an
        // empty tips box and a zero in it as the same thing.
        tips: (fields[4]?.[1].value ?? ""),
      };
      const made = staffFromFields(entered);
      if (!made.ok) { error.textContent = made.reason; return; }
      if (state.staff.length >= MAX_STAFF) {
        error.textContent = `This app pays at most ${MAX_STAFF} people in one run.`;
        return;
      }
      state.staff = [...state.staff, made.member];
      state.progress = undefined;
      error.textContent = "";
      for (const [, input] of fields) input.value = "";
      redraw();
    });

    runButton.addEventListener("click", () => {
      if (state.running) return;
      /* A run that has already happened cannot be started again over the same
       * registry. Pressing the button twice is the cheapest way to pay
       * everybody twice, and a run is not atomic, so "it failed half way" and
       * "it succeeded" look similar enough on a screen to be confused. Clearing
       * the payroll — or importing a new file — is the deliberate act that
       * makes a second run possible, and it is the act that forces somebody to
       * look at which rows were already sent. */
      if (state.progress !== undefined) {
        error.textContent =
          "This payroll has already been run. Rows shown as sent are sent. " +
          "Clear the payroll, or import the rows that still need paying, before sending again.";
        return;
      }
      const planned = planPayroll(state.staff, state.chainId, state.token, state.from);
      if (!planned.ok) {
        error.textContent = planned.line > 0
          ? `Line ${planned.line}: ${planned.reason}`
          : planned.reason;
        return;
      }
      state.running = true;
      error.textContent = "";
      redraw();
      void run(planned.plan);
    });

    const run = async (plan: PayrollPlan) => {
      await runPayroll(plan, propose, (progress) => {
        state.progress = progress;
        redraw();
      });
      state.running = false;
      redraw();
    };

    redraw();
  },
};
