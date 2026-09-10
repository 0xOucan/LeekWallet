/**
 * The secondary market, as DOM.
 *
 * Thin, like act-view.ts: `market.ts` decides what a call is and what a price
 * means, and this file reads a form, calls it, and puts its sentences on
 * screen. The one rule it owns is that no price is ever shown in one unit — a
 * listing's price appears as HBAR, as tinybar, and as the weibar value the
 * transaction will carry, every time, because the ratio between them is the
 * thing a reader can actually check.
 */

import { formatUnits } from "@leekwallet/core/chains.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import type { RegisterView } from "./register.ts";
import {
  ATS_MARKET, ELIGIBILITY_NOTICE, ESCROW_NOTICE, HBAR_UNIT_NOTICE,
  encodeCancel, encodeFill, encodeList, encodeSecurityApprove, hbarText, hbarToTinybar,
  marketContext, readMarket, runMarket,
  type Listing, type MarketCall, type MarketOutcome, type MarketView,
} from "./market.ts";

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

/**
 * A share count, never as a bare pretty number.
 *
 * The decimals come from the register read, so the scaled figure is as good as
 * that read — and the raw units it was scaled from travel beside it regardless,
 * because raw units are what the contract moved and what the device drew.
 */
const shares = (raw: bigint, decimals: number | undefined): string =>
  decimals === undefined
    ? `${raw} raw units (nobody answered for this security's decimals)`
    : `${formatUnits(raw, decimals)} shares (${raw} raw units)`;

/**
 * Append the market panel under a register that has been read.
 *
 * `view` is required for the same reason the privileged panel requires it: the
 * decimals a share count is rendered with are a fact about the contract, and a
 * market screen built before the register was read would be pricing a security
 * it had never looked at.
 */
export function renderMarketPanel(
  root: HTMLElement, view: RegisterView, context: AppContext,
): void {
  const section = el("section", "ats-panel");
  section.append(el("h4", undefined, "Secondary market"));
  section.append(el("p", "ats-muted",
    `Escrow market ${ATS_MARKET}, settling in native HBAR.`));
  section.append(el("p", "ats-notice", HBAR_UNIT_NOTICE));
  section.append(el("p", "ats-muted", ELIGIBILITY_NOTICE));

  const decimals = view.decimals.state === "ok" ? view.decimals.value : undefined;
  const out = el("div", "ats-panel");
  const listings = el("div", "ats-panel");
  section.append(listings, out);
  root.append(section);

  const refresh = async (): Promise<void> => {
    listings.replaceChildren(el("p", "ats-muted", "Reading the market…"));
    let market: MarketView;
    try {
      market = await readMarket(marketContext(
        context.request, view.chainId, context.endpointHost ?? (() => undefined),
      ));
    } catch (e) {
      listings.replaceChildren(el("p", "ats-notice",
        `The market could not be read: ${String((e as Error)?.message ?? e)}`));
      return;
    }
    listings.replaceChildren();
    if (market.count.state !== "ok") {
      /* Not "no listings". Nobody answered, and the difference is the whole
       * discipline of this console. */
      listings.append(el("p", "ats-uncertain",
        "The market did not answer how many listings it holds, so none are shown. " +
        "That is not the same as there being none."));
      return;
    }
    listings.append(el("p", "ats-muted",
      `${market.count.value} listing(s) ever created` +
      (market.truncated ? ", of which only the most recent are shown" : "")));

    for (const outcome of market.listings) {
      if (outcome.state !== "ok") {
        listings.append(el("p", "ats-uncertain", "One listing could not be read."));
        continue;
      }
      listings.append(listingRow(outcome.value, decimals, view, context, out, refresh));
    }
  };

  section.append(sellForm(view, decimals, context, out, refresh));
  void refresh();
}

/* ---------------------------------------------------------------- one listing */

function listingRow(
  listing: Listing,
  decimals: number | undefined,
  view: RegisterView,
  context: AppContext,
  out: HTMLElement,
  refresh: () => Promise<void>,
): HTMLElement {
  const box = el("div", "ats-screen");
  box.append(el("div", "ats-screen-title", `Listing ${listing.id} · ${listing.status}`));
  box.append(row("Security", el("span", "ats-address", listing.security)));
  box.append(row("Seller", el("span", "ats-address", listing.seller)));
  box.append(row("Shares", shares(listing.amount, decimals)));
  /* Every price, in all three units, every time. See the file header. */
  box.append(row("Price", hbarText(listing.priceTotal)));

  if (listing.security.toLowerCase() !== view.address.toLowerCase()) {
    box.append(el("p", "ats-muted",
      "This listing is for a different security than the register above."));
  }

  if (listing.status !== "open") return box;
  if (!context.propose) {
    box.append(el("p", "ats-muted", "No device is connected, so this cannot be acted on."));
    return box;
  }

  const mine = listing.seller.toLowerCase() === context.address.toLowerCase();
  const button = el("button", undefined, mine ? "Cancel this listing" : "Buy this lot");
  button.type = "button";
  button.addEventListener("click", () => {
    button.disabled = true;
    const call = mine ? encodeCancel(listing.id) : encodeFill(listing);
    out.replaceChildren();
    out.append(preview(call));
    void runMarket(context, [call]).then((outcome) => {
      out.append(report(outcome));
      if (outcome.kind === "sent") void refresh();
      else button.disabled = false;
    });
  });
  box.append(button);
  if (mine) box.append(el("p", "ats-muted", ESCROW_NOTICE));
  return box;
}

/* ------------------------------------------------------------------ the sell */

function sellForm(
  view: RegisterView,
  decimals: number | undefined,
  context: AppContext,
  out: HTMLElement,
  refresh: () => Promise<void>,
): HTMLElement {
  const form = el("div", "ats-panel");
  form.append(el("h4", undefined, "Sell into the market"));
  if (!context.propose) {
    form.append(el("p", "ats-notice",
      "No device is connected, so this console can read the market but cannot " +
      "ask for a signature."));
    return form;
  }

  const amount = el("input");
  amount.type = "text";
  amount.setAttribute("aria-label", "Shares to sell, in raw units");
  const price = el("input");
  price.type = "text";
  price.setAttribute("aria-label", "Total price for the whole lot, in HBAR");

  form.append(row("Shares (raw units)", amount));
  form.append(row("Total price (HBAR)", price));
  form.append(el("p", "ats-muted",
    "The price is for the WHOLE lot, not per share. The contract has no " +
    "per-share figure at all, so there is no division for it to truncate."));
  form.append(el("p", "ats-muted", ESCROW_NOTICE));

  const plan = el("button", undefined, "Plan the sale");
  plan.type = "button";
  form.append(plan);

  plan.addEventListener("click", () => {
    out.replaceChildren();
    let calls: readonly MarketCall[];
    let raw: bigint;
    try {
      const trimmed = amount.value.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new Error("the share count must be a whole number of raw units");
      }
      raw = BigInt(trimmed);
      const tinybar = hbarToTinybar(price.value);
      calls = [
        encodeSecurityApprove(view.address, raw),
        encodeList(view.address, raw, tinybar),
      ];
      out.append(el("p", "ats-muted",
        `${shares(raw, decimals)} for ${hbarText(tinybar)}`));
    } catch (e) {
      out.append(el("p", "ats-notice", `That could not be read: ${(e as Error).message}`));
      return;
    }
    for (const call of calls) out.append(preview(call));

    const sign = el("button", undefined, "Approve both on the device");
    sign.type = "button";
    sign.addEventListener("click", () => {
      sign.disabled = true;
      void runMarket(context, calls, { token: view.address, amount: raw })
        .then((outcome) => {
          out.append(report(outcome));
          if (outcome.kind === "sent") void refresh();
        });
    });
    out.append(sign);
  });

  return form;
}

/* ---------------------------------------------------------------- rendering */

/** What one call is, before a press is spent finding out. */
function preview(call: MarketCall): HTMLElement {
  const box = el("div", "ats-screen");
  box.append(el("div", "ats-screen-title", call.label));
  box.append(row("To", el("span", "ats-address", call.to)));
  box.append(row("Calldata", el("span", "ats-address", `${call.data.slice(0, 10)}…`)));
  box.append(row(
    "Transaction value",
    call.value === 0n ? "0" : `${call.value} weibar (= ${call.value / 10_000_000_000n} tinybar)`,
    call.value === 0n ? undefined : "ats-privileged",
  ));
  return box;
}

function report(outcome: MarketOutcome): HTMLElement {
  const wrap = el("div", "ats-panel");
  switch (outcome.kind) {
    case "sent":
      for (const step of outcome.steps) {
        wrap.append(el("p", "ats-muted", `${step.call.label}: ${step.result}`));
      }
      wrap.append(el("p", "ats-muted",
        "The market above is now out of date — it is being read again."));
      return wrap;
    case "approved-not-listed":
      /* The one state that still costs something after the user walks away. */
      wrap.append(el("p", "ats-notice ats-alarm", outcome.notice));
      wrap.append(el("p", "ats-privileged",
        `Outstanding: ${outcome.amount} raw units approved to ${ATS_MARKET}`));
      return wrap;
    default:
      wrap.append(el("p", "ats-notice", outcome.notice));
      return wrap;
  }
}
