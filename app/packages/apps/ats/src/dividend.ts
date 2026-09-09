/**
 * Declaring a dividend against a snapshot, and paying it out without paying
 * anyone twice (plan §4, milestone E4 / C3).
 *
 * ---------------------------------------------------------------------------
 * THE PROPERTY
 *
 * **A distribution whose total does not equal per-share × snapshot supply must
 * refuse.** Not "warns", not "rounds": refuses, before any calldata exists.
 * `planDividend` is the only constructor of a `DividendPlan`, every screen and
 * every payment is built from one, and the arithmetic below is the only route
 * through it. `test/dividend.test.ts` names that property and pins it.
 *
 * The reason it is a refusal rather than a correction is that there are two
 * numbers and no way to tell which one is wrong. An issuer who typed a total
 * that does not match the register has either mistyped the total or is looking
 * at a different snapshot than they think; silently substituting our own
 * product would ship the second case straight to the holders.
 *
 * ---------------------------------------------------------------------------
 * Two units, never mixed, never floating point
 *
 * - **Shares** are raw units of the security, scaled by its own `decimals()`.
 * - **Payment** is raw units of whatever ERC-20 the issuer pays in, scaled by
 *   that token's `decimals()`.
 *
 * `perShare` is payment units per ONE WHOLE share, which is how the plan's own
 * screen states it ("Per share 0.25 USDC"). So every conversion is
 *
 *     payment = perShare × shareUnits / 10^shareDecimals
 *
 * and that division must be exact. Everything here is `bigint`; a `number`
 * would silently stop being exact somewhere above 2^53, which for a six-decimal
 * token is nine billion units — a plausible dividend, not an absurd one.
 *
 * Inexact division is refused rather than floored. Flooring is where a
 * distribution stops reconciling: 14 holders each losing a sub-unit remainder
 * leaves a residue in the issuer's account that no line of the plan accounts
 * for, and "the totals nearly match" is not a property. Refusing says exactly
 * which holders cannot be paid a whole unit at this rate, and the remedy — a
 * finer per-share figure, or a token with more decimals — is the issuer's.
 *
 * ---------------------------------------------------------------------------
 * What the contracts do and do not do, because it changes the design
 *
 * `IDividend.setDividend((uint256 recordDate, uint256 executionDate, uint256
 * amount, uint8 amountDecimals))` **declares** a corporate action. It moves no
 * money: there is no `payDividend` anywhere in
 * `@hashgraph/asset-tokenization-contracts` 8.0.0. The register binds its own
 * snapshot when the record date is reached and then answers
 * `getDividendAmountFor(id, holder)` with a numerator/denominator; the actual
 * payment is a transfer of some other token, made by the issuer.
 *
 * That has two consequences this file is arranged around:
 *
 *  1. **The snapshot in the screen is ours, not the contract's.** `setDividend`
 *     takes no snapshot id. So the reconciliation is against a snapshot this
 *     console READ — `totalSupplyAtSnapshot(id)` and the holder balances at
 *     that id — and the screen says which id it used. The contract will bind
 *     its own at the record date, and if the register changes in between, the
 *     two are different. `SNAPSHOT_BINDING_CAVEAT` is that sentence, and it is
 *     shown wherever the plan is.
 *  2. **The payout is N ordinary ERC-20 transfers**, each of which is its own
 *     approval on the device. Which is where double-paying becomes possible,
 *     and why the ledger below exists.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { formatUnits } from "@leekwallet/core/chains.ts";
import { sanitiseText } from "./abi.ts";

/* ------------------------------------------------------------------ inputs */

/** A snapshot as the register reported it. Every figure is from a read. */
export interface SnapshotFacts {
  /** 1-based snapshot id, as `SnapshotRow.id`. */
  id: bigint;
  /** `totalSupplyAtSnapshot(id)`, raw share units. */
  totalSupply: bigint;
  /** `getTotalTokenHoldersAtSnapshot(id)`. */
  holderCount: bigint;
  /** The security's `decimals()`. Not the payment token's. */
  decimals: number;
}

/**
 * The token the dividend is paid in.
 *
 * `reportedSymbol` is `symbol()` off that contract and is believed by nobody:
 * any contract can call itself USDC. It is carried so the screen can quote it
 * AS a quotation (PROTOCOL.md 6d) and never as a fact — see `describeToken`.
 */
export interface PaymentToken {
  /** Lower-case 0x address of the ERC-20 the holders are paid in. */
  address: string;
  /** Its own `decimals()`. */
  decimals: number;
  /** `symbol()`, unverified and unverifiable. Optional; absent is fine. */
  reportedSymbol?: string | undefined;
}

/** One holder's balance at the snapshot, from `balancesOfAtSnapshot`. */
export interface SnapshotHolder {
  address: string;
  /** Raw share units held at that snapshot. */
  shares: bigint;
}

/** What the issuer is proposing. Every field is theirs except the snapshot. */
export interface DividendTerms {
  snapshot: SnapshotFacts;
  token: PaymentToken;
  /** Payment raw units per one WHOLE share. */
  perShare: bigint;
  /**
   * The total the issuer states, in payment raw units.
   *
   * Stated rather than derived, deliberately. A total this file computed and
   * then displayed would agree with itself no matter what was typed, and the
   * audit gate is precisely that the two are compared.
   */
  statedTotal: bigint;
  /** Unix seconds. The register takes its own snapshot at this instant. */
  recordDate: bigint;
  /** Unix seconds. When the declared dividend becomes payable. */
  executionDate: bigint;
}

/* ------------------------------------------------------------------ output */

/** One holder's payment, in payment raw units. */
export interface Allocation {
  address: string;
  shares: bigint;
  amount: bigint;
}

/**
 * A checked distribution.
 *
 * Only `planDividend` returns one. Nothing else in this app constructs the
 * type, and `encodeDividend` re-runs the arithmetic on whatever it is handed,
 * so a plan assembled by hand in a test or by a future caller cannot become
 * calldata with a total nobody checked.
 */
export interface DividendPlan {
  state: "plan";
  terms: DividendTerms;
  /** The total this console computed. Equal to `terms.statedTotal`, checked. */
  total: bigint;
  /** Every holder at the snapshot, in the order the register returned them. */
  allocations: readonly Allocation[];
  /**
   * Identity of this exact distribution: chain, security, snapshot, rate, and
   * every allocation. A ledger only resumes against the plan it was opened
   * for — see `resumeDistribution`.
   */
  planId: string;
}

export interface DividendRefusal {
  state: "refused";
  why: string;
}

const refuse = (why: string): DividendRefusal => ({ state: "refused", why });

/**
 * The caveat that travels with every dividend screen.
 *
 * Consequence 1 of the header, in one sentence. It is not a disclaimer: the
 * reconciliation is exact against the snapshot named, and inexact against
 * whatever the register looks like at the record date, and the person pressing
 * the button is the only one who can close that gap.
 */
export const SNAPSHOT_BINDING_CAVEAT =
  "setDividend takes no snapshot id: the register binds its own snapshot when " +
  "the record date is reached. The figures here reconcile against snapshot " +
  "#SNAPSHOT as this console read it. If the register changes before the " +
  "record date, they will not be the same set of holders.";

/** That sentence with the id filled in. */
export const snapshotBindingCaveat = (id: bigint): string =>
  SNAPSHOT_BINDING_CAVEAT.replace("#SNAPSHOT", `#${id}`);

/* -------------------------------------------------------------- the maths */

/**
 * `perShare × shares / 10^decimals`, exactly, or undefined.
 *
 * Undefined means the product is not a whole number of payment units. The
 * caller refuses; nothing here rounds in either direction.
 */
export function paymentFor(perShare: bigint, shares: bigint, shareDecimals: number)
  : bigint | undefined {
  if (perShare < 0n || shares < 0n) return undefined;
  const scale = 10n ** BigInt(shareDecimals);
  const product = perShare * shares;
  return product % scale === 0n ? product / scale : undefined;
}

/**
 * THE PROPERTY, on its own, so it can be read and tested without a plan.
 *
 * Returns the total a distribution at this rate over this snapshot MUST have,
 * or a refusal. A caller that has a stated total compares the two; a caller
 * that has none cannot make one up, because there is no other function here
 * that produces a total.
 */
export function totalForSnapshot(
  perShare: bigint,
  snapshot: SnapshotFacts,
): { state: "ok"; total: bigint } | DividendRefusal {
  if (perShare <= 0n) return refuse("the per-share amount must be a positive number of payment units");
  if (snapshot.totalSupply <= 0n) {
    return refuse(`snapshot #${snapshot.id} has no supply, so there is nothing to distribute against`);
  }
  if (!Number.isInteger(snapshot.decimals) || snapshot.decimals < 0 || snapshot.decimals > 77) {
    return refuse("the security's decimals were not read, so shares cannot be restated");
  }
  const total = paymentFor(perShare, snapshot.totalSupply, snapshot.decimals);
  if (total === undefined) {
    return refuse(
      `per-share × snapshot supply is not a whole number of payment units ` +
      `(${perShare} × ${snapshot.totalSupply} / 10^${snapshot.decimals}); ` +
      "no total is representable at this rate",
    );
  }
  return { state: "ok", total };
}

/* --------------------------------------------------------------- planning */

/**
 * Check a proposed distribution against the snapshot, or refuse.
 *
 * The order of the checks is the order of the consequences: the total first,
 * because it is the audit gate; then that the holder list is the whole list,
 * because a distribution over a partial register underpays whoever is missing;
 * then that the balances add up to the supply the total was computed from,
 * because otherwise "reconciles to the snapshot" is a sentence about two
 * different snapshots; then each holder's own amount.
 */
export function planDividend(
  chainId: number,
  security: string,
  terms: DividendTerms,
  holders: readonly SnapshotHolder[],
): DividendPlan | DividendRefusal {
  const computed = totalForSnapshot(terms.perShare, terms.snapshot);
  if (computed.state !== "ok") return computed;

  /* THE PROPERTY. Stated against computed, both in raw payment units, no
   * tolerance — a dividend that is one unit out is one unit that has to come
   * from somewhere, and the difference between 3,500.00 and 3,500.01 is the
   * difference between an issuer who checked and one who did not. */
  if (terms.statedTotal !== computed.total) {
    return refuse(
      `the stated total ${terms.statedTotal} does not equal per-share × snapshot ` +
      `supply, which is ${computed.total} (${terms.perShare} per whole share × ` +
      `${terms.snapshot.totalSupply} raw shares at ${terms.snapshot.decimals} decimals). ` +
      "Nothing is declared and nothing is paid.",
    );
  }

  if (BigInt(holders.length) !== terms.snapshot.holderCount) {
    return refuse(
      `the snapshot reports ${terms.snapshot.holderCount} holders and this list has ` +
      `${holders.length}. A distribution over part of the register underpays whoever ` +
      "is not on it.",
    );
  }

  let sumShares = 0n;
  for (const h of holders) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(h.address)) {
      return refuse(`${h.address} is not a 20-byte address, so it cannot be paid`);
    }
    if (h.shares < 0n) return refuse(`${h.address} has a negative balance at the snapshot`);
    sumShares += h.shares;
  }
  if (sumShares !== terms.snapshot.totalSupply) {
    return refuse(
      `the holders' balances add up to ${sumShares} raw shares and the snapshot's total ` +
      `supply is ${terms.snapshot.totalSupply}. These are two different registers; the ` +
      "total above reconciles to neither.",
    );
  }

  const allocations: Allocation[] = [];
  const indivisible: string[] = [];
  for (const h of holders) {
    const amount = paymentFor(terms.perShare, h.shares, terms.snapshot.decimals);
    if (amount === undefined) { indivisible.push(h.address); continue; }
    allocations.push({ address: h.address.toLowerCase(), shares: h.shares, amount });
  }
  if (indivisible.length > 0) {
    return refuse(
      `${indivisible.length} holder(s) cannot be paid a whole number of payment units at ` +
      `this rate, starting with ${indivisible[0]}. Rounding them would leave a residue ` +
      "the total does not account for, so nothing is declared. Use a finer per-share " +
      "figure, or a payment token with more decimals.",
    );
  }

  /* Belt and braces, and the brace is cheap: the allocations must sum to the
   * total that will be on the device screen. Exact division makes this true by
   * construction — which is exactly why it is worth asserting, because a
   * future change to the rounding rule would break it here rather than in a
   * holder's balance. */
  const sumPaid = allocations.reduce((a, x) => a + x.amount, 0n);
  if (sumPaid !== computed.total) {
    return refuse(
      `the per-holder amounts add up to ${sumPaid}, not to the total ${computed.total}`,
    );
  }

  return {
    state: "plan",
    terms,
    total: computed.total,
    allocations,
    planId: planIdOf(chainId, security, terms, allocations),
  };
}

/**
 * The identity of a distribution.
 *
 * keccak over every figure that could make two distributions different: the
 * chain, the security, the payment token, the snapshot, the rate, the dates,
 * and every allocation in order. It is not a security boundary — it protects
 * against a mistake, not an attacker — but the mistake it protects against is
 * resuming yesterday's half-finished payout against today's plan, which pays
 * somebody twice.
 */
function planIdOf(
  chainId: number,
  security: string,
  terms: DividendTerms,
  allocations: readonly Allocation[],
): string {
  const parts = [
    String(chainId), security.toLowerCase(), terms.token.address.toLowerCase(),
    String(terms.token.decimals), terms.snapshot.id.toString(),
    terms.snapshot.totalSupply.toString(), String(terms.snapshot.decimals),
    terms.perShare.toString(), terms.statedTotal.toString(),
    terms.recordDate.toString(), terms.executionDate.toString(),
    ...allocations.map((a) => `${a.address}:${a.amount}`),
  ];
  const h = keccak_256(new TextEncoder().encode(parts.join("|")));
  return `0x${[...h].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/* ------------------------------------------------------------- the ledger */

/**
 * What is known about one holder's payment.
 *
 * Three states, and the third is the one that makes this honest. A wallet that
 * proposed a transfer and did not get a transaction hash back does NOT know
 * whether the transfer happened: the device may have signed and the broadcast
 * may have landed while the answer was lost. So that holder is `uncertain`,
 * and an uncertain holder is never paid again automatically — the run stops
 * there and a person decides, having looked at the chain.
 *
 * The alternative, retrying on failure, is the one behaviour that turns a
 * dropped connection into a double payment. It is not offered anywhere in this
 * file, and `nextPayment` returning `blocked` is how it stays unoffered.
 */
export type PaymentRecord =
  /** Broadcast, with the hash the wallet returned. */
  | { state: "paid"; tx: string }
  /** Asked for, outcome unknown. Blocks the run until a human resolves it. */
  | { state: "uncertain"; why: string }
  /** A human looked at the chain and says this holder was not paid. */
  | { state: "not-paid"; why: string };

/**
 * The record of a distribution in progress.
 *
 * Plain data, so a caller may write it wherever it keeps state and hand it
 * back. It carries `planId` so that handing back the WRONG one is a refusal
 * rather than a payout.
 */
export interface DistributionLedger {
  planId: string;
  /** Keyed by lower-case holder address. Absent means "not yet asked". */
  records: Record<string, PaymentRecord>;
}

export const openLedger = (plan: DividendPlan): DistributionLedger =>
  ({ planId: plan.planId, records: {} });

/** What a run should do next. */
export type DistributionStep =
  /** Pay this holder. `index` is its position in the plan, for the UI. */
  | { state: "pay"; index: number; allocation: Allocation }
  /** Every holder has a `paid` record. */
  | { state: "complete"; paid: number; total: bigint }
  /**
   * Stopped, and not resumable by this app. Either an outcome is unknown, or
   * the ledger belongs to a different plan.
   */
  | { state: "blocked"; why: string };

/**
 * The next payment, or why there is not one.
 *
 * Scans in plan order and stops at the first holder that is not `paid`:
 *
 *  - no record, or `not-paid`  → pay them
 *  - `uncertain`               → blocked, because paying could be paying twice
 *
 * There is no "skip the uncertain one and carry on". Carrying on would finish
 * the run and report success with one holder in an unknown state, and the
 * report is the thing an issuer would then file.
 */
export function nextPayment(plan: DividendPlan, ledger: DistributionLedger): DistributionStep {
  if (ledger.planId !== plan.planId) {
    return {
      state: "blocked",
      why:
        "this record of payments was opened for a different distribution — a different " +
        "snapshot, rate, or set of holders. Resuming it against this plan is how a " +
        "holder gets paid twice, so it refuses.",
    };
  }
  let paid = 0;
  for (let i = 0; i < plan.allocations.length; i++) {
    const a = plan.allocations[i] as Allocation;
    const record = ledger.records[a.address];
    if (record?.state === "paid") { paid++; continue; }
    if (record?.state === "uncertain") {
      return {
        state: "blocked",
        why:
          `${a.address} was asked for and the outcome is not known (${record.why}). ` +
          "Check that address on an explorer and mark it paid or not paid; this app " +
          "will not guess, because guessing wrong pays it twice.",
      };
    }
    return { state: "pay", index: i, allocation: a };
  }
  return { state: "complete", paid, total: plan.total };
}

/** Record an outcome. Returns a new ledger; the old one is not mutated. */
export function record(
  ledger: DistributionLedger,
  address: string,
  outcome: PaymentRecord,
): DistributionLedger {
  return {
    planId: ledger.planId,
    records: { ...ledger.records, [address.toLowerCase()]: outcome },
  };
}

/**
 * Adopt a ledger from a previous run, or refuse.
 *
 * Separate from `nextPayment` so that "can this be resumed at all" is a
 * question with its own answer, and so a UI can ask it before showing a resume
 * button that would immediately refuse.
 */
export function resumeDistribution(
  plan: DividendPlan,
  ledger: DistributionLedger,
): { state: "resumed"; ledger: DistributionLedger; done: number; remaining: number }
  | DividendRefusal {
  if (ledger.planId !== plan.planId) {
    return refuse(
      "that record of payments belongs to a different distribution; it cannot be " +
      "resumed against this plan",
    );
  }
  const known = new Set(plan.allocations.map((a) => a.address));
  for (const address of Object.keys(ledger.records)) {
    if (!known.has(address.toLowerCase())) {
      return refuse(`the record mentions ${address}, who is not a holder in this plan`);
    }
  }
  const done = plan.allocations.filter((a) => ledger.records[a.address]?.state === "paid").length;
  return { state: "resumed", ledger, done, remaining: plan.allocations.length - done };
}

/** What has been paid so far, in payment raw units. For the progress line. */
export function paidSoFar(plan: DividendPlan, ledger: DistributionLedger): bigint {
  if (ledger.planId !== plan.planId) return 0n;
  return plan.allocations.reduce(
    (sum, a) => (ledger.records[a.address]?.state === "paid" ? sum + a.amount : sum),
    0n,
  );
}

/* ---------------------------------------------------------------- wording */

/**
 * The payment token, as text that claims nothing.
 *
 * The symbol is the token contract's own answer to `symbol()` and this app has
 * verified nothing about it, so it appears in quotes, attributed, and never as
 * the unit of a number: "3500.00 (unverified symbol "USDC", token 0x…)". That
 * is the same rule `chainLabelDetailed()` and `TOKEN_HINT_NOTICE` apply — a
 * symbol printed as a bare unit is a claim, and the only thing here anybody can
 * check is the address.
 */
export function describeToken(token: PaymentToken): string {
  const symbol = token.reportedSymbol === undefined
    ? undefined : sanitiseText(token.reportedSymbol, 16);
  const where = `token ${token.address}`;
  return symbol === undefined
    ? `${where} (it reports no symbol)`
    : `${where}, which calls itself "${symbol}" — unverified`;
}

/** An amount of the payment token: exact raw units, restated, never a symbol. */
export const paymentAmount = (raw: bigint, token: PaymentToken): string =>
  `${formatUnits(raw, token.decimals)} (${raw} raw units)`;

/**
 * The distribution as lines, for the console's own summary.
 *
 * Not the device screen — that is `describePrivilegedCall`'s, built from the
 * calldata. This is the plan beside it, and the two are separate on purpose:
 * this one knows about the snapshot and the holders, and the device only ever
 * sees the four numbers that are actually in the transaction.
 */
export function renderDividendPlan(plan: DividendPlan): string {
  const t = plan.terms;
  return [
    `Snapshot  #${t.snapshot.id} (${t.snapshot.holderCount} holders, ` +
      `${formatUnits(t.snapshot.totalSupply, t.snapshot.decimals)} shares)`,
    `Per share ${paymentAmount(t.perShare, t.token)} per whole share`,
    `Total     ${paymentAmount(plan.total, t.token)}`,
    `Paid in   ${describeToken(t.token)}`,
    `Holders   ${plan.allocations.length}, each an approval of its own`,
    snapshotBindingCaveat(t.snapshot.id),
  ].join("\n");
}
