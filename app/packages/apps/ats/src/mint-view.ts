/**
 * Minting into a security, and sending shares out of this wallet, as DOM.
 *
 * ---------------------------------------------------------------------------
 * Two different powers on one screen, kept apart on purpose
 *
 * `mint` brings shares into existence and is an ISSUER power: it goes through
 * `proposePrivileged`, so it is rendered by the privileged descriptor table and
 * carries a consequence line. `transfer` moves shares this wallet already owns
 * and confers nothing: it goes through `runTransfer`, with a descriptor of its
 * own. They sit side by side because a person distributing an issue does both
 * in the same sitting, and they are built by different functions because one of
 * them creates supply and the other does not. holdings.ts says more.
 *
 * ---------------------------------------------------------------------------
 * The mint form is gated on a READ, and only on an affirmative one
 *
 * A row offers to mint only where `hasRole(ROLE_ISSUER, this wallet)` came back
 * `ok: true`. A revert, an unreachable node or an absent row is NOT the same as
 * "no" and is never rendered as one: `mintRefusal` gives each case its own
 * sentence, and the row prints it instead of a form. That is the retired pilot
 * in securities.ts turned into a control — it holds DEFAULT_ADMIN_ROLE and
 * nothing else, its register reads normally, and its mint reverts after the
 * press.
 *
 * ---------------------------------------------------------------------------
 * Facts come from a register read, never from this table
 *
 * `proposePrivileged` needs `SecurityFacts` — name, decimals, control-list
 * direction — and they are facts about the contract. So pressing mint reads
 * that security's register first and builds the facts from it. It costs a round
 * trip. The alternative is describing a security from a hard-coded table, which
 * is how a screen ends up naming a contract nobody looked at.
 */

import { formatUnits } from "@leekwallet/core/chains.ts";
import { parseUnits } from "@leekwallet/core/balances.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { proposePrivileged, type ActOutcome } from "./act.ts";
import { factsFrom, screenElement } from "./act-view.ts";
import {
  HOLDINGS_NOTICE, canMint, canSell, mintRefusal, readHoldings, runTransfer,
  type Holding,
} from "./holdings.ts";
import { maxSupplyIsCap, readRegister, type Outcome } from "./register.ts";
import { marketContext, readMarket } from "./market.ts";
import {
  RECIPIENT_NOTICE, RecipientBook, browserRecipientStore,
} from "./recipients.ts";
import type { SecurityChoice } from "./discover.ts";

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
 * A figure, or the reason there is not one.
 *
 * There is no branch here that produces "0" from anything but an `ok` reading
 * of zero. That is the rule of register.ts restated in the smallest place it
 * has to hold.
 */
function amountCell(
  outcome: Outcome<bigint>, decimals: Outcome<number>,
): HTMLElement {
  if (outcome.state === "unsupported") {
    return el("span", "ats-uncertain", "the contract reverted when asked");
  }
  if (outcome.state === "unavailable") {
    return el("span", "ats-uncertain", `unreadable: ${outcome.why}`);
  }
  if (decimals.state !== "ok") {
    /* The raw figure is real and the scaled one would be a guess. Print the
     * one that was read and say why the other is missing. */
    return el("span", undefined,
      `${outcome.value} raw units (nobody answered for this security's decimals)`);
  }
  return el("span", undefined,
    `${formatUnits(outcome.value, decimals.value)} (${outcome.value} raw units)`);
}

function roleCell(holding: Holding): HTMLElement {
  if (canMint(holding)) return el("span", "ats-privileged", "issuer");
  const why = mintRefusal(holding) as string;
  return el("span", holding.issuer.state === "ok" ? "ats-muted" : "ats-uncertain", why);
}

/* ------------------------------------------------------------------- panel */

/**
 * The holdings table, with a mint form and a send form under each row that
 * earns one.
 *
 * `choices` is a GETTER, not an array: the discovery panel may add rows to it
 * after this panel is built, and a captured array would leave a freshly issued
 * security invisible here until the whole console was remounted. It is read at
 * the moment the button is pressed, which is the moment the answer matters.
 * `onSelect` lets a row become the security
 * the console is reading, which is how a holding reaches the market panel's
 * sell form: the market lists a security the register has been read for, and
 * this is the button that reads it.
 */
export function renderHoldingsPanel(
  root: HTMLElement,
  context: AppContext,
  choices: () => readonly SecurityChoice[],
  onSelect: (address: string) => void,
  book: RecipientBook = new RecipientBook(browserRecipientStore()),
): void {
  const section = el("section", "ats-panel");
  section.append(el("h4", undefined, "What this wallet holds, and what it may do"));
  section.append(el("p", "ats-muted", HOLDINGS_NOTICE));
  section.append(row("Wallet", el("span", "ats-address", context.address)));

  const refresh = el("button", undefined, "Read balances and roles");
  const out = el("div", "ats-panel");
  section.append(refresh, recipientsBox(book), out);
  root.append(section);

  out.append(el("p", "ats-muted",
    "Nothing has been read yet. Press the button — a balance is a chain read, " +
    "and this panel shows none before one has happened."));

  refresh.addEventListener("click", () => {
    void (async () => {
      refresh.disabled = true;
      out.replaceChildren(el("p", "ats-muted", "Reading balances and roles…"));
      const wanted = choices();
      if (wanted.length === 0) {
        out.replaceChildren(el("p", "ats-muted",
          "There are no securities to read balances for."));
        refresh.disabled = false;
        return;
      }
      /* Everything the escrow market has ever listed, added to what this repo
       * wrote down and what this wallet issued.
       *
       * Those two sources share a blind spot: a security somebody ELSE issued
       * and this wallet bought. It is in no table and its EquityDeployed log
       * names a different caller, so after a fill the shares settled on chain
       * and this panel kept saying nothing was there. The book is the third
       * source that closes it — every listing names its security, so anything
       * tradeable here is discoverable without a table.
       *
       * A market that will not answer is not a reason to show nothing: the
       * other two sources still stand, and the read continues without it. */
      /* One choice per address, in the order they will be read. Rows that came
       * only from the book get a placeholder whose `symbol` is empty: the
       * contract's own symbol() is read alongside the balance and is what the
       * row actually shows, so inventing one here would be the guess this
       * console keeps refusing to make. */
      const byAddress = new Map<string, SecurityChoice>(
        wanted.map((c) => [c.address.toLowerCase(), c]),
      );
      let addresses = wanted.map((c) => c.address.toLowerCase());
      try {
        const book = await readMarket(marketContext(
          context.request, context.chainId,
          context.endpointHost ?? (() => undefined),
        ));
        for (const entry of book.listings) {
          if (entry.state !== "ok") continue;
          const a = entry.value.security.toLowerCase();
          if (byAddress.has(a)) continue;
          byAddress.set(a, {
            address: a, symbol: "", note: "seen in the escrow market",
            kind: "equity", source: "log",
          });
          addresses = [...addresses, a];
        }
      } catch {
        /* Deliberately silent here and stated below instead: a failed market
         * read makes this list SHORTER, not wrong, and the panel already says
         * an absent row is not a zero balance. */
      }

      let holdings: Holding[];
      try {
        holdings = await readHoldings(
          context.request, context.chainId, context.address, addresses,
        );
      } catch (e) {
        out.replaceChildren(el("p", "ats-notice",
          `Nothing could be read: ${String((e as Error)?.message ?? e)}. This is ` +
          "not a statement about what this wallet holds."));
        refresh.disabled = false;
        return;
      }
      out.replaceChildren();
      holdings.forEach((holding) => {
        const choice = byAddress.get(holding.address.toLowerCase());
        if (choice === undefined) return;   /* cannot happen; not a crash if it does */
        out.append(holdingBox(holding, choice, context, book, onSelect));
      });
      refresh.disabled = false;
    })();
  });
}

function holdingBox(
  holding: Holding,
  choice: SecurityChoice,
  context: AppContext,
  book: RecipientBook,
  onSelect: (address: string) => void,
): HTMLElement {
  const box = el("div", "ats-screen");
  /* The contract's own symbol() wins over the table's note, and over the empty
   * placeholder a market-derived row carries. A security that will not name
   * itself is shown by its address, which is the identifier that was ever
   * load-bearing. */
  const chainSymbol = holding.symbol.state === "ok" ? holding.symbol.value : undefined;
  const title = chainSymbol ?? (choice.symbol !== "" ? choice.symbol : holding.address);
  box.append(el("div", "ats-screen-title", `${title} · ${choice.kind}`));
  box.append(row("Address", el("span", "ats-address", holding.address)));
  box.append(row("Your balance", amountCell(holding.balance, holding.decimals)));
  box.append(row("Total supply", amountCell(holding.totalSupply, holding.decimals)));
  box.append(row("This wallet", roleCell(holding)));

  const actions = el("div", "ats-row");
  const read = el("button", "ghost", "Read register / sell in the market");
  read.title =
    "Load this security into the console above. The market panel's sell form " +
    "appears under a register that has been read.";
  read.addEventListener("click", () => onSelect(holding.address));
  actions.append(read);
  box.append(actions);
  if (!canSell(holding)) {
    box.append(el("p", "ats-muted",
      holding.balance.state === "ok"
        ? "There is nothing here to list for sale: the balance read back as zero."
        : "Whether there is anything here to sell is not known — see the balance above."));
  }

  const out = el("div", "ats-panel");
  if (canMint(holding)) {
    box.append(mintForm(holding, context, book, out));
  } else {
    box.append(el("p", "ats-muted", `No mint form: ${mintRefusal(holding) as string}`));
  }
  box.append(sendForm(holding, context, book, out));
  box.append(out);
  return box;
}

/* -------------------------------------------------------------------- mint */

function mintForm(
  holding: Holding, context: AppContext, book: RecipientBook, out: HTMLElement,
): HTMLElement {
  const form = el("div", "ats-panel");
  form.append(el("p", "ats-muted",
    "Mint brings new shares into existence and credits them to one address. " +
    "It is an issuer power and it is irreversible."));
  const to = recipientPicker(book, "Mint to");
  const amount = el("input");
  amount.type = "text";
  /*
   * Shares, as a person writes them -- not raw units.
   *
   * This field used to take raw units, and the first real mint typed
   * 1000000000000000000 into it for a six-decimal security whose cap is
   * 1000000000000. That is a thousand billion shares, the contract reverted,
   * and the message said only CONTRACT_REVERT_EXECUTED. Raw units are the
   * right thing to SIGN and the wrong thing to ASK FOR: nobody holds "1e18
   * raw units" of anything in their head.
   *
   * The scale comes from the security's own `decimals()`, read from the
   * contract at the moment of the press, never from this app's table. If it
   * cannot be read, the mint is refused rather than guessed -- a scale nobody
   * verified is the whole bug this change exists to remove. The raw figure is
   * shown before the press so it can be compared against the device screen,
   * which is the only number that matters.
   */
  const dec = holding.decimals.state === "ok" ? holding.decimals.value : undefined;
  amount.placeholder = dec === undefined ? "shares" : `shares, e.g. 1000`;
  amount.setAttribute("aria-label", "Amount in shares");
  form.append(to.wrap, row(
    dec === undefined ? "Amount (shares)" : `Amount (shares, ${dec} decimals)`,
    amount));
  const preview = el("p", "ats-muted");
  form.append(preview);
  const showPreview = () => {
    const text = amount.value.trim();
    if (text === "" || dec === undefined) { preview.textContent = ""; return; }
    try {
      preview.textContent =
        `= ${parseUnits(text, dec)} raw units — this is the figure the device shows.`;
    } catch {
      preview.textContent = "";
    }
  };
  amount.addEventListener("input", showPreview);
  const go = el("button", undefined, "Mint");
  form.append(go);

  go.addEventListener("click", () => {
    void (async () => {
      const address = to.value();
      if (address === undefined) {
        out.replaceChildren(el("p", "ats-notice", "Choose or type a 20-byte address to mint to."));
        return;
      }
      const typed = amount.value.trim();
      if (!/^\d+(\.\d+)?$/.test(typed)) {
        out.replaceChildren(el("p", "ats-notice",
          "The amount must be a number of shares, like 1000 or 1000.5."));
        return;
      }
      go.disabled = true;
      out.replaceChildren(el("p", "ats-muted",
        "Reading this security's register, so the screen describes the contract " +
        "rather than this app's table…"));
      try {
        const view = await readRegister(
          context.request, context.chainId, holding.address,
          context.endpointHost ?? (() => undefined),
        );
        /* The cap, checked here rather than discovered on chain.
         *
         * `maxSupply` is in RAW units and so is this field, and the two are
         * easy to confuse by a factor of 10**decimals: a first attempt at this
         * screen sent 1e18 for a security with six decimals and a cap of 1e12,
         * which is a thousand billion shares. The contract reverted, the press
         * was spent, and the message said only CONTRACT_REVERT_EXECUTED.
         *
         * This console refuses a call that cannot succeed rather than letting
         * the device draw it -- the same rule the ATS factory's own bounds get
         * in LeekSecurityFactory. The sentence names the cap, the supply, the
         * decimals and the headroom, because "it reverted" taught nobody what
         * number to type instead. */
        /* The scale is the contract's, read just now, or there is no mint. */
        if (view.decimals.state !== "ok") {
          out.replaceChildren(el("p", "ats-notice",
            "Nothing was asked for: this security's decimals() could not be " +
            "read, so there is no scale to turn shares into the raw units a " +
            "mint actually takes. Guessing one is how a mint lands a million " +
            "times off."));
          go.disabled = false;
          return;
        }
        let want: bigint;
        try {
          want = parseUnits(typed, view.decimals.value);
        } catch {
          out.replaceChildren(el("p", "ats-notice",
            `Nothing was asked for: ${typed} carries more decimal places than ` +
            `this security's ${view.decimals.value}. Rounding somebody's share ` +
            `count is not this app's decision to make.`));
          go.disabled = false;
          return;
        }
        if (want <= 0n) {
          out.replaceChildren(el("p", "ats-notice", "The amount must be greater than zero."));
          go.disabled = false;
          return;
        }
        const cap = view.maxSupply;
        const supply = view.totalSupply;
        if (cap.state === "ok" && supply.state === "ok" && maxSupplyIsCap(cap.value)) {
          const room = cap.value > supply.value ? cap.value - supply.value : 0n;
          if (want > room) {
            const decRead = view.decimals.state === "ok" ? view.decimals.value : undefined;
            const scaled = decRead === undefined
              ? ""
              : ` At ${decRead} decimals that cap is ` +
                `${formatUnits(cap.value, decRead)} shares.`;
            out.replaceChildren(el("p", "ats-notice",
              `Nothing was asked for. ${want} raw units is more than this ` +
              `security can still issue: the cap is ${cap.value} raw units and ` +
              `${supply.value} is already issued, leaving ${room}.${scaled} ` +
              `Minting past the cap reverts on chain, after the press.`));
            go.disabled = false;
            return;
          }
        }
        const outcome = await proposePrivileged(context, factsFrom(view), {
          action: "mint", to: address, amount: want,
        });
        out.replaceChildren(actOutcomeElement(outcome));
      } catch (e) {
        out.replaceChildren(el("p", "ats-notice",
          `Nothing was asked for: this security's register could not be read ` +
          `(${String((e as Error)?.message ?? e)}), and a mint is not proposed ` +
          "against a contract this console has not looked at."));
      } finally {
        go.disabled = false;
      }
    })();
  });
  return form;
}

function actOutcomeElement(outcome: ActOutcome): HTMLElement {
  const box = el("div", "ats-panel");
  switch (outcome.kind) {
    case "sent":
      box.append(screenElement(outcome.screen));
      box.append(el("p", "ats-muted", `Signed and sent. Transaction ${outcome.result}.`));
      break;
    case "declined":
      box.append(screenElement(outcome.screen));
      box.append(el("p", "ats-uncertain", outcome.notice));
      break;
    case "refused":
      box.append(el("p", "ats-notice", `${outcome.why} ${outcome.notice}`));
      break;
    case "cannot-ask":
      box.append(el("p", "ats-uncertain", outcome.notice));
      break;
  }
  return box;
}

/* -------------------------------------------------------------------- send */

function sendForm(
  holding: Holding, context: AppContext, book: RecipientBook, out: HTMLElement,
): HTMLElement {
  const form = el("div", "ats-panel");
  form.append(el("p", "ats-muted",
    "Send moves shares this wallet already holds. It creates nothing. Whether " +
    "the recipient may hold them is decided by this security's own control " +
    "list, KYC, pause and freeze rules, on chain, after the press — nothing on " +
    "this screen can tell you in advance."));
  const to = recipientPicker(book, "Send to");
  const amount = el("input");
  amount.type = "text";
  amount.placeholder = "raw units";
  amount.setAttribute("aria-label", "Amount in raw units to send");
  form.append(to.wrap, row("Amount (raw units)", amount));
  const go = el("button", undefined, "Send shares");
  form.append(go);

  go.addEventListener("click", () => {
    void (async () => {
      const address = to.value();
      if (address === undefined) {
        out.replaceChildren(el("p", "ats-notice", "Choose or type a 20-byte address to send to."));
        return;
      }
      if (!/^\d+$/.test(amount.value.trim()) || BigInt(amount.value.trim()) <= 0n) {
        out.replaceChildren(el("p", "ats-notice",
          "The amount must be a whole number of raw units, greater than zero."));
        return;
      }
      go.disabled = true;
      const outcome = await runTransfer(
        context, holding.address, address, BigInt(amount.value.trim()),
      );
      const line = el("p");
      switch (outcome.kind) {
        case "sent":
          line.className = "ats-muted";
          line.textContent = `Signed and sent. Transaction ${outcome.result}.`;
          break;
        case "declined":
          line.className = "ats-uncertain";
          line.textContent = outcome.notice;
          break;
        case "refused":
          line.className = "ats-notice";
          line.textContent = outcome.reason;
          break;
        case "cannot-ask":
          line.className = "ats-uncertain";
          line.textContent = outcome.notice;
          break;
      }
      out.replaceChildren(line);
      go.disabled = false;
    })();
  });
  return form;
}

/* -------------------------------------------------------------- recipients */

/** The book as a panel: what is in it, and one field to add to it. */
function recipientsBox(book: RecipientBook): HTMLElement {
  const box = el("details");
  box.append(el("summary", undefined, "Recipient addresses"));
  box.append(el("p", "ats-muted", RECIPIENT_NOTICE));
  const list = el("div", "ats-panel");
  const address = el("input");
  address.type = "text";
  address.placeholder = "0x… address";
  address.setAttribute("aria-label", "Recipient address");
  const label = el("input");
  label.type = "text";
  label.placeholder = "your own note (optional)";
  label.setAttribute("aria-label", "Recipient note");
  const add = el("button", undefined, "Remember this address");
  const problem = el("p", "ats-notice");
  problem.hidden = true;

  const paint = (): void => {
    list.replaceChildren();
    const entries = book.list();
    if (entries.length === 0) {
      list.append(el("p", "ats-muted", "No addresses have been entered."));
      return;
    }
    for (const entry of entries) {
      const line = el("div", "ats-row");
      line.append(el("span", "ats-address", entry.address));
      /* The note never appears without the address beside it. See recipients.ts. */
      if (entry.label !== "") line.append(el("span", "ats-muted", entry.label));
      const drop = el("button", "ghost", "Forget");
      drop.addEventListener("click", () => { book.remove(entry.address); paint(); });
      line.append(drop);
      list.append(line);
    }
  };

  add.addEventListener("click", () => {
    const result = book.add(address.value, label.value);
    problem.hidden = result.ok;
    problem.textContent = result.ok ? "" : result.reason;
    if (result.ok) { address.value = ""; label.value = ""; paint(); }
  });

  const form = el("div", "ats-row");
  form.append(address, label, add);
  box.append(list, form, problem);
  paint();
  return box;
}

/**
 * A chooser over the book plus a free-text field.
 *
 * Both, always. The book is a convenience and must not become the only way to
 * name an address — a panel that can only send to addresses it has seen before
 * is a panel that cannot make the first payment.
 */
function recipientPicker(book: RecipientBook, label: string): {
  wrap: HTMLElement; value: () => string | undefined;
} {
  const wrap = el("div", "ats-row");
  wrap.append(el("span", "ats-label", label));
  const select = el("select");
  select.setAttribute("aria-label", `${label} — a remembered address`);
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— type an address —";
  select.append(blank);
  for (const entry of book.list()) {
    const opt = document.createElement("option");
    opt.value = entry.address;
    opt.textContent = RecipientBook.describe(entry);
    select.append(opt);
  }
  const input = el("input");
  input.type = "text";
  input.placeholder = "0x… address";
  input.setAttribute("aria-label", `${label} — an address`);
  select.addEventListener("change", () => { input.value = select.value; });
  wrap.append(select, input);
  return {
    wrap,
    value: (): string | undefined => {
      const v = input.value.trim();
      return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : undefined;
    },
  };
}
