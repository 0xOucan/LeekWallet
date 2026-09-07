/**
 * Finding a maker's Aqua positions, and reading what is left in them.
 *
 * Two steps, deliberately separate, because they fail differently.
 *
 * **Discovery** is a log scan. There is no `positionsOf(maker)` on chain and no
 * indexed `maker` to filter on (see registry.ts), so the only honest source is
 * `Shipped` and `Pushed` logs read back and matched here. That makes discovery
 * a statement about a *block range*, never about all of history.
 *
 * **Reading** is `rawBalances` per (app, strategyHash, token), batched through
 * multicall3. This is authoritative for now: it is current state, not history,
 * so a position found by an old log and since docked reads as docked.
 *
 * ---------------------------------------------------------------------------
 * Why a partial scan is refused outright
 *
 * A log scan is chunked, and the obvious behaviour when chunk 7 of 12 fails is
 * to return what the other eleven found. This does not do that, and the reason
 * is the property the whole milestone exists for: a position that exists but
 * was not seen renders as *no such position*, which is indistinguishable from
 * having none. There is no visual treatment that fixes that, because the row
 * simply is not there to mark. So one failed chunk makes the whole discovery
 * `unavailable`, which the view can and must render as "we could not look".
 *
 * The reads are the opposite and are per-position unions instead: a position
 * whose read failed is a row on the screen that can say so.
 */

import {
  chunk, decodeAggregate3Return, encodeAggregate3, MULTICALL_CHUNK_SIZE,
  multicall3Address, type Aggregate3Result, type Call3,
} from "@leekwallet/core/multicall.ts";
import type { EthRequest } from "@leekwallet/core/balances.ts";
import {
  AQUA_REGISTRY, decodePushed, decodeRawBalances, decodeShipped, encodeRawBalances,
  TOPIC_PUSHED, TOPIC_SHIPPED, type RegistrySlot,
} from "./registry.ts";

/* --------------------------------------------------------------- scanning */

/**
 * Blocks per `eth_getLogs`.
 *
 * Public providers cap the range and disagree about the cap; 10k is under the
 * lowest of the commonly-used ones. Chosen for the node, like
 * MULTICALL_CHUNK_SIZE: too large and the request is rejected wholesale, which
 * under the all-or-nothing rule above costs the entire scan.
 */
export const LOG_CHUNK_BLOCKS = 10_000n;

/**
 * How far back to look when the caller does not say.
 *
 * There is no honest default of "everything": Aqua's deployment block differs
 * per chain, this repo has not verified any of them, and asking a public node
 * for `fromBlock: 0` is refused or times out. So the default is a window, the
 * window is reported back in the result, and DISCOVERY_NOTICE says out loud
 * that positions older than it were not looked for. A caller that knows the
 * deployment block should pass it.
 */
export const DEFAULT_SCAN_BLOCKS = 200_000n;

/** Ceiling on chunks per scan, so a bad `fromBlock` cannot become a flood. */
export const MAX_LOG_CHUNKS = 64;

export interface ScanOptions {
  /** First block to look at. Defaults to `toBlock - DEFAULT_SCAN_BLOCKS`. */
  fromBlock?: bigint;
  /** Last block. Defaults to the node's `eth_blockNumber`. */
  toBlock?: bigint;
  chunkBlocks?: bigint;
  maxChunks?: number;
}

/** The window a result actually covers. Rendered, not just carried. */
export interface ScanWindow {
  fromBlock: bigint;
  toBlock: bigint;
}

export type DiscoveryFailure =
  | "head-unreadable"
  | "logs-unavailable"
  | "undecodable"
  | "range-too-large";

/**
 * A position as the logs describe it, before any balance is read.
 *
 * `tokens` comes from `Pushed`, not from `Shipped`: `Shipped` carries the
 * strategy bytes but not the token list, while `ship()` emits one `Pushed` per
 * token in the same transaction. Later `push()`es by takers repeat the same
 * keys, so the set is right even though the event count is not a count of
 * ships.
 *
 * `strategy` is optional because the two events are found independently: a
 * `Pushed` inside the window whose `Shipped` was before it gives a position we
 * can read balances for and cannot show the strategy bytes of. That is a real
 * state and it is better shown as such than dropped.
 */
export interface DiscoveredPosition {
  app: string;
  strategyHash: string;
  tokens: string[];
  strategy?: string;
}

export type Discovery =
  | { ok: true; window: ScanWindow; positions: DiscoveredPosition[] }
  | { ok: false; reason: DiscoveryFailure; window?: ScanWindow };

const hexQuantity = (value: bigint): string => `0x${value.toString(16)}`;

function parseQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("not a hex quantity");
  }
  return BigInt(value);
}

/**
 * Scan for a maker's positions in a block window.
 *
 * `maker` is compared lower-case against the decoded first word of each log.
 * Filtering client-side is forced by the ABI, not chosen — registry.ts explains
 * why — so the node sees a request for every maker's ships and learns nothing
 * about which address is asking.
 */
export async function discoverPositions(
  request: EthRequest,
  maker: string,
  options: ScanOptions = {},
): Promise<Discovery> {
  const wanted = maker.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wanted)) throw new Error("maker is not a 20-byte address");

  let toBlock: bigint;
  if (options.toBlock !== undefined) {
    toBlock = options.toBlock;
  } else {
    try {
      toBlock = parseQuantity(await request({ method: "eth_blockNumber", params: [] }));
    } catch {
      /* Not "no positions". We never got as far as asking. */
      return { ok: false, reason: "head-unreadable" };
    }
  }

  const span = options.fromBlock === undefined ? DEFAULT_SCAN_BLOCKS : undefined;
  const fromBlock = options.fromBlock ?? (toBlock > span! ? toBlock - span! : 0n);
  if (fromBlock > toBlock) return { ok: false, reason: "range-too-large" };
  const window: ScanWindow = { fromBlock, toBlock };

  const chunkBlocks = options.chunkBlocks ?? LOG_CHUNK_BLOCKS;
  const maxChunks = options.maxChunks ?? MAX_LOG_CHUNKS;
  if ((toBlock - fromBlock) / chunkBlocks + 1n > BigInt(maxChunks)) {
    return { ok: false, reason: "range-too-large", window };
  }

  /* Keyed `app|strategyHash`, so the two events and repeated pushes converge on
   * one row. Insertion order is preserved, which puts older positions first. */
  const found = new Map<string, DiscoveredPosition>();
  const upsert = (app: string, hash: string): DiscoveredPosition => {
    const key = `${app.toLowerCase()}|${hash.toLowerCase()}`;
    let position = found.get(key);
    if (!position) {
      position = { app: app.toLowerCase(), strategyHash: hash.toLowerCase(), tokens: [] };
      found.set(key, position);
    }
    return position;
  };

  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = start + chunkBlocks - 1n > toBlock ? toBlock : start + chunkBlocks - 1n;
    let logs: unknown;
    try {
      logs = await request({
        method: "eth_getLogs",
        params: [{
          address: AQUA_REGISTRY,
          /* Topic position 0 as an array: "Shipped OR Pushed", one request
           * instead of two per chunk. Docked is not asked for — the current
           * `tokensCount` says whether a position is docked, and believing a
           * log over live state would be believing history over now. */
          topics: [[TOPIC_SHIPPED, TOPIC_PUSHED]],
          fromBlock: hexQuantity(start),
          toBlock: hexQuantity(end),
        }],
      });
    } catch {
      return { ok: false, reason: "logs-unavailable", window };
    }
    if (!Array.isArray(logs)) return { ok: false, reason: "undecodable", window };

    for (const log of logs) {
      try {
        const shipped = decodeShipped(log as never);
        if (shipped) {
          if (shipped.maker.toLowerCase() !== wanted) continue;
          const position = upsert(shipped.app, shipped.strategyHash);
          position.strategy = shipped.strategy;
          continue;
        }
        const pushed = decodePushed(log as never);
        if (pushed) {
          if (pushed.maker.toLowerCase() !== wanted) continue;
          const position = upsert(pushed.app, pushed.strategyHash);
          const token = pushed.token.toLowerCase();
          if (!position.tokens.includes(token)) position.tokens.push(token);
        }
      } catch {
        /* One malformed log means the response did not come from the contract
         * whose layout is assumed, and the rest of the batch is no more
         * trustworthy for having parsed. Refuse the scan rather than report a
         * shorter list of positions as if it were the list. */
        return { ok: false, reason: "undecodable", window };
      }
    }
  }

  return { ok: true, window, positions: [...found.values()] };
}

/* ---------------------------------------------------------------- reading */

/** One (position, token) leg with its current registry slot, or why not. */
export type LegReading =
  | ({ token: string; ok: true } & RegistrySlot)
  | { token: string; ok: false; reason: "call-failed" | "undecodable" | "batch-failed" };

export interface PositionReading {
  app: string;
  strategyHash: string;
  strategy?: string;
  legs: LegReading[];
}

/**
 * Read every leg's registry slot, batched.
 *
 * One reading per (position, token) in the order given, always — the caller
 * zips this against its own list and must never check whether the lengths still
 * line up. `allowFailure` is true for the reason multicall.ts states, and a
 * failed call comes back as `ok: false` rather than as a zero balance.
 */
export async function readPositions(
  request: EthRequest,
  chainId: number,
  maker: string,
  positions: readonly DiscoveredPosition[],
  chunkSize: number = MULTICALL_CHUNK_SIZE,
): Promise<PositionReading[]> {
  const legs: { position: number; token: string }[] = [];
  const calls: Call3[] = [];
  positions.forEach((position, index) => {
    for (const token of position.tokens) {
      legs.push({ position: index, token });
      calls.push({
        target: AQUA_REGISTRY,
        allowFailure: true,
        callData: encodeRawBalances(maker, position.app, position.strategyHash, token),
      });
    }
  });

  const out: PositionReading[] = positions.map((p) => ({
    app: p.app,
    strategyHash: p.strategyHash,
    ...(p.strategy === undefined ? {} : { strategy: p.strategy }),
    legs: [],
  }));
  if (calls.length === 0) return out;

  const to = multicall3Address(chainId);
  const readings: LegReading[] = [];
  for (const slice of chunk(calls, chunkSize)) {
    const base = readings.length;
    let results: Aggregate3Result[];
    try {
      results = decodeAggregate3Return(
        await request({ method: "eth_call", params: [{ to, data: encodeAggregate3(slice) }, "latest"] }),
      );
    } catch {
      for (let i = 0; i < slice.length; i++) {
        readings.push({ token: legs[base + i]!.token, ok: false, reason: "batch-failed" });
      }
      continue;
    }
    if (results.length !== slice.length) {
      for (let i = 0; i < slice.length; i++) {
        readings.push({ token: legs[base + i]!.token, ok: false, reason: "batch-failed" });
      }
      continue;
    }
    for (let i = 0; i < slice.length; i++) {
      const token = legs[base + i]!.token;
      const result = results[i] as Aggregate3Result;
      if (!result.success) {
        readings.push({ token, ok: false, reason: "call-failed" });
        continue;
      }
      try {
        readings.push({ token, ok: true, ...decodeRawBalances(result.returnData) });
      } catch {
        readings.push({ token, ok: false, reason: "undecodable" });
      }
    }
  }

  readings.forEach((reading, i) => out[legs[i]!.position]!.legs.push(reading));
  return out;
}

/**
 * The sentence that must accompany any position list.
 *
 * The floor-not-census point in one line, the same shape as
 * ALLOWANCE_NOTICE — it is the thing a user could most easily read backwards.
 */
export const DISCOVERY_NOTICE =
  "Positions are found by reading Aqua's logs over a range of blocks, which is " +
  "shown above. Aqua does not index the maker in its events, so there is no way " +
  "to ask for yours alone and no way to ask for all of history at once. A " +
  "position shipped before this range was not looked for, and an empty list " +
  "means none were found in it — not that you have none.";
