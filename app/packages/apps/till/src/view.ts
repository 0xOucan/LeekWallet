/**
 * The bill as text, and then as DOM.
 *
 * Split the way Aqua's view is split, for the same reason: the properties that
 * must not break — a rail that cannot be paid never rendering as one that can,
 * base + tip always equalling the total on screen, the QR never carrying an
 * amount different from the printed one — are properties of the view MODEL, so
 * the model is pure and node can assert on it with no browser present.
 *
 * `tillView()` never throws. A waiter who has typed half an amount is the
 * normal case, not an error, and the model says "nothing to charge yet" rather
 * than the app failing to render.
 */

import qrcodegen from "qrcode-generator";
import { formatUnits } from "@leekwallet/core/chains.ts";
import { buildOrder, formatCents, type Cents, type Order, type Tip } from "./order.ts";
import { payableUnits } from "./order.ts";
import {
  breakevenCents, CARD_NOTICE, costsMoreThanCard, deploymentFor,
  railsCheapestFirst, type Rail, type TillToken,
} from "./rails.ts";
import { buildPaymentUri, shareMessage, whatsappLink } from "./uri.ts";

export interface TillState {
  /** Shown on the QR caption and in the WhatsApp message. */
  merchant: string;
  /** Where the money goes — the address the shell is showing. */
  recipient: string;
  /** Null until the waiter has typed something parseable. */
  base: Cents | null;
  tip: Tip;
  token: TillToken;
  /** The rail the customer picked. */
  chainId: number;
  /** Sub-cent order marker, 0–99. See order.ts. */
  marker: number;
}

/** How a line should read. `unavailable` is a state, never a styled zero. */
export type Tone = "normal" | "muted" | "warn" | "unavailable";

export interface Line {
  label: string;
  value: string;
  tone: Tone;
}

export interface RailRow {
  chainId: number;
  name: string;
  /** "≈ $0.01 in gas" — an estimate, and it says so. */
  costText: string;
  /**
   * False means the customer cannot be offered this combination at all: the
   * control is disabled, not shown and then refused on press.
   */
  selectable: boolean;
  /** Why not. Present exactly when `selectable` is false. */
  reason?: string;
  /** Present when the rail works but costs the customer more than a card. */
  warning?: string;
  selected: boolean;
}

export type Charge =
  | {
      ok: true;
      /** Raw units, exactly as the URI carries them. */
      units: bigint;
      /** The same figure in the token's own decimals: "284.5317". */
      unitsText: string;
      uri: string;
      share: string;
      whatsapp: string;
    }
  | { ok: false; reason: string };

export interface TillView {
  merchant: string;
  recipient: string;
  lines: Line[];
  rails: RailRow[];
  charge: Charge;
  notices: string[];
}

function railCost(rail: Rail): string {
  // Two decimals always: "$0.01" and "$2.00" side by side is the comparison
  // the waiter is being asked to make.
  return `≈ $${(rail.feeCents / 100).toFixed(2)} in gas`;
}

export function tillView(state: TillState): TillView {
  const order: Order | null = state.base === null ? null : buildOrder(state.base, state.tip);

  const lines: Line[] = order === null
    ? [{ label: "Total", value: "waiting for an amount", tone: "muted" }]
    : [
        { label: "Bill", value: `${formatCents(order.base)} ${state.token}`, tone: "normal" },
        {
          label: state.tip.kind === "percent" ? `Tip ${state.tip.percent}%` : "Tip",
          value: `${formatCents(order.tip)} ${state.token}`,
          tone: order.tip === 0n ? "muted" : "normal",
        },
        { label: "Total", value: `${formatCents(order.total)} ${state.token}`, tone: "normal" },
      ];

  const total = order?.total ?? 0n;
  const rails: RailRow[] = railsCheapestFirst().map((rail) => {
    const deployment = deploymentFor(rail.chainId, state.token);
    const row: RailRow = {
      chainId: rail.chainId,
      name: rail.name,
      costText: railCost(rail),
      selectable: deployment.ok,
      selected: deployment.ok && rail.chainId === state.chainId,
    };
    if (!deployment.ok) row.reason = deployment.reason;
    else if (order !== null && costsMoreThanCard(rail, total)) {
      /* The honest version of "cheaper than Mastercard". It is true on the
       * L2s and on Arc by a factor of 40–80; on L1 it is false below a ~$49
       * ticket, which is most restaurant bills. */
      row.warning =
        `Costs more than a card on this bill. Its flat fee only beats 4.06% above ` +
        `$${(breakevenCents(rail) / 100).toFixed(2)} — pick a cheaper chain.`;
    }
    return row;
  });

  const charge = chargeFor(state, order);

  const notices = [CARD_NOTICE];
  if (charge.ok) {
    notices.push(
      `The total carries hundredths of a cent so two open bills never produce the ` +
        `same payment. It is a marker, not a fee.`,
    );
  }
  notices.push(
    `This terminal holds no key. It can ask for money and cannot move any, ` +
      `including the money it asks for.`,
  );

  return { merchant: state.merchant, recipient: state.recipient, lines, rails, charge, notices };
}

function chargeFor(state: TillState, order: Order | null): Charge {
  if (order === null) return { ok: false, reason: "Enter the bill total." };
  if (order.total <= 0n) return { ok: false, reason: "A bill of zero has nothing to charge." };
  const deployment = deploymentFor(state.chainId, state.token);
  if (!deployment.ok) return { ok: false, reason: deployment.reason };
  if (!/^0x[0-9a-fA-F]{40}$/.test(state.recipient)) {
    return { ok: false, reason: "No merchant address to be paid into." };
  }

  const units = payableUnits(order.total, deployment.decimals, state.marker);
  const uri = buildPaymentUri({
    chainId: deployment.chainId,
    token: deployment.address,
    recipient: state.recipient,
    amount: units,
  });
  const unitsText = formatUnits(units, deployment.decimals);
  const rail = railsCheapestFirst().find((r) => r.chainId === state.chainId);
  const share = shareMessage({
    merchant: state.merchant,
    totalText: unitsText,
    token: state.token,
    chainName: rail?.name ?? String(state.chainId),
    uri,
  });
  return { ok: true, units, unitsText, uri, share, whatsapp: whatsappLink(share) };
}

/* ------------------------------------------------------------------ DOM */

/**
 * A QR as an SVG path. The shell draws receive addresses the same way
 * (src/main.ts) and this is deliberately a second copy rather than a shared
 * helper: an app that imported from the shell would reverse the dependency
 * arrow the mini-app contract exists to keep pointing one way.
 *
 * Error correction M, as there: a code held up at a table is not a label on a
 * crate, and a smaller matrix reads better on a customer's phone.
 */
export function qrSvg(text: string, doc: Document = document): SVGSVGElement {
  const qr = qrcodegen(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;

  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", "240");
  svg.setAttribute("height", "240");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Payment QR code");
  const bg = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  /* White regardless of theme: a scanner needs the contrast in one direction
   * and a dark-mode QR is a customer standing at the till not paying. */
  bg.setAttribute("fill", "#ffffff");
  svg.appendChild(bg);

  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.appendChild(path);
  return svg;
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Draw the priced half of the screen: totals, rails, QR, share. */
export function renderCharge(
  root: HTMLElement,
  view: TillView,
  onPickChain: (chainId: number) => void,
): void {
  root.replaceChildren();

  const totals = el("div", "till-totals");
  for (const line of view.lines) {
    const row = el("div", `till-line till-tone-${line.tone}`);
    row.append(el("span", "till-label", line.label), el("span", "till-value", line.value));
    totals.append(row);
  }
  root.append(totals);

  const rails = el("div", "till-rails");
  rails.append(el("h4", undefined, "Pay from — cheapest first"));
  for (const rail of view.rails) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `till-rail${rail.selected ? " till-rail-selected" : ""}`;
    /* Unpayable combinations are disabled, not offered and then refused: a
     * waiter who can press EURC on Polygon has already told the customer a
     * price on a chain that cannot receive it. */
    button.disabled = !rail.selectable;
    button.append(el("span", "till-rail-name", rail.name), el("span", "till-rail-cost", rail.costText));
    if (rail.reason !== undefined) button.append(el("span", "till-rail-reason", rail.reason));
    if (rail.warning !== undefined) button.append(el("span", "till-rail-warning", rail.warning));
    if (rail.selectable) button.addEventListener("click", () => onPickChain(rail.chainId));
    rails.append(button);
  }
  root.append(rails);

  const charge = el("div", "till-charge");
  if (!view.charge.ok) {
    charge.classList.add("till-tone-unavailable");
    charge.append(el("p", "till-value", view.charge.reason));
  } else {
    /* Two QR codes, because one of them is not reliably scannable.
     *
     * The EIP-681 code is correct -- target is the token, `address=` is the
     * recipient, `uint256` is in raw units -- and where a wallet implements the
     * ERC-20 /transfer form it fills the whole payment in one scan. But that
     * form is thinly supported: MetaMask Mobile currently has an open bug where
     * its scanner does not parse EIP-681 at all, and several wallets only
     * handle the plain-address case.
     *
     * A terminal that only works with some wallets is not a terminal. So the
     * address code is offered beside it: every wallet can scan an address, and
     * the amount is displayed large enough to be typed. Slower, and it always
     * works.
     *
     * The exact-payment code is first because when it works it is better. */
    const codes = el("div", "till-codes");

    const exact = el("div", "till-code");
    exact.append(el("p", "till-code-label", "Pay exactly — one scan"));
    exact.append(qrSvg(view.charge.uri));
    exact.append(el("p", "till-code-note", "If your wallet does not read this, use the code beside it."));

    const plain = el("div", "till-code");
    plain.append(el("p", "till-code-label", "Or scan the address"));
    plain.append(qrSvg(view.recipient));
    plain.append(el("p", "till-code-note", `Then send ${view.charge.unitsText} yourself.`));

    codes.append(exact, plain);
    charge.append(codes);

    charge.append(el("p", "till-amount", `${view.charge.unitsText} to ${view.recipient}`));
    charge.append(el("code", "till-uri", view.charge.uri));

    const actions = el("div", "till-actions");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy link";
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText((view.charge as { uri: string }).uri);
    });
    const share = document.createElement("a");
    share.className = "till-share";
    share.href = view.charge.whatsapp;
    share.target = "_blank";
    share.rel = "noreferrer noopener";
    share.textContent = "Send on WhatsApp";
    actions.append(copy, share);
    charge.append(actions);
  }
  root.append(charge);

  const notices = el("div", "till-notices");
  for (const note of view.notices) notices.append(el("p", undefined, note));
  root.append(notices);
}
