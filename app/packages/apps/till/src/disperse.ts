/**
 * Paying everybody in two transactions instead of two per person.
 *
 * ---------------------------------------------------------------------------
 * Why this exists, and what it deliberately does not do
 *
 * A payroll of N people is 2N transfers, and this app sends each as its own
 * transaction with its own device confirmation — which is the honest thing and
 * also, at ten staff, twenty presses. Disperse does many ERC-20 transfers in
 * one transaction, so the same payroll becomes an approval plus two calls.
 *
 * **Two calls, not one.** Salaries go in one disperse and tips in another. The
 * whole argument of payroll.ts is that a wage and money held for the staff who
 * earned it are different money and must stay separately readable on chain;
 * folding them into a single batch to save one press would trade the point of
 * the feature for a press. Two batches keep two totals, two transactions and
 * two sets of events — and the device still shows every recipient.
 *
 * **No total page on the device.** The firmware draws one page per recipient
 * and deliberately no sum: a total is the number somebody checks INSTEAD of the
 * list, and the list is what leaves the wallet.
 *
 * ---------------------------------------------------------------------------
 * The bound, and why it is nine
 *
 * `disperseToken` encodes as 164 + 64N bytes and the device holds 768
 * (ETH_MAX_DATA), so nine recipients is 740 and ten is 804. The firmware
 * refuses the tenth as a call it cannot hold rather than drawing nine of ten —
 * and this module refuses it first, with a sentence, rather than letting a
 * payroll reach the device and die there.
 *
 * A larger payroll is more than one run. That is worse than one press and much
 * better than a screen that showed eight of ten payments.
 */

import { AbiError } from "@leekwallet/core/balances.ts";

/** `ETH_DISPERSE_MAX_RECIPIENTS` in src/eth-decode.h, mirrored. */
export const DISPERSE_MAX_RECIPIENTS = 9;

/**
 * Disperse on Arc testnet.
 *
 * Not ours and not deployed by us: the canonical Disperse contract, already on
 * chain, carrying `disperseToken`, `disperseTokenSimple` and `disperseEther`.
 * We use `disperseToken` only.
 *
 * `disperseEther` would send the NATIVE token, which on Arc is USDC at 18
 * decimals — a different asset from the 6-decimal ERC-20 USDC this app pays
 * in, and confusing the two is a 10^12 mistake. This module never calls it.
 */
export const DISPERSE = "0xd15fe25ed0dba12fe05e7029c88b10c25e8880e3";

const SELECTOR_DISPERSE_TOKEN = "c73a2d60";   // disperseToken(address,address[],uint256[])
const SELECTOR_APPROVE = "095ea7b3";          // approve(address,uint256)

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

const word = (v: bigint): string => {
  if (v < 0n) throw new AbiError("a negative value has no ABI encoding");
  const h = v.toString(16);
  if (h.length > 64) throw new AbiError("value does not fit a uint256");
  return h.padStart(64, "0");
};

const addressWord = (a: string): string => {
  if (!HEX40.test(a)) throw new AbiError(`${a} is not a 20-byte address`);
  return a.slice(2).toLowerCase().padStart(64, "0");
};

export interface DisperseLeg {
  readonly to: string;
  readonly units: bigint;
}

export interface DisperseCall {
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
  readonly label: string;
}

/**
 * The approval Disperse needs before it can move anything.
 *
 * Capped at exactly the batch total, never unlimited: Disperse pulls with
 * `transferFrom`, so the allowance is the real ceiling on what it can take, and
 * an unlimited one outlives the payroll it was granted for.
 */
export function encodeDisperseApproval(token: string, total: bigint): DisperseCall {
  if (total <= 0n) throw new AbiError("an approval for nothing disperses nothing");
  return {
    to: token.toLowerCase(),
    data: `0x${SELECTOR_APPROVE}${addressWord(DISPERSE)}${word(total)}`,
    value: 0n,
    label: `approve Disperse for ${total} raw units`,
  };
}

/**
 * One `disperseToken` call.
 *
 * The canonical encoding, and only that: the recipients array immediately
 * after the head, the values array immediately after it, equal lengths. The
 * device refuses anything else, so producing anything else would be building a
 * transaction that cannot be signed.
 */
export function encodeDisperse(
  token: string, legs: readonly DisperseLeg[], what: string,
): DisperseCall {
  if (legs.length === 0) throw new AbiError("a disperse with no recipients pays nobody");
  if (legs.length > DISPERSE_MAX_RECIPIENTS) {
    throw new AbiError(
      `${legs.length} recipients is more than the device will draw ` +
      `(${DISPERSE_MAX_RECIPIENTS}); split the payroll into more than one run`,
    );
  }
  for (const leg of legs) {
    if (leg.units <= 0n) throw new AbiError("a payment of zero is not a payment");
  }

  const n = BigInt(legs.length);
  const offRecipients = 3n * 32n;
  const offValues = offRecipients + 32n + n * 32n;

  const head = addressWord(token) + word(offRecipients) + word(offValues);
  const recipients = word(n) + legs.map((l) => addressWord(l.to)).join("");
  const values = word(n) + legs.map((l) => word(l.units)).join("");

  return {
    to: DISPERSE,
    data: `0x${SELECTOR_DISPERSE_TOKEN}${head}${recipients}${values}`,
    value: 0n,
    label: `${what}: ${legs.length} payment(s) in one transaction`,
  };
}

export interface DispersePlan {
  readonly approval: DisperseCall;
  /** Salaries and tips, each its own call. Never merged — see the header. */
  readonly salaries: DisperseCall | undefined;
  readonly tips: DisperseCall | undefined;
  readonly totalUnits: bigint;
}

export type DisperseRefusal = { ok: false; reason: string };

/**
 * Build the whole run: one approval, then salaries, then tips.
 *
 * A leg with no tips contributes nothing to the tips batch rather than a zero
 * transfer — a zero-value transfer is a transaction that says a payment
 * happened when none did, and some tokens revert on it anyway.
 */
export function planDisperse(
  token: string,
  salaryLegs: readonly DisperseLeg[],
  tipsLegs: readonly DisperseLeg[],
): DispersePlan | DisperseRefusal {
  try {
    const salaries = salaryLegs.length > 0
      ? encodeDisperse(token, salaryLegs, "Salaries") : undefined;
    const tips = tipsLegs.length > 0
      ? encodeDisperse(token, tipsLegs, "Tips") : undefined;
    if (salaries === undefined && tips === undefined) {
      return { ok: false, reason: "There is nothing to pay." };
    }
    const total = [...salaryLegs, ...tipsLegs].reduce((a, l) => a + l.units, 0n);
    return {
      approval: encodeDisperseApproval(token, total),
      salaries, tips, totalUnits: total,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? String(e) };
  }
}
