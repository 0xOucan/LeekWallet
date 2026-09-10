/**
 * One tier-picked position, from a pair, a tier and a mid price, to calldata —
 * or a refusal that names what is missing.
 *
 * Pure. No DOM, no network, no clock, no `propose`. The balances it reasons
 * about are passed in, exactly as `deploy.ts` takes allowances in, and for the
 * same reason: what this module decides is checkable in a test with no chain.
 *
 * ---------------------------------------------------------------------------
 * The check `deploy.ts` does not make, and why it belongs here
 *
 * `planDeployment` refuses an unlimited approval, a strategy naming another
 * maker and a program it cannot decode. It does NOT check that the maker holds
 * the tokens: the registry credits a strategy with a *virtual* balance, and the
 * Aqua whitepaper is explicit (§3, quoted at length in funding.ts) that the AMM
 * "continues quoting prices based solely on virtual balances without checking
 * real balances or allowances". A position credited with tokens the maker does
 * not hold looks alive in every view and reverts on every fill, at the taker's
 * expense.
 *
 * So a leg asking for more than the maker holds is refused here, before any
 * calldata exists. `funding.ts` reports the same condition for positions that
 * already exist; this is the same rule applied one step earlier, where it is
 * still free to fix.
 *
 * ---------------------------------------------------------------------------
 * One-sided positions, stated rather than hidden
 *
 * The maker on Base holds USDC and neither WETH nor cbBTC (measured
 * 2026-09-10). Both pairs are therefore one-sided, and there are exactly three
 * honest outcomes:
 *
 *   both legs funded  → a two-sided position: a market in both directions.
 *   one leg funded    → a ONE-SIDED position. It is a real, decodable,
 *                       fillable offer, and it is only an offer in one
 *                       direction: a taker can give the maker the missing
 *                       token and take the funded one. Nobody can buy the
 *                       missing token from this position, because there is
 *                       none behind it. `ONE_SIDED_NOTICE` says that, and the
 *                       plan carries which side is empty so the caller cannot
 *                       render it without.
 *   neither funded    → refused. Not a warning next to a sign button: there is
 *                       no position to ship, and a plan on screen would be a
 *                       plan somebody can be tempted to press.
 *
 * The third case is the one the brief calls "do not render a plan that cannot
 * execute", and the second is the one it calls handling one side honestly.
 */

import { AbiError } from "@leekwallet/core/balances.ts";
import { capAmountText } from "@leekwallet/core/approval-cap.ts";
import { AQUA_SWAPVM_ROUTER } from "./registry.ts";
import { readOrderProgram } from "./program.ts";
import {
  TIERS, buildPosition, showRational,
  type Position, type RiskTier,
} from "./authoring.ts";
import { planDeployment, type DeployLeg, type DeployPlan, type DeployRefusal } from "./deploy.ts";
import {
  BASE_TOKENS, pairById, tokenById, withSymbols,
  type KnownToken, type PairSpec,
} from "./tokens.ts";

/** What the maker is known to hold and to have approved, per token. */
export interface LegInput {
  /** A key of `BASE_TOKENS`. Anything else is a refusal, never a guess. */
  tokenId: string;
  /** Raw units this leg would credit the strategy with. Zero means "not this side". */
  amount: bigint;
  /**
   * The maker's real balance, or undefined when nobody could read it.
   *
   * Undefined is NOT zero and is not treated as enough, either: a plan built on
   * an unread balance is a plan that might be unfillable, and saying so costs
   * one sentence where discovering it costs a taker a reverted fill.
   */
  balance?: bigint;
  /** The standing allowance to the registry, or undefined if unread. */
  allowance?: bigint;
}

export interface TierRequest {
  maker: string;
  pairId: string;
  tier: RiskTier;
  /** The mid, in the pair's stated direction, as digits the operator typed. */
  mid: string;
  /** Percent as a decimal string, e.g. "0.30". */
  feePercent: string;
  /** Unix seconds. */
  deadline: bigint;
  gateToken: string;
  /** Exactly 8 bytes. */
  salt: Uint8Array;
  legs: readonly LegInput[];
}

export type TierRefusal =
  /** The form could not be read at all: a pair, a tier or a number. */
  | { kind: "input"; notice: string }
  /** Every leg is empty, or the maker holds none of either side. */
  | { kind: "nothing-to-fund"; missing: readonly string[]; notice: string }
  /** A leg asks for more than the maker holds. */
  | { kind: "short"; token: string; symbol: string; want: bigint; held: bigint; notice: string }
  /** A leg's balance could not be read, so nothing here is checkable. */
  | { kind: "balance-unknown"; token: string; symbol: string; notice: string }
  /** The program does not decode, so the device would refuse it. */
  | { kind: "undecodable"; notice: string }
  /** deploy.ts said no. Its own sentence is carried, not rewritten. */
  | { kind: "deploy"; refusal: DeployRefusal; notice: string };

export interface FundedLeg {
  token: KnownToken;
  amount: bigint;
  held: bigint;
}

export interface TierPlan {
  ok: true;
  pair: PairSpec;
  tier: RiskTier;
  position: Position;
  /** The read-back of §3.4, in symbols a person can check against a price. */
  bandText: string;
  /** The tier's own words. Never a projection of return — see TIERS. */
  tierSummary: string;
  /** Both edges of the band, as decimal strings in the stated direction. */
  loHuman: string;
  hiHuman: string;
  /** The expiry the program carries, so the caller can print it for checking. */
  deadline: bigint;
  sides: "two-sided" | "one-sided";
  legs: readonly FundedLeg[];
  /** Present only when `sides` is "one-sided": the side with nothing behind it. */
  emptySide?: KnownToken;
  plan: DeployPlan;
  /** Everything the UI must say, in order. deploy.ts's, plus this file's. */
  notices: string[];
}

export type TierResult = TierPlan | { ok: false; refusal: TierRefusal };

export const ONE_SIDED_NOTICE =
  "This position has tokens on one side only. It is a real offer and it can be " +
  "filled — but in one direction: a taker can give you the empty side and take " +
  "the funded one. Nobody can buy the empty side from you here, because there " +
  "is none behind the position, and the price band applies just the same to " +
  "the half that cannot trade. Fund both sides if you want a market in both " +
  "directions.";

export const BAND_READBACK_NOTICE =
  "Read the price range above against a price you already know. A wrong " +
  "decimals value does not fail — it silently prices a different range, and " +
  "this sentence is the only check that catches it. Nothing in the code below " +
  "can: the sqrt bounds are plausible numbers either way.";

export const APPROVAL_SIZE_NOTICE =
  "The approval is exactly the amount this position is credited with, per " +
  "token. Not unlimited, and no headroom: this wallet is the app here, so " +
  "there is no dapp with a stale reading to accommodate.";

const NOT_HELD = (symbols: readonly string[]): string =>
  `This pair cannot be shipped from this wallet: it holds none of ` +
  `${symbols.join(" or ")}. A strategy credited with tokens that are not there ` +
  `quotes prices it cannot honour — Aqua does not check, so every fill against ` +
  `it reverts at the taker's expense. Fund the wallet first; nothing is planned ` +
  `until then.`;

/**
 * Plan one position, or refuse.
 *
 * The order of the checks is the order in which a person can act on them: the
 * form first, then what the wallet holds, then the program, then deploy.ts's
 * own refusals. A funding problem reported after a decode problem is a
 * sentence about the wrong thing.
 */
export function planTierPosition(request: TierRequest): TierResult {
  const pair = pairById(request.pairId);
  if (pair === undefined) {
    return { ok: false, refusal: { kind: "input", notice: `"${request.pairId}" is not one of this app's pairs.` } };
  }
  if (TIERS[request.tier] === undefined) {
    return { ok: false, refusal: { kind: "input", notice: `"${request.tier}" is not one of the three tiers.` } };
  }

  /* Every leg named must be one of the pair's two tokens. A leg for a third
   * token is not a mistake to trim silently: it means the caller and this
   * module disagree about what is being shipped. */
  const wanted: FundedLeg[] = [];
  const missing: string[] = [];
  for (const id of [pair.a, pair.b]) {
    const token = tokenById(id);
    if (token === undefined) {
      return { ok: false, refusal: { kind: "input", notice: `"${id}" is not a token this app knows.` } };
    }
    const leg = request.legs.find((l) => l.tokenId === id);
    const amount = leg?.amount ?? 0n;
    if (amount < 0n) {
      return { ok: false, refusal: { kind: "input", notice: "an amount cannot be negative." } };
    }
    if (amount === 0n) { missing.push(token.symbol); continue; }

    if (leg?.balance === undefined) {
      return {
        ok: false,
        refusal: {
          kind: "balance-unknown", token: token.address, symbol: token.symbol,
          notice:
            `Nobody answered for this wallet's ${token.symbol} balance, so there ` +
            `is no way to tell whether this position could be filled. That is not ` +
            `read as zero and it is not read as enough — it is read as unknown, ` +
            `and nothing is planned against an unknown.`,
        },
      };
    }
    if (leg.balance < amount) {
      return {
        ok: false,
        refusal: {
          kind: "short", token: token.address, symbol: token.symbol,
          want: amount, held: leg.balance,
          notice:
            `This position would be credited with ` +
            `${capAmountText(amount, { decimals: token.decimals, symbol: token.symbol })} ` +
            `of ${token.symbol} and this wallet holds ` +
            `${capAmountText(leg.balance, { decimals: token.decimals, symbol: token.symbol })}. ` +
            `Aqua quotes against the credit and pulls against the balance, so the ` +
            `difference is a position that looks alive and reverts on every fill. ` +
            `Lower the amount or fund the wallet.`,
        },
      };
    }
    wanted.push({ token, amount, held: leg.balance });
  }

  if (wanted.length === 0) {
    return {
      ok: false,
      refusal: { kind: "nothing-to-fund", missing, notice: NOT_HELD(missing) },
    };
  }

  let position: Position;
  try {
    position = buildPosition({
      maker: request.maker,
      a: BASE_TOKENS[pair.a] as KnownToken,
      b: BASE_TOKENS[pair.b] as KnownToken,
      mid: {
        base: (BASE_TOKENS[pair.midBase] as KnownToken).address,
        quote: (BASE_TOKENS[pair.midQuote] as KnownToken).address,
        price: request.mid,
      },
      tier: request.tier,
      deadline: request.deadline,
      gateToken: request.gateToken,
      feePercent: request.feePercent,
      salt: request.salt,
    });
  } catch (e) {
    const why = e instanceof AbiError ? e.message : String((e as Error)?.message ?? e);
    return { ok: false, refusal: { kind: "input", notice: `That could not be priced: ${why}` } };
  }

  /* The device's own rule, applied before a signature is asked for. A program
   * this repo cannot decode is one the firmware refuses as a whole
   * transaction, so planning it would only produce a press that dies on the
   * hardware. plan-position.mjs makes the same check for the same reason. */
  const reading = readOrderProgram(position.strategy, AQUA_SWAPVM_ROUTER);
  if (!reading.ok) {
    return {
      ok: false,
      refusal: {
        kind: "undecodable",
        notice:
          "This program does not decode here, so the device would refuse to sign " +
          "it. Nothing is planned. That is a disagreement between this app and " +
          "the firmware, which is a bug to fix rather than a prompt to retry.",
      },
    };
  }

  const legs: DeployLeg[] = wanted.map((l) => {
    const found = request.legs.find((x) => x.tokenId === keyOf(l.token));
    return {
      token: l.token.address,
      amount: l.amount,
      decimals: l.token.decimals,
      symbol: l.token.symbol,
      ...(found?.allowance !== undefined ? { allowance: found.allowance } : {}),
    };
  });

  const plan = planDeployment({
    maker: request.maker, app: AQUA_SWAPVM_ROUTER, strategy: position.strategy, legs,
  });
  if (!plan.ok) {
    return { ok: false, refusal: { kind: "deploy", refusal: plan.refusal, notice: plan.refusal.notice } };
  }

  const sides = wanted.length === 2 ? "two-sided" : "one-sided";
  const emptySide = sides === "one-sided"
    ? Object.values(BASE_TOKENS).find((t) => !wanted.some((w) => w.token.address === t.address)
        && [pair.a, pair.b].some((id) => (BASE_TOKENS[id] as KnownToken).address === t.address))
    : undefined;

  const notices = [
    BAND_READBACK_NOTICE,
    ...(sides === "one-sided" ? [ONE_SIDED_NOTICE] : []),
    APPROVAL_SIZE_NOTICE,
    ...plan.notices,
  ];

  return {
    ok: true,
    pair,
    tier: request.tier,
    position,
    bandText: withSymbols(position.bandText),
    tierSummary: (TIERS[request.tier]).summary,
    loHuman: showRational(position.band.loHuman),
    hiHuman: showRational(position.band.hiHuman),
    deadline: request.deadline,
    sides,
    legs: wanted,
    ...(emptySide !== undefined ? { emptySide } : {}),
    plan,
    notices,
  };
}

/** The table key for a token. Used only to line a leg back up with its input. */
const keyOf = (token: KnownToken): string =>
  Object.keys(BASE_TOKENS).find((k) => (BASE_TOKENS[k] as KnownToken).address === token.address) ?? "";
