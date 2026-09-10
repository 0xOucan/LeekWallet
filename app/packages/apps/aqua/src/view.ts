/**
 * The portfolio as rows of text, and then as DOM.
 *
 * Split in two on purpose. `portfolioView()` is pure and returns strings and
 * tags; `renderPortfolio()` puts them in elements. The reason is that the
 * property this app must not get wrong — an unreadable value never rendering as
 * a number — is a property of the *text*, and a test that can only reach it
 * through a DOM is a test that needs a DOM to prove the thing that matters.
 * Here it is provable in node with no browser at all: see test/view.test.ts.
 *
 * Every displayed quantity carries a `tone`, and `unavailable` is a tone. There
 * is no code path that produces the string "0" from an absent answer; the
 * amount formatter takes a union, not a bigint, and has nothing to print when
 * the union says nobody answered.
 */

import { chainLabel, formatUnits, tokenHint, TOKEN_HINT_NOTICE } from "@leekwallet/core/chains.ts";
import { ALLOWANCE_NOTICE } from "@leekwallet/core/allowances.ts";
import { DISCOVERY_NOTICE, type LegReading } from "./positions.ts";
import {
  EXPOSURE_NOTICE, portfolioSummary, verdictFor,
  type Portfolio, type TokenExposure,
} from "./portfolio.ts";
import { AQUA_REGISTRY } from "./registry.ts";
import { FUNDING_NOTICE, type FundingState } from "./funding.ts";

/**
 * How a value should read, and therefore how it should look.
 *
 * `unavailable` and `zero` are separate members of this union and no function
 * below maps one to the other. That is the whole failure mode, stated as a
 * type so it cannot be fixed in one renderer and forgotten in the next.
 */
export type Tone = "normal" | "zero" | "docked" | "unavailable" | "danger";

export interface Field {
  label: string;
  value: string;
  tone: Tone;
  /** Shown smaller, under the value. The address behind a guessed symbol. */
  detail?: string;
}

export interface PositionRow {
  app: string;
  strategyHash: string;
  /** Present only when the `Shipped` log fell inside the scanned window. */
  strategyBytes?: string;
  legs: Field[];
  /**
   * One `Field` per leg, same order as `legs`, saying whether that leg's real
   * balance and allowance still cover what it is virtually committed to. See
   * funding.ts — the protocol will keep quoting prices against it regardless.
   */
  funding: Field[];
}

export interface ExposureRow {
  token: string;
  /** Advisory symbol, or the address. Never rendered without the address. */
  label: string;
  approval: Field;
  committed: Field;
  headroom: Field;
}

export interface PortfolioView {
  title: string;
  /** The one-line verdict. `tone` decides the banner. */
  headline: Field;
  scanned: string;
  exposures: ExposureRow[];
  positions: PositionRow[];
  notices: string[];
}

/* ---------------------------------------------------------------- amounts */

/** A guessed symbol, or the address itself. Never a symbol on its own. */
function tokenLabel(chainId: number, token: string): string {
  return tokenHint(chainId, token)?.symbol ?? token;
}

/**
 * Raw units rendered with a guessed `decimals`, or raw units when there is no
 * guess. The raw figure is the only one that came off the chain, so a token
 * this repo has no hint for reads as an integer rather than as a number scaled
 * by an assumption — chains.ts's TOKEN_HINT_NOTICE says the same thing.
 */
function amountText(chainId: number, token: string, raw: bigint): string {
  const hint = tokenHint(chainId, token);
  return hint
    ? `${formatUnits(raw, hint.decimals)} ${hint.symbol}`
    : `${raw} (raw units)`;
}

/** A leg's registry slot as a field. The four states, all named. */
function legField(chainId: number, leg: LegReading): Field {
  const label = tokenLabel(chainId, leg.token);
  const detail = tokenHint(chainId, leg.token) ? leg.token : undefined;
  const base = { label, ...(detail === undefined ? {} : { detail }) };
  if (!leg.ok) {
    /* The point of the whole app. No number, and a tone the view must not
     * style like a value. */
    return { ...base, value: "unavailable — the registry did not answer", tone: "unavailable" };
  }
  if (leg.state === "docked") {
    return { ...base, value: "docked — withdrawn by you", tone: "docked" };
  }
  if (leg.state === "absent") {
    return { ...base, value: "not in this strategy", tone: "zero" };
  }
  return {
    ...base,
    value: amountText(chainId, leg.token, leg.amount),
    tone: leg.amount === 0n ? "zero" : "normal",
  };
}

/**
 * A leg's funding state as a field. `funded` is silent on tone (normal), not
 * on text — a maker checking one leg among many should not have to guess
 * whether "normal" tone means "checked and fine" or "not checked at all".
 */
function fundingField(chainId: number, token: string, state: FundingState): Field {
  const label = tokenLabel(chainId, token);
  const detail = tokenHint(chainId, token) ? token : undefined;
  const base = { label: `Funding — ${label}`, ...(detail === undefined ? {} : { detail }) };
  switch (state) {
    case "funded":
      return { ...base, value: "funded — balance and allowance cover this strategy", tone: "normal" };
    case "underfunded-balance":
      return {
        ...base,
        value: "underfunded — wallet balance is below what this strategy is committed to; " +
          "pull() will revert until you dock or rebalance",
        tone: "danger",
      };
    case "underfunded-allowance":
      return {
        ...base,
        value: "underfunded — allowance to the Aqua registry is below this strategy's " +
          "commitment; raise the approval",
        tone: "danger",
      };
    case "unknown":
      return { ...base, value: "unavailable — balance or allowance did not answer", tone: "unavailable" };
  }
}

function exposureRow(chainId: number, exposure: TokenExposure): ExposureRow {
  const verdict = verdictFor(exposure);
  const label = tokenLabel(chainId, exposure.token);

  const approval: Field = verdict.kind === "unlimited"
    ? { label: "Approval to Aqua", value: "UNLIMITED — everything you hold can be pulled", tone: "danger" }
    : verdict.kind === "none"
      ? { label: "Approval to Aqua", value: "none — nothing can be pulled", tone: "zero" }
      : verdict.kind === "capped"
        ? {
            label: "Approval to Aqua",
            value: amountText(chainId, exposure.token, verdict.allowance),
            tone: "normal",
            detail: AQUA_REGISTRY,
          }
        : {
            label: "Approval to Aqua",
            value: "unavailable — the token did not answer",
            tone: "unavailable",
          };

  const committed: Field = exposure.committedComplete
    ? {
        label: "Committed to strategies",
        value: amountText(chainId, exposure.token, exposure.committed),
        tone: exposure.committed === 0n ? "zero" : "normal",
      }
    : {
        /* A sum missing a term is not a sum. Showing the partial figure with a
         * footnote would still put a number where the truth is "unknown". */
        label: "Committed to strategies",
        value: `unavailable — ${exposure.unreadableLegs} position(s) did not answer`,
        tone: "unavailable",
      };

  const headroom: Field = verdict.kind === "capped" && exposure.committedComplete
    ? {
        label: "Pullable beyond that",
        value: amountText(chainId, exposure.token, verdict.headroom),
        tone: verdict.headroom === 0n ? "zero" : "normal",
      }
    : verdict.kind === "unlimited"
      ? { label: "Pullable beyond that", value: "unbounded", tone: "danger" }
      : verdict.kind === "none"
        ? { label: "Pullable beyond that", value: "nothing", tone: "zero" }
        : { label: "Pullable beyond that", value: "unavailable", tone: "unavailable" };

  return { token: exposure.token, label, approval, committed, headroom };
}

const DISCOVERY_REASONS: Readonly<Record<string, string>> = {
  "head-unreadable": "the node would not say what block it is on",
  "logs-unavailable": "the log query failed",
  undecodable: "the logs did not decode as Aqua's",
  "range-too-large": "the block range asked for is too large to scan",
};

/**
 * The whole screen, as data.
 *
 * The order is the argument: the approval comes above the positions, because
 * the approval is the number that decides what the positions can cost.
 */
export function portfolioView(portfolio: Portfolio): PortfolioView {
  const chainId = portfolio.chainId;
  const summary = portfolioSummary(portfolio);

  const headline: Field = summary.kind === "unavailable"
    ? {
        label: "Portfolio",
        /* Never "no positions". We did not find out. */
        value: `Could not read your Aqua positions — ${DISCOVERY_REASONS[summary.reason] ?? summary.reason}. ` +
          "This is not the same as having none.",
        tone: "unavailable",
      }
    : summary.kind === "empty"
      ? {
          label: "Portfolio",
          value: "No Aqua positions found in the blocks scanned.",
          tone: "zero",
        }
      : summary.kind === "partial"
        ? {
            label: "Portfolio",
            value: `${summary.positions} position(s); ${summary.unknownTokens} token(s) could not be read. ` +
              "Treat the missing figures as unknown, not as zero.",
            tone: "unavailable",
          }
        : summary.kind === "unlimited-approval"
          ? {
              label: "Portfolio",
              value: `Unlimited approval to Aqua on ${summary.tokens.length} token(s). ` +
                "Your exposure is your whole balance, not the amount shipped.",
              tone: "danger",
            }
          : { label: "Portfolio", value: `${summary.positions} position(s).`, tone: "normal" };

  const window = portfolio.discovery.window;
  const scanned = window
    ? `Blocks ${window.fromBlock}–${window.toBlock}`
    : "No blocks were scanned";

  return {
    title: `Aqua · ${chainLabel(chainId)}`,
    headline,
    scanned,
    exposures: portfolio.exposures.map((e) => exposureRow(chainId, e)),
    positions: portfolio.positions.map((p, i) => {
      const funding = portfolio.funding[i];
      return {
        app: p.app,
        strategyHash: p.strategyHash,
        ...(p.strategy === undefined ? {} : { strategyBytes: p.strategy }),
        legs: p.legs.map((leg) => legField(chainId, leg)),
        // `funding[i]` lines up with `positions[i]` — `fetchPortfolio` builds
        // both from the same `positions` array in the same order. A missing
        // entry (should not happen) renders as nothing rather than guessing.
        funding: (funding?.legs ?? []).map((leg) => fundingField(chainId, leg.token, leg.state)),
      };
    }),
    notices: [EXPOSURE_NOTICE, DISCOVERY_NOTICE, ALLOWANCE_NOTICE, TOKEN_HINT_NOTICE, FUNDING_NOTICE],
  };
}

/* -------------------------------------------------------------------- DOM */

function fieldElement(field: Field): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `aqua-field aqua-tone-${field.tone}`;
  const label = document.createElement("span");
  label.className = "aqua-label";
  label.textContent = field.label;
  const value = document.createElement("span");
  value.className = "aqua-value";
  value.textContent = field.value;
  wrap.append(label, value);
  if (field.detail !== undefined) {
    const detail = document.createElement("code");
    detail.className = "aqua-detail";
    detail.textContent = field.detail;
    wrap.append(detail);
  }
  return wrap;
}

/**
 * Draw a view into an element, replacing whatever was there.
 *
 * `textContent` everywhere and no `innerHTML`: app addresses, strategy hashes
 * and strategy bytes all arrive from an unverified RPC operator and none of
 * them is markup.
 */
export function renderPortfolio(root: HTMLElement, view: PortfolioView): void {
  root.replaceChildren();
  root.classList.add("aqua-portfolio");

  const title = document.createElement("h2");
  title.textContent = view.title;
  root.append(title, fieldElement(view.headline));

  const scanned = document.createElement("p");
  scanned.className = "aqua-scanned";
  scanned.textContent = view.scanned;
  root.append(scanned);

  if (view.exposures.length > 0) {
    const heading = document.createElement("h3");
    heading.textContent = "What can be pulled from your wallet";
    root.append(heading);
    for (const exposure of view.exposures) {
      const section = document.createElement("section");
      section.className = "aqua-exposure";
      const name = document.createElement("h4");
      name.textContent = exposure.label;
      const address = document.createElement("code");
      address.className = "aqua-detail";
      address.textContent = exposure.token;
      section.append(name, address,
        fieldElement(exposure.approval), fieldElement(exposure.committed),
        fieldElement(exposure.headroom));
      root.append(section);
    }
  }

  if (view.positions.length > 0) {
    const heading = document.createElement("h3");
    heading.textContent = "Positions";
    root.append(heading);
    for (const position of view.positions) {
      const section = document.createElement("section");
      section.className = "aqua-position";
      for (const [label, value] of [
        ["App", position.app],
        ["Strategy hash", position.strategyHash],
        ["Strategy bytes", position.strategyBytes ?? "not in the scanned range"],
      ] as const) {
        section.append(fieldElement({
          label, value,
          tone: value === "not in the scanned range" ? "unavailable" : "normal",
        }));
      }
      for (const leg of position.legs) section.append(fieldElement(leg));
      for (const funding of position.funding) section.append(fieldElement(funding));
      root.append(section);
    }
  }

  const notices = document.createElement("div");
  notices.className = "aqua-notices";
  for (const text of view.notices) {
    const p = document.createElement("p");
    p.textContent = text;
    notices.append(p);
  }
  root.append(notices);
}
