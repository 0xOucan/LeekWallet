/**
 * A fake ATS security, answering `eth_call` the way a real one would.
 *
 * Why this exists rather than a recorded transcript: at the time of writing no
 * equity had been deployed on Hedera testnet from this workspace (no testnet
 * HBAR), so there is nothing to record. Everything below is constructed from
 * the contract ABIs in `@hashgraph/asset-tokenization-contracts` 8.0.0, and it
 * is labelled a fixture wherever it reaches a screen — see `FIXTURE_NOTICE`.
 * It is a demo and a test harness. It is NOT evidence that this app has read a
 * real security, and nothing in the UI may present it as one.
 *
 * It answers through the same `aggregate3` path the real reads use, so the
 * decoding under test is the decoding that ships, not a parallel shortcut.
 */

import { decodeAggregate3Return } from "@leekwallet/core/multicall.ts";
import type { EthRequest } from "@leekwallet/core/balances.ts";
import { SELECTOR, word, selectorOf } from "./abi.ts";
import { ROLES } from "./roles.ts";

export const FIXTURE_NOTICE =
  "Fixture data. This is a constructed example, not a security read from a " +
  "chain — no figure on this screen came from Hedera.";

export const FIXTURE_ADDRESS = "0x00000000000000000000000000000000004e5f21";

const HOLDERS = [
  "0x000000000000000000000000000000000048a1b2",
  "0x000000000000000000000000000000000048a1c3",
  "0x000000000000000000000000000000000048a1d4",
] as const;

const BALANCES = [400_000n, 350_000n, 250_000n] as const;

/** Snapshot 1 and 2. Balances differ, which is the point of having two. */
const SNAPSHOTS: readonly { supply: bigint; holders: bigint }[] = [
  { supply: 800_000n, holders: 2n },
  { supply: 1_000_000n, holders: 3n },
];

const ADMIN = "0x00000000000000000000000000000000004a1111";

/** Which roles are held, and by whom. Deliberately a handful, not all 37. */
const ROLE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  DefaultAdmin: [ADMIN],
  Issuer: [ADMIN],
  Controller: [ADMIN, "0x00000000000000000000000000000000004a2222"],
  Pauser: [ADMIN],
  Kyc: [ADMIN],
  Snapshot: [ADMIN],
};

/* ------------------------------------------------------------------ encoding */

const hex = (s: string): string => (s.startsWith("0x") ? s.slice(2) : s);
const uintReturn = (v: bigint): string => `0x${word(v)}`;
const boolReturn = (v: boolean): string => uintReturn(v ? 1n : 0n);
const addrWord = (a: string): string => "0".repeat(24) + hex(a).toLowerCase();

const addressArrayReturn = (items: readonly string[]): string =>
  `0x${word(32n)}${word(BigInt(items.length))}${items.map(addrWord).join("")}`;

const stringReturn = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let body = "";
  for (const b of bytes) body += b.toString(16).padStart(2, "0");
  return `0x${word(32n)}${word(BigInt(bytes.length))}${body.padEnd(Math.ceil(bytes.length / 32) * 64, "0")}`;
};

const REVERT_SNAPSHOT_ABSENT = `0x${selectorOf("SnapshotIdDoesNotExists(uint256)")}${word(0n)}`;
/** A bare `revert()` — what a diamond returns for a facet it does not have. */
const REVERT_EMPTY = "0x";

/* ------------------------------------------------------------- the answers */

/** Options for shaping a fixture into the case a test needs. */
export interface FixtureOptions {
  /** Facets to answer as absent. Names are `SigName`s. */
  missing?: readonly string[];
  /** Is the security paused? */
  paused?: boolean;
  /** Allowlist (true) or blocklist (false). */
  whitelist?: boolean;
  /** Holders reported as having KYC. Defaults to the first two. */
  kycGranted?: readonly string[];
  /**
   * How many snapshots exist. Defaults to the two in `SNAPSHOTS`.
   *
   * Set it above `SNAPSHOT_PROBE_LIMIT` to exercise the case that matters:
   * a security with more snapshots than the probe will walk, which must come
   * back marked incomplete rather than as a count.
   */
  snapshotCount?: number;
}

/**
 * Answer one inner call by selector.
 *
 * Returns `undefined` to mean "this call reverts", which the aggregate3
 * wrapper turns into `success: false` — the same thing a diamond does for a
 * facet it does not have.
 */
function answer(data: string, opts: FixtureOptions): string | undefined {
  const sel = hex(data).slice(0, 8).toLowerCase();
  const args = hex(data).slice(8);
  const argWord = (i: number): bigint => BigInt(`0x${args.slice(i * 64, (i + 1) * 64) || "0"}`);
  const argAddress = (i: number): string => `0x${args.slice(i * 64 + 24, (i + 1) * 64)}`;
  const missing = new Set(opts.missing ?? []);
  const kyc = new Set((opts.kycGranted ?? HOLDERS.slice(0, 2)).map((a) => a.toLowerCase()));

  // A facet listed in `missing` reverts before anything else is considered,
  // so "this deployment lacks the control list" is one option away.
  if (Object.entries(SELECTOR).some(([n, s]) => s === sel && missing.has(n))) return undefined;
  const is = (name: keyof typeof SELECTOR): boolean => SELECTOR[name] === sel;

  if (is("name")) return stringReturn("ACME Equity Series A");
  if (is("symbol")) return stringReturn("ACME");
  if (is("decimals")) return uintReturn(6n);
  if (is("totalSupply")) return uintReturn(1_000_000n);
  if (is("getMaxSupply")) return uintReturn(5_000_000n);
  if (is("paused")) return boolReturn(opts.paused ?? false);
  if (is("isInternalKycActivated")) return boolReturn(true);
  if (is("getTotalSecurityHolders")) return uintReturn(BigInt(HOLDERS.length));
  if (is("getSecurityHolders")) return addressArrayReturn(HOLDERS);
  if (is("getControlListType")) return boolReturn(opts.whitelist ?? true);
  if (is("getControlListCount")) return uintReturn(BigInt(HOLDERS.length));
  if (is("getControlListMembers")) return addressArrayReturn(HOLDERS);

  if (is("balanceOf")) {
    const i = HOLDERS.findIndex((h) => h.toLowerCase() === argAddress(0));
    return uintReturn(i === -1 ? 0n : (BALANCES[i] as bigint));
  }
  if (is("getKycStatusFor")) return uintReturn(kyc.has(argAddress(0)) ? 1n : 0n);
  if (is("isInControlList")) {
    return boolReturn(HOLDERS.some((h) => h.toLowerCase() === argAddress(0)));
  }

  if (is("getRoleMemberCount") || is("getRoleMembers")) {
    const id = `0x${args.slice(0, 64)}`;
    const role = ROLES.find((r) => r.id.toLowerCase() === id.toLowerCase());
    const members = role ? (ROLE_MEMBERS[role.name] ?? []) : [];
    return is("getRoleMemberCount")
      ? uintReturn(BigInt(members.length))
      : addressArrayReturn(members);
  }

  if (is("totalSupplyAtSnapshot") || is("getTotalTokenHoldersAtSnapshot")) {
    const id = argWord(0);
    const count = BigInt(opts.snapshotCount ?? SNAPSHOTS.length);
    if (id === 0n || id > count) return undefined;
    // Past the two hand-written rows the figures are synthetic but distinct,
    // which is all an enumeration test needs.
    const row = SNAPSHOTS[Number(id) - 1] ?? { supply: id * 1000n, holders: id };
    return uintReturn(is("totalSupplyAtSnapshot") ? row.supply : row.holders);
  }

  return undefined;
}

/**
 * Snapshot probes past the end revert with `SnapshotIdDoesNotExists`, not with
 * empty data — the difference is what tells the reader "that is the last one"
 * rather than "the facet is missing", so the fixture has to get it right.
 */
function answerOrRevert(data: string, opts: FixtureOptions): { success: boolean; returnData: string } {
  const sel = hex(data).slice(0, 8).toLowerCase();
  const out = answer(data, opts);
  if (out !== undefined) return { success: true, returnData: out };
  const isSnapshotProbe =
    sel === SELECTOR.totalSupplyAtSnapshot || sel === SELECTOR.getTotalTokenHoldersAtSnapshot;
  const missing = new Set(opts.missing ?? []);
  const facetMissing = missing.has("totalSupplyAtSnapshot");
  return {
    success: false,
    returnData: isSnapshotProbe && !facetMissing ? REVERT_SNAPSHOT_ABSENT : REVERT_EMPTY,
  };
}

/** ABI-encode `(bool,bytes)[]`, the aggregate3 return. */
function encodeResults(results: readonly { success: boolean; returnData: string }[]): string {
  const bodies = results.map((r) => {
    const body = hex(r.returnData);
    const len = body.length / 2;
    return word(r.success ? 1n : 0n) + word(64n) + word(BigInt(len)) +
      body.padEnd(Math.ceil(len / 32) * 64, "0");
  });
  let cursor = BigInt(results.length) * 32n;
  let offsets = "";
  for (const b of bodies) {
    offsets += word(cursor);
    cursor += BigInt(b.length / 2);
  }
  return `0x${word(32n)}${word(BigInt(results.length))}${offsets}${bodies.join("")}`;
}

/** Decode `aggregate3(Call3[])` calldata back into the inner calls. */
function innerCalls(data: string): string[] {
  // Re-uses the production decoder by shape, not by import: the argument here
  // is a Call3[] and the decoder handles (bool,bytes)[]. Simpler to walk it.
  const body = hex(data).slice(8);
  const w = (i: number): bigint => BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`);
  const arrayAt = Number(w(0)) * 2;
  const count = Number(BigInt(`0x${body.slice(arrayAt, arrayAt + 64)}`));
  const elementsAt = arrayAt + 64;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const off = Number(BigInt(`0x${body.slice(elementsAt + i * 64, elementsAt + (i + 1) * 64)}`)) * 2;
    const at = elementsAt + off;
    // target, allowFailure, offset-to-bytes(0x60), then length + data
    const len = Number(BigInt(`0x${body.slice(at + 192, at + 256)}`));
    out.push(`0x${body.slice(at + 256, at + 256 + len * 2)}`);
  }
  return out;
}

/**
 * An `EthRequest` that answers as this fixture security.
 *
 * `onCall` is how a test counts requests or fails one of them mid-run.
 */
export function fixtureRequest(
  opts: FixtureOptions = {},
  onCall?: (method: string, index: number) => void,
): EthRequest {
  let index = 0;
  return async ({ method, params }) => {
    onCall?.(method, index++);
    if (method === "eth_blockNumber") return "0x2654b23";
    if (method !== "eth_call") throw new Error(`fixture does not serve ${method}`);
    const p = (params as [{ data: string }, string])[0];
    return encodeResults(innerCalls(p.data).map((d) => answerOrRevert(d, opts)));
  };
}

/**
 * A transport that behaves like a Hedera HTS system contract: every call
 * SUCCEEDS and returns data that is not what was asked for.
 *
 * Not hypothetical. `eth_call` against USDC (0x...1549) and WHBAR (0x...3aD2)
 * on Hedera testnet answers unknown selectors this way instead of reverting,
 * so "the call did not revert" is not evidence on this chain that the function
 * exists. Anything that treats success as existence reports a plain ERC-20 as
 * an ATS security with a full register.
 */
export function htsLikeRequest(): EthRequest {
  return async ({ method, params }) => {
    if (method === "eth_blockNumber") return "0x2654b23";
    if (method !== "eth_call") throw new Error(`fixture does not serve ${method}`);
    const p = (params as [{ data: string }, string])[0];
    return encodeResults(innerCalls(p.data).map(() => ({ success: true, returnData: "0x" })));
  };
}

/** Round-trip guard: the fixture's own encoding must satisfy the real decoder. */
export function fixtureSelfCheck(): number {
  return decodeAggregate3Return(
    encodeResults([{ success: true, returnData: uintReturn(1n) }]),
  ).length;
}
