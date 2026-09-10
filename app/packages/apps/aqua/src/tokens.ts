/**
 * The closed set of tokens and pairs this app will author a position in, and
 * the one descriptor it offers as evidence for its own approvals.
 *
 * ---------------------------------------------------------------------------
 * Why a table here rather than the token list
 *
 * `chains.ts`'s TOKEN_HINTS is advisory metadata for rendering — it exists so a
 * preview can say "this looks like USDC" beside the address that actually
 * decides. Authoring is the other direction: a decimals value used to SCALE a
 * price is not a label, it is arithmetic, and a wrong one moves the band by
 * orders of magnitude with no visible symptom (authoring.ts §3.2, and the
 * comment on MAX_SQRT_PRICE, which is explicit that no bound catches it).
 *
 * So the addresses and decimals below are written out here, in the same shape
 * and with the same values as `contracts/script/plan-position.mjs`, which is
 * the script the RUNBOOK has always used. A change in a token list must not be
 * able to silently reprice a band.
 *
 * The set is closed for the same reason `TIERS` is closed: a free-form token
 * field is a field in which somebody pastes an address whose decimals nobody
 * checked.
 *
 * ---------------------------------------------------------------------------
 * The descriptor, and why this app needs one at all
 *
 * A deployment is `approve` then `ship`. `ship` and `dock` are in
 * `DEVICE_DRAWN_KINDS` — the device decodes them itself — but `approve` is an
 * ordinary ERC-20 call, and `screenProposal` refuses any call with no
 * descriptor. Core's bundled set covers Circle's TESTNET USDC and no Base
 * mainnet token at all, so without this the approval step of every plan this
 * app builds would be declined by the wallet, and the tier picker would be a
 * screen that cannot ship anything.
 *
 * `MiniApp.descriptors` is the sanctioned way to close that: an app supplies
 * EVIDENCE, core keeps the verdict (mini-app.ts). It is offered for exactly the
 * three addresses below, on exactly chain 8453, and for one signature. It
 * cannot describe anything else, and core still checks that every argument
 * renders and that the reading agrees with the firmware's own decoder.
 */

import { parseDescriptor, type Descriptor } from "@leekwallet/core/erc7730.ts";
import type { TokenSpec } from "./authoring.ts";

/** Base mainnet. Every address in this file is Base-only. */
export const BASE_CHAIN_ID = 8453;

export interface KnownToken extends TokenSpec {
  /** For the human read-back only. Never used to decide anything. */
  symbol: string;
}

/**
 * Supplies measured 2026-09-10: cbBTC is the wrapped BTC on Base by a wide
 * margin (45,692 BTC against WBTC's 65 and tBTC's 46).
 */
export const BASE_TOKENS: Readonly<Record<string, KnownToken>> = {
  weth: { address: "0x4200000000000000000000000000000000000006", decimals: 18, symbol: "WETH" },
  usdc: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" },
  cbbtc: { address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8, symbol: "cbBTC" },
};

export type TokenId = string;

/**
 * One pair, with the direction the mid price is stated in.
 *
 * `midBase`/`midQuote` are the way a person knows the price — "4000 USDC per
 * WETH", "110000 USDC per cbBTC" — not the way the VM orders the pair. The
 * ordering opcode 18 needs is derived by `orderPair`, from the addresses, and
 * is deliberately not stated twice.
 */
export interface PairSpec {
  id: string;
  label: string;
  a: TokenId;
  b: TokenId;
  midBase: TokenId;
  midQuote: TokenId;
  /** An example of a mid a reader will recognise, for the placeholder only. */
  midExample: string;
}

export const PAIRS: readonly PairSpec[] = [
  {
    id: "weth-usdc", label: "WETH / USDC",
    a: "weth", b: "usdc", midBase: "weth", midQuote: "usdc", midExample: "4000",
  },
  {
    id: "usdc-cbbtc", label: "cbBTC / USDC",
    a: "usdc", b: "cbbtc", midBase: "cbbtc", midQuote: "usdc", midExample: "110000",
  },
];

export const pairById = (id: string): PairSpec | undefined => PAIRS.find((p) => p.id === id);

/** A token from the closed table, or undefined. Never a guess. */
export const tokenById = (id: TokenId): KnownToken | undefined => BASE_TOKENS[id];

/** The symbol for an address, from the closed table only, or the address. */
export const symbolOf = (address: string): string =>
  Object.values(BASE_TOKENS).find((t) => t.address === address.toLowerCase())?.symbol ?? address;

/**
 * A band read-back with addresses replaced by symbols from the table above.
 *
 * `authoring.ts` speaks in addresses on purpose — a symbol is not a fact — but
 * the read-back is the one check a human can actually perform (§3.4), and
 * "2800 to 5714 USDC per WETH" is checkable where the same sentence with two
 * hex addresses in it is not. The substitution is from the closed table, never
 * from a contract.
 */
export const withSymbols = (text: string): string =>
  Object.values(BASE_TOKENS).reduce((t, tok) => t.replaceAll(tok.address, tok.symbol), text);

/* ------------------------------------------------------------- descriptors */

export const AQUA_DESCRIPTOR_SOURCE = "local/aqua-base-approve";

/** The one signature this app offers a descriptor for. */
export const APPROVE_KEY = "approve(address spender, uint256 amount)";

/**
 * The descriptor set for one of the three tokens above, or nothing.
 *
 * Nothing is the answer for every other address and every other chain, and it
 * is not a degraded one: an approval this app did not build has no business
 * being described by this app.
 */
export function aquaDescriptors(chainId: number, to: string): readonly Descriptor[] {
  if (chainId !== BASE_CHAIN_ID) return [];
  const token = Object.values(BASE_TOKENS).find((t) => t.address === to.toLowerCase());
  if (token === undefined) return [];
  const parsed = parseDescriptor(
    {
      context: { contract: { deployments: [{ chainId, address: token.address }] } },
      metadata: { owner: `${token.symbol} on Base`, contractName: token.symbol },
      display: {
        formats: {
          [APPROVE_KEY]: {
            intent: "Approve a spender",
            fields: [
              { label: "Spender", path: "#.spender", format: "addressName" },
              /* Raw, not `amount`. An `amount` format would render a decimals
               * value this app supplied, next to an approve button, on a
               * screen whose whole subject is the size of the cap — and the
               * device shows raw units regardless. The plan's own step label
               * states the figure in token units, marked as a guess. */
              { label: "Amount", path: "#.amount", format: "raw" },
            ],
          },
        },
      },
    },
    AQUA_DESCRIPTOR_SOURCE,
  );
  return parsed === null ? [] : [parsed];
}
