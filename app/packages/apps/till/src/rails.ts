/**
 * The payment rails this terminal accepts, ranked by what they cost the
 * customer, and the token deployments on each.
 *
 * ---------------------------------------------------------------------------
 * Why the chain list lives here and the decimals do not
 *
 * Choosing to take money on these nine chains is a product decision belonging
 * to this app — delete the directory and the wallet still knows the chains,
 * still renders their USDC, and simply no longer offers to be a till. What is
 * NOT app knowledge is how many decimals a token has: that is in core's
 * TOKEN_HINTS (chains.ts), read here through `tokenHint()` and never restated.
 *
 * That is not tidiness. On Arc the native gas unit has 18 decimals and the
 * ERC-20 interface at 0x3600…0000 has 6, on the same chain, and a local copy
 * of "6" that drifted from core's would misprice a bill by 10^12. A payment
 * we cannot scale from core's table is refused below rather than guessed at.
 *
 * ---------------------------------------------------------------------------
 * Why the ranking is by cost, and why L1 carries a warning
 *
 * Mexican card acquiring, from Banxico's Oct 2025 tables and Mercado Pago's own
 * terms: Clip averages 3.59%, Mercado Pago 3.34%, and Mercado Pago Point on
 * debit is 3.5% + IVA = 4.06%. Our cost is gas. On an L2 or on Arc that is a
 * fraction of a cent, which is 40–80x cheaper than a card and is the claim the
 * project makes. On Ethereum L1 it is around $2 a transfer, which is a FLAT
 * fee, and a flat fee beats a percentage only above a ticket size:
 *
 *     $2.00 / 4.06%  =  $49.27 (rounded up to the cent)
 *
 * Below roughly a $49 ticket, L1 costs the customer more than Mercado Pago
 * would have cost the merchant — two to five times more on a $10–20 taquería
 * bill. So `breakevenCents` is computed from the two published numbers rather
 * than asserted, and the view marks a rail whose break-even the current total
 * has not reached. A terminal that listed nine chains as equals would be
 * telling a lie that costs a real customer real money.
 */

import {
  ArbitrumSepolia, ArcTestnet, AvalancheFuji, BaseSepolia, EthereumSepolia,
  LineaSepolia, OptimismSepolia, PolygonAmoy, UnichainSepolia,
} from "@circle-fin/app-kit/chains";
import { chainLabel, tokenHint } from "@leekwallet/core/chains.ts";

/** The two Circle stablecoins this terminal takes. */
export type TillToken = "USDC" | "EURC";

export const TILL_TOKENS: readonly TillToken[] = ["USDC", "EURC"] as const;

export interface Rail {
  chainId: number;
  /** Whatever core calls the chain. Not a second copy of the chain table. */
  name: string;
  /**
   * A transfer's gas, in whole US cents, as an order of magnitude rather than
   * a quote. Nothing is settled on this figure — it decides list order and one
   * warning, both of which are wrong only if the figure is wrong by an order
   * of magnitude, which is exactly what separates an L2 from L1.
   */
  feeCents: number;
  /**
   * True for a chain whose fee is flat and large enough to lose to a card on a
   * small bill. Only Ethereum L1 is one today; it is a field rather than a
   * chain-id test so a second such chain is data, not a code change.
   */
  flatFee: boolean;
  /**
   * Blocks of depth before a `Transfer` to the merchant is shown as PAID
   * rather than as seen. Per rail because two blocks on an L2 and two blocks
   * on Ethereum L1 are not the same claim about permanence: the L2 testnets
   * here reorg at depth 1 if at all, while a 2-block reorg on an Ethereum
   * chain is an ordinary Tuesday. See watch.ts for what the terminal does
   * after this depth, which is: never retract.
   */
  confirmations: number;
}

/**
 * Mercado Pago Point, debit, 3.5% + 16% IVA, in basis points. The most
 * expensive of the published Mexican rates and therefore the most generous
 * possible comparison to L1 — the break-even below is a floor, not a best case.
 */
export const CARD_RATE_BPS = 406;

/**
 * Token contracts per rail, taken from Circle's own chain definitions.
 *
 * ---------------------------------------------------------------------------
 * Why these addresses come from the SDK and not from this file
 *
 * They used to be a hand-copied table transcribed out of Circle's docs. Every
 * entry was right, and that is exactly the problem with it: it was right on the
 * day it was typed, and nothing in this repository would notice the day it
 * stopped being. A wrong USDC address on a QR is money sent to a contract that
 * cannot give it back.
 *
 * `@circle-fin/app-kit/chains` is the data half of the sponsor SDK — chain ids,
 * USDC and EURC addresses, CCTP domains, Gateway contracts — and it is a plain
 * frozen object with no client, no adapter and no key in it. That is precisely
 * the split docs/SDK-POLICY.md asks for: the SDK supplies the addresses, and
 * nothing in this app hands it a signer, because this app has none to hand.
 *
 * `EURC` being `null` on five of the nine is now Circle's statement rather than
 * ours, which is the part worth having: a chain that gains EURC gains it here
 * on the next SDK bump instead of on the next time somebody remembers.
 *
 * The decimals still come from core's token table (`tokenHint`), never from
 * the SDK and never from a constant here — see `deploymentFor` below.
 */
const CIRCLE_CHAINS = [
  ArcTestnet, BaseSepolia, OptimismSepolia, ArbitrumSepolia, UnichainSepolia,
  PolygonAmoy, LineaSepolia, AvalancheFuji, EthereumSepolia,
] as const;

/**
 * The nine CCTP V2 testnet chains, listed cheapest first.
 *
 * Order in this array is the tie-break for equal fees, and Arc leads on
 * purpose: it is where the money settles, so paying there needs no bridge at
 * all. Everything else is a source domain.
 */
const RAILS: readonly Rail[] = [
  { chainId: ArcTestnet.chainId, name: chainLabel(ArcTestnet.chainId), feeCents: 1, flatFee: false, confirmations: 2 },   // Arc; gas is USDC
  { chainId: BaseSepolia.chainId, name: chainLabel(BaseSepolia.chainId), feeCents: 1, flatFee: false, confirmations: 2 },       // Base Sepolia
  { chainId: OptimismSepolia.chainId, name: chainLabel(OptimismSepolia.chainId), feeCents: 1, flatFee: false, confirmations: 2 }, // OP Sepolia
  { chainId: ArbitrumSepolia.chainId, name: chainLabel(ArbitrumSepolia.chainId), feeCents: 1, flatFee: false, confirmations: 2 },     // Arbitrum Sepolia
  { chainId: UnichainSepolia.chainId, name: chainLabel(UnichainSepolia.chainId), feeCents: 1, flatFee: false, confirmations: 2 },         // Unichain Sepolia
  { chainId: PolygonAmoy.chainId, name: chainLabel(PolygonAmoy.chainId), feeCents: 1, flatFee: false, confirmations: 5 },       // Polygon Amoy; reorgs deeper than its L2 peers
  { chainId: LineaSepolia.chainId, name: chainLabel(LineaSepolia.chainId), feeCents: 2, flatFee: false, confirmations: 2 },       // Linea Sepolia
  { chainId: AvalancheFuji.chainId, name: chainLabel(AvalancheFuji.chainId), feeCents: 3, flatFee: false, confirmations: 2 },       // Avalanche Fuji
  { chainId: EthereumSepolia.chainId, name: chainLabel(EthereumSepolia.chainId), feeCents: 200, flatFee: true, confirmations: 12 }, // Ethereum L1 (Sepolia)
] as const;

/**
 * Circle writes addresses checksummed; core stores them lower-case, and the
 * watcher compares log topics as lower-case hex. One normalisation, here, so
 * no caller has to remember which form it is holding.
 */
const CONTRACTS: Record<TillToken, Readonly<Record<number, string>>> = {
  USDC: Object.fromEntries(
    CIRCLE_CHAINS.map((c) => [c.chainId, c.usdcAddress.toLowerCase()]),
  ),
  EURC: Object.fromEntries(
    CIRCLE_CHAINS.flatMap((c) =>
      c.eurcAddress === null ? [] : [[c.chainId, c.eurcAddress.toLowerCase()] as const],
    ),
  ),
};

/** Every chain the terminal is willing to be opened on, cheapest first. */
export const TILL_CHAIN_IDS: readonly number[] = RAILS.map((r) => r.chainId);

/** The rails, cheapest first. Already in that order; stated so callers rely on it. */
export const railsCheapestFirst = (): readonly Rail[] => RAILS;

/**
 * How deep a payment must be on this chain before the terminal says PAID.
 * An unknown chain gets the most cautious figure any rail asks for, not the
 * least: guessing low here is guessing in the direction of telling a customer
 * their money arrived when it may not have.
 */
export const confirmationsFor = (chainId: number): number =>
  railFor(chainId)?.confirmations ?? Math.max(...RAILS.map((r) => r.confirmations));

export const railFor = (chainId: number): Rail | undefined =>
  RAILS.find((r) => r.chainId === chainId);

/**
 * A deployment the terminal can actually bill in, or a sentence saying why not.
 *
 * A discriminated union, not `string | undefined`, for the reason the apps
 * README gives: an unavailable rail and a cheap one must never render the same,
 * and the reason has to survive as far as the screen.
 */
export type Deployment =
  | { ok: true; chainId: number; token: TillToken; address: string; decimals: number }
  | { ok: false; reason: string };

export function deploymentFor(chainId: number, token: TillToken): Deployment {
  const rail = railFor(chainId);
  if (rail === undefined) return { ok: false, reason: `This terminal does not take payment on chain ${chainId}.` };
  const address = CONTRACTS[token][chainId];
  if (address === undefined) {
    return { ok: false, reason: `${token} is not deployed on ${rail.name}. Ask for USDC, or move to a chain that has it.` };
  }
  /* Decimals come from core or the payment does not happen. Defaulting to 6
   * here would be a local copy of the one number Arc proves you cannot copy. */
  const hint = tokenHint(chainId, address);
  if (hint === undefined) {
    return {
      ok: false,
      reason: `${token} on ${rail.name} has no decimals in the wallet's token table, so an amount ` +
        `cannot be scaled exactly. The terminal will not guess.`,
    };
  }
  return { ok: true, chainId, token, address, decimals: hint.decimals };
}

/**
 * The smallest bill, in cents, at which this rail's gas beats a card.
 *
 * Integer arithmetic, rounded up: the answer is a threshold and rounding it
 * down would put a ticket on the wrong side of its own warning.
 */
export function breakevenCents(rail: Rail): number {
  return Math.ceil((rail.feeCents * 10_000) / CARD_RATE_BPS);
}

/**
 * True when this rail's flat fee makes the bill worse than a card would be.
 * Never true for the L2s, whose fee is a rounding error at any ticket size.
 */
export function costsMoreThanCard(rail: Rail, totalCents: bigint): boolean {
  if (!rail.flatFee) return false;
  return totalCents < BigInt(breakevenCents(rail));
}

export const CARD_NOTICE =
  `Card fees compared against Mercado Pago Point on debit, 3.5% + IVA = 4.06% ` +
  `(Banxico, Oct 2025). Gas figures are order-of-magnitude estimates, not quotes.`;
