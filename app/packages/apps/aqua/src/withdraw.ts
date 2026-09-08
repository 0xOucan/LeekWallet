/**
 * Docking a position, and the offer that has to follow it.
 *
 * Pure, like deploy.ts: calldata and sentences, no network and no `propose`.
 *
 * ---------------------------------------------------------------------------
 * Why revoking is a separate signature, and why it is offered rather than done
 *
 * `dock()` returns the virtual balances. It does not touch the ERC-20
 * allowance, because the allowance was never Aqua's to hold — it is a standing
 * permission on the token contract, granted to the registry, and it survives
 * every position it was granted for. So a maker who docks everything and walks
 * away is left with exactly the thing portfolio.ts calls the real exposure:
 * an allowance, with nothing on the other side of it. Upside gone, ceiling
 * unchanged.
 *
 * Hence the offer. It is an offer and not an automatic second step for two
 * reasons. It costs a signature and gas, which is the user's to spend; and a
 * maker who docks one strategy of three still needs the allowance for the
 * other two. `shouldOfferRevoke` is what encodes the difference, and it needs
 * to be told about every position in the token, not just the one being docked.
 *
 * A standing allowance is not offered for revocation on a guess. If any
 * position in that token could not be read, the offer is withheld and the
 * reason said out loud — "we could not look" is not "there is nothing left",
 * and this app's whole discipline is keeping those apart.
 */

import { AbiError } from "@leekwallet/core/balances.ts";
import { encodeErc20Approve } from "@leekwallet/core/allowances.ts";
import { capAmountText } from "@leekwallet/core/approval-cap.ts";
import { AQUA_MAX_LEGS, AQUA_REGISTRY, encodeDock } from "./registry.ts";
import type { DeployStep } from "./deploy.ts";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;

export interface DockRequest {
  /** The Aqua app the strategy was shipped to. */
  app: string;
  /** The strategy hash, as the portfolio view shows it. */
  strategyHash: string;
  /** Every token in the strategy. Docking a subset leaves the rest shipped. */
  tokens: readonly string[];
}

/** Said above the dock screen. */
export const DOCK_MEANING_NOTICE =
  "Docking returns this strategy's balances and stops Aqua filling it. It does " +
  "not touch your token approval: that is a standing permission on the token " +
  "contract and it outlives every position it was granted for. If this was " +
  "your last position in these tokens, revoke it as well — an allowance with " +
  "no position is exposure with no upside.";

export function planDock(request: DockRequest): { step: DeployStep; notices: string[] } {
  if (!HEX40.test(request.app)) throw new AbiError("app is not a 20-byte address");
  if (!HEX64.test(request.strategyHash)) {
    throw new AbiError("strategyHash is not a 32-byte value");
  }
  if (request.tokens.length === 0) throw new AbiError("a dock with no tokens returns nothing");
  if (request.tokens.length > AQUA_MAX_LEGS) {
    throw new AbiError(`the device draws at most ${AQUA_MAX_LEGS} legs per strategy`);
  }
  return {
    step: {
      role: "dock",
      to: AQUA_REGISTRY,
      data: encodeDock(request.app, request.strategyHash, request.tokens),
      label: `dock the strategy ${request.strategyHash.slice(0, 10)}… from ${request.app}`,
    },
    notices: [DOCK_MEANING_NOTICE],
  };
}

/* ------------------------------------------------------- the revoke offer */

/** What this app knows about one token after a dock. */
export interface TokenAfterDock {
  token: string;
  /** The current allowance to the registry, or undefined if unreadable. */
  allowance?: bigint;
  /**
   * Positions still holding a non-zero balance in this token, after the dock.
   *
   * Undefined means the count is not known — a failed registry read, a scan
   * that did not complete. It is not zero, and the difference decides whether
   * the offer is made at all.
   */
  remainingPositions?: number;
  decimals?: number;
  symbol?: string;
}

export type RevokeOffer =
  /** Make the offer: a standing allowance with nothing behind it. */
  | { kind: "offer"; token: string; step: DeployStep; allowance: bigint; notice: string }
  /** Nothing to revoke. Said plainly so a caller does not render an empty offer. */
  | { kind: "none"; token: string; why: "already-zero" | "positions-remain" }
  /** Do not know. Never rendered as "nothing to revoke". */
  | { kind: "unknown"; token: string; notice: string };

export const REVOKE_NOTICE =
  "You have no Aqua position left in this token and the registry can still " +
  "pull from this wallet up to the amount below. Setting it to zero costs one " +
  "signature and closes that. Nothing else in this app is affected — a later " +
  "position will ask for its own approval.";

export const REVOKE_UNKNOWN_NOTICE =
  "This app could not read either the allowance or every position in this " +
  "token, so it cannot tell you whether a standing approval is left with " +
  "nothing behind it. It is not offering to revoke, and that is not the same " +
  "as there being nothing to revoke — check the approvals list.";

/**
 * Should this token's allowance be offered for revocation?
 *
 * Both unknowns collapse to `unknown` on purpose. An allowance we could not
 * read and a position count we could not complete are different failures with
 * the same correct response: say so, and do not imply an all-clear.
 */
export function revokeOffer(state: TokenAfterDock): RevokeOffer {
  if (!HEX40.test(state.token)) throw new AbiError("token is not a 20-byte address");
  const token = state.token.toLowerCase();
  if (state.allowance === undefined || state.remainingPositions === undefined) {
    return { kind: "unknown", token, notice: REVOKE_UNKNOWN_NOTICE };
  }
  if (state.remainingPositions > 0) return { kind: "none", token, why: "positions-remain" };
  if (state.allowance === 0n) return { kind: "none", token, why: "already-zero" };

  return {
    kind: "offer",
    token,
    allowance: state.allowance,
    notice: REVOKE_NOTICE,
    step: {
      role: "approve",
      token,
      to: token,
      /* Zero is its own answer and never needs the zero-first sequence: it IS
       * the zero step. planCap says the same, and this path does not go
       * through it because there is no cap being applied, only a revoke. */
      data: encodeErc20Approve(AQUA_REGISTRY, 0n),
      amount: 0n,
      label:
        "set the Aqua registry's allowance to zero, from " +
        capAmountText(state.allowance, {
          ...(state.decimals !== undefined ? { decimals: state.decimals } : {}),
          ...(state.symbol !== undefined ? { symbol: state.symbol } : {}),
        }),
    },
  };
}
