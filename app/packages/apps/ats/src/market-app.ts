/**
 * The secondary market as its own app: every listing ever made, and the two
 * things you can do to one.
 *
 * ---------------------------------------------------------------------------
 * Why this is a separate mini-app rather than a panel
 *
 * It used to be the last section of the Issuer console's register, drawn only
 * after a security had been loaded and read. That ordering had a reason — what
 * a lot of shares is worth is a decision made against the register above it —
 * but it had a cost nobody weighed: **a market you cannot find is a market
 * nobody uses.** With the shell's sections collapsed you had to know to open
 * the console, pick a security, press "Read register", and scroll past roles,
 * snapshots, privileged actions and distributions to reach it.
 *
 * The Till app already had the answer: it registers three manifests (`till`,
 * `till-waiter`, `till-payroll`) so each shows up in the Apps list on its own.
 * This is the same move for ATS.
 *
 * ---------------------------------------------------------------------------
 * What this app can show that the panel could not
 *
 * A `Listing` carries its own `security` address (market.ts), so listings are
 * global to the escrow contract and self-describing. That means the whole
 * history — open, filled and cancelled, across every security — can be listed
 * without any register being loaded at all. The old panel only ever appeared
 * next to one security, so the history of the market as a market was never on
 * screen anywhere.
 *
 * Selling still belongs to the console. A sale needs the security's decimals
 * and a register somebody actually read, and offering a sell form here would
 * be offering to price a lot against a register nobody looked at. This app
 * says where to go instead of growing a second, weaker copy of that form.
 */

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";
import { ATS_CSS } from "./css.ts";
import { ATS_SECURITIES_CHAIN_ID, KNOWN_SECURITIES } from "./securities.ts";
import { readHoldings, type Holding } from "./holdings.ts";
import { parseUnits } from "@leekwallet/core/balances.ts";
import { formatUnits } from "@leekwallet/core/chains.ts";
import {
  ATS_MARKET, ELIGIBILITY_NOTICE, ESCROW_NOTICE, HBAR_UNIT_NOTICE,
  encodeCancel, encodeFill, encodeList, encodeSecurityApprove, hbarText,
  hbarToTinybar, marketContext, marketDescriptors, readMarket, runMarket,
  securityApproveDescriptors,
  type Listing, type MarketView,
} from "./market.ts";

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const row = (label: string, value: string | HTMLElement): HTMLElement => {
  const r = el("div", "ats-row");
  r.append(el("span", "ats-label", label));
  r.append(typeof value === "string" ? el("span", "ats-value", value) : value);
  return r;
};

/**
 * One listing, drawn with its status said in words.
 *
 * `filled` and `cancelled` rows are kept, not hidden: the history is the point
 * of this screen, and a market that shows only what is buyable right now is a
 * market with no evidence that anything ever traded.
 */
function listingElement(
  listing: Listing,
  me: string | undefined,
  /** `symbol()` as the CONTRACT answered it, keyed by address. */
  symbols: ReadonlyMap<string, string>,
  /** `decimals()` likewise. Absent means the row stays in raw units. */
  decimalsOf: ReadonlyMap<string, number>,
  onFill: (l: Listing) => void,
  onCancel: (l: Listing) => void,
): HTMLElement {
  const box = el("section", "ats-panel");
  box.append(el("h4", undefined, `Listing ${listing.id} · ${listing.status}`));

  /* The symbol is read from the security itself, not looked up in this repo's
   * table — which is why eight freshly issued companies showed as bare
   * addresses here while the same securities named themselves correctly in the
   * sell picker two panels above. A table is what you use when you cannot ask;
   * you can ask. */
  const sym = symbols.get(listing.security.toLowerCase());
  box.append(row("Security", sym === undefined ? listing.security : `${sym} — ${listing.security}`));
  if (sym === undefined) {
    box.append(el("p", "ats-muted",
      "This security has not said what it is called — either its symbol() has " +
      "not been read yet, or it answered with something this app will not put " +
      "on a screen. The address is what was listed and what the device shows."));
  }
  box.append(row("Seller", listing.seller));
  /* Shares, scaled by THIS security's own decimals() — keyed by address, so a
   * scale is never borrowed from another row. The raw figure stays beside it:
   * it is what the contract holds and what the device will show, and a screen
   * that prints only the pretty number is a screen you cannot check against
   * the device. Without a decimals reading the row stays raw and says so,
   * rather than guessing 18 and being a million times wrong. */
  const dec = decimalsOf.get(listing.security.toLowerCase());
  box.append(row("Shares", dec === undefined
    ? `${listing.amount} raw units (decimals not read, so not scaled)`
    : `${formatUnits(listing.amount, dec)} shares (${listing.amount} raw units)`));
  /* Both units, from the one helper that always prints them together: the
   * ratio between them is the thing a reader can actually check. */
  box.append(row("Price", hbarText(listing.priceTotal)));

  if (listing.status === "open") {
    const mine = me !== undefined && me.toLowerCase() === listing.seller.toLowerCase();
    if (mine) {
      /* The contract has `list`, `cancel` and `fill` and NO price update.
       * Changing a price is therefore cancel-then-list, which is two
       * transactions and a gap in which somebody else may fill the old one at
       * the old price. Saying that is the whole value of this sentence: a
       * button labelled "change price" would imply an atomicity the contract
       * does not have. */
      box.append(el("p", "ats-muted",
        "Your listing. There is no price update on this contract: to reprice, " +
        "cancel and list again. Between those two transactions the old price " +
        "is still fillable by anyone."));
      const cancel = el("button", undefined, `Cancel listing ${listing.id}`) as HTMLButtonElement;
      cancel.type = "button";
      cancel.addEventListener("click", () => onCancel(listing));
      box.append(cancel);
    } else {
      const buy = el("button", undefined, `Buy listing ${listing.id}`) as HTMLButtonElement;
      buy.type = "button";
      buy.addEventListener("click", () => onFill(listing));
      box.append(buy);
    }
  } else {
    box.append(el("p", "ats-muted",
      listing.status === "filled"
        ? "Settled. The shares moved to the buyer and the price to the seller, in one transaction."
        : "Cancelled by the seller. The escrowed shares went back."));
  }
  return box;
}

export const ATS_MARKET_APP: MiniApp = {
  id: "ats-market",
  name: "Share market",
  summary:
    "The secondary market for Hedera ATS securities: every listing ever made, " +
    "what settled, and what is still open to buy.",
  chainIds: [ATS_SECURITIES_CHAIN_ID],
  css: ATS_CSS,

  /*
   * Without this the wallet refuses everything this app proposes.
   *
   * `screenProposal` signs a call only when a bundled ERC-7730 descriptor
   * renders every argument or the firmware draws the call itself. The market's
   * three calls have neither on their own — they are ordinary contract calls —
   * so the descriptors have to come from the manifest, exactly as they do in
   * the Issuer console's.
   *
   * Splitting the market into its own app dropped them, and the symptom was
   * the wallet refusing `fill(uint256)` with "no bundled ERC-7730 descriptor
   * describes 0x3fda5389". Two sets, chosen by what is being called and never
   * merged: the market's own three at its one constant address, and the plain
   * ERC-20 approve that a listing needs first against the security itself. An
   * approval folded into the market's table would owe a consequence line about
   * a power it does not confer.
   */
  descriptors: (chainId, to) =>
    to.toLowerCase() === ATS_MARKET
      ? marketDescriptors(chainId, to)
      : securityApproveDescriptors(chainId, to),

  async mount(root: HTMLElement, context: AppContext) {
    root.replaceChildren();
    const panel = el("div", "ats");
    root.append(panel);

    panel.append(el("h3", undefined, "Share market"));
    panel.append(el("p", "ats-muted",
      `Escrow market ${ATS_MARKET}, settling in native HBAR.`));
    panel.append(el("p", "ats-notice", HBAR_UNIT_NOTICE));
    panel.append(el("p", "ats-muted", ELIGIBILITY_NOTICE));

    const out = el("div", "ats-panel");
    const list = el("div");
    const reload = el("button", undefined, "Read the market") as HTMLButtonElement;
    reload.type = "button";

    /* ------------------------------------------------------------- selling
     *
     * A picker over what this wallet actually holds, rather than a free-text
     * address: you cannot sell what you do not have, and an address field here
     * is an invitation to escrow shares of the wrong security. The balances
     * and decimals come from the chain (holdings.ts) at the moment the list is
     * built -- the symbol beside them is this repo's note and is labelled as
     * such everywhere else in this console.
     */
    const sell = el("section", "ats-panel");
    sell.append(el("h4", undefined, "List shares for sale"));
    sell.append(el("p", "ats-muted", ESCROW_NOTICE));
    const sellPicker = el("select") as HTMLSelectElement;
    sellPicker.setAttribute("aria-label", "Security to sell");
    /* Anything this repo has not written down is still sellable: paste its
     * address and the balance and decimals are read from the chain like any
     * other. The table is a convenience, never the set of what exists — a
     * security issued from the device five minutes ago is not in it. */
    const sellOther = el("input") as HTMLInputElement;
    sellOther.type = "text";
    sellOther.placeholder = "0x… another security";
    sellOther.setAttribute("aria-label", "Another security address");
    const addOther = el("button", undefined, "Add that address") as HTMLButtonElement;
    addOther.type = "button";
    const sellShares = el("input") as HTMLInputElement;
    sellShares.type = "text";
    sellShares.placeholder = "shares";
    sellShares.setAttribute("aria-label", "Shares to sell");
    const sellPrice = el("input") as HTMLInputElement;
    sellPrice.type = "text";
    sellPrice.placeholder = "HBAR for the whole lot";
    sellPrice.setAttribute("aria-label", "Total price in HBAR");
    const sellNote = el("p", "ats-muted");
    const sellOut = el("div", "ats-panel");
    const sellGo = el("button", undefined, "Plan the sale") as HTMLButtonElement;
    sellGo.type = "button";
    const refreshHoldings =
      el("button", undefined, "Read what this wallet holds") as HTMLButtonElement;
    refreshHoldings.type = "button";
    sell.append(refreshHoldings, row("Security", sellPicker),
      row("Or an address", sellOther), addOther,
      row("Shares", sellShares), row("Total price (HBAR)", sellPrice),
      sellNote, sellGo, sellOut);
    sell.append(el("p", "ats-muted",
      "The price is for the WHOLE lot, not per share. The contract has no " +
      "per-share figure at all, so there is no division for it to truncate."));

    let held: Holding[] = [];
    /* Addresses the operator typed, kept beside the table rather than merged
     * into it: "this repo wrote it down" and "somebody pasted it" are
     * different kinds of knowledge, and the console says so elsewhere too. */
    let extra: string[] = [];
    /*
     * Securities seen in the market's own listings.
     *
     * Every `Listing` names its security, so the book itself is a directory of
     * what is tradeable here — no table required. That matters after a fill:
     * the thing you just bought was almost certainly issued by somebody else
     * and is therefore in neither this repo's table nor your own
     * EquityDeployed logs, so without this it would settle on chain and then
     * fail to appear in "what this wallet holds". Reading the book is how the
     * holdings list learns the address.
     */
    let fromMarket: string[] = [];
    /* address -> symbol(), as the contracts answered. Filled by loadHoldings,
     * which already reads every security in the book. */
    let symbols = new Map<string, string>();
    let decimalsByAddress = new Map<string, number>();
    /* The last book read, kept so the rows can be redrawn when the symbols
     * arrive without asking the chain for the listings a second time. */
    let lastView: MarketView | undefined;

    const redrawBook = (): void => {
      if (lastView === undefined) return;
      list.replaceChildren();
      for (const entry of lastView.listings) {
        if (entry.state === "ok") {
          list.append(listingElement(
            entry.value, context.address, symbols, decimalsByAddress, fill, cancel));
        } else {
          /* A row that failed to decode stays a failed row. Dropping it would
           * quietly shorten the history. */
          list.append(el("p", "ats-notice",
            "One listing could not be read, and is not shown as empty because " +
            "an unreadable offer and no offer are different facts."));
        }
      }
    };
    const decimalsOfSelected = (): number | undefined => {
      const h = held.find((x) => x.address === sellPicker.value);
      return h && h.decimals.state === "ok" ? h.decimals.value : undefined;
    };
    const describeSelected = (): void => {
      const h = held.find((x) => x.address === sellPicker.value);
      if (h === undefined) { sellNote.textContent = ""; return; }
      const dec = h.decimals.state === "ok" ? h.decimals.value : undefined;
      if (h.balance.state !== "ok") {
        sellNote.textContent =
          "This wallet's balance of that security could not be read. A balance " +
          "nobody answered for is not a balance of zero, and listing against " +
          "one is how shares get escrowed that are not there.";
        return;
      }
      sellNote.textContent = dec === undefined
        ? `Holding ${h.balance.value} raw units. Its decimals() could not be read, ` +
          `so shares cannot be scaled and this sale cannot be planned.`
        : `Holding ${formatUnits(h.balance.value, dec)} shares ` +
          `(${h.balance.value} raw units, ${dec} decimals).`;
    };
    sellPicker.addEventListener("change", describeSelected);

    const loadHoldings = async (): Promise<void> => {
      refreshHoldings.disabled = true;
      sellNote.textContent = "Reading balances…";
      try {
        held = await readHoldings(
          context.request, context.chainId, context.address,
          [...new Set([
            ...KNOWN_SECURITIES.map((k) => k.address.toLowerCase()),
            ...fromMarket,
            ...extra,
          ])],
        );
        sellPicker.replaceChildren();
        for (const h of held) {
          const opt = document.createElement("option");
          opt.value = h.address;
          /* The contract's own symbol, read just now — not this repo's note.
           * An address that will not say what it is called is shown as an
           * address, which is what was ever load-bearing anyway. */
          const sym = h.symbol.state === "ok" ? h.symbol.value : undefined;
          opt.textContent = sym === undefined ? h.address : `${sym} — ${h.address}`;
          sellPicker.append(opt);
        }
        symbols = new Map(held.flatMap((h) =>
          h.symbol.state === "ok" && h.symbol.value !== undefined
            ? [[h.address.toLowerCase(), h.symbol.value] as const]
            : []));
        decimalsByAddress = new Map(held.flatMap((h) =>
          h.decimals.state === "ok" ? [[h.address.toLowerCase(), h.decimals.value] as const] : []));
        describeSelected();
        /* The book was drawn before the symbols were known, so draw it again
         * now that they are. Cheap: no new chain reads, just a repaint. */
        redrawBook();
      } catch (e) {
        sellNote.textContent = `Balances could not be read, so nothing is offered to sell. ${String(e)}`;
      }
      refreshHoldings.disabled = false;
    };
    refreshHoldings.addEventListener("click", () => { void loadHoldings(); });
    addOther.addEventListener("click", () => {
      const typed = sellOther.value.trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(typed)) {
        sellNote.textContent = "That is not a 20-byte address.";
        return;
      }
      extra = extra.includes(typed) ? extra : [...extra, typed];
      sellOther.value = "";
      void loadHoldings();
    });

    sellGo.addEventListener("click", () => {
      void (async () => {
        const security = sellPicker.value;
        const dec = decimalsOfSelected();
        if (security === "" || dec === undefined) {
          sellOut.replaceChildren(el("p", "ats-notice",
            "Pick a security whose decimals() this app could read. Without a " +
            "scale, shares cannot be turned into the raw units a listing takes."));
          return;
        }
        let amount: bigint;
        let priceTinybar: bigint;
        try {
          amount = parseUnits(sellShares.value.trim(), dec);
          priceTinybar = hbarToTinybar(sellPrice.value);
        } catch (e) {
          sellOut.replaceChildren(el("p", "ats-notice", `Nothing was asked for. ${String(e)}`));
          return;
        }
        if (amount <= 0n || priceTinybar <= 0n) {
          sellOut.replaceChildren(el("p", "ats-notice",
            "Both the share count and the price must be greater than zero."));
          return;
        }
        sellGo.disabled = true;
        sellOut.replaceChildren(el("p", "ats-muted",
          `Two transactions, each confirmed on the device: approve the market ` +
          `for ${amount} raw units, then list them for ${hbarText(priceTinybar)}. ` +
          `If the first lands and the second does not, the approval stands with ` +
          `no listing behind it.`));
        const outcome = await runMarket(
          context,
          [encodeSecurityApprove(security, amount), encodeList(security, amount, priceTinybar)],
          { token: security, amount },
        );
        sellOut.replaceChildren(el("p",
          outcome.kind === "sent" ? "ats-muted" : "ats-notice",
          outcome.kind === "sent"
            ? `Sent. ${outcome.steps.map((x) => x.result).join(" ")}`
            : outcome.notice));
        sellGo.disabled = false;
        if (outcome.kind === "sent") { await read(); await loadHoldings(); }
      })();
    });

    panel.append(sell, reload, out, list);

    const fill = (listing: Listing): void => {
      void (async () => {
        out.replaceChildren(el("p", "ats-muted",
          "Check every page on the device. A fill pays the seller and moves the " +
          "shares in one transaction; whether you may hold them is decided by " +
          "the security's own rules, on chain, after the press."));
        const outcome = await runMarket(context, [encodeFill(listing)]);
        out.replaceChildren(el("p",
          outcome.kind === "sent" ? "ats-muted" : "ats-notice",
          outcome.kind === "sent"
            ? `Sent. ${outcome.steps.map((s) => s.result).join(" ")}`
            : outcome.notice));
        if (outcome.kind === "sent") void read();
      })();
    };

    const cancel = (listing: Listing): void => {
      void (async () => {
        out.replaceChildren(el("p", "ats-muted",
          "Check the device. Cancelling returns the escrowed shares to you — " +
          "unless the security's own rules refuse the transfer back, in which " +
          "case they stay escrowed and only a forced transfer by the issuer " +
          "moves them. There is no rescue function, deliberately."));
        const outcome = await runMarket(context, [encodeCancel(listing.id)]);
        out.replaceChildren(el("p",
          outcome.kind === "sent" ? "ats-muted" : "ats-notice",
          outcome.kind === "sent"
            ? `Sent. ${outcome.steps.map((x) => x.result).join(" ")}`
            : outcome.notice));
        /* Re-read both, in this order: the book first so `fromMarket` learns
         * the security that was just bought, then the holdings so it shows up
         * there. Reversing them would refresh the holdings against a directory
         * that has not heard of the purchase yet. */
        if (outcome.kind === "sent") { await read(); await loadHoldings(); }
      })();
    };

    const read = async (): Promise<void> => {
      reload.disabled = true;
      out.replaceChildren(el("p", "ats-muted", "Reading the market…"));
      list.replaceChildren();
      let view: MarketView;
      try {
        view = await readMarket(marketContext(
          context.request, context.chainId, context.endpointHost ?? (() => undefined),
        ));
      } catch (e) {
        /* A market that could not be read says so. An empty list here would be
         * the sentence "nothing has ever traded", which is a different and
         * much stronger claim than "nobody answered". */
        out.replaceChildren(el("p", "ats-notice",
          `The market could not be read, so nothing is listed below — that is ` +
          `not the same as there being no listings. ${String(e)}`));
        reload.disabled = false;
        return;
      }

      if (view.count.state !== "ok") {
        out.replaceChildren(el("p", "ats-notice",
          "The market did not answer how many listings exist, so none are shown."));
        reload.disabled = false;
        return;
      }

      out.replaceChildren(el("p", "ats-muted",
        `${view.count.value} listing(s) ever created.` +
        (view.truncated ? " More exist than this screen walked." : "")));

      fromMarket = [...new Set(
        view.listings.flatMap((e) => (e.state === "ok" ? [e.value.security.toLowerCase()] : [])),
      )];
      lastView = view;
      redrawBook();
      reload.disabled = false;
    };

    reload.addEventListener("click", () => {
      void (async () => { await read(); await loadHoldings(); })();
    });
    void (async () => { await read(); await loadHoldings(); })();
  },
};
