/**
 * Attended DCA — a schedule of positions, each one still signed by a person.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE BELIEVING ANYTHING ELSE IN THIS FILE
 *
 * **This module has never been exercised on mainnet.** Nothing here has
 * shipped a real tranche, been filled by a real taker, or been docked on a
 * real chain. What is true of it is exactly this: it is pure, it is unit
 * tested, the calldata it plans decodes through `readOrderProgram()`, and the
 * device would render it. That is "available". It is not "proven", and the two
 * must not be allowed to blur — this project has already had to withdraw three
 * claims that were stated more confidently than the evidence behind them, and
 * a fourth is not free.
 *
 * ---------------------------------------------------------------------------
 * Why "attended", and why that word is load-bearing
 *
 * DCA is not on the Aqua router. `_twap` belongs to the limit-order router's
 * opcode set, and — measured, 2026-09-10, against `1inch/swap-vm` at
 * `afd99c4` — **there is no `TWAPSwap.sol` in that repository at all**; the
 * string "twap" does not appear in it. So there is no audited instruction to
 * port. See `docs/STRATEGIES.md` §4 for the full evaluation and for the
 * EIP-170 measurements that go with it.
 *
 * That leaves the keeper pattern: dock, re-ship, on a schedule. And a keeper
 * runs straight into the one thing this wallet will not do.
 *
 *   **A keeper cannot sign.** Every `ship` is a maker signature, and the maker
 *   key is on a device behind a physical button.
 *
 * So there are two possible products and only one of them belongs here:
 *
 *   - *Unattended DCA* needs a hot key with standing authority to ship. That
 *     is the precise thing this wallet exists not to have. Not built, and not
 *     buildable here without abandoning the premise.
 *   - *Attended DCA* — this module. The schedule is real and computed ahead of
 *     time; each tranche's calldata is prepared and then WAITS. A tranche
 *     becomes a transaction when a person presses a button, and never
 *     otherwise.
 *
 * Calling the second one "automated DCA" would be the same class of error as
 * calling a 1e9-base number "bps": it reads correctly and it is not true. So
 * this module says "attended" everywhere, including in the sentences it hands
 * the UI, and `plan()` returns `attended: true` as a field rather than as a
 * comment so a caller cannot render it without having seen it.
 *
 * ---------------------------------------------------------------------------
 * The economics, stated rather than hidden
 *
 * 1inch's own guidance for scheduled orders puts a sensible
 * `minTradeAmountOut` at roughly 1000x the gas cost of the fill in
 * output-token terms — on an L2 that lands in the hundreds of dollars per
 * tranche. The funded maker here holds about **2 USDC**. A DCA campaign over
 * 2 USDC produces tranches worth fractions of a cent: far below any dust
 * guard's purpose, and below the gas to fill them.
 *
 * That is a real limitation and it is not papered over: `plan()` computes
 * `economic: false` whenever a tranche is smaller than `minTrancheOut`, and
 * the caller is expected to show `UNECONOMIC_NOTICE`. The mechanism is
 * demonstrable at this size; the economics are not, and a schedule that
 * implies otherwise would be the overclaim this file's header warns about.
 */

import { AbiError } from "@leekwallet/core/balances.ts";
import {
  buildPosition, type MidPrice, type RiskTier, type TokenSpec, type Position,
} from "./authoring.ts";

/** The one sentence a caller must not drop. */
export const ATTENDED_NOTICE =
  "This is an attended schedule, not an automation. Each tranche is prepared " +
  "ahead of time and then waits: it becomes a transaction only when you " +
  "approve it on the device, and never on its own. Nothing here holds a key, " +
  "and nothing here can ship while you are away.";

/** Shown whenever a tranche is too small to be worth filling. */
export const UNECONOMIC_NOTICE =
  "These tranches are smaller than the gas it would cost a taker to fill " +
  "them, so in practice nobody will. The schedule is correct and the device " +
  "will render it; it is a demonstration of the mechanism at a size at which " +
  "the economics do not work. Fund more, or lengthen the interval, if you " +
  "want tranches anyone would take.";

/** Shown always, because it is the thing most likely to be assumed away. */
export const UNPROVEN_NOTICE =
  "No tranche from this planner has ever been shipped on a live chain. What " +
  "is checked is that the calldata decodes and that the device would render " +
  "it — not that it trades.";

export interface DcaRequest {
  readonly maker: string;
  readonly a: TokenSpec;
  readonly b: TokenSpec;
  readonly mid: MidPrice;
  readonly tier: RiskTier;
  readonly gateToken: string;
  readonly feePercent: string;
  /** Total to spend across the whole schedule, in raw units of `spendToken`. */
  readonly total: bigint;
  /** Which of the two tokens is being spent down. Must be `a` or `b`. */
  readonly spendToken: string;
  /** How many tranches. Bounded — see `MAX_TRANCHES`. */
  readonly tranches: number;
  /** Unix seconds at which tranche 0 becomes shippable. */
  readonly startAt: bigint;
  /** Seconds between tranches. Also each tranche's `deadline` window. */
  readonly intervalSeconds: number;
  /**
   * Below this many raw units of output, a tranche is flagged uneconomic.
   * No default: a silent default here would be a number nobody chose deciding
   * whether a warning appears.
   */
  readonly minTrancheOut: bigint;
  /** 8 bytes of entropy. Tranche `n` salts with this XOR'd by `n`. */
  readonly saltSeed: Uint8Array;
}

/**
 * A cap on schedule length.
 *
 * Every tranche is one device approval, so a hundred-tranche schedule is a
 * hundred button presses nobody will perform — a schedule longer than a person
 * will actually attend is a schedule that silently stops part way, leaving
 * approvals standing with no position behind them. Bounded low on purpose.
 */
export const MAX_TRANCHES = 24;

export interface Tranche {
  readonly index: number;
  /** Unix seconds this tranche becomes shippable. */
  readonly shipAfter: bigint;
  /** Its own `deadline`, one interval past `shipAfter`. */
  readonly deadline: bigint;
  /** Raw units of `spendToken` this tranche ships. */
  readonly amount: bigint;
  /** The position itself: program, strategy, band, all decodable. */
  readonly position: Position;
}

export interface DcaPlan {
  /** Always true. A field, not a comment, so it cannot be rendered unseen. */
  readonly attended: true;
  readonly tranches: readonly Tranche[];
  /** False when any tranche is below `minTrancheOut`. Show `UNECONOMIC_NOTICE`. */
  readonly economic: boolean;
  /** Sum of every tranche's amount. Equals `total` exactly — see below. */
  readonly totalPlanned: bigint;
  /** The sentences a caller must show. All of them, not a selection. */
  readonly notices: readonly string[];
}

/**
 * Plan a schedule.
 *
 * Pure: no clock, no network, no randomness. `startAt` is passed in rather
 * than read from `Date.now()` so the same request always plans the same bytes,
 * which is what makes the plan reviewable before it is signed.
 *
 * The division deliberately gives the remainder to the LAST tranche rather
 * than dropping it. `total` is what the user said they would spend, and a
 * schedule that quietly spends 1.999999 of 2.000000 USDC has produced a number
 * nobody asked for. Summed, the tranches equal `total` exactly, and that is
 * asserted rather than assumed.
 */
export function planDca(req: DcaRequest): DcaPlan {
  if (!Number.isInteger(req.tranches) || req.tranches < 2) {
    throw new AbiError("a schedule needs at least two tranches, or it is not a schedule");
  }
  if (req.tranches > MAX_TRANCHES) {
    throw new AbiError(
      `at most ${MAX_TRANCHES} tranches: each one is a separate press on the ` +
      "device, and a schedule longer than a person will attend is one that " +
      "stops part way with approvals still standing",
    );
  }
  if (req.total <= 0n) throw new AbiError("a schedule with nothing to spend spends nothing");
  if (req.total < BigInt(req.tranches)) {
    throw new AbiError("fewer raw units than tranches — some tranche would ship zero");
  }
  if (!Number.isInteger(req.intervalSeconds) || req.intervalSeconds <= 0) {
    throw new AbiError("the interval must be a positive number of seconds");
  }
  if (req.startAt <= 0n) throw new AbiError("the start time must be a positive unix time");
  if (req.saltSeed.length !== 8) throw new AbiError("the salt seed must be exactly 8 bytes");

  const spend = req.spendToken.toLowerCase();
  if (spend !== req.a.address.toLowerCase() && spend !== req.b.address.toLowerCase()) {
    throw new AbiError("the spent token is not one of the pair's two tokens");
  }

  const each = req.total / BigInt(req.tranches);
  const remainder = req.total - each * BigInt(req.tranches);
  const interval = BigInt(req.intervalSeconds);

  const tranches: Tranche[] = [];
  for (let i = 0; i < req.tranches; i++) {
    const shipAfter = req.startAt + interval * BigInt(i);
    const salt = Uint8Array.from(req.saltSeed);
    /* Distinct bytes per tranche so two tranches of one schedule cannot
     * collide in `_balances[maker][app][hash][token]`. XOR across the low two
     * bytes covers MAX_TRANCHES with room to spare. */
    salt[6] = (salt[6] as number) ^ ((i >> 8) & 0xff);
    salt[7] = (salt[7] as number) ^ (i & 0xff);

    tranches.push({
      index: i,
      shipAfter,
      deadline: shipAfter + interval,
      /* The last tranche carries the remainder, so the sum is exact. */
      amount: i === req.tranches - 1 ? each + remainder : each,
      position: buildPosition({
        maker: req.maker, a: req.a, b: req.b, mid: req.mid, tier: req.tier,
        deadline: shipAfter + interval,
        gateToken: req.gateToken, feePercent: req.feePercent, salt,
      }),
    });
  }

  const totalPlanned = tranches.reduce((s, t) => s + t.amount, 0n);
  /* Not an assumption. If the arithmetic above ever stops being exact, this
   * is where it stops rather than where it starts spending the wrong amount. */
  if (totalPlanned !== req.total) {
    throw new AbiError("the tranches do not sum to the total — refusing to plan");
  }

  const economic = tranches.every((t) => t.amount >= req.minTrancheOut);
  const notices = [ATTENDED_NOTICE, UNPROVEN_NOTICE];
  if (!economic) notices.push(UNECONOMIC_NOTICE);

  return { attended: true, tranches, economic, totalPlanned, notices };
}

/**
 * Which tranche, if any, is shippable at `now`.
 *
 * Returns the first tranche whose window is open — `shipAfter <= now <
 * deadline`. A tranche whose window has closed is skipped rather than shipped
 * late: its `deadline` opcode would make the position expire on arrival, and
 * shipping one is spending gas to create nothing. `undefined` means "wait", and
 * the caller must be able to tell that apart from "done", which is why
 * `remaining` exists beside it.
 */
export function shippableAt(plan: DcaPlan, now: bigint): Tranche | undefined {
  return plan.tranches.find((t) => t.shipAfter <= now && now < t.deadline);
}

/** How many tranches have not yet had their window close. */
export function remaining(plan: DcaPlan, now: bigint): number {
  return plan.tranches.filter((t) => now < t.deadline).length;
}
