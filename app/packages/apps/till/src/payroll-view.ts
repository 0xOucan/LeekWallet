/**
 * The payroll screen: the registry, the file it came from, the total, and the
 * run.
 *
 * ---------------------------------------------------------------------------
 * What the screen has to make impossible
 *
 * Someone is about to approve a list of strangers' addresses receiving money.
 * Two mistakes are easy to make and both are unrecoverable:
 *
 *  1. Approving a **total** they did not expect. So the total is the largest
 *     thing on the screen, computed from the rows (never read from the file),
 *     rendered through `describeTokenAmount` with the notice that says nobody
 *     verified the token's decimals, and shown before the run can be armed.
 *  2. Believing a **label**. `name` and `role` come from a file the host read;
 *     the device has never seen them and cannot attest to them. The screen
 *     therefore prints the address on the same line as the name, every time,
 *     and says in words that the device will show the address and not the
 *     name. A payroll UI that showed "Ana — 500 USDC" and nothing else would
 *     be inviting the user to check the one field an attacker controls.
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

/** One person, as a row on the screen. */
export interface StaffRowView {
  readonly name: string;
  readonly role: string;
  /** Always shown. The only field that decides where the money goes. */
  readonly address: string;
  /** Raw units, always; the scaled figure only where it exists. */
  readonly amountText: string;
  readonly rawText: string;
  readonly state: string;
}

export interface PayrollView {
  readonly chainName: string;
  readonly token: PayrollToken;
  readonly count: number;
  readonly rows: readonly StaffRowView[];
  /** The prominent figure. Empty when there is nothing plannable. */
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
    `Each payment is a separate transaction and a separate confirmation on the ` +
      `device. A run is not atomic: it can stop part way, and rows already sent ` +
      `stay sent.`,
    TOKEN_SCALE_NOTICE,
  ];

  if (!planned.ok) {
    return {
      chainName,
      token: state.token,
      count: state.staff.length,
      rows: state.staff.map((m) => ({
        name: m.name, role: m.role, address: m.address,
        amountText: `${m.amount.text} ${state.token}`, rawText: "", state: "",
      })),
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
  return {
    chainName,
    token: state.token,
    count: plan.payments.length,
    rows: plan.payments.map((payment, i) => ({
      name: payment.member.name,
      role: payment.member.role,
      address: payment.member.address,
      amountText: amountText(payment.view, state.token),
      rawText: payment.view.rawText,
      state: stateText(state.progress?.states[i]),
    })),
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
    `${view.count} on the payroll · ${view.token} on ${view.chainName}`);
  panel.append(head);

  if (view.problem !== undefined) {
    panel.append(el("p", "till-error", view.problem));
  } else {
    const total = el("div", "till-payroll-total");
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
    line.append(el("span", "till-payroll-amount", row.amountText));
    if (row.state !== "") line.append(el("span", "till-payroll-state", row.state));
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
  summary: "Pay the staff: import a CSV, check the total, confirm every transfer on the device.",
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
    paste.placeholder = "name,role,address,amount\nAna,waiter,0x…,500.00";
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
    const fields = (["name", "role", "address", "amount"] as const).map((which) => {
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
        amount: (fields[3]?.[1].value ?? ""),
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
