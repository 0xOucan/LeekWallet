/**
 * Deploying a position: a capped approval per token, then one `ship`.
 *
 * Pure. No network, no clock, no DOM, no `propose`. Everything this file needs
 * to know about the chain — the current allowance per token — is passed in, and
 * everything it produces is calldata plus the sentences that must accompany it.
 * `run.ts` is what walks the result past the user and the device.
 *
 * ---------------------------------------------------------------------------
 * The two refusals, and why they are refusals
 *
 * **An unlimited approval is refused.** Not offered with a warning, not behind
 * a confirmation. Aqua pulls from the maker's wallet at execution, so the
 * allowance is the real ceiling on what can leave and it applies across every
 * strategy at once — `portfolio.ts` says this at length and the arithmetic is
 * `exposure = allowance × shipped strategies`. An unlimited allowance plus one
 * small position is unlimited exposure. There is no amount a user could be
 * shipping that makes "and also everything else, forever" the right cap, so
 * this app never encodes one.
 *
 * **A strategy naming another maker is refused.** strategy.ts carries the
 * reasoning; the short version is that the hash cannot distinguish the two
 * cases, so the struct has to be decoded, and neither an attack nor a mistake
 * should reach a signature.
 *
 * Both refusals are values, not exceptions. A caller has to look at `ok`
 * before it can reach a step, and the sentence to show is in the refusal.
 *
 * ---------------------------------------------------------------------------
 * Why the cap is exactly the amount, here of all places
 *
 * approval-cap.ts's `DAPP_UNAWARE_NOTICE` advises approving a little above what
 * you mean to spend, because a dapp working from its own reading of the
 * allowance may refuse to submit against one exactly equal to the amount. That
 * advice is for a dapp this wallet does not control. Here the wallet IS the
 * dapp: it builds the ship in the same plan, from the same figures, and there
 * is no frontend with a stale reading to accommodate. So the cap is the amount,
 * and the honest headroom is zero.
 */

import { isUnlimited } from "@leekwallet/core/allowances.ts";
import { AbiError } from "@leekwallet/core/balances.ts";
import {
  APPROVAL_EDIT_NOTICE, capAmountText, planCap, type ApprovalCall,
} from "@leekwallet/core/approval-cap.ts";
import { AQUA_MAX_LEGS, AQUA_REGISTRY, encodeShip } from "./registry.ts";
import {
  UNREADABLE_STRATEGY_NOTICE, WRONG_MAKER_NOTICE, checkMaker,
  type StrategyRefusal,
} from "./strategy.ts";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

/** One token this position will be credited with, and what is known about it. */
export interface DeployLeg {
  token: string;
  /** Raw units, as the strategy will be credited. */
  amount: bigint;
  /**
   * The allowance this token currently grants the registry, or undefined when
   * nobody could read it.
   *
   * Undefined is deliberately not treated as zero — see planCap. Assuming zero
   * is what produces the silent revert on USDT-style tokens, and the plan says
   * so in words rather than guessing.
   */
  allowance?: bigint;
  /** From the token list, never from the contract. Labels only. */
  decimals?: number;
  symbol?: string;
}

export interface DeployRequest {
  /** The address the shell is showing. The app does not choose this. */
  maker: string;
  /** The Aqua app whose strategy this is. */
  app: string;
  /** The strategy bytes, exactly as they will be hashed and shipped. */
  strategy: string;
  legs: readonly DeployLeg[];
}

/** What stopped a plan being built. Every one is a refusal to sign. */
export type DeployRefusal =
  | { kind: "wrong-maker"; named: string; expected: string; notice: string }
  | { kind: "unreadable-strategy"; refusal: StrategyRefusal; notice: string }
  | { kind: "unlimited-cap"; token: string; notice: string }
  | { kind: "nothing-to-ship"; notice: string }
  | { kind: "too-many-legs"; legs: number; notice: string };

/** One transaction, already encoded, with this app's own words for it. */
export interface DeployStep {
  /** What this step is for, so a half-run sequence can be described exactly. */
  role: "approve" | "ship" | "dock";
  /** The token being approved. Absent on the ship step. */
  token?: string;
  to: string;
  data: string;
  /** One line, the app's own. Never dapp-authored: this app is the dapp. */
  label: string;
  /**
   * For an approval: what the allowance is set to. Carried so the half-failure
   * report can name the exact figure left standing rather than re-deriving it
   * from calldata somebody would have to decode again.
   */
  amount?: bigint;
}

export interface DeployPlan {
  ok: true;
  /** In order. An approval that fails stops the rest — see run.ts. */
  steps: DeployStep[];
  /** The hash the position will be filed under, and what the device will show. */
  strategyHash: string;
  /** Everything the UI must say, in order. */
  notices: string[];
}

export type DeployResult = DeployPlan | { ok: false; refusal: DeployRefusal };

/** Said above every approve screen this app produces. */
export const CAP_MEANING_NOTICE =
  "This approval is the real limit on what Aqua can take from this wallet. " +
  "Aqua does not hold your tokens: it pulls them from here when a swap " +
  "executes, and the allowance applies across every strategy you have shipped, " +
  "not just this one. The cap below is the amount this position is being " +
  "credited with — so once it is spent, nothing more can be pulled until you " +
  "approve again. It is never unlimited.";

/** Said above the ship screen. */
export const SHIP_MEANING_NOTICE =
  "Shipping does not move any tokens. It tells Aqua that this strategy may be " +
  "filled from this wallet, up to the amounts below and up to the approval " +
  "above, whichever is smaller. Changing a shipped strategy is not an edit: it " +
  "is dock, then ship again, and both are separate signatures.";

/**
 * Build the plan, or refuse.
 *
 * Order is approvals first, ship last, and that is the only order that has a
 * safe failure. Shipping first would leave a strategy Aqua believes it can
 * fill and no allowance to fill it from — every swap against it reverts at the
 * taker's expense, and the position looks live in every view. Approving first
 * leaves an allowance with no position, which is the failure run.ts reports in
 * words and the user can revoke in one more signature. Neither is good; only
 * one of them is recoverable by the person who caused it.
 */
export function planDeployment(request: DeployRequest): DeployResult {
  if (!HEX40.test(request.maker)) throw new AbiError("maker is not a 20-byte address");
  if (!HEX40.test(request.app)) throw new AbiError("app is not a 20-byte address");

  if (request.legs.length === 0) {
    return {
      ok: false,
      refusal: {
        kind: "nothing-to-ship",
        notice: "A strategy with no tokens provides nothing and cannot be shipped.",
      },
    };
  }
  if (request.legs.length > AQUA_MAX_LEGS) {
    return {
      ok: false,
      refusal: {
        kind: "too-many-legs",
        legs: request.legs.length,
        notice:
          `This strategy has ${request.legs.length} tokens. The device draws one ` +
          `confirmation page per token and will not summarise past ` +
          `${AQUA_MAX_LEGS}, so a strategy this size cannot be shown in full and ` +
          `is refused rather than partly displayed.`,
      },
    };
  }

  /* The maker check comes before anything is encoded. A plan half-built for a
   * strategy that will be refused is a plan somebody can be tempted to use. */
  const maker = checkMaker(request.strategy, request.maker);
  if (!maker.ok) {
    return maker.reason === "wrong-maker"
      ? {
          ok: false,
          refusal: {
            kind: "wrong-maker",
            named: maker.named,
            expected: maker.expected,
            notice: WRONG_MAKER_NOTICE,
          },
        }
      : {
          ok: false,
          refusal: {
            kind: "unreadable-strategy",
            refusal: maker.refusal,
            notice: UNREADABLE_STRATEGY_NOTICE,
          },
        };
  }

  const steps: DeployStep[] = [];
  const notices: string[] = [CAP_MEANING_NOTICE];

  for (const leg of request.legs) {
    if (!HEX40.test(leg.token)) throw new AbiError("a leg's token is not an address");
    if (leg.amount <= 0n) {
      return {
        ok: false,
        refusal: {
          kind: "nothing-to-ship",
          notice:
            "A leg with no amount would approve nothing and credit nothing. " +
            "Remove the token or give it an amount.",
        },
      };
    }
    /* The cap is the amount, so this cannot fire from anything this app builds.
     * It fires when a caller hands in an amount that is itself an infinity —
     * a strategy built elsewhere, a figure pasted from a dapp — and that is
     * precisely the case worth refusing rather than approving because our own
     * arithmetic happened to produce it. */
    if (isUnlimited(leg.amount, 256)) {
      return {
        ok: false,
        refusal: {
          kind: "unlimited-cap",
          token: leg.token,
          notice:
            "This leg's amount is an unlimited allowance wearing an amount's " +
            "clothes. Aqua pulls from this wallet, so approving it would put " +
            "every one of these tokens behind one strategy, forever. This app " +
            "will not encode an unlimited approval.",
        },
      };
    }

    const call: ApprovalCall = {
      standard: "erc20",
      token: leg.token.toLowerCase(),
      spender: AQUA_REGISTRY,
      /* What the dapp asked for is what we are asking for: this app is the
       * dapp. The field exists for the dapp-facing path and is filled in
       * honestly rather than left at zero. */
      amount: leg.amount,
      unlimited: false,
      bits: 256,
    };
    const meta = {
      ...(leg.decimals !== undefined ? { decimals: leg.decimals } : {}),
      ...(leg.symbol !== undefined ? { symbol: leg.symbol } : {}),
    };
    const cap = planCap(call, leg.amount, leg.allowance, meta);

    for (const step of cap.steps) {
      steps.push({
        role: "approve",
        token: leg.token.toLowerCase(),
        to: leg.token.toLowerCase(),
        data: step.data,
        amount: step.amount,
        label: `${step.label} for the Aqua registry`,
      });
    }
    for (const notice of cap.notices) {
      /* The edit notice is about a dapp being told a smaller number than it
       * asked for. Nothing here asked for a larger one, so repeating it would
       * be describing a situation the user is not in. The rest — the
       * zero-first sequence, the unreadable allowance — are real here. */
      if (notice === APPROVAL_EDIT_NOTICE) continue;
      if (!notices.includes(notice)) notices.push(notice);
    }
  }

  steps.push({
    role: "ship",
    to: AQUA_REGISTRY,
    data: encodeShip(
      request.app,
      request.strategy,
      request.legs.map((l) => ({ token: l.token, amount: l.amount })),
    ),
    label:
      `ship a strategy to ${request.app} providing ` +
      request.legs
        .map((l) => capAmountText(l.amount, {
          ...(l.decimals !== undefined ? { decimals: l.decimals } : {}),
          ...(l.symbol !== undefined ? { symbol: l.symbol } : {}),
        }))
        .join(", "),
  });
  notices.push(SHIP_MEANING_NOTICE);

  return { ok: true, steps, strategyHash: maker.hash, notices };
}
