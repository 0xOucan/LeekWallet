/**
 * A fake chain: logs, an aggregate3 encoder, and a node that can be told to
 * fail one method at a time.
 *
 * The last part is the point. The property this app must hold — an unreachable
 * RPC never rendering as a zero — is only testable if a test can make the RPC
 * unreachable *selectively*: head but not logs, logs but not calls, the
 * registry but not the token. A helper that could only make everything fail
 * would prove nothing, because everything failing is the easy case.
 */

import { TOPIC_PUSHED, TOPIC_SHIPPED } from "../src/registry.ts";

export const w = (n: bigint): string => n.toString(16).padStart(64, "0");
export const aw = (a: string): string => "0".repeat(24) + a.slice(2).toLowerCase();

/** `(bool,bytes)[]` as aggregate3 returns it. Mirrors the decoder's layout. */
export function encodeAggregate3Return(
  results: readonly { success: boolean; returnData: string }[],
): string {
  const bodies: string[] = [];
  const offsets: string[] = [];
  let cursor = results.length * 32;
  for (const r of results) {
    offsets.push(w(BigInt(cursor)));
    const data = r.returnData.slice(2);
    const padded = data.length % 64 === 0 ? data : data.padEnd(data.length + (64 - (data.length % 64)), "0");
    const body = w(r.success ? 1n : 0n) + w(0x40n) + w(BigInt(data.length / 2)) + padded;
    bodies.push(body);
    cursor += body.length / 2;
  }
  return `0x${w(0x20n)}${w(BigInt(results.length))}${offsets.join("")}${bodies.join("")}`;
}

export const shippedLog = (maker: string, app: string, hash: string, strategy = "0x"): unknown => {
  const data = strategy.slice(2);
  const padded = data.length === 0
    ? ""
    : data.padEnd(data.length + ((64 - (data.length % 64)) % 64), "0");
  return {
    topics: [TOPIC_SHIPPED],
    data: `0x${aw(maker)}${aw(app)}${hash.slice(2)}${w(0x80n)}${w(BigInt(data.length / 2))}${padded}`,
  };
};

export const pushedLog = (
  maker: string, app: string, hash: string, token: string, amount: bigint,
): unknown => ({
  topics: [TOPIC_PUSHED],
  data: `0x${aw(maker)}${aw(app)}${hash.slice(2)}${aw(token)}${w(amount)}`,
});

export interface FakeNodeOptions {
  head?: bigint;
  logs?: readonly unknown[];
  /** Per-call answers, consumed in order, for `eth_call`. */
  calls?: readonly string[];
  /** Methods that throw instead of answering. The whole point of this file. */
  failing?: readonly string[];
}

export interface FakeNode {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  /** Every method actually asked for, in order. */
  seen: string[];
}

export function fakeNode(options: FakeNodeOptions = {}): FakeNode {
  const seen: string[] = [];
  const calls = [...(options.calls ?? [])];
  const failing = new Set(options.failing ?? []);
  return {
    seen,
    request: async ({ method }) => {
      seen.push(method);
      if (failing.has(method)) throw new Error(`${method} is unreachable`);
      if (method === "eth_blockNumber") return `0x${(options.head ?? 1_000_000n).toString(16)}`;
      if (method === "eth_getLogs") return options.logs ?? [];
      if (method === "eth_call") {
        const next = calls.shift();
        if (next === undefined) throw new Error("fakeNode: no eth_call answer left");
        return next;
      }
      throw new Error(`fakeNode: unexpected method ${method}`);
    },
  };
}
