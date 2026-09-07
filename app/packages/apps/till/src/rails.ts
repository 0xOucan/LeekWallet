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
}

/**
 * Mercado Pago Point, debit, 3.5% + 16% IVA, in basis points. The most
 * expensive of the published Mexican rates and therefore the most generous
 * possible comparison to L1 — the break-even below is a floor, not a best case.
 */
export const CARD_RATE_BPS = 406;

/**
 * The nine CCTP V2 testnet chains, listed cheapest first.
 *
 * Order in this array is the tie-break for equal fees, and Arc leads on
 * purpose: it is where the money settles, so paying there needs no bridge at
 * all. Everything else is a source domain.
 */
const RAILS: readonly Rail[] = [
  { chainId: 5042002, name: chainLabel(5042002), feeCents: 1, flatFee: false },   // Arc; gas is USDC
  { chainId: 84532, name: chainLabel(84532), feeCents: 1, flatFee: false },       // Base Sepolia
  { chainId: 11155420, name: chainLabel(11155420), feeCents: 1, flatFee: false }, // OP Sepolia
  { chainId: 421614, name: chainLabel(421614), feeCents: 1, flatFee: false },     // Arbitrum Sepolia
  { chainId: 1301, name: chainLabel(1301), feeCents: 1, flatFee: false },         // Unichain Sepolia
  { chainId: 80002, name: chainLabel(80002), feeCents: 1, flatFee: false },       // Polygon Amoy
  { chainId: 59141, name: chainLabel(59141), feeCents: 2, flatFee: false },       // Linea Sepolia
  { chainId: 43113, name: chainLabel(43113), feeCents: 3, flatFee: false },       // Avalanche Fuji
  { chainId: 11155111, name: chainLabel(11155111), feeCents: 200, flatFee: true }, // Ethereum L1 (Sepolia)
] as const;

/**
 * Token contracts per rail. Lower case, as core stores them.
 *
 * EURC's absence on five of the nine is the load-bearing part: a chain missing
 * from the EURC map has no EURC anybody checked, and the terminal must offer
 * nothing there rather than an address assumed by analogy with USDC. Offering
 * a combination and then failing on it is the same bug as offering it and
 * succeeding at sending money nowhere.
 */
const CONTRACTS: Record<TillToken, Readonly<Record<number, string>>> = {
  USDC: {
    5042002: "0x3600000000000000000000000000000000000000",
    84532: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    11155420: "0x5fd84259d66cd46123540766be93dfe6d43130d7",
    421614: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    1301: "0x31d0220469e10c4e71834a79b1f276d740d3768f",
    80002: "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
    59141: "0xfece4462d57bd51a6a552365a011b95f0e16d9b7",
    43113: "0x5425890298aed601595a70ab815c96711a31bc65",
    11155111: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  },
  EURC: {
    5042002: "0x89b50855aa3be2f677cd6303cec089b5f319d72a",
    84532: "0x808456652fdb597867f38412077a9182bf77359f",
    43113: "0x5e44db7996c682e92a960b65ac713a54ad815c6b",
    11155111: "0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4",
  },
};

/** Every chain the terminal is willing to be opened on, cheapest first. */
export const TILL_CHAIN_IDS: readonly number[] = RAILS.map((r) => r.chainId);

/** The rails, cheapest first. Already in that order; stated so callers rely on it. */
export const railsCheapestFirst = (): readonly Rail[] => RAILS;

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
