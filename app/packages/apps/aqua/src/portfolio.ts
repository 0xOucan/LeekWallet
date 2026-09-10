/**
 * The whole read: positions, and the approval that decides what they can cost.
 *
 * ---------------------------------------------------------------------------
 * The thing this app exists to say
 *
 * Aqua never takes custody. Tokens sit in the maker's wallet and are moved at
 * execution by `Aqua.pull()`, which is an ordinary `transferFrom` against the
 * maker's ERC-20 allowance **to the registry**. So the virtual balance is a
 * ceiling the app agreed to; the allowance is the ceiling the *token* enforces.
 * Real exposure is the smaller of them per token, and it is:
 *
 *     exposure = allowance × shipped strategies
 *
 * An unlimited approval and one small strategy is unlimited exposure, because
 * nothing but the registry's own bookkeeping stands between the two, and that
 * bookkeeping is per-strategy while the approval is not. A view that showed the
 * strategy and not the approval would be showing the number that cannot hurt
 * you and hiding the one that can. That is why `TokenExposure` is a first-class
 * part of this result and not a field hanging off a position.
 *
 * ---------------------------------------------------------------------------
 * Zero is not the same as "we could not look"
 *
 * Every number in here arrives inside a union that distinguishes them, from
 * three separate layers: `Discovery` (the log scan happened or it did not),
 * `LegReading` (the registry answered, or it did not, or it said absent /
 * docked), and `AllowanceResult` from core (the token answered, or it did not).
 * Nothing in this file collapses any of those to `0n`, and `portfolioSummary`
 * below refuses to state a total when any part of it is unknown. An LP who
 * reads "0" and believes their liquidity is gone does something expensive and
 * irreversible; an LP who reads "unavailable" refreshes.
 */

import {
  fetchAllowances, isUnlimited, type AllowanceResult,
} from "@leekwallet/core/allowances.ts";
import type { EthRequest } from "@leekwallet/core/balances.ts";
import { AQUA_REGISTRY, isAquaChain } from "./registry.ts";
import {
  discoverPositions, readPositions, type Discovery, type PositionReading, type ScanOptions,
} from "./positions.ts";
import { readFunding, type PositionFunding } from "./funding.ts";

/**
 * A token's real exposure to Aqua on one chain.
 *
 * `allowance` is core's union verbatim rather than a number, so a token that
 * did not answer cannot reach a renderer as a figure. `committed` is the sum of
 * the *active* virtual balances across this maker's positions in that token,
 * and `committedComplete` says whether every leg that fed it was actually read
 * — a sum with a hole in it is not a sum, and a renderer must be able to tell.
 */
export interface TokenExposure {
  token: string;
  allowance: AllowanceResult;
  committed: bigint;
  committedComplete: boolean;
  /** Legs in this token whose registry slot could not be read. */
  unreadableLegs: number;
}

export interface Portfolio {
  chainId: number;
  maker: string;
  /** The log scan. `ok: false` here means the position list below is not one. */
  discovery: Discovery;
  /** Empty when discovery failed — read `discovery.ok` before rendering it. */
  positions: PositionReading[];
  /** One per distinct token across all positions. The headline figures. */
  exposures: TokenExposure[];
  /**
   * One entry per position, same order as `positions`, each carrying one
   * `FundingState` per leg in the same order as that position's legs. See
   * funding.ts's header for why the protocol itself does not compute this.
   */
  funding: PositionFunding[];
}

/**
 * Read everything for one maker on one chain.
 *
 * The allowance query is the union of tokens the scan found, so a failed scan
 * means no allowance is read either. That is intentional and it is the honest
 * shape: with no position list there is nothing to be exposed *through*, and
 * inventing a token set to ask about would produce a confident "no exposure"
 * from a state where nothing was known.
 */
export async function fetchPortfolio(
  request: EthRequest,
  chainId: number,
  maker: string,
  options: ScanOptions = {},
): Promise<Portfolio> {
  if (!isAquaChain(chainId)) throw new Error(`Aqua is not deployed on chain ${chainId}`);

  const discovery = await discoverPositions(request, maker, options);
  if (!discovery.ok) return { chainId, maker, discovery, positions: [], exposures: [], funding: [] };

  const positions = await readPositions(request, chainId, maker, discovery.positions);

  const tokens: string[] = [];
  for (const position of positions) {
    for (const leg of position.legs) {
      if (!tokens.includes(leg.token)) tokens.push(leg.token);
    }
  }

  /* One spender: the registry. Permit2 is not asked about — `Aqua.pull` calls
   * `safeTransferFrom` on the token directly, so a Permit2 allowance is not a
   * path Aqua can use and listing it here would suggest an exposure that does
   * not exist. */
  const allowances = tokens.length === 0
    ? []
    : await fetchAllowances(
        request, chainId, maker,
        tokens.map((token) => ({ token, spender: AQUA_REGISTRY, via: "erc20" as const })),
      );

  const exposures: TokenExposure[] = tokens.map((token, i) => {
    let committed = 0n;
    let unreadableLegs = 0;
    for (const position of positions) {
      for (const leg of position.legs) {
        if (leg.token !== token) continue;
        if (!leg.ok) { unreadableLegs++; continue; }
        /* "absent" and "docked" contribute nothing because nothing can be
         * pulled from them — but they are not failures, so they do not make
         * the sum incomplete. */
        if (leg.state === "active") committed += leg.amount;
      }
    }
    return {
      token,
      allowance: allowances[i] as AllowanceResult,
      committed,
      committedComplete: unreadableLegs === 0,
      unreadableLegs,
    };
  });

  // Read last, and independently of the exposure computation above: funding
  // needs only `positions`, and reads it in its own batched calls rather than
  // reusing `allowances` — that allowance was queried against the *sum* of
  // committed legs, while funding.ts compares each leg's own amount.
  const funding = await readFunding(request, chainId, maker, positions);

  return { chainId, maker, discovery, positions, exposures, funding };
}

/* ------------------------------------------------------------- the verdict */

/**
 * What a token's approval means, as one of four things a person can act on.
 *
 * Not a number and not a boolean: the interesting cases are "unlimited" and
 * "unknown", and both would be lost by returning an amount.
 */
export type ExposureVerdict =
  /** Approval at or beyond half a uint256 — the drainer's pattern. */
  | { kind: "unlimited" }
  /** A real cap. `headroom` is what could still be pulled beyond `committed`. */
  | { kind: "capped"; allowance: bigint; headroom: bigint }
  /** Approval is zero: nothing can be pulled, whatever the registry says. */
  | { kind: "none" }
  /** The token did not answer. Says nothing about whether exposure exists. */
  | { kind: "unknown"; reason: string };

export function verdictFor(exposure: TokenExposure): ExposureVerdict {
  const allowance = exposure.allowance;
  if (!allowance || !allowance.ok) {
    return { kind: "unknown", reason: allowance ? allowance.reason : "not-queried" };
  }
  if (isUnlimited(allowance.amount, 256)) return { kind: "unlimited" };
  if (allowance.amount === 0n) return { kind: "none" };
  /* Headroom can exceed `committed` — an approval is not bounded by what has
   * been shipped, which is the point. It is clamped at zero rather than going
   * negative, because "less approved than committed" is not extra safety to
   * report, it just means a pull would revert. */
  const headroom = allowance.amount > exposure.committed
    ? allowance.amount - exposure.committed
    : 0n;
  return { kind: "capped", allowance: allowance.amount, headroom };
}

/**
 * The single sentence at the top of the screen.
 *
 * Ordered by what a maker should act on first: an unreadable state outranks a
 * dangerous one, because "we do not know" must never be quietly downgraded to
 * "you are fine".
 */
export type PortfolioSummary =
  | { kind: "unavailable"; reason: string }
  | { kind: "empty" }
  | { kind: "partial"; positions: number; unknownTokens: number }
  | { kind: "unlimited-approval"; tokens: string[] }
  | { kind: "ok"; positions: number };

export function portfolioSummary(portfolio: Portfolio): PortfolioSummary {
  if (!portfolio.discovery.ok) {
    return { kind: "unavailable", reason: portfolio.discovery.reason };
  }
  if (portfolio.positions.length === 0) return { kind: "empty" };

  const verdicts = portfolio.exposures.map((e) => [e, verdictFor(e)] as const);
  const unknown = verdicts.filter(([, v]) => v.kind === "unknown");
  const incomplete = portfolio.exposures.filter((e) => !e.committedComplete);
  if (unknown.length > 0 || incomplete.length > 0) {
    return {
      kind: "partial",
      positions: portfolio.positions.length,
      unknownTokens: new Set([
        ...unknown.map(([e]) => e.token), ...incomplete.map((e) => e.token),
      ]).size,
    };
  }

  const unlimited = verdicts.filter(([, v]) => v.kind === "unlimited").map(([e]) => e.token);
  if (unlimited.length > 0) return { kind: "unlimited-approval", tokens: unlimited };

  return { kind: "ok", positions: portfolio.positions.length };
}

/**
 * The sentence that must accompany any exposure figure.
 *
 * The approval-times-strategies point, in the words a maker needs rather than
 * in the words the protocol uses.
 */
export const EXPOSURE_NOTICE =
  "Aqua does not hold your tokens. It pulls them from your wallet when a swap " +
  "executes, using your ERC-20 approval to the Aqua registry. The approval is " +
  "therefore the real limit on what can leave, and it applies across every " +
  "strategy at once — a strategy's own balance does not cap it. An unlimited " +
  "approval means unlimited exposure no matter how small the position looks.";
