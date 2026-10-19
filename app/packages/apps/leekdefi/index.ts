/**
 * LeekDefi: the LeekStonks index market, inside the wallet.
 *
 * The same market the website at leekdefi.0xoucanproject.xyz serves, read from
 * the same contracts on Mezo testnet, confirmed on the device instead of in a
 * browser extension. The palette and the wording are deliberately the
 * website's (styles.ts says why), so that someone who used it recognises this.
 *
 * ---------------------------------------------------------------------------
 * What this app can and cannot do
 *
 * It reads chains through `context.request` and it asks for signatures through
 * `context.propose`. It holds no key, no transport and no device client, and
 * `propose` returns an outcome rather than a signing capability: the shell
 * picks the signer, fills the chain and the fees, and the device draws the
 * call and confirms it before any signature exists. Every call it proposes is
 * one the firmware's own table in src/eth-decode.c can decode and draw field
 * by field - a host-side descriptor alone would satisfy this companion's gate
 * and not the device's, which is the distinction descriptors.ts is about.
 *
 * ---------------------------------------------------------------------------
 * The two sentences this screen must not get wrong
 *
 * "Holding a share pays no income." `redeem` pays `shares * price - fee` and
 * never reads reserves, so a growing reserve does not increase what a share is
 * worth. There is no yield on a share and no APY to quote, and the website
 * says so in the same words.
 *
 * "GOLOGGLE and AMEZON are invented index names." They track baskets of
 * cryptoassets and contain, reference and derive from no company's shares.
 * Neither is a security, and neither is named after one.
 *
 * Both appear below, and web/test/stakingRate.test.ts in leek-stocks pins the
 * equivalents on the website for the same reason: they are the claims most
 * likely to be dropped by someone tidying up copy.
 */

import type { ProposalOutcome } from "@leekwallet/core/app-proposal.ts";
import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";

import {
  BORROWER_OPERATIONS, INDICES, MEZO_FAUCET, MEZO_TESTNET, MUSD, STAKING,
} from "./addresses.ts";
import {
  collateralRatioBps, encodeBorrow, hasPosition, readBorrow, type BorrowState,
} from "./borrow.ts";
import { descriptorsFor } from "./descriptors.ts";
import { encode, readAll, type IndexState, type LeekDefiState } from "./read.ts";
import { CSS } from "./styles.ts";

/* ------------------------------------------------------------- formatting */

const WAD = 10n ** 18n;

/**
 * An 18-decimal amount, with `decimals` places shown.
 *
 * Truncates rather than rounds. A balance rounded up reads as more money than
 * the address holds, and "you have 1.0 shares" when you have 0.999999 is the
 * kind of wrong that makes a redeem fail with no visible reason.
 */
function formatWad(value: bigint, decimals = 4): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const whole = v / WAD;
  const frac = v % WAD;
  const digits = frac.toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${digits ? `.${digits}` : ""}`;
}

/** Basis points as a percentage, e.g. 50 -> "0.50%". */
const formatBps = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Parse a user-typed decimal into 18-decimal units, or null if it is not a number. */
function parseWad(text: string): bigint | null {
  const trimmed = text.trim();
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed)) return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > 18) return null;
  const value = BigInt(whole || "0") * WAD + BigInt((frac + "0".repeat(18)).slice(0, 18));
  return value > 0n ? value : null;
}

/**
 * What to tell the user about a proposal's outcome.
 *
 * Narrowed on `kind` rather than reaching for `.result`, because a refusal
 * carries one sentence and only one: `PROPOSAL_DECLINED`. An app is not told
 * whether the user rejected it or the gate refused it, and that asymmetry is
 * deliberate - an app that could tell the two apart could search for a payload
 * that passes, or re-ask the moment it sees a rejection. The person whose
 * money it is sees the real reason, in the shell's log, every time.
 */
function describeOutcome(outcome: ProposalOutcome, sent: string): string {
  if (!outcome.ok) return outcome.text;
  return outcome.kind === "call" ? `${sent}: ${outcome.result}` : `${sent}: signed`;
}

/* --------------------------------------------------------------- elements */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A label and a value.
 *
 * `value === null` renders "not read" in the unread style, never a zero: a
 * figure that could not be fetched and a figure that is genuinely zero are
 * different facts, and only one of them is safe to show as a number.
 */
function row(label: string, value: string | null, note?: string): HTMLElement {
  const wrap = el("div", "leekdefi-row");
  const left = el("div");
  left.append(el("div", "leekdefi-label", label));
  if (note !== undefined) left.append(el("div", "leekdefi-note", note));
  wrap.append(left);
  wrap.append(
    value === null
      ? el("div", "leekdefi-value leekdefi-unread", "not read")
      : el("div", "leekdefi-value", value),
  );
  return wrap;
}

function card(title: string): HTMLElement {
  const node = el("section", "leekdefi-card");
  node.append(el("div", "leekdefi-card-title", title));
  return node;
}

/* ------------------------------------------------------------------ panes */

/**
 * Backing, in three states rather than two.
 *
 * A null coverage means either that the price could not be read - liabilities()
 * calls price() - or that nothing is owed, because the ratio has no
 * denominator. Those are opposite situations: one is a broken read, the other
 * a healthy empty vault. The website collapsed them and told readers of a
 * freshly deployed vault that the price was unreadable while it was working
 * perfectly; that was fixed there and must not be reintroduced here.
 */
function backingRow(index: IndexState): HTMLElement {
  const { reserves, liabilities } = index;
  if (liabilities === null) {
    return row("Backing", null, "the price is unreadable, so what the vault owes is unknown");
  }
  if (liabilities === 0n) {
    const value = index.shareSupply === 0n ? "no shares yet" : "nothing owed";
    const wrap = el("div", "leekdefi-row");
    const left = el("div");
    left.append(el("div", "leekdefi-label", "Backing"));
    left.append(el("div", "leekdefi-note", "no shares have been issued, so there is nothing to cover"));
    wrap.append(left, el("div", "leekdefi-value", value));
    return wrap;
  }
  if (reserves === null) return row("Backing", null, "reserves could not be read");

  const bps = Number((reserves * 10_000n) / liabilities);
  const short = liabilities > reserves;
  const wrap = el("div", "leekdefi-row");
  const left = el("div");
  left.append(el("div", "leekdefi-label", "Backing"));
  left.append(
    el(
      "div",
      "leekdefi-note",
      `${formatWad(reserves, 2)} MUSD held against ${formatWad(liabilities, 2)} owed`,
    ),
  );
  const value = el("div", `leekdefi-value ${short ? "leekdefi-loss" : "leekdefi-gain"}`);
  /* A sign and a word, not only a hue: roughly one man in twelve cannot
     separate these two colours, and "the red one" is not information to them. */
  value.textContent = `${short ? "▼ " : "▲ "}${formatBps(bps)}`;
  wrap.append(left, value);
  return wrap;
}

function indexCard(index: IndexState): HTMLElement {
  const node = card(`${index.symbol} / MUSD`);

  const price = el("div", "leekdefi-value-lg");
  if (index.price === null) {
    price.className = "leekdefi-value-lg leekdefi-unread";
    price.textContent = "no usable price";
  } else {
    price.textContent = `${formatWad(index.price, 2)} MUSD`;
  }
  node.append(price);

  if (index.price === null) {
    node.append(
      el(
        "div",
        "leekdefi-note",
        "The vault refused to price a share: the oracle's last answer is older " +
          "than it accepts. Buying and redeeming revert until the feed publishes.",
      ),
    );
  }

  node.append(backingRow(index));
  node.append(row("Your shares", index.shares === null ? null : formatWad(index.shares)));
  node.append(
    row(
      "Your fee",
      index.effectiveFeeBps === null ? null : formatBps(index.effectiveFeeBps),
      index.baseFeeBps !== null && index.effectiveFeeBps !== null && index.effectiveFeeBps < index.baseFeeBps
        ? `discounted from ${formatBps(index.baseFeeBps)} by your MEZO stake`
        : "read from the vault, discount included",
    ),
  );
  node.append(row("Vault", shortAddress(index.vault)));

  /* A build whose vault points at a share token the vault does not name is
     looking at the wrong deployment. Said out loud rather than ignored. */
  if (index.shareMatchesExpectation === false) {
    const warn = el("div", "leekdefi-message");
    warn.textContent =
      "This build expected a different share token for this vault. The vault's " +
      "own answer is being used; the addresses in this build are out of date.";
    node.append(warn);
  }
  return node;
}

/**
 * Mezo's borrow market: where the MUSD comes from.
 *
 * Mirrors the website's panel, because the step it covers is unavoidable here.
 * On Mezo testnet the settlement token is the real MUSD and nothing mints it
 * but this market, so a wallet that could buy a share but not borrow was a
 * market you could only use if you had already borrowed elsewhere.
 *
 * The ratio sits beside the debt rather than behind a disclosure: the BTC is
 * liquidatable, and that is the one consequence a borrower must not have to
 * look for.
 */
function borrowPanel(
  state: BorrowState,
  propose: AppContext["propose"],
  say: (text: string) => void,
  nativeBalance: bigint | null,
): HTMLElement {
  const node = card("Get MUSD: borrow against BTC");
  node.append(
    el(
      "div",
      "leekdefi-note",
      "This market settles in MUSD and mints none of it. MUSD comes from " +
        "Mezo's own borrow market: you lock BTC as collateral and it mints " +
        "MUSD against it. It is a loan, not a swap — the BTC comes back when " +
        "the debt is repaid, and it can be liquidated if the collateral ratio " +
        "falls too far.",
    ),
  );
  node.append(row("Mezo BorrowerOperations", shortAddress(BORROWER_OPERATIONS)));

  const ratio = collateralRatioBps(state);
  const open = hasPosition(state);

  if (open) {
    node.append(
      row(
        "BTC locked",
        state.collateral === null ? null : formatWad(state.collateral, 8),
        "collateral, returned when the position closes",
      ),
    );
    node.append(
      row(
        "MUSD owed",
        state.debt === null ? null : formatWad(state.debt, 2),
        "includes the 200 MUSD liquidation reserve",
      ),
    );
    /* The threshold is read from the protocol, never assumed: a hardcoded
       110% that the protocol later changed would be a screen that is quietly
       wrong about when somebody loses their Bitcoin. */
    const mcrPct = state.mcr === null ? null : Number((state.mcr * 100n) / 10n ** 18n);
    const ratioRow = el("div", "leekdefi-row");
    const left = el("div");
    left.append(el("div", "leekdefi-label", "Collateral ratio"));
    left.append(
      el(
        "div",
        "leekdefi-note",
        mcrPct === null ? "liquidation threshold not read" : `liquidatable below ${mcrPct}%`,
      ),
    );
    ratioRow.append(left);
    if (ratio === null) {
      ratioRow.append(el("div", "leekdefi-value leekdefi-unread", "not read"));
    } else {
      /* A caret and a word as well as a hue: the colour alone is not
         information to roughly one man in twelve. */
      const near = mcrPct !== null && ratio < mcrPct * 100 + 2_000;
      const v = el("div", `leekdefi-value ${near ? "leekdefi-loss" : "leekdefi-gain"}`);
      v.textContent = `${near ? "▼ " : "▲ "}${(ratio / 100).toFixed(0)}%`;
      ratioRow.append(v);
    }
    node.append(ratioRow);
  } else {
    node.append(
      el(
        "div",
        "leekdefi-note",
        state.status === null
          ? "Your position could not be read."
          : "You have no position in this market yet.",
      ),
    );
    node.append(
      row(
        "Smallest loan",
        state.minNetDebt === null ? null : `${formatWad(state.minNetDebt, 2)} MUSD`,
        "the protocol refuses less, plus a 200 MUSD liquidation reserve on top",
      ),
    );
    node.append(
      row("Your BTC", nativeBalance === null ? null : formatWad(nativeBalance, 8), "gas and collateral are the same asset here"),
    );
  }

  node.append(
    row(
      "BTC price",
      state.price === null ? null : `${formatWad(state.price, 2)} USD`,
      "from Mezo's own feed, not ours",
    ),
  );

  if (propose === undefined) {
    node.append(el("div", "leekdefi-note", "No device is connected, so nothing can be signed."));
    return node;
  }

  const input = el("input", "leekdefi-input");
  input.type = "text";
  input.inputMode = "decimal";
  input.placeholder = "0.00";
  input.setAttribute("aria-label", "MUSD amount");
  node.append(input);

  const amountOrComplain = (): bigint | null => {
    const amount = parseWad(input.value);
    if (amount === null) say("Enter an amount of MUSD greater than zero.");
    return amount;
  };

  const actions = el("div", "leekdefi-actions");

  if (!open) {
    /* Opening needs BTC in the same transaction, as value. The collateral is
       not an argument, which is exactly why the device draws it from the
       transaction rather than from the calldata. */
    const collInput = el("input", "leekdefi-input");
    collInput.type = "text";
    collInput.inputMode = "decimal";
    collInput.placeholder = "0.01";
    collInput.setAttribute("aria-label", "BTC to lock as collateral");
    node.append(el("div", "leekdefi-note", "BTC to lock as collateral:"));
    node.append(collInput);

    const borrow = el("button", "leekdefi-button", "Borrow MUSD");
    borrow.type = "button";
    borrow.addEventListener("click", () => {
      const debt = amountOrComplain();
      if (debt === null) return;
      const collateral = parseWad(collInput.value);
      if (collateral === null) {
        say("Enter the BTC to lock as collateral.");
        return;
      }
      if (state.minNetDebt !== null && debt < state.minNetDebt) {
        say(`The protocol refuses a loan below ${formatWad(state.minNetDebt, 2)} MUSD.`);
        return;
      }
      /* Checked before asking for a signature: a position that opens below
         the minimum ratio is liquidatable the moment it exists. */
      if (state.price !== null && state.mcr !== null && debt > 0n) {
        const wouldBe = (collateral * state.price * 10_000n) / (debt * 10n ** 18n);
        const floor = (state.mcr * 10_000n) / 10n ** 18n;
        if (wouldBe < floor) {
          say(
            `That is a ratio of ${(Number(wouldBe) / 100).toFixed(0)}%, below the ` +
              `${(Number(floor) / 100).toFixed(0)}% the protocol requires. Lock more BTC or borrow less.`,
          );
          return;
        }
      }
      void (async () => {
        const outcome = await propose({
          kind: "call",
          to: BORROWER_OPERATIONS,
          data: encodeBorrow.openTrove(debt),
          value: collateral,
          reason: `Borrow ${formatWad(debt)} MUSD against ${formatWad(collateral, 8)} BTC`,
        });
        say(describeOutcome(outcome, "Borrow sent"));
      })();
    });
    actions.append(borrow);
  } else {
    const more = el("button", "leekdefi-button", "Borrow more");
    more.type = "button";
    more.addEventListener("click", () => {
      const amount = amountOrComplain();
      if (amount === null) return;
      void (async () => {
        const outcome = await propose({
          kind: "call",
          to: BORROWER_OPERATIONS,
          data: encodeBorrow.withdrawMUSD(amount),
          reason: `Borrow a further ${formatWad(amount)} MUSD against the same BTC`,
        });
        say(describeOutcome(outcome, "Borrow sent"));
      })();
    });

    const repay = el("button", "leekdefi-button-quiet", "Repay");
    repay.type = "button";
    repay.addEventListener("click", () => {
      const amount = amountOrComplain();
      if (amount === null) return;
      void (async () => {
        const outcome = await propose({
          kind: "call",
          to: BORROWER_OPERATIONS,
          data: encodeBorrow.repayMUSD(amount),
          reason: `Repay ${formatWad(amount)} MUSD of debt`,
        });
        say(describeOutcome(outcome, "Repayment sent"));
      })();
    });

    const close = el("button", "leekdefi-button-quiet", "Close and take the BTC back");
    close.type = "button";
    close.addEventListener("click", () => {
      void (async () => {
        const outcome = await propose({
          kind: "call",
          to: BORROWER_OPERATIONS,
          data: encodeBorrow.closeTrove(),
          reason: "Repay all MUSD debt and withdraw the BTC collateral",
        });
        say(describeOutcome(outcome, "Close sent"));
      })();
    });

    actions.append(more, repay, close);
    node.append(
      el(
        "div",
        "leekdefi-note",
        "The protocol requires the debt, less its 200 MUSD liquidation reserve, " +
          "to stay at or above the minimum. Closing is the only way past that, " +
          "and it needs the whole debt in MUSD in your wallet.",
      ),
    );
  }

  node.append(actions);
  return node;
}

/* ---------------------------------------------------------------- the app */

export const leekDefiApp: MiniApp = {
  id: "leekdefi",
  name: "LeekDefi",
  summary: "Buy and redeem synthetic index shares, settled in MUSD on Mezo",
  chainIds: [MEZO_TESTNET],
  css: CSS,
  descriptors: descriptorsFor,

  async mount(root: HTMLElement, context: AppContext): Promise<void> {
    root.replaceChildren();
    const wrap = el("div", "leekdefi");
    root.append(wrap);

    /* ------------------------------------------------------------ header */
    const header = el("header");
    header.append(el("div", "leekdefi-wordmark", "LeekStonks"));
    header.append(
      el("div", "leekdefi-tagline", "Synthetic index exposure, cash-settled in MUSD · part of LeekDefi"),
    );
    wrap.append(header);

    wrap.append(
      el(
        "div",
        "leekdefi-disclaimer",
        "Not securities and not shares in any company: GOLOGGLE and AMEZON are " +
          "invented index names tracking baskets of cryptoassets. Testnet only.",
      ),
    );

    /* ----------------------------------------------- address, and copying */
    const who = card("This address");
    who.append(el("div", "leekdefi-address", context.address));
    const copyRow = el("div", "leekdefi-actions");
    const copy = el("button", "leekdefi-button-quiet", "Copy address");
    copy.type = "button";
    copy.addEventListener("click", () => {
      /* Clipboard access is denied outright in some webviews and on an
         insecure origin, and navigator.clipboard is undefined in others. Both
         are reported as failures with the address still on screen to select by
         hand - a button that silently did nothing is worse than one that says
         it could not. */
      void (async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error("no clipboard in this window");
          await navigator.clipboard.writeText(context.address);
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Copy blocked — select it above";
        }
        setTimeout(() => { copy.textContent = "Copy address"; }, 2500);
      })();
    });
    copyRow.append(copy);
    who.append(copyRow);
    wrap.append(who);

    /* ------------------------------------------------------------ faucet */
    const faucet = card("Get testnet funds");
    const link = el("a", "leekdefi-link", "Mezo's faucet (faucet.test.mezo.org)");
    link.href = MEZO_FAUCET;
    link.target = "_blank";
    /* noreferrer as well as noopener: the opened page should learn neither
       this window nor where the click came from. */
    link.rel = "noopener noreferrer";
    const faucetLine = el("div", "leekdefi-note");
    faucetLine.append(
      document.createTextNode("Gas on Mezo is paid in BTC, not ether. "),
      link,
      document.createTextNode(
        " hands out the testnet BTC that is both gas and borrow collateral. " +
          "MUSD is not faucetable here: it is the real MUSD, minted by borrowing " +
          "against BTC in Mezo's own market at ",
      ),
      el("span", "leekdefi-address", shortAddress(BORROWER_OPERATIONS)),
      document.createTextNode("."),
    );
    faucet.append(faucetLine);
    wrap.append(faucet);

    /* ------------------------------------------------------ loading state */
    const body = el("div");
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = "16px";
    body.append(el("div", "leekdefi-note", "Reading the contracts…"));
    wrap.append(body);

    const message = el("div", "leekdefi-message");
    message.hidden = true;
    wrap.append(message);

    const say = (text: string): void => {
      message.textContent = text;
      message.hidden = false;
    };

    let state: LeekDefiState;
    let borrow: BorrowState;
    let nativeBalance: bigint | null;
    try {
      [state, borrow, nativeBalance] = await Promise.all([
        readAll(context.request, context.address),
        readBorrow(context.request, context.address),
        /* BTC is gas AND collateral on this chain, so the borrow panel needs
           it. Null on failure, like every other figure here. */
        context
          .request({ method: "eth_getBalance", params: [context.address, "latest"] })
          .then((raw) => (typeof raw === "string" ? BigInt(raw) : null))
          .catch(() => null),
      ]);
    } catch (e) {
      /* Rejecting is the honest outcome when the app cannot say anything true,
         and the shell renders the failure. */
      throw new Error(`LeekDefi could not read Mezo testnet: ${(e as Error).message}`);
    }

    const render = (): void => {
      body.replaceChildren();
      for (const index of state.indices) body.append(indexCard(index));

      /* The order the website uses, and it is the order of the steps: see the
         price, get the MUSD, then spend it. A borrow panel below the buy
         button would be below the thing it is a prerequisite for. */
      body.append(borrowPanel(borrow, context.propose, say, nativeBalance));

      /* ---------------------------------------------------------- wallet */
      const position = card("Your position");
      position.append(row("MUSD", state.musd === null ? null : formatWad(state.musd), "dollar-denominated, at $1.00 parity"));
      position.append(
        row(
          "BTC (gas)",
          nativeBalance === null ? null : formatWad(nativeBalance, 8),
          "gas on Mezo is BTC, not ether",
        ),
      );
      const host = context.endpointHost?.();
      position.append(row("Read from", host ?? null, "whoever answered most recently"));
      body.append(position);

      /* ----------------------------------------------------------- trade */
      const first = state.indices[0];
      if (first !== undefined) {
        const trade = card(`Buy ${first.symbol}`);
        const input = el("input", "leekdefi-input");
        input.type = "text";
        input.inputMode = "decimal";
        input.placeholder = "0.00";
        input.setAttribute("aria-label", "MUSD to spend");
        trade.append(input);
        trade.append(
          el(
            "div",
            "leekdefi-note",
            "The amount of MUSD to spend. The shares you receive depend on the " +
              "oracle's price at the moment the transaction lands, so the device " +
              "will show you a floor as well as the amount.",
          ),
        );

        const actions = el("div", "leekdefi-actions");
        const approve = el("button", "leekdefi-button", "Approve MUSD");
        approve.type = "button";
        const buy = el("button", "leekdefi-button", "Buy shares");
        buy.type = "button";
        actions.append(approve, buy);
        trade.append(actions);

        if (context.propose === undefined) {
          /* Absence of propose is a real state, not a legacy allowance: no
             device is connected, or this is a harness. Said rather than
             pretended. */
          approve.disabled = true;
          buy.disabled = true;
          trade.append(
            el(
              "div",
              "leekdefi-note",
              "No device is connected, so nothing can be signed. Connect one to buy or redeem.",
            ),
          );
        } else {
          const propose = context.propose;
          const amountOrComplain = (): bigint | null => {
            const amount = parseWad(input.value);
            if (amount === null) say("Enter an amount of MUSD greater than zero.");
            return amount;
          };

          approve.addEventListener("click", () => {
            const amount = amountOrComplain();
            if (amount === null) return;
            void (async () => {
              const outcome = await propose({
                kind: "call",
                to: MUSD,
                data: encode.approve(first.vault, amount),
                reason: `Allow the ${first.symbol} vault to take ${formatWad(amount)} MUSD`,
              });
              say(describeOutcome(outcome, "Approval sent"));
            })();
          });

          buy.addEventListener("click", () => {
            const amount = amountOrComplain();
            if (amount === null) return;
            if (first.price === null) {
              say("The vault cannot price a share right now, so a buy would revert.");
              return;
            }
            if (first.allowance !== null && first.allowance < amount) {
              say("Approve at least this much MUSD first — the vault cannot take it otherwise.");
              return;
            }
            /* A floor of 99% of what the current price implies, after the fee
               this address actually pays. Never zero: a buy with no floor is a
               buy at whatever price the oracle happens to publish, which is
               the one call an operator of a mispriced feed wants signed. */
            const feeBps = BigInt(first.effectiveFeeBps ?? first.baseFeeBps ?? 50);
            const net = (amount * (10_000n - feeBps)) / 10_000n;
            const expected = (net * WAD) / first.price;
            const minShares = (expected * 99n) / 100n;
            void (async () => {
              const outcome = await propose({
                kind: "call",
                to: first.vault,
                data: encode.buy(amount, minShares),
                reason: `Buy ${first.symbol} with ${formatWad(amount)} MUSD, at least ${formatWad(minShares)} shares`,
              });
              say(describeOutcome(outcome, "Buy sent"));
            })();
          });
        }
        body.append(trade);
      }

      /* --------------------------------------------------------- staking */
      const staking = card("Stake MEZO");
      staking.append(
        el(
          "div",
          "leekdefi-note",
          "Staking MEZO does two things: it discounts the fee you pay to buy and " +
            "redeem, and it pays you a share of the fees everyone else pays. " +
            "Unlike holding a share, this does earn.",
        ),
      );
      const s = state.staking;
      staking.append(row("Total staked", s.totalStaked === null ? null : `${formatWad(s.totalStaked)} MEZO`, "across every staker"));
      staking.append(row("Revenue to stakers", s.totalDistributed === null ? null : `${formatWad(s.totalDistributed)} MUSD`, "distributed since this contract was deployed"));
      staking.append(row("Your stake", s.yourStake === null ? null : `${formatWad(s.yourStake)} sMEZO`, "one sMEZO per MEZO staked"));
      staking.append(row("Your rewards", s.yourRewards === null ? null : `${formatWad(s.yourRewards)} MUSD`, "claimable once the holding period has passed"));

      /* The discount is zero during the cooldown, and that looks exactly like
         a bug unless the remaining time is on screen. */
      const now = BigInt(Math.floor(Date.now() / 1000));
      const cooling = s.coolingUntil !== null && s.coolingUntil > now ? s.coolingUntil - now : 0n;
      staking.append(
        row(
          "Your discount",
          s.discountBps === null ? null : formatBps(s.discountBps),
          cooling > 0n
            ? `0% until the holding period ends in ${Math.ceil(Number(cooling) / 60)} min — ` +
              "the discount requires the position to have been held, which is what " +
              "stops it being rented for one transaction"
            /* An address that never staked has a coolingUntil of zero, which
               is not the same as a cooldown that has elapsed. Saying "applies
               now" beside 0.00% reads as a bug rather than as "you have not
               staked", which is what it actually means. */
            : (s.yourStake ?? 0n) === 0n
              ? "stake MEZO to earn a discount; 1 MEZO is the first tier"
              : "applies now",
        ),
      );
      staking.append(row("Staking contract", shortAddress(STAKING)));
      body.append(staking);

      /* ---------------------------------------------------------- honesty */
      body.append(
        el(
          "div",
          "leekdefi-note",
          "Holding a share pays no income. A share returns the index price at the " +
            "moment you redeem, less the fee. Reserves growing does not increase " +
            "what one share is worth, so there is no yield and no APY to quote. The " +
            "treasury half of each fee is routed to MEZO stakers, who do earn — a " +
            "share is not a claim on it.",
        ),
      );
      body.append(
        el(
          "div",
          "leekdefi-note",
          "A share is priced from an index the vault does not hold, so the MUSD paid " +
            "in by buyers can be less than the MUSD owed to redeemers. Redemption " +
            "reverts when reserves are short rather than paying part of it. See audit " +
            "finding H-1.",
        ),
      );
    };

    render();
  },
};
