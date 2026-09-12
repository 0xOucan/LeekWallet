/**
 * Issuing, and finding what was issued, as DOM.
 *
 * Thin, like act-view.ts and market-view.ts: `issue.ts` decides what a deploy
 * call is and whether there is one, `discover.ts` decides what the logs say,
 * and this file reads two fields, calls them, and puts their sentences on
 * screen. The two rules it owns:
 *
 *   1. The preview is DECODED from the calldata, never echoed from the form.
 *      A panel that reprints what you typed tells you about the form; a panel
 *      that decodes what it built tells you about the transaction.
 *   2. A failed discovery is rendered as a failure, in the place the list would
 *      have been. It never collapses into an empty list — see discover.ts, and
 *      the sibling log-scanning app whose header it quotes.
 */

import type { AppContext } from "@leekwallet/core/mini-app.ts";
import {
  DEVICE_CANNOT_DRAW_NOTICE, LEEK_SECURITY_FACTORY, ETH_MAX_DATA,
  planIssue, runIssue, type IssueKind, type IssuePlan, type IssueRefusal,
} from "./issue.ts";
import {
  DISCOVERY_NOTICE, discoverIssued, mergeSecurities,
  type Discovery, type SecurityChoice,
} from "./discover.ts";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const row = (label: string, value: HTMLElement | string, cls?: string): HTMLElement => {
  const line = el("div", "ats-row");
  line.append(el("span", "ats-label", label));
  line.append(typeof value === "string" ? el("span", cls, value) : value);
  return line;
};

const field = (label: string, placeholder: string, maxLength: number): {
  wrap: HTMLElement; input: HTMLInputElement;
} => {
  const wrap = el("div", "ats-row");
  wrap.append(el("span", "ats-label", label));
  const input = el("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.setAttribute("aria-label", label);
  wrap.append(input);
  return { wrap, input };
};

/* ------------------------------------------------------------------- issue */

/**
 * The issuance form.
 *
 * Rendered even when the factory is unset, and that is the point of it: the
 * screen states what is missing and names the constant, which is more use than
 * an absent panel nobody can ask a question about. The button stays live — the
 * refusal comes back from `planIssue` as a sentence and is printed — because a
 * disabled control with no explanation is the same silence in a different font.
 */
export function renderIssuePanel(root: HTMLElement, context: AppContext): void {
  const section = el("section", "ats-panel");
  section.append(el("h4", undefined, "Issue a security"));
  section.append(el("p", "ats-muted",
    "LeekSecurityFactory deploys an ATS equity or bond from a fixed template " +
    "and grants all twelve roles to the caller — this wallet. Only the name " +
    "and the symbol vary, which is what makes the call small enough for a " +
    `device that holds ${ETH_MAX_DATA} bytes of calldata and refuses more.`));

  if (LEEK_SECURITY_FACTORY.trim() === "") {
    /* Said once, at the top, in the notice style, rather than only when the
     * button is pressed: a user should not have to spend an action to find out
     * that the panel cannot work yet. */
    section.append(el("p", "ats-notice",
      "LeekSecurityFactory is not deployed and this console has no address for " +
      "it, so nothing here will build a transaction yet. The address goes in " +
      "LEEK_SECURITY_FACTORY in app/packages/apps/ats/src/issue.ts."));
  } else {
    section.append(row("Factory", el("span", "ats-address", LEEK_SECURITY_FACTORY)));
  }
  section.append(el("p", "ats-notice", DEVICE_CANNOT_DRAW_NOTICE));

  const kindRow = el("div", "ats-row");
  kindRow.append(el("span", "ats-label", "Kind"));
  const kind = el("select");
  kind.setAttribute("aria-label", "Equity or bond");
  for (const [value, text] of [
    ["deployEquity", "Equity — 1,000,000 shares, USD 1.00 face, voting"],
    ["deployBond", "Bond — 100,000 notes, USD 1,000.00 face, one-year term"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    kind.append(opt);
  }
  kindRow.append(kind);

  const name = field("Name", "LeekWallet Equity Series B", 64);
  const symbol = field("Symbol", "LEEKC", 12);
  const build = el("button", undefined, "Build the call");
  const ask = el("button", "ghost", "Ask the device");
  ask.disabled = true;
  const buttons = el("div", "ats-row");
  buttons.append(build, ask);
  const out = el("div", "ats-panel");
  section.append(kindRow, name.wrap, symbol.wrap, buttons, out);
  root.append(section);

  let plan: IssuePlan | IssueRefusal | undefined;

  build.addEventListener("click", () => {
    plan = planIssue({
      kind: kind.value as IssueKind,
      name: name.input.value,
      symbol: symbol.input.value,
    });
    out.replaceChildren();
    if (!plan.ok) {
      ask.disabled = true;
      out.append(el("p", "ats-notice", plan.reason));
      return;
    }
    ask.disabled = false;
    out.append(planElement(plan));
  });

  ask.addEventListener("click", () => {
    void (async () => {
      if (plan === undefined) return;
      ask.disabled = true;
      const outcome = await runIssue(context, plan);
      const line = el("p");
      switch (outcome.kind) {
        case "sent":
          line.className = "ats-muted";
          line.textContent =
            `Signed and sent. Transaction ${outcome.result}. The security's address ` +
            "is in the EquityDeployed or BondDeployed log of that transaction; " +
            "press \"Find what this wallet has issued\" below once it is mined.";
          break;
        case "declined":
          line.className = "ats-uncertain";
          line.textContent = outcome.notice;
          ask.disabled = false;
          break;
        case "refused":
          line.className = "ats-notice";
          line.textContent = outcome.reason;
          break;
        case "cannot-ask":
          line.className = "ats-uncertain";
          line.textContent = outcome.notice;
          ask.disabled = false;
          break;
      }
      out.append(line);
    })();
  });
}

/** The built call, read back out of its own bytes. */
function planElement(plan: IssuePlan): HTMLElement {
  const box = el("div", "ats-screen");
  box.append(el("div", "ats-screen-title",
    plan.kind === "deployEquity" ? "DEPLOY EQUITY" : "DEPLOY BOND"));
  box.append(row("To", el("span", "ats-address", plan.to)));
  /* Decoded, not echoed. See the file header. */
  box.append(row("Name", plan.decoded.name));
  box.append(row("Symbol", plan.decoded.symbol));
  box.append(row("Calldata", `${plan.dataBytes} bytes of ${ETH_MAX_DATA} the device holds`));
  box.append(row("Selector", el("span", "ats-address", plan.data.slice(0, 10))));
  box.append(el("p", "ats-muted",
    "Read back from the bytes this app built, not from the fields above. This " +
    "is this app's own reading and it is advisory: it is not a device screen " +
    "and it is not an approval."));
  return box;
}

/* ---------------------------------------------------------------- discover */

/**
 * Find what this wallet has issued, and merge it with the hard-coded table.
 *
 * `onSelect` hands an address back to whoever mounted the panel, so a row can
 * become the security the console is reading without this file knowing how the
 * console loads one. `onChoices` hands back the merged list after every scan,
 * so the holdings panel reads balances for what was just discovered as well as
 * for the table — and it is called with the table alone on mount, so a panel
 * downstream of it is never left with no list at all.
 */
export function renderDiscoverPanel(
  root: HTMLElement,
  context: AppContext,
  onSelect: (address: string) => void,
  onChoices: (choices: readonly SecurityChoice[]) => void = () => {},
  factory: string = LEEK_SECURITY_FACTORY,
): void {
  const section = el("section", "ats-panel");
  section.append(el("h4", undefined, "Securities this wallet can act on"));
  section.append(el("p", "ats-muted", DISCOVERY_NOTICE));
  section.append(row("Issuer", el("span", "ats-address", context.address)));

  const scan = el("button", undefined, "Find what this wallet has issued");
  const out = el("div", "ats-panel");
  section.append(scan, out);
  root.append(section);

  /* The table alone, drawn before any scan: these four addresses are known
   * without asking anybody, and a panel that is blank until a network call
   * succeeds is a panel that looks broken when the network is. */
  const initial = mergeSecurities(
    { ok: false, reason: "logs-unavailable", why: "not scanned yet" },
  );
  paintChoices(out, initial, undefined, onSelect);
  onChoices(initial);

  scan.addEventListener("click", () => {
    void (async () => {
      scan.disabled = true;
      out.replaceChildren(el("p", "ats-muted", "Scanning the factory's logs…"));
      let discovery: Discovery;
      try {
        discovery = await discoverIssued(context.request, context.address, factory);
      } catch (e) {
        /* A throw is not a result. Neither is it an empty list. */
        discovery = {
          ok: false, reason: "logs-unavailable",
          why: `the scan threw: ${String((e as Error)?.message ?? e)}`,
        };
      }
      out.replaceChildren();
      const merged = mergeSecurities(discovery);
      paintChoices(out, merged, discovery, onSelect);
      onChoices(merged);
      scan.disabled = false;
    })();
  });
}

function paintChoices(
  out: HTMLElement,
  choices: readonly SecurityChoice[],
  discovery: Discovery | undefined,
  onSelect: (address: string) => void,
): void {
  out.replaceChildren();
  if (discovery === undefined) {
    out.append(el("p", "ats-muted",
      "The four securities this repo knows about are listed below. Press the " +
      "button to ask the chain what else this wallet has issued."));
  } else if (discovery.ok) {
    out.append(el("p", "ats-muted",
      `Scanned blocks ${discovery.window.fromBlock}–${discovery.window.toBlock}: ` +
      `${discovery.issued.length} deployment(s) by this wallet. Anything issued ` +
      "before that window was not looked for."));
  } else {
    /* The failure goes where the list would have been, in the alarm style, and
     * the table below it is labelled as the table. Nothing on this screen may
     * read as "you have issued nothing". */
    out.append(el("p", "ats-notice",
      `The log scan did not complete, so this console cannot say what this ` +
      `wallet has issued: ${discovery.why} The list below is this repo's ` +
      "hard-coded table only, and is not an answer to that question."));
  }

  const table = el("table", "ats-table");
  const head = el("tr");
  for (const h of ["Symbol", "Address", "Kind", "Known from", "Note"]) {
    head.append(el("th", undefined, h));
  }
  table.append(head);
  for (const choice of choices) {
    const tr = el("tr");
    const pick = el("button", "ghost", choice.symbol);
    pick.title = "Read this security's register";
    pick.addEventListener("click", () => onSelect(choice.address));
    const symbolCell = el("td");
    symbolCell.append(pick);
    tr.append(symbolCell);
    tr.append(el("td", "ats-address", choice.address));
    tr.append(el("td", undefined, choice.kind));
    tr.append(el("td", undefined, SOURCE_TEXT[choice.source]));
    tr.append(el("td", "ats-muted", choice.note));
    table.append(tr);
  }
  out.append(table);
  out.append(el("p", "ats-muted",
    "\"Known from\" is the difference between something this repo wrote down " +
    "and something the chain told us. A symbol or a name in either case is a " +
    "label: the register read is what produces figures."));
}

const SOURCE_TEXT: Readonly<Record<SecurityChoice["source"], string>> = {
  table: "this repo's table",
  log: "the factory's logs",
  both: "table, confirmed by a log",
};
