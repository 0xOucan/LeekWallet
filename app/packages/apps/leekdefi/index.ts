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

import type { AppProposal, ProposalOutcome } from "@leekwallet/core/app-proposal.ts";
import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";

import {
  BORROWER_OPERATIONS, INDICES, MEZO, MEZO_FAUCET, MEZO_TESTNET, MUSD, STAKING,
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

/**
 * An input with a label above it that is actually visible.
 *
 * The borrow panel shipped with two boxes, one of which carried only an
 * `aria-label`. A sighted user saw an unlabelled box above a labelled one and
 * typed the BTC collateral into the MUSD field, which was then refused for
 * being under the protocol's minimum loan - a correct refusal to a question
 * nobody meant to ask. An aria-label is for a screen reader, not a substitute
 * for telling everybody else which field is which.
 */
/**
 * Stops the panel offering an approval that has already been given.
 *
 * The allowance was always read -- `allowance`, `shareAllowance` and
 * `mezoAllowance` have been in `read.ts` since the start -- but the three
 * Approve buttons never consulted it, so they stayed armed after the approval
 * landed. Pressing one sent the device a second, identical approval to draw
 * and sign for no change in state. The device is the one thing in this system
 * that cannot be asked twice cheaply: every spurious signature trains the
 * habit of approving without reading, which is the whole defence.
 *
 * So: one helper, wired at every approval site, rather than three guards that
 * can drift apart. It re-evaluates as the amount is typed, because "already
 * approved" is a claim about a specific number and raising the amount makes it
 * false again.
 *
 * A null allowance disarms nothing. Unreadable is not the same as zero, and
 * the honest move is to let the user approve rather than block on a figure
 * this app could not fetch.
 */
function armApproval(
  button: HTMLButtonElement,
  input: HTMLInputElement,
  allowance: bigint | null,
  unit: string,
): HTMLElement {
  const note = el("div", "leekdefi-note");
  const sync = (): void => {
    const wanted = parseWad(input.value);
    if (allowance === null) {
      button.disabled = false;
      note.textContent = `The current allowance could not be read, so the approval is offered anyway.`;
      return;
    }
    if (wanted !== null && allowance >= wanted) {
      button.disabled = true;
      note.textContent =
        `Already approved: ${formatWad(allowance)} ${unit} is allowed, which covers ` +
        `${formatWad(wanted)}. No second signature is needed.`;
      return;
    }
    /* With the field empty there is no "that" to be less than, and saying
       "Nothing is approved yet" over a standing allowance is simply false --
       which is exactly what it said after an approval had landed. State the
       allowance, and ask for the amount. */
    button.disabled = false;
    if (wanted === null) {
      note.textContent =
        allowance === 0n
          ? `Nothing is approved yet. Enter an amount.`
          : `${formatWad(allowance)} ${unit} is approved. Enter an amount to see whether it covers it.`;
      return;
    }
    note.textContent =
      allowance === 0n
        ? `Nothing is approved yet.`
        : `${formatWad(allowance)} ${unit} is approved, less than ${formatWad(wanted)}. Approving replaces the figure rather than adding to it.`;
  };
  input.addEventListener("input", sync);
  sync();
  return note;
}

/**
 * What is currently typed in each field, by field id.
 *
 * `render()` calls `body.replaceChildren()`, which destroys every input along
 * with its value. So choosing a different index -- which redraws, because
 * every allowance and refusal below belongs to the selected index -- silently
 * emptied the amount field, and the next press was refused for having no
 * amount. Worse, it happened after a write too: the figure vanished at the
 * moment the panel redrew with the new state.
 *
 * Keyed by the id `labelledInput` already derives from the label, so a field
 * keeps its value across any number of redraws without the call sites
 * knowing. Cleared on mount so a fresh open is a fresh form.
 */
const DRAFTS = new Map<string, string>();

function labelledInput(label: string, placeholder: string, hint?: string): {
  wrap: HTMLElement;
  input: HTMLInputElement;
} {
  const wrap = el("div");
  const id = `leekdefi-field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const l = el("label", "leekdefi-label", label);
  l.htmlFor = id;
  l.style.display = "block";
  l.style.marginBottom = "4px";
  const input = el("input", "leekdefi-input");
  input.type = "text";
  input.inputMode = "decimal";
  input.id = id;
  input.placeholder = placeholder;
  input.value = DRAFTS.get(id) ?? "";
  input.addEventListener("input", () => { DRAFTS.set(id, input.value); });
  wrap.append(l, input);
  if (hint !== undefined) wrap.append(el("div", "leekdefi-note", hint));
  return { wrap, input };
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
  /* Repaying and closing SPEND MUSD, so the panel cannot judge either without
     knowing what is held. Closing needs debt minus the liquidation reserve,
     which is less than the debt and easy to get wrong by exactly 200. */
  musd: bigint | null,
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
        state.reserve === null
          ? "includes the liquidation reserve"
          : `includes the ${formatWad(state.reserve, 0)} MUSD liquidation reserve`,
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
        state.reserve === null
          ? "the protocol refuses less"
          : `the protocol refuses less, plus a ${formatWad(state.reserve, 0)} MUSD liquidation reserve on top`,
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

  const smallest = state.minNetDebt === null ? null : formatWad(state.minNetDebt, 2);
  const debtField = labelledInput(
    open ? "MUSD to borrow or repay" : "MUSD to borrow",
    smallest ?? "0.00",
    open
      ? undefined
      : smallest === null
        ? undefined
        : `At least ${smallest} MUSD — the protocol refuses less.`,
  );
  const input = debtField.input;
  node.append(debtField.wrap);

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
    const collField = labelledInput(
      "BTC to lock as collateral",
      "0.01",
      "Returned when the position closes. It is also the gas token here, so " +
        "leave some unlocked.",
    );
    const collInput = collField.input;
    node.append(collField.wrap);

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
         the minimum ratio is liquidatable the moment it exists.
         Against debt PLUS the liquidation reserve, because that is what the
         protocol measures. Using the typed figure alone made this preview
         more optimistic than the chain and sent the device a transaction
         that reverts. */
      if (state.price !== null && state.mcr !== null && debt > 0n) {
        const owed = debt + (state.reserve ?? 0n);
        const wouldBe = (collateral * state.price * 10_000n) / (owed * 10n ** 18n);
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
      /* The same check `Borrow MUSD` makes, against the debt already owed.
         Without it this was the one borrow path that could hand the device a
         transaction the protocol would reject. */
      if (
        state.price !== null && state.mcr !== null &&
        state.collateral !== null && state.debt !== null
      ) {
        const owed = state.debt + amount;
        const wouldBe = (state.collateral * state.price * 10_000n) / (owed * 10n ** 18n);
        const floor = (state.mcr * 10_000n) / 10n ** 18n;
        if (wouldBe < floor) {
          say(
            `Borrowing that much would put the ratio at ${(Number(wouldBe) / 100).toFixed(0)}%, ` +
              `below the ${(Number(floor) / 100).toFixed(0)}% the protocol requires. Borrow less.`,
          );
          return;
        }
      }
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
      if (musd !== null && musd < amount) {
        say(`You hold ${formatWad(musd, 2)} MUSD, less than that.`);
        return;
      }
      /* The liquidation reserve is not repayable debt: it is returned when the
         trove closes. Repaying against the gross figure overshoots by exactly
         the reserve, and the protocol reverts. */
      if (state.debt !== null && state.reserve !== null) {
        const repayable = state.debt - state.reserve;
        if (amount > repayable) {
          say(
            `Only ${formatWad(repayable, 2)} MUSD of that debt is repayable; the ` +
              `remaining ${formatWad(state.reserve, 2)} is the liquidation reserve, ` +
              `returned when the position closes. Use Close instead.`,
          );
          return;
        }
        const left = repayable - amount;
        if (left > 0n && state.minNetDebt !== null && left < state.minNetDebt) {
          say(
            `That would leave ${formatWad(left, 2)} MUSD owed, below the ` +
              `${formatWad(state.minNetDebt, 2)} minimum. Repay less, or close the position.`,
          );
          return;
        }
      }
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
      /* Closing repays the debt MINUS the reserve out of your own balance. A
         position opened with borrowed MUSD and then spent is short of this by
         the borrowing fee, which is the common case rather than the odd one. */
      if (state.debt !== null && state.reserve !== null && musd !== null) {
        const needed = state.debt - state.reserve;
        if (musd < needed) {
          say(
            `Closing repays ${formatWad(needed, 2)} MUSD and you hold ` +
              `${formatWad(musd, 2)}. Short by ${formatWad(needed - musd, 2)}. ` +
              `The ${formatWad(state.reserve, 2)} liquidation reserve covers the rest ` +
              `and comes back with the BTC.`,
          );
          return;
        }
      }
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
        "The protocol requires the debt, less its liquidation reserve, to stay " +
          "at or above the minimum. Closing is the only way past that, and it " +
          "needs the whole debt in MUSD in your wallet.",
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
    /* Appended AFTER the panels, further down: the website puts it last and
       this read it second, which pushed the prices below a block of
       instructions on every visit. */

    /* ------------------------------------------------------ loading state */
    const body = el("div");
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = "16px";
    body.append(el("div", "leekdefi-note", "Reading the contracts…"));
    wrap.append(body);

    wrap.append(faucet);

    const message = el("div", "leekdefi-message");
    message.hidden = true;
    wrap.append(message);

    const say = (text: string): void => {
      message.textContent = text;
      message.hidden = false;
    };

    /* Mezo can take minutes to admit a transaction exists. A manual re-read is
       the difference between "it failed" and "the node has not said yet". */
    const reread = el("button", "leekdefi-button-quiet", "Re-read the chain");
    reread.type = "button";
    wrap.append(reread);

    const readEverything = async (): Promise<
      [LeekDefiState, BorrowState, bigint | null]
    > =>
      await Promise.all([
        readAll(context.request, context.address),
        readBorrow(context.request, context.address),
        /* BTC is gas AND collateral on this chain, so the borrow panel needs
           it. Null on failure, like every other figure here. */
        context
          .request({ method: "eth_getBalance", params: [context.address, "latest"] })
          .then((raw) => (typeof raw === "string" ? BigInt(raw) : null))
          .catch(() => null),
      ]);

    DRAFTS.clear();

    /* Which index the trade panel is pointed at. Outside render(), because a
       redraw must not silently move the user back to the first index. */
    let selected = 0;
    let state: LeekDefiState;
    let borrow: BorrowState;
    let nativeBalance: bigint | null;
    try {
      [state, borrow, nativeBalance] = await readEverything();
    } catch (e) {
      /* Rejecting is the honest outcome when the app cannot say anything true,
         and the shell renders the failure. */
      throw new Error(`LeekDefi could not read Mezo testnet: ${(e as Error).message}`);
    }

    /* Re-read, then redraw. Without this the panel showed the chain as it was
       when the app opened: after a borrow landed it still offered to OPEN a
       trove, the chain answered "BorrowerOps: Trove is active", and the app —
       which by design cannot tell a revert from a reject — reported it as a
       refusal. The state was stale, not the logic. */
    /* Has THIS account's next transaction number moved on?
       The nonce advances exactly when one of this address's transactions is
       included, which is the question being asked. Comparing a snapshot of
       the whole contract state was the wrong question: it also changed when
       somebody else's fee moved reserves, so the wait ended early and left
       the panel a step behind the chain. `scripts/lib/send.sh` in the
       contracts repo waits on the nonce for exactly this reason. */
    const nonce = async (): Promise<bigint | null> => {
      try {
        const raw = await context.request({
          method: "eth_getTransactionCount",
          params: [context.address, "latest"],
        });
        return typeof raw === "string" ? BigInt(raw) : null;
      } catch {
        return null;
      }
    };

    const readNow = async (): Promise<boolean> => {
      try {
        [state, borrow, nativeBalance] = await readEverything();
      } catch (e) {
        say(`Could not re-read the contracts: ${(e as Error).message}`);
        return false;
      }
      render();
      return true;
    };

    /**
     * Re-read now, or wait for a sent transaction to be included first.
     *
     * Broadcasting is not landing. Reading the instant `propose` returns gets
     * the state from BEFORE the transaction, because on Mezo inclusion is
     * seconds to minutes behind the send. That is how a 150 MUSD approval
     * that had landed showed as "Nothing is approved yet", after which this
     * app's own guard refused the buy it existed to enable.
     *
     * `since` is the nonce read before the write was proposed. Waiting for it
     * to advance waits for this account's own transaction and nothing else.
     */
    const refresh = async (since: bigint | null = null): Promise<void> => {
      if (since === null) { await readNow(); return; }
      for (let attempt = 0; attempt < 20; attempt++) {
        const now = await nonce();
        if (now === null || now > since) { await readNow(); return; }
        say("Sent. Waiting for Mezo to include it…");
        await new Promise((r) => setTimeout(r, 3000));
      }
      await readNow();
      /* A minute is long enough that something is wrong and short enough that
         saying so is still useful. It is not a claim the write failed: this
         chain is slow, and the manual re-read is right there. */
      say(
        "Sent, but Mezo has not reported it included after a minute. On this " +
          "chain that is usually late rather than failed — press Re-read the chain.",
      );
    };

    reread.addEventListener("click", () => {
      say("Re-reading…");
      void refresh().then(() => say("Re-read the chain."));
    });

    /* Every write goes through this, so there is one place that refreshes
       rather than eleven that might forget. Mezo answers
       eth_getTransactionReceipt with null for minutes after inclusion, so a
       send that looks unconfirmed usually landed; re-reading the contracts is
       the only honest way to find out, and it is why this waits. */
    const proposeAndRefresh =
      context.propose === undefined
        ? undefined
        : async (proposal: AppProposal): Promise<ProposalOutcome> => {
            /* Read before proposing: afterwards it is already ambiguous
               whether an advance was this transaction or a previous one. */
            const before = await nonce();
            const outcome = await context.propose!(proposal);
            if (outcome.ok) await refresh(before);
            return outcome;
          };

    const render = (): void => {
      body.replaceChildren();
      for (const index of state.indices) body.append(indexCard(index));

      /* The order the website uses, and it is the order of the steps: see the
         price, get the MUSD, then spend it. A borrow panel below the buy
         button would be below the thing it is a prerequisite for. */
      body.append(borrowPanel(borrow, proposeAndRefresh, say, nativeBalance, state.musd));

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
      /* Appended after the trade panel below, not here. */

      /* ----------------------------------------------------------- trade */
      /* One panel with a market selector, which is what the website does.
         This used to read `state.indices[0]` and nothing else, so the second
         index was priced on screen and could not be bought: every index got a
         card and only the first got a trade panel. A selector rather than a
         panel per index, so there is one amount field and one pair of
         buttons and no question about which index a press applies to. */
      const first = state.indices[selected] ?? state.indices[0];
      if (first !== undefined) {
        const trade = card(`Buy and redeem ${first.symbol}`);

        if (state.indices.length > 1) {
          const pickWrap = el("div");
          const pickId = "leekdefi-market";
          const pickLabel = el("label", "leekdefi-label", "Index");
          pickLabel.htmlFor = pickId;
          pickLabel.style.display = "block";
          pickLabel.style.marginBottom = "4px";
          const pick = document.createElement("select");
          pick.id = pickId;
          pick.className = "leekdefi-input";
          state.indices.forEach((index, i) => {
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = index.symbol;
            opt.selected = i === selected;
            pick.append(opt);
          });
          pick.addEventListener("change", () => {
            selected = Number(pick.value);
            /* Redraw rather than patch: the allowances, the share balance and
               every refusal below belong to the index that is selected. */
            render();
          });
          pickWrap.append(pickLabel, pick);
          trade.append(pickWrap);
        }

        /* Labelled for everybody, not only for a screen reader - the same
           defect the borrow panel had. */
        const tradeField = labelledInput("MUSD to spend", "0.00");
        const input = tradeField.input;
        trade.append(tradeField.wrap);
        trade.append(
          el(
            "div",
            "leekdefi-note",
            "The shares you receive depend on the oracle's price at the moment " +
              "the transaction lands, so the device will show you a floor as " +
              "well as the amount.",
          ),
        );

        const actions = el("div", "leekdefi-actions");
        const approve = el("button", "leekdefi-button", "Approve MUSD");
        approve.type = "button";
        const buy = el("button", "leekdefi-button", "Buy shares");
        buy.type = "button";
        /* Redeeming takes two signatures, and the first is not optional:
           `redeem` ends in `share.burnFrom(msg.sender, shares)`, and burnFrom
           spends an allowance. A panel that offered only the redeem would
           send the device a transaction that reverts. */
        const approveShares = el("button", "leekdefi-button-quiet", "Approve shares");
        approveShares.type = "button";
        const redeem = el("button", "leekdefi-button-quiet", "Redeem shares");
        redeem.type = "button";
        actions.append(approve, buy);
        trade.append(actions);

        /* Its own field, in the unit it is actually denominated in.
           Redeeming used to read the amount field the buy uses, which means
           MUSD, and the only thing separating the two meanings was a sentence
           asking the reader to remember. It refused an empty field with
           "Enter an amount of MUSD greater than zero" while wanting shares. */
        const redeemField = labelledInput(
          `${first.symbol} shares to redeem`,
          "0.00",
          `You hold ${first.shares === null ? "an unreadable number of" : formatWad(first.shares)} ${first.symbol}.`,
        );
        const redeemInput = redeemField.input;
        trade.append(redeemField.wrap);
        const redeemActions = el("div", "leekdefi-actions");
        redeemActions.append(approveShares, redeem);
        trade.append(redeemActions);
        trade.append(
          el(
            "div",
            "leekdefi-note",
            "Approve the shares before redeeming — the vault burns them from " +
              "you, which spends an allowance.",
          ),
        );

        if (proposeAndRefresh === undefined) {
          /* Absence of propose is a real state, not a legacy allowance: no
             device is connected, or this is a harness. Said rather than
             pretended. */
          approve.disabled = true;
          buy.disabled = true;
          approveShares.disabled = true;
          redeem.disabled = true;
          trade.append(
            el(
              "div",
              "leekdefi-note",
              "No device is connected, so nothing can be signed. Connect one to buy or redeem.",
            ),
          );
        } else {
          const propose = proposeAndRefresh;
          const amountOrComplain = (): bigint | null => {
            const amount = parseWad(input.value);
            if (amount === null) say("Enter an amount of MUSD greater than zero.");
            return amount;
          };
          /* Shares, not MUSD, and it says so when it refuses. */
          const sharesOrComplain = (): bigint | null => {
            const shares = parseWad(redeemInput.value);
            if (shares === null) say(`Enter a number of ${first.symbol} shares greater than zero.`);
            return shares;
          };

          /* Both approvals read the same field, because the field means MUSD
             for a buy and shares for a redeem. Each is judged against its own
             allowance. */
          trade.append(armApproval(approve, input, first.allowance, "MUSD"));
          trade.append(armApproval(approveShares, redeemInput, first.shareAllowance, first.symbol));

          approve.addEventListener("click", () => {
            const amount = amountOrComplain();
            if (amount === null) return;
            /* armApproval disables the button, but a disabled button is a UI
               state and this is the guard. Both exist on purpose: the device
               must not be asked to draw an approval that changes nothing. */
            if (first.allowance !== null && first.allowance >= amount) {
              say(`${formatWad(first.allowance)} MUSD is already approved, which covers that.`);
              return;
            }
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
            /* An allowance is permission, not money. Checking only the
               allowance let a buy past with an empty balance. */
            if (state.musd !== null && state.musd < amount) {
              say(`You hold ${formatWad(state.musd, 2)} MUSD, less than that.`);
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

          approveShares.addEventListener("click", () => {
            const amount = sharesOrComplain();
            if (amount === null) return;
            if (first.share === null) {
              say("The vault did not name its share token, so nothing can be approved.");
              return;
            }
            void (async () => {
              const outcome = await propose({
                kind: "call",
                to: first.share as string,
                data: encode.approve(first.vault, amount),
                reason: `Allow the ${first.symbol} vault to burn ${formatWad(amount)} shares`,
              });
              say(describeOutcome(outcome, "Share approval sent"));
            })();
          });

          redeem.addEventListener("click", () => {
            const amount = sharesOrComplain();
            if (amount === null) return;
            if (first.price === null) {
              say("The vault cannot price a share right now, so a redeem would revert.");
              return;
            }
            if (first.shares !== null && first.shares < amount) {
              say(`You hold ${formatWad(first.shares)} shares, fewer than that.`);
              return;
            }
            if (first.shareAllowance !== null && first.shareAllowance < amount) {
              say("Approve the shares first — the vault burns them from you.");
              return;
            }
            /* Redemption reverts when reserves are short rather than paying
               part of it, so the panel says so before a signature is spent
               on a transaction that cannot succeed. See H-1. */
            const gross = (amount * first.price) / WAD;
            if (first.reserves !== null && gross > first.reserves) {
              say(
                `The vault holds ${formatWad(first.reserves, 2)} MUSD and that redeem ` +
                  `needs ${formatWad(gross, 2)}. It reverts rather than paying part. See H-1.`,
              );
              return;
            }
            const feeBps = BigInt(first.effectiveFeeBps ?? first.baseFeeBps ?? 50);
            const net = (gross * (10_000n - feeBps)) / 10_000n;
            const minMusd = (net * 99n) / 100n;
            void (async () => {
              const outcome = await propose({
                kind: "call",
                to: first.vault,
                data: encode.redeem(amount, minMusd),
                reason: `Redeem ${formatWad(amount)} ${first.symbol} for at least ${formatWad(minMusd)} MUSD`,
              });
              say(describeOutcome(outcome, "Redeem sent"));
            })();
          });
        }
        body.append(trade);
      }
      body.append(position);

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
      staking.append(
        row(
          "Your MEZO",
          s.yourMezo === null ? null : formatWad(s.yourMezo),
          "available to stake",
        ),
      );

      if (proposeAndRefresh === undefined) {
        staking.append(el("div", "leekdefi-note", "No device is connected, so nothing can be signed."));
      } else {
        const proposeStake = proposeAndRefresh;
        const stakeField = labelledInput(
          "MEZO to stake or unstake",
          "1.0",
          "Tiers are 1, 10 and 50 MEZO for 10%, 25% and 50% off the fee. The " +
            "discount needs the position HELD for the cooldown, which is what " +
            "stops it being rented for a single transaction.",
        );
        staking.append(stakeField.wrap);

        const stakeActions = el("div", "leekdefi-actions");
        const approveMezo = el("button", "leekdefi-button", "Approve MEZO");
        approveMezo.type = "button";
        const stakeBtn = el("button", "leekdefi-button", "Stake");
        stakeBtn.type = "button";
        const unstakeBtn = el("button", "leekdefi-button-quiet", "Unstake");
        unstakeBtn.type = "button";
        stakeActions.append(approveMezo, stakeBtn, unstakeBtn);
        staking.append(stakeActions);

        const mezoAmount = (): bigint | null => {
          const amount = parseWad(stakeField.input.value);
          if (amount === null) say("Enter an amount of MEZO greater than zero.");
          return amount;
        };

        staking.append(armApproval(approveMezo, stakeField.input, s.mezoAllowance, "MEZO"));

        approveMezo.addEventListener("click", () => {
          const amount = mezoAmount();
          if (amount === null) return;
          if (s.mezoAllowance !== null && s.mezoAllowance >= amount) {
            say(`${formatWad(s.mezoAllowance)} MEZO is already approved, which covers that. Press Stake.`);
            return;
          }
          void (async () => {
            const outcome = await proposeStake({
              kind: "call",
              to: MEZO,
              data: encode.approve(STAKING, amount),
              reason: `Allow staking to take ${formatWad(amount)} MEZO`,
            });
            say(describeOutcome(outcome, "MEZO approval sent"));
          })();
        });

        stakeBtn.addEventListener("click", () => {
          const amount = mezoAmount();
          if (amount === null) return;
          if (s.yourMezo !== null && s.yourMezo < amount) {
            say(`You hold ${formatWad(s.yourMezo)} MEZO, fewer than that.`);
            return;
          }
          if (s.mezoAllowance !== null && s.mezoAllowance < amount) {
            say("Approve the MEZO first — staking cannot take it otherwise.");
            return;
          }
          void (async () => {
            const outcome = await proposeStake({
              kind: "call",
              to: STAKING,
              data: encode.stake(amount),
              reason: `Stake ${formatWad(amount)} MEZO for a fee discount`,
            });
            say(describeOutcome(outcome, "Stake sent"));
          })();
        });

        unstakeBtn.addEventListener("click", () => {
          const amount = mezoAmount();
          if (amount === null) return;
          if (s.yourStake !== null && s.yourStake < amount) {
            say(
              s.yourStake === 0n
                ? "You have nothing staked."
                : `You have ${formatWad(s.yourStake)} MEZO staked, less than that.`,
            );
            return;
          }
          /* Unstaking is refused during the cooldown by the contract. Said
             here first, with the time remaining, rather than spending a
             signature to be told. */
          if (cooling > 0n) {
            say(
              `Staking is still cooling for ${Math.ceil(Number(cooling) / 60)} min. ` +
                "Unstaking reverts until then.",
            );
            return;
          }
          void (async () => {
            const outcome = await proposeStake({
              kind: "call",
              to: STAKING,
              data: encode.unstake(amount),
              reason: `Unstake ${formatWad(amount)} MEZO`,
            });
            say(describeOutcome(outcome, "Unstake sent"));
          })();
        });
      }
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
