/**
 * Noticing that the bill was paid.
 *
 * The terminal prints a QR and then has to answer one question, repeatedly, for
 * a customer standing at a table: *has it arrived?* This file reads `Transfer`
 * logs to the merchant address on every rail and answers it.
 *
 * ---------------------------------------------------------------------------
 * The failure mode this whole file is shaped around
 *
 * **A chain we could not reach is `unknown`, never `unpaid`.**
 *
 * "No payment on Base" and "we could not ask Base" are the same absence of
 * evidence and completely different facts. Rendering them alike tells a
 * customer who has already paid that they have not, which invites them to pay
 * twice — the worst thing a point of sale can do, and worse than showing
 * nothing at all. Aqua's positions.ts states the same rule for a different
 * screen; this follows its shape deliberately rather than inventing a second
 * one:
 *
 *  1. **The result is a union with a named reason**, not a list plus a boolean.
 *     `unknown` carries *why*, as far as the screen.
 *  2. **A partial scan is refused wholesale.** If any chunk of a chain's block
 *     range fails, that chain is `unknown`. Returning the logs from the chunks
 *     that did answer would be a shorter list of payments presented as *the*
 *     list — and a missing payment is invisible, so there is no way to mark it.
 *  3. **A chain with no endpoint is `unknown` too**, not skipped. An app must
 *     not build its own RPC client (mini-app.ts), so the shell decides which
 *     chains are reachable; a chain it cannot supply is one we did not look at.
 *  4. **The view has a tone for it** and the tone has its own words, asserted
 *     on rendered text in test/watch-view.test.ts — because the property is a
 *     property of what the waiter reads, not of a discriminant in a type.
 *
 * ---------------------------------------------------------------------------
 * Matching a payment to a bill
 *
 * By the exact amount, which order.ts made unique: `$284.53` is charged as
 * `$284.5317`, the last two digits being a per-order marker. So a match is
 * `log.amount === expectedUnits(chain)` — equality, not a range. An amount that
 * is close but not equal belongs to some other bill or to no bill, and is
 * reported as an unmatched arrival rather than silently paying this table off:
 * a customer who typed the amount by hand and dropped the marker has genuinely
 * paid something, and the waiter needs to see that, not "no payment yet".
 *
 * The marker is only unique among *open* orders, which is why the amount alone
 * is enough here and will not be enough for accounting (C4).
 *
 * ---------------------------------------------------------------------------
 * Reorgs: the assumption, stated rather than assumed
 *
 * We do **not** assume a log is final because we saw it. A payment is reported
 * as `seen` while it is shallower than its rail's `confirmations`, and only
 * then as `confirmed`. The depth per rail is in rails.ts and is data, because
 * two blocks on an L2 and two blocks on Ethereum L1 are not the same claim.
 *
 * Beyond that depth we deliberately go one-way: **once confirmed, never
 * un-confirmed.** A reorg deeper than `confirmations` would leave the terminal
 * showing PAID for money that no longer exists. That is accepted, knowingly,
 * because the alternative is worse in the direction that matters: a terminal
 * that retracts PAID because one poll failed, or because an endpoint served a
 * stale head, would accuse a paying customer of not paying. Takings are
 * reconciled against the chain at shift close (C4), which is where a
 * disappeared payment must be caught; it is not something a waiter can act on
 * mid-service anyway.
 *
 * The same one-way rule is what makes a failed poll harmless: `mergeReport`
 * below refuses to overwrite a match with an `unknown`.
 */

import type { EthRequest } from "@leekwallet/core/balances.ts";
import { payableUnits, type Cents } from "./order.ts";
import { confirmationsFor, deploymentFor, type TillToken } from "./rails.ts";

/** `keccak256("Transfer(address,address,uint256)")`. */
export const TOPIC_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Blocks asked for in one `eth_getLogs`.
 *
 * Public providers cap the range and disagree about the cap. 2k is well under
 * the lowest of the ones in chains.ts, and a bill is open for minutes, so this
 * is a ceiling that is never reached in normal service rather than a working
 * window size.
 */
export const MAX_POLL_BLOCKS = 2_000n;

/**
 * How far back the first poll looks.
 *
 * A customer can scan the QR before the waiter has finished pressing things, so
 * the first scan looks slightly behind the head rather than only forward. Small
 * on purpose: this is a window on *this* bill, not a history of the merchant.
 */
export const INITIAL_LOOKBACK_BLOCKS = 50n;

/**
 * Blocks re-read on every poll, so a log that arrives in a block we have
 * already passed is still seen. Independent of `confirmations` — that is about
 * trusting a log, this is about not missing one.
 */
export const RESCAN_BLOCKS = 12n;

/** Default gap between polls. Fast enough to feel live at a table. */
export const DEFAULT_POLL_MS = 6_000;

/** A read path to one chain, plus whoever answered it. */
export interface ChainRequest {
  request: EthRequest;
  /** Host of the endpoint that last answered, for provenance. */
  endpointHost?: () => string | undefined;
}

/** The bill being watched for. One open order, priced in cents. */
export interface WatchTarget {
  /** Where the money lands. In C5 this becomes each chain's CajaInbox. */
  recipient: string;
  token: TillToken;
  total: Cents;
  /** Sub-cent order marker, 0–99. See order.ts. */
  marker: number;
}

/**
 * The exact raw units this bill must arrive as on a chain, or undefined when
 * the chain cannot take this token at all. Derived from the same function the
 * QR uses, so the figure watched for and the figure asked for cannot drift.
 */
export function expectedUnits(target: WatchTarget, chainId: number): bigint | undefined {
  const deployment = deploymentFor(chainId, target.token);
  if (!deployment.ok) return undefined;
  return payableUnits(target.total, deployment.decimals, target.marker);
}

export interface Payment {
  chainId: number;
  /** The token contract the transfer was on. */
  token: string;
  from: string;
  amount: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  /** `head - blockNumber + 1`, floored at 0. Never decreases; see mergeReport. */
  confirmations: bigint;
}

export type WatchFailure =
  /** The shell offered no read path to this chain. We did not look. */
  | "no-endpoint"
  /** The node would not say what block it is on. */
  | "head-unreadable"
  /** `eth_getLogs` failed, or one chunk of it did. */
  | "logs-unavailable"
  /** Something came back that is not a `Transfer` log. */
  | "undecodable";

/** The blocks a report actually covers. Rendered, not merely carried. */
export interface BlockWindow {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * What we know about one chain. Four kinds, and no two of them collapse.
 *
 * `searched` is the only one that means "not paid here", and it can only be
 * produced by a scan that completed.
 */
export type ChainReport =
  | { kind: "matched"; chainId: number; window: BlockWindow; payments: Payment[]; endpointHost?: string; unmatched?: Payment[] }
  | { kind: "searched"; chainId: number; window: BlockWindow; endpointHost?: string; unmatched?: Payment[] }
  | { kind: "unknown"; chainId: number; reason: WatchFailure; window?: BlockWindow; endpointHost?: string }
  /** This token is not deployed here, so nobody could pay on this chain. */
  | { kind: "unpayable"; chainId: number; reason: string };

export interface WatchSnapshot {
  /** One report per watched chain, in the order the chains were given. */
  reports: ChainReport[];
  /** Poll number, from 1. Zero means nothing has been polled yet. */
  polls: number;
  /** When the last poll finished, ms since epoch. */
  updatedAt: number;
  /** True once the watcher has stopped and will produce nothing further. */
  stopped: boolean;
}

/* ------------------------------------------------------------------ decode */

const hexQuantity = (value: bigint): string => `0x${value.toString(16)}`;

function parseQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("not a hex quantity");
  }
  return BigInt(value);
}

/** A 32-byte topic word carrying an address, as `0x` + 40 lower-case hex. */
function addressFromWord(word: unknown): string {
  if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error("not a 32-byte word");
  }
  const body = word.slice(2).toLowerCase();
  // The high 12 bytes of an address word are zero. Anything else is not an
  // address, and reading the low 20 bytes anyway would invent one.
  if (!/^0{24}/.test(body)) throw new Error("word is not an address");
  return `0x${body.slice(24)}`;
}

export interface RawLog {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
  removed?: unknown;
}

/**
 * One `Transfer` log, or a throw.
 *
 * Throws rather than returning undefined because of rule 2 in the header: a log
 * this does not understand means the response did not come from the contract
 * whose layout we assumed, and quietly dropping it would shorten a list that
 * gets presented as complete.
 */
export function decodeTransfer(log: RawLog): Omit<Payment, "chainId" | "confirmations"> {
  const topics = log.topics;
  if (!Array.isArray(topics) || topics.length < 3) throw new Error("not a Transfer log");
  if (String(topics[0]).toLowerCase() !== TOPIC_TRANSFER) throw new Error("wrong event");
  const data = log.data;
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) throw new Error("bad data");
  // `value` is the only non-indexed argument, so the data is exactly one word.
  if (data.length !== 66) throw new Error("Transfer data is not one word");
  if (typeof log.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(log.address)) {
    throw new Error("log has no contract address");
  }
  if (typeof log.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) {
    throw new Error("log has no transaction hash");
  }
  return {
    token: log.address.toLowerCase(),
    from: addressFromWord(topics[1]),
    amount: BigInt(data),
    blockNumber: parseQuantity(log.blockNumber),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(parseQuantity(log.logIndex)),
  };
}

/* -------------------------------------------------------------------- scan */

/** Where a chain's scanning has got to. One per chain, owned by the watcher. */
export interface ChainCursor {
  /** Highest block already scanned, or undefined before the first poll. */
  scannedTo?: bigint;
}

export interface ScanOptions {
  maxPollBlocks?: bigint;
  initialLookback?: bigint;
  rescan?: bigint;
}

/**
 * Poll one chain once.
 *
 * The filter is `Transfer` on the token contract with `to` = the merchant, so
 * the node returns only transfers into the address the QR names. Whoever
 * answers learns the merchant is watching for payment, which is a fact already
 * printed on the QR — rpc.ts limit 2 applies but costs nothing new here.
 */
export async function scanChain(
  chainId: number,
  target: WatchTarget,
  channel: ChainRequest | undefined,
  cursor: ChainCursor,
  options: ScanOptions = {},
): Promise<ChainReport> {
  const deployment = deploymentFor(chainId, target.token);
  if (!deployment.ok) return { kind: "unpayable", chainId, reason: deployment.reason };

  /* Not "no payment on this chain". Nobody asked anybody anything. */
  if (channel === undefined) return { kind: "unknown", chainId, reason: "no-endpoint" };

  const host = channel.endpointHost?.();
  const named = <T extends object>(report: T): T =>
    (host === undefined ? report : { ...report, endpointHost: host });

  let head: bigint;
  try {
    head = parseQuantity(await channel.request({ method: "eth_blockNumber", params: [] }));
  } catch {
    return named({ kind: "unknown", chainId, reason: "head-unreadable" }) as ChainReport;
  }

  const maxPoll = options.maxPollBlocks ?? MAX_POLL_BLOCKS;
  const lookback = options.initialLookback ?? INITIAL_LOOKBACK_BLOCKS;
  const rescan = options.rescan ?? RESCAN_BLOCKS;
  const previous = cursor.scannedTo;
  let fromBlock = previous === undefined
    ? (head > lookback ? head - lookback : 0n)
    /* Re-read the last few blocks every time: a log can appear in a block we
     * have already scanned past if the endpoint was behind when we asked. */
    : (previous + 1n > rescan ? previous + 1n - rescan : 0n);
  if (fromBlock > head) fromBlock = head;
  /* A long gap (the terminal was asleep, or an endpoint was far behind) is
   * clamped rather than chunked into a flood. The window is rendered, so a
   * clamp is visible as blocks that were not looked at rather than as a lie. */
  if (head - fromBlock >= maxPoll) fromBlock = head - maxPoll + 1n;

  const window: BlockWindow = { fromBlock, toBlock: head };
  const paddedRecipient = `0x${"0".repeat(24)}${target.recipient.replace(/^0x/, "").toLowerCase()}`;
  if (!/^0x[0-9a-f]{64}$/.test(paddedRecipient)) {
    return named({ kind: "unknown", chainId, reason: "undecodable", window }) as ChainReport;
  }

  let logs: unknown;
  try {
    logs = await channel.request({
      method: "eth_getLogs",
      params: [{
        address: deployment.address,
        // [event, any sender, this recipient]
        topics: [TOPIC_TRANSFER, null, paddedRecipient],
        fromBlock: hexQuantity(fromBlock),
        toBlock: hexQuantity(head),
      }],
    });
  } catch {
    return named({ kind: "unknown", chainId, reason: "logs-unavailable", window }) as ChainReport;
  }
  if (!Array.isArray(logs)) {
    return named({ kind: "unknown", chainId, reason: "undecodable", window }) as ChainReport;
  }

  const wanted = expectedUnits(target, chainId);
  const payments: Payment[] = [];
  const unmatched: Payment[] = [];
  for (const raw of logs) {
    const log = raw as RawLog;
    /* A log the node itself marks as reorged out was never a payment. This is
     * the one place a log is dropped, and the node is the authority on it. */
    if (log.removed === true) continue;
    let decoded: Omit<Payment, "chainId" | "confirmations">;
    try {
      decoded = decodeTransfer(log);
    } catch {
      return named({ kind: "unknown", chainId, reason: "undecodable", window }) as ChainReport;
    }
    const payment: Payment = {
      chainId,
      ...decoded,
      confirmations: head >= decoded.blockNumber ? head - decoded.blockNumber + 1n : 0n,
    };
    if (wanted !== undefined && payment.amount === wanted) payments.push(payment);
    else unmatched.push(payment);
  }

  // Only advance on a scan that completed, so a failure re-reads its range.
  cursor.scannedTo = head;

  const extra = unmatched.length > 0 ? { unmatched } : {};
  return named(
    payments.length > 0
      ? { kind: "matched", chainId, window, payments, ...extra }
      : { kind: "searched", chainId, window, ...extra },
  ) as ChainReport;
}

/* ------------------------------------------------------------------- merge */

const paymentKey = (p: Payment): string => `${p.chainId}|${p.txHash}|${p.logIndex}`;

/**
 * Fold a fresh report into what we already knew about that chain.
 *
 * The one-way rule, in code: a match survives every later failure, and a
 * payment's confirmation count only ever goes up. This is what makes "the RPC
 * went down after the customer paid" a screen that still says PAID, and it is
 * why a poll may fail as often as it likes without costing anything already
 * shown to a customer.
 */
export function mergeReport(previous: ChainReport | undefined, next: ChainReport): ChainReport {
  if (previous === undefined || previous.kind !== "matched") return next;
  if (next.kind !== "matched") {
    /* Keep the match. Losing sight of a chain does not unpay a bill, and a
     * screen that flickered between PAID and "no payment" would be worse than
     * one that never updated at all. */
    return previous;
  }
  const byKey = new Map(previous.payments.map((p) => [paymentKey(p), p]));
  for (const payment of next.payments) {
    const seen = byKey.get(paymentKey(payment));
    byKey.set(paymentKey(payment), seen === undefined || payment.confirmations > seen.confirmations
      ? payment
      : seen);
  }
  return { ...next, payments: [...byKey.values()] };
}

/** True when this payment is deep enough to be believed on its rail. */
export const isConfirmed = (payment: Payment): boolean =>
  payment.confirmations >= BigInt(confirmationsFor(payment.chainId));

/* ------------------------------------------------------------------ poller */

export interface WatcherOptions {
  /** Chains to watch, in the order they should be rendered. */
  chains: readonly number[];
  /** A read path per chain, or undefined for a chain the shell cannot reach. */
  channelFor: (chainId: number) => ChainRequest | undefined;
  target: WatchTarget;
  onUpdate: (snapshot: WatchSnapshot) => void;
  intervalMs?: number;
  scan?: ScanOptions;
  /**
   * False once the watcher's screen is gone. Checked before every poll and
   * before every callback, because `MiniApp` has no unmount hook: the shell
   * tears an app down by dropping its root (src/apps/mount.ts), so a poller
   * that only stopped on `stop()` would outlive the panel it draws into and
   * keep asking an operator about a merchant nobody is watching.
   */
  alive?: () => boolean;
  /** Injectable for tests. Defaults to the global timer functions. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * A polling watcher over several chains.
 *
 * `start()` never makes a request synchronously — the first poll is scheduled,
 * not run — so mounting the app touches no network until the event loop turns.
 * That is also what lets test/no-signing.test.ts drive the whole UI and assert
 * that nothing reached out.
 */
export class PaymentWatcher {
  private readonly options: WatcherOptions;
  private readonly cursors = new Map<number, ChainCursor>();
  private reports = new Map<number, ChainReport>();
  private timer: unknown;
  private stopped = false;
  private polls = 0;
  private inFlight = false;

  constructor(options: WatcherOptions) {
    this.options = options;
  }

  private get setTimer(): (fn: () => void, ms: number) => unknown {
    return this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  private get clearTimer(): (handle: unknown) => void {
    return this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  private alive(): boolean {
    return !this.stopped && (this.options.alive?.() ?? true);
  }

  snapshot(): WatchSnapshot {
    return {
      reports: this.options.chains.map((chainId) =>
        this.reports.get(chainId) ?? { kind: "unknown", chainId, reason: "no-endpoint" }),
      polls: this.polls,
      updatedAt: (this.options.now ?? Date.now)(),
      stopped: this.stopped,
    };
  }

  start(): this {
    if (this.stopped) throw new Error("a stopped watcher cannot be restarted");
    this.schedule(0);
    return this;
  }

  /**
   * Stop polling and release the timer.
   *
   * Idempotent, and it is the only thing a caller has to remember: after it,
   * no timer is outstanding and no callback fires, including from a poll
   * already in flight.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(ms: number): void {
    if (!this.alive()) return this.stop();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.poll();
    }, ms);
  }

  /** One round over every chain. Exposed so a test can step it by hand. */
  async poll(): Promise<void> {
    if (!this.alive() || this.inFlight) return;
    this.inFlight = true;
    const fresh = new Map(this.reports);
    try {
      for (const chainId of this.options.chains) {
        let cursor = this.cursors.get(chainId);
        if (cursor === undefined) {
          cursor = {};
          this.cursors.set(chainId, cursor);
        }
        let report: ChainReport;
        try {
          report = await scanChain(
            chainId, this.options.target, this.options.channelFor(chainId), cursor, this.options.scan ?? {},
          );
        } catch {
          /* A throw from the channel itself — not from a request — is still
           * "we did not find out", never "nothing arrived". */
          report = { kind: "unknown", chainId, reason: "logs-unavailable" };
        }
        fresh.set(chainId, mergeReport(fresh.get(chainId), report));
      }
      this.polls++;
      this.reports = fresh;
    } finally {
      this.inFlight = false;
    }
    /* The screen may have gone while this round was in flight. Drawing into a
     * detached root is harmless; scheduling the next round is the leak. */
    if (!this.alive()) return this.stop();
    this.options.onUpdate(this.snapshot());
    this.schedule(this.options.intervalMs ?? DEFAULT_POLL_MS);
  }
}
