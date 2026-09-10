/**
 * Funding risk: whether a leg's real wallet balance and ERC-20 allowance can
 * still cover what it is virtually committed to.
 *
 * ---------------------------------------------------------------------------
 * Why this exists — quoting the Aqua whitepaper (v1.0)
 *
 * §3: "pull() decreases virtual balances and transfers tokens ... [if] wallet
 * balances fall below virtual commitments, strategies cannot execute ... pull()
 * operations will revert." And, the sentence this whole file is for:
 * **"the AMM continues quoting prices based solely on virtual balances without
 * checking real balances or allowances"** — a position can look alive on
 * screen and in the registry while every trade against it fails on chain.
 *
 * §6.2: "Illiquidity as temporary friction. When wallet balances fall below
 * virtual commitments, strategies cannot execute trades ... Makers can
 * instantly resolve this by docking underperforming strategies or rebalancing
 * their portfolio."
 *
 * §6.3, Operational best practices: **"Set ERC-20 approvals aligned with
 * active strategy needs"** and **"Monitor virtual versus real balance ratios
 * for optimal capital efficiency"**.
 *
 * The protocol says outright that it will not do this checking for the maker
 * — quoting continues regardless, and docking an underfunded strategy is
 * described as the maker's job, not the contract's. So the wallet does it:
 * this file is the "monitor virtual versus real balance ratios" the
 * whitepaper recommends, applied automatically instead of by hand.
 *
 * ---------------------------------------------------------------------------
 * What "funding" means here, and what it does not
 *
 * A leg's virtual amount (`positions.ts`'s `LegReading.amount`, `state:
 * "active"` only — a docked or absent leg has nothing committed and is
 * trivially funded) is checked against two independent real-world ceilings:
 * the maker's ERC-20 `balanceOf` and the maker's `allowance` to
 * `AQUA_REGISTRY`, the same registry `Aqua.pull()` calls `transferFrom`
 * through (registry.ts's header explains why the registry, not the app, is
 * the spender). Either one falling short of the virtual amount means the
 * strategy cannot execute — `pull()` reverts either way — but the remedy
 * differs, so they are reported as two distinct states rather than one
 * generic "broken".
 *
 * A failed read is never treated as sufficient funding. Following
 * `LegReading`'s own rule (positions.ts) and multicall.ts's rule at length: a
 * `success: false` word is not a `0`, and here it is doubly not a "this is
 * fine" — telling a maker their strategy is funded because a balance call
 * reverted is worse than telling them nothing.
 */

import { fetchAllowances, type AllowanceResult } from "@leekwallet/core/allowances.ts";
import type { EthRequest } from "@leekwallet/core/balances.ts";
import { fetchTokenBalancesBatched, type TokenBalanceResult } from "@leekwallet/core/multicall.ts";
import { AQUA_REGISTRY } from "./registry.ts";
import type { PositionReading } from "./positions.ts";

/**
 * The four things a leg's funding can be, all named.
 *
 * `funded` and `unknown` are kept as separate members for the same reason
 * `LegReading.ok` is a union rather than a boolean default: there is no code
 * path below that can produce `funded` from a read that failed.
 */
export type FundingState =
  /** Real balance and allowance both cover the virtual amount. */
  | "funded"
  /** Real balance is below the virtual amount. `pull()` will revert. */
  | "underfunded-balance"
  /** Balance is enough; the allowance to the registry is not. */
  | "underfunded-allowance"
  /** The balance read, the allowance read, or both, did not answer. */
  | "unknown";

export interface LegFunding {
  token: string;
  state: FundingState;
}

export interface PositionFunding {
  app: string;
  strategyHash: string;
  /** One entry per leg, same order as the `PositionReading` it was built from. */
  legs: LegFunding[];
}

/**
 * A leg the registry read failed for has no known virtual amount, so its
 * funding cannot be judged either — `unknown`, never `funded` by default. A
 * docked or absent leg, by contrast, is known to commit nothing and is
 * trivially `funded`.
 */
function fundingOfNonActiveLeg(token: string, ok: boolean): LegFunding {
  return { token, state: ok ? "funded" : "unknown" };
}

function fundingOfActiveLeg(
  token: string,
  committed: bigint,
  balance: TokenBalanceResult | undefined,
  allowance: AllowanceResult | undefined,
): LegFunding {
  if (!balance || !balance.ok || !allowance || !allowance.ok) {
    return { token, state: "unknown" };
  }
  // Checked in this order because a balance shortfall is the more binding
  // constraint — no allowance, however large, moves a token the wallet does
  // not hold — and because it names the whitepaper's own first-listed remedy
  // ("docking or rebalancing") before its second ("raise the approval").
  if (balance.raw < committed) return { token, state: "underfunded-balance" };
  if (allowance.amount < committed) return { token, state: "underfunded-allowance" };
  return { token, state: "funded" };
}

/**
 * Read the funding state of every active leg across a maker's positions.
 *
 * Batched the way `readPositions` and `fetchAllowances` already are: one
 * `fetchTokenBalancesBatched` call and one `fetchAllowances` call for the
 * *distinct* tokens behind active legs, not one request per leg — reusing
 * core's existing multicall plumbing rather than re-encoding `aggregate3`
 * here. Both calls carry `allowFailure: true` internally (multicall.ts's
 * header), so one bad token cannot sink the read for the rest.
 *
 * One reading per (position, token) leg, in the order given, always — the
 * same contract `readPositions` promises, so a caller can zip this against
 * `positions` without re-checking lengths. Nothing here touches
 * `readPositions` or its ordering.
 */
export async function readFunding(
  request: EthRequest,
  chainId: number,
  maker: string,
  positions: readonly PositionReading[],
): Promise<PositionFunding[]> {
  const tokens: string[] = [];
  for (const position of positions) {
    for (const leg of position.legs) {
      if (leg.ok && leg.state === "active" && !tokens.includes(leg.token)) tokens.push(leg.token);
    }
  }

  const balances = tokens.length === 0
    ? []
    : await fetchTokenBalancesBatched(request, chainId, maker, tokens);
  const allowances = tokens.length === 0
    ? []
    : await fetchAllowances(
        request, chainId, maker,
        tokens.map((token) => ({ token, spender: AQUA_REGISTRY, via: "erc20" as const })),
      );

  const balanceByToken = new Map(tokens.map((token, i) => [token, balances[i]]));
  const allowanceByToken = new Map(tokens.map((token, i) => [token, allowances[i]]));

  /* Sum every active leg's virtual amount per token, across ALL positions.
   *
   * This is the whole reason the check is not per-leg. Shared liquidity is
   * Aqua's central claim — whitepaper §4.1, "the same wallet equity to back
   * multiple strategies simultaneously" — so one wallet balance routinely
   * backs several commitments at once. Comparing a single leg against the
   * full balance would call two 100-USDC commitments "funded" against a
   * 150-USDC wallet, when only one of them can actually pull. The maker
   * would be over-committed and told they were fine, on exactly the risk the
   * protocol's design creates.
   *
   * So every leg of an over-committed token reads as underfunded. That is not
   * over-reporting: which leg wins the race is decided by whoever trades
   * first, so no individual leg can honestly be called safe. */
  const committedByToken = new Map<string, bigint>();
  for (const position of positions) {
    for (const leg of position.legs) {
      if (!leg.ok || leg.state !== "active") continue;
      committedByToken.set(leg.token, (committedByToken.get(leg.token) ?? 0n) + leg.amount);
    }
  }

  return positions.map((position) => ({
    app: position.app,
    strategyHash: position.strategyHash,
    legs: position.legs.map((leg): LegFunding => {
      if (!leg.ok || leg.state !== "active") return fundingOfNonActiveLeg(leg.token, leg.ok);
      return fundingOfActiveLeg(
        leg.token,
        committedByToken.get(leg.token) ?? leg.amount,
        balanceByToken.get(leg.token),
        allowanceByToken.get(leg.token),
      );
    }),
  }));
}

/**
 * The sentence that must accompany any funding state.
 *
 * Names both whitepaper remedies in the maker's own words — dock or
 * rebalance for a balance shortfall (§6.2), raise the approval for an
 * allowance shortfall (§6.3) — because the protocol has already said it will
 * not act on either for them: "Aqua doesn't automatically pause illiquid
 * positions."
 */
export const FUNDING_NOTICE =
  "Aqua quotes prices from your virtual balances alone and does not check " +
  "your real wallet balance or allowance before doing so, and it does not " +
  "pause an underfunded strategy on its own. A strategy shown underfunded " +
  "here will revert instead of executing. Fix it by docking or rebalancing " +
  "the strategy if the wallet balance fell short, or by raising the ERC-20 " +
  "approval to the Aqua registry if only the allowance did.";
