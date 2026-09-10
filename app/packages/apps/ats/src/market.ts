/**
 * The secondary market: list, cancel and fill, through `AtsEscrowMarket`.
 *
 * Pure, apart from `readListings`, which takes an `EthRequest` and returns
 * outcomes. No DOM and no `propose` below this line.
 *
 * ---------------------------------------------------------------------------
 * The two HBAR units, which is the whole reason this file is careful
 *
 * The contract's own header records both halves and how each was found. They
 * are restated here because a caller that gets either wrong produces a
 * transaction that fails in a way that looks like the other:
 *
 *   `priceTotal`, in storage and in `WrongPayment`, is **TINYBAR** (1 HBAR =
 *   1e8), because it is compared against `msg.value` — and `msg.value` arrives
 *   in tinybar on Hedera.
 *
 *   The **transaction value field** is **WEIBAR** (1 tinybar = 1e10 weibar),
 *   because Hedera's relay divides the signed value by 1e10 before the
 *   contract sees it.
 *
 * So one number, `priceTotal`, has to appear in a fill in two different units
 * at once: as nothing in the calldata (the fill takes only a listing id) and as
 * `priceTotal × 1e10` in the value field. Get it wrong low and the relay
 * rejects the transaction before it arrives — "Value can't be non-zero and less
 * than 10_000_000_000 wei which is 1 tinybar". Get it wrong high and the
 * contract reverts `WrongPayment(sent, required)` with the two figures exactly
 * 1e10 apart. Four failures went into pinning that down.
 *
 * **The defence here is that a caller never chooses.** `encodeFill` takes the
 * listing as it was read from the chain and computes both halves itself; there
 * is no exported function that takes a value in weibar, and no way to hand
 * `fill` a number of your own. `hbarText` prints both units wherever a price is
 * shown, so a reader can see the ratio rather than take it on trust.
 *
 * ---------------------------------------------------------------------------
 * What this market does not do
 *
 * It does not check whether a trade is allowed. It attempts the transfer and
 * lets the security's own control list, KYC, pause and freeze guards revert it
 * — see the contract header. So this file must not imply a fill will succeed:
 * a listing is rendered as an offer, never as an entitlement, and eligibility
 * is decided by the security at fill time and by nothing on this screen.
 */

import { multicall3Address } from "@leekwallet/core/multicall.ts";
import { AbiError, type EthRequest } from "@leekwallet/core/balances.ts";
import { parseDescriptor, type Descriptor } from "@leekwallet/core/erc7730.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { addressWord, selectorOf, word } from "./abi.ts";
import { callBatch, mapOutcome, type Outcome, type ReadContext } from "./register.ts";
import { decodeUint } from "./abi.ts";

/**
 * The deployed market. Hedera testnet, native HBAR leg, `PAYMENT_DECIMALS = 8`.
 * A trade has settled through it.
 */
export const ATS_MARKET = "0xcde9596fd89c5368b5bd46c2b93544cbb201f8df";

/** 1 HBAR, in the unit `priceTotal` and `msg.value` are measured in. */
export const TINYBAR_PER_HBAR = 100_000_000n;

/** The relay's divisor: a signed value field of `n` reaches the contract as `n / 1e10`. */
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/**
 * `PAYMENT_DECIMALS` as the contract reports it: 8, not 18.
 *
 * The constructor comments say why in as many words — reporting 18 would tell
 * every caller to price a lot 1e10 too high, which is precisely the fill that
 * reverted.
 */
export const PAYMENT_DECIMALS = 8;

export const HBAR_UNIT_NOTICE =
  "A price here is in tinybar (1 HBAR = 100,000,000 tinybar), because that is " +
  "the unit the contract compares against msg.value. The transaction that pays " +
  "it carries a value field 10,000,000,000 times larger, in weibar, because " +
  "Hedera's relay divides the signed value by that before the contract sees " +
  "it. Both figures are shown wherever a price is; this app computes the " +
  "second from the first and never takes it from a field.";

export const ELIGIBILITY_NOTICE =
  "This market does not check whether you may hold this security. It attempts " +
  "both transfers and lets the security's own control list, KYC, pause and " +
  "freeze rules revert them — so a fill you are not eligible for fails on " +
  "chain, after the press, and costs the gas. Nothing on this screen can tell " +
  "you in advance.";

export const ESCROW_NOTICE =
  "Listing moves the shares into the market contract. If the issuer freezes " +
  "you after that, cancel cannot give them back — the transfer to you reverts " +
  "and the shares stay escrowed. There is no rescue function, deliberately; " +
  "recovery is the issuer's own forced transfer.";

/* ---------------------------------------------------------------- signatures */

export const MARKET_SIG = {
  list: "list(address,uint256,uint256)",
  cancel: "cancel(uint256)",
  fill: "fill(uint256)",
  getListing: "getListing(uint256)",
  nextListingId: "nextListingId()",
} as const;

export const MARKET_SELECTOR: Readonly<Record<keyof typeof MARKET_SIG, string>> =
  Object.fromEntries(
    Object.entries(MARKET_SIG).map(([k, v]) => [k, selectorOf(v)]),
  ) as Record<keyof typeof MARKET_SIG, string>;

/* -------------------------------------------------------------------- prices */

/**
 * A price in HBAR, as digits a person typed, to tinybar. Exact, integer only.
 *
 * Refuses more than eight decimal places rather than truncating: a price
 * rounded down by one tinybar is a different offer, and rounding it silently is
 * the same class of helpfulness `parseUnits` refuses for a token amount.
 */
export function hbarToTinybar(text: string): bigint {
  const trimmed = text.trim();
  const m = /^([0-9]+)(?:\.([0-9]*))?$/.exec(trimmed);
  if (m === null) throw new AbiError(`"${text}" is not a plain decimal number of HBAR`);
  const frac = m[2] ?? "";
  if (frac.length > 8) {
    throw new AbiError(
      `${trimmed} has ${frac.length} decimal places; HBAR has 8, and rounding a ` +
      "price is offering a different one",
    );
  }
  const tinybar = BigInt((m[1] as string) + frac.padEnd(8, "0"));
  if (tinybar <= 0n) {
    /* The contract refuses a zero price, and the relay refuses any non-zero
     * transaction value below one tinybar. Both floors are the same number
     * here, so the refusal is one sentence. */
    throw new AbiError("a price must be at least 1 tinybar (0.00000001 HBAR)");
  }
  return tinybar;
}

/** Both units, always together. The ratio is the thing a reader can check. */
export const hbarText = (tinybar: bigint): string =>
  `${formatTinybar(tinybar)} HBAR (${tinybar} tinybar; ` +
  `transaction value ${tinybar * WEIBAR_PER_TINYBAR} weibar)`;

/** Exact tinybar → decimal HBAR. Integer arithmetic only. */
export function formatTinybar(tinybar: bigint): string {
  const whole = tinybar / TINYBAR_PER_HBAR;
  const frac = (tinybar % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/* ------------------------------------------------------------------ listings */

export const STATUS_NAMES = ["none", "open", "filled", "cancelled"] as const;
export type ListingStatus = (typeof STATUS_NAMES)[number];

export interface Listing {
  id: bigint;
  seller: string;
  security: string;
  /** Raw units of the security, as measured by the contract's balance delta. */
  amount: bigint;
  /** TINYBAR. See the header; never a weibar figure, never a display number. */
  priceTotal: bigint;
  status: ListingStatus;
}

/**
 * Decode `getListing`'s return: five static words, no offsets to follow.
 *
 * A struct of static components is returned in the head exactly as five
 * separate values would be, so there is nothing here to misread — which is why
 * this decoder is written out rather than avoided.
 */
export function decodeListing(id: bigint, data: unknown): Listing {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new AbiError("getListing did not answer with whole-byte hex");
  }
  const body = data.slice(2);
  if (body.length < 5 * 64) throw new AbiError("getListing answered with fewer than five words");
  const at = (i: number): bigint => BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`);
  const address = (i: number): string => {
    const w = body.slice(i * 64, (i + 1) * 64);
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(w)) throw new AbiError("an address word is not clean");
    return `0x${w.slice(24).toLowerCase()}`;
  };
  const status = at(4);
  if (status > 3n) throw new AbiError(`unknown listing status ${status}`);
  return {
    id,
    seller: address(0),
    security: address(1),
    amount: at(2),
    priceTotal: at(3),
    status: STATUS_NAMES[Number(status)] as ListingStatus,
  };
}

/**
 * How far the listing walk goes.
 *
 * Bounded for the reason register.ts bounds its snapshot probe: the ids are
 * dense and sequential, so a walk is the only enumeration available, and an
 * unbounded one is a self-inflicted rate limit. A market with more listings
 * than this comes back marked incomplete rather than as a count.
 */
export const LISTING_WALK_LIMIT = 60;

export interface MarketView {
  /** `nextListingId - 1`, or an outcome saying nobody answered. */
  count: Outcome<bigint>;
  listings: Array<Outcome<Listing>>;
  /** True when there are more ids than the walk covered. */
  truncated: boolean;
}

/**
 * Read the market: how many listings exist, then each one.
 *
 * Two round trips at most, both through the same `aggregate3` path the register
 * uses, both pinned to the same block the caller pinned everything else to. A
 * listing that fails to decode stays a failure in its own row; it never becomes
 * an empty listing, which would read as "no offer" rather than "we could not
 * see".
 */
export async function readMarket(ctx: ReadContext): Promise<MarketView> {
  const [head] = await callBatch(ctx, [
    { target: ATS_MARKET, allowFailure: true, callData: `0x${MARKET_SELECTOR.nextListingId}` },
  ]);
  const next = mapOutcome(head as Outcome<string>, decodeUint);
  if (next.state !== "ok") return { count: next, listings: [], truncated: false };

  const total = next.value > 0n ? next.value - 1n : 0n;
  const walked = total > BigInt(LISTING_WALK_LIMIT) ? BigInt(LISTING_WALK_LIMIT) : total;
  /* Newest first: a market's interesting end is the recent one, and the walk
   * limit should cut off the oldest rather than the newest. */
  const ids: bigint[] = [];
  for (let i = 0n; i < walked; i++) ids.push(total - i);

  const results = await callBatch(
    ctx,
    ids.map((id) => ({
      target: ATS_MARKET,
      allowFailure: true,
      callData: `0x${MARKET_SELECTOR.getListing}${word(id)}`,
    })),
  );
  return {
    count: { state: "ok", value: total },
    listings: results.map((r, i) => mapOutcome(r, (data) => decodeListing(ids[i] as bigint, data))),
    truncated: total > walked,
  };
}

/** A read context aimed at the market, from what the app already has. */
export const marketContext = (
  request: EthRequest, chainId: number, host: () => string | undefined,
): ReadContext => ({
  request, chainId, token: ATS_MARKET, block: "latest", host,
});

/* ------------------------------------------------------------------ encoding */

/** One transaction, with its value already in the unit the relay expects. */
export interface MarketCall {
  to: string;
  data: string;
  /** WEIBAR. Zero for everything but a fill. */
  value: bigint;
  label: string;
}

/**
 * Approve the market to take the shares this listing escrows.
 *
 * Sized to the lot, never unlimited: the market pulls the shares at `list`, so
 * the allowance is the ceiling on what it can take, and there is no amount
 * being listed that makes "and everything else, forever" the right cap.
 */
export function encodeSecurityApprove(security: string, amount: bigint): MarketCall {
  if (amount <= 0n) throw new AbiError("an approval for nothing escrows nothing");
  return {
    to: security.toLowerCase(),
    data: `0x${selectorOf("approve(address,uint256)")}${addressWord(ATS_MARKET)}${word(amount)}`,
    value: 0n,
    label: `approve the market for ${amount} raw units of this security`,
  };
}

export function encodeList(security: string, amount: bigint, priceTotalTinybar: bigint): MarketCall {
  if (amount <= 0n) throw new AbiError("a listing of zero shares is refused by the contract");
  if (priceTotalTinybar <= 0n) throw new AbiError("a listing needs a price");
  return {
    to: ATS_MARKET,
    data: `0x${MARKET_SELECTOR.list}${addressWord(security)}${word(amount)}${word(priceTotalTinybar)}`,
    value: 0n,
    label: `list ${amount} raw units for ${formatTinybar(priceTotalTinybar)} HBAR`,
  };
}

export function encodeCancel(listingId: bigint): MarketCall {
  if (listingId <= 0n) throw new AbiError("listing ids start at 1");
  return {
    to: ATS_MARKET,
    data: `0x${MARKET_SELECTOR.cancel}${word(listingId)}`,
    value: 0n,
    label: `cancel listing ${listingId}`,
  };
}

/**
 * Buy a listed lot.
 *
 * Takes the LISTING, not a price. That is the safety property of this file: the
 * only figure that can reach the value field is the `priceTotal` that was read
 * off the chain, multiplied by the one constant that converts it, inside this
 * function. There is no exported way to pay a number of your own, so there is
 * no place for the 1e10 to be applied twice, in the wrong direction, or not at
 * all.
 */
export function encodeFill(listing: Listing): MarketCall {
  if (listing.status !== "open") {
    throw new AbiError(`listing ${listing.id} is ${listing.status}, not open`);
  }
  if (listing.priceTotal <= 0n) throw new AbiError("a listing with no price cannot be paid");
  return {
    to: ATS_MARKET,
    data: `0x${MARKET_SELECTOR.fill}${word(listing.id)}`,
    /* tinybar → weibar. The relay divides this by 1e10; the contract then
     * compares what arrives against priceTotal exactly. */
    value: listing.priceTotal * WEIBAR_PER_TINYBAR,
    label: `fill listing ${listing.id} for ${formatTinybar(listing.priceTotal)} HBAR`,
  };
}

/* --------------------------------------------------------------- descriptors */

export const MARKET_DESCRIPTOR_SOURCE = "local/ats-escrow-market";

/**
 * Descriptors for the market's three write calls.
 *
 * The market's address is a constant, unlike a security's, so this factory
 * takes only a chain — and every argument of all three signatures is static, so
 * the engine renders each of them in full rather than dropping the format.
 */
export function marketDescriptors(chainId: number, to: string): readonly Descriptor[] {
  if (to.toLowerCase() !== ATS_MARKET) return [];
  const parsed = parseDescriptor(
    {
      context: { contract: { deployments: [{ chainId, address: ATS_MARKET }] } },
      metadata: { owner: "ATS escrow market", contractName: "AtsEscrowMarket" },
      display: {
        formats: {
          "list(address security, uint256 amount, uint256 priceTotal)": {
            intent: "List shares for sale",
            fields: [
              { label: "Security", path: "#.security", format: "addressName" },
              { label: "Shares (raw)", path: "#.amount", format: "raw" },
              /* Raw, and labelled tinybar. An `amount` format would render this
               * against the chain's native 18 decimals and show a price 1e10
               * too small — the exact confusion this file exists to prevent. */
              { label: "Price (tinybar)", path: "#.priceTotal", format: "raw" },
            ],
          },
          "cancel(uint256 listingId)": {
            intent: "Withdraw a listing",
            fields: [{ label: "Listing", path: "#.listingId", format: "raw" }],
          },
          "fill(uint256 listingId)": {
            intent: "Buy a listed lot",
            fields: [{ label: "Listing", path: "#.listingId", format: "raw" }],
          },
        },
      },
    },
    MARKET_DESCRIPTOR_SOURCE,
  );
  return parsed === null ? [] : [parsed];
}

/**
 * A descriptor for `approve` on one security, so the listing approval can be
 * described.
 *
 * Separate from `atsDescriptors` because it is not a privileged action: it is
 * an ordinary ERC-20 approval that happens to be aimed at this market, and
 * folding it into the privileged table would put it in front of
 * `describePrivilegedCall`, which would then owe it a consequence line about an
 * issuer power it does not confer.
 */
export function securityApproveDescriptors(
  chainId: number, security: string,
): readonly Descriptor[] {
  const parsed = parseDescriptor(
    {
      context: { contract: { deployments: [{ chainId, address: security.toLowerCase() }] } },
      metadata: { owner: "ATS security", contractName: "ATS security" },
      display: {
        formats: {
          "approve(address spender, uint256 amount)": {
            intent: "Approve a spender",
            fields: [
              { label: "Spender", path: "#.spender", format: "addressName" },
              { label: "Shares (raw)", path: "#.amount", format: "raw" },
            ],
          },
        },
      },
    },
    MARKET_DESCRIPTOR_SOURCE,
  );
  return parsed === null ? [] : [parsed];
}

/* -------------------------------------------------------------------- asking */

/** What one attempted market action did. Mirrors act.ts's vocabulary. */
export type MarketOutcome =
  | { kind: "sent"; steps: Array<{ call: MarketCall; result: string }> }
  /** Nothing was signed. No state changed. */
  | { kind: "nothing-happened"; notice: string }
  /**
   * The dangerous one, and it only exists for `list`: the approval landed and
   * the listing did not, so the market can take shares that are not listed.
   */
  | { kind: "approved-not-listed"; token: string; amount: bigint; notice: string }
  | { kind: "cannot-ask"; notice: string };

/** Same sentence as act.ts's, named apart because both are re-exported. */
export const MARKET_NO_DEVICE_NOTICE =
  "Nothing was asked for and nothing was signed: this build has no way to " +
  "reach a device. Connect one and try again.";

export const NOTHING_HAPPENED_NOTICE =
  "The signature did not happen, so nothing changed on chain. That covers a " +
  "rejection on the device, a wallet that would not describe the call, and a " +
  "device that is no longer connected — an app is not told which, and the " +
  "reason is in the wallet's own log.";

export const APPROVED_NOT_LISTED_NOTICE =
  "The approval went through and the listing did not. The market can now take " +
  "the shares below out of this wallet and there is no listing on the other " +
  "side of it. This app will not retry on its own — the allowance has changed " +
  "since this plan was built. Either set the allowance back to zero, or start " +
  "again and let it read afresh.";

/**
 * Walk one or two calls past the user and the device, stopping at the first no.
 *
 * No retry, for the reason act.ts gives: each step is a press, and an app that
 * re-asks after a refusal teaches people to press through.
 */
export async function runMarket(
  context: AppContext,
  calls: readonly MarketCall[],
  /** Set when the first call is an approval, so a half-run can be named. */
  approvalOf?: { token: string; amount: bigint },
): Promise<MarketOutcome> {
  const propose = context.propose;
  if (!propose) return { kind: "cannot-ask", notice: MARKET_NO_DEVICE_NOTICE };

  const done: Array<{ call: MarketCall; result: string }> = [];
  for (const call of calls) {
    const outcome = await propose({
      kind: "call",
      to: call.to,
      data: call.data,
      ...(call.value > 0n ? { value: call.value } : {}),
      reason: `secondary market: ${call.label}`.slice(0, 120),
    });
    if (!outcome.ok || outcome.kind !== "call") {
      if (done.length > 0 && approvalOf !== undefined) {
        return {
          kind: "approved-not-listed",
          token: approvalOf.token,
          amount: approvalOf.amount,
          notice: APPROVED_NOT_LISTED_NOTICE,
        };
      }
      return { kind: "nothing-happened", notice: NOTHING_HAPPENED_NOTICE };
    }
    done.push({ call, result: outcome.result });
  }
  return { kind: "sent", steps: done };
}

/** The multicall this app reads the market through. Exported for a test. */
export const marketMulticall = (chainId: number): string => multicall3Address(chainId);
