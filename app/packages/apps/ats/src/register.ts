/**
 * Reading the register of one ATS security.
 *
 * ---------------------------------------------------------------------------
 * The one rule the whole file is arranged around
 *
 * **An unreachable node must never render as zero, and never as "no holders".**
 *
 * "0 holders" and "we could not find out" are different sentences with
 * different consequences: the first tells an issuer the register is empty, the
 * second tells them to look again. A dashboard that collapses them is worse
 * than one that shows nothing, because it is confidently wrong at the exact
 * moment the network is down. So there is no `?? 0n` anywhere below, no
 * `catch { return [] }`, and every field is an `Outcome<T>` that a renderer
 * cannot read a number out of without having looked at `state` first — the
 * same shape, and the same reasoning, as `TokenBalanceResult` in
 * core/multicall.ts.
 *
 * Three states rather than two, because a diamond makes the third real:
 *
 *   - `ok`          — the contract answered.
 *   - `unsupported` — the contract answered by reverting. On an ATS security
 *                     this usually means the facet is not installed, which is
 *                     a fact about this deployment, not a failure. "This
 *                     security has no control list" is worth saying plainly.
 *   - `unavailable` — nobody answered. Say so, and say who was asked.
 *
 * ---------------------------------------------------------------------------
 * Freshness, and why there is no cache
 *
 * A revoked role that still reads "admin" on screen is the failure mode that
 * matters here: the person looking at it is deciding whether an irreversible
 * power is still held by someone. So:
 *
 * 1. **Nothing is merged across refreshes.** `readRegister` builds a whole new
 *    `RegisterView` and the UI replaces the old one wholesale. There is no
 *    path that keeps a previous `ok` value when the new read came back
 *    `unavailable` — a stale "still admin" surviving a failed refresh is
 *    precisely what "no cached state" has to rule out, and the way to rule it
 *    out is to have no code that could do it.
 * 2. **One instant, not a smear.** Every call in a view is made at one pinned
 *    block number where the node allows it, so the holder list, the balances
 *    and the role members are all as of the same moment. A view assembled from
 *    four different heights can show a total supply that no block ever had.
 *    When the node refuses historical calls the view falls back to `latest`
 *    and records `pinnedBlock: undefined` — the caveat is carried in the data
 *    rather than assumed away.
 * 3. **The instant is carried, not implied.** `fetchedAt`, `blockNumber` and
 *    `endpointHost` travel with the view, and `privilegedFreshness()` gives
 *    role/KYC/pause facts a much shorter shelf life than a balance gets,
 *    because their consequences are worse. Displaying them is not optional:
 *    see view.ts.
 *
 * ---------------------------------------------------------------------------
 * Batching
 *
 * Multicall3 is deployed at its canonical address on Hedera testnet (verified
 * by `eth_getCode` against testnet.hashio.io, 2026-09), so the ~50 reads a
 * dashboard needs cost a handful of `eth_call`s rather than fifty. That is a
 * disclosure argument before it is a speed one — see core/multicall.ts.
 * `allowFailure` is always on, so one absent facet does not erase the register.
 */

import { freshnessOf, type EthRequest, type Freshness } from "@leekwallet/core/balances.ts";
import {
  decodeAggregate3Return, encodeAggregate3, multicall3Address,
  type Aggregate3Result, type Call3,
} from "@leekwallet/core/multicall.ts";
import {
  addressWord, bytes32Word, decodeAddressArray, decodeBool, decodeString,
  decodeHolderBalanceArray, decodeUint, decodeUint8, encode, selectorOf, word,
  type HolderBalance, type SigName,
} from "./abi.ts";
import { ROLES, type RoleInfo } from "./roles.ts";

/* ----------------------------------------------------------------- outcomes */

export type Outcome<T> =
  | { state: "ok"; value: T }
  /** The contract replied by reverting — usually a facet this security lacks. */
  | { state: "unsupported"; revert: string }
  /** Nobody answered. `why` names what went wrong, for the screen. */
  | { state: "unavailable"; why: string };

export const ok = <T>(value: T): Outcome<T> => ({ state: "ok", value });

/** The two non-`ok` shapes. They carry no `T`, so they cross types unchanged. */
export type NotOk = Extract<Outcome<unknown>, { state: "unsupported" | "unavailable" }>;

/**
 * Re-type a failure so it can stand in for a field of another type.
 *
 * The point is that the failure is passed THROUGH rather than replaced: when
 * the holder count could not be read, the holder list reports that same
 * reason, not an empty array. There is no other way to move between outcome
 * types in this file, on purpose.
 */
export const carry = <T>(o: NotOk): Outcome<T> => o;
export const unavailable = <T>(why: string): Outcome<T> => ({ state: "unavailable", why });

/** Map an `ok` through a decoder; a decoder that throws is not an `ok`. */
export function mapOutcome<A, B>(o: Outcome<A>, f: (a: A) => B): Outcome<B> {
  if (o.state !== "ok") return o;
  try {
    return ok(f(o.value));
  } catch (e) {
    // A contract that answers with something undecodable has answered; it just
    // has not answered *this*. Not "unsupported" — that would claim the facet
    // is missing when what happened is that its reply made no sense.
    return unavailable(`undecodable reply: ${String((e as Error)?.message ?? e)}`);
  }
}

/* --------------------------------------------------------------- the errors */

/**
 * `SnapshotIdDoesNotExists(uint256)`, the revert that marks the end of the
 * snapshot list.
 *
 * Note the contracts' spelling — "Exists", not "Exist". Derived by keccak from
 * that exact string rather than typed as four bytes, because the whole
 * snapshot enumeration hangs off recognising it and a wrong selector would
 * make every security look like it had no snapshots at all.
 */
export const SNAPSHOT_ABSENT_SELECTOR = `0x${selectorOf("SnapshotIdDoesNotExists(uint256)")}`;

/** `SnapshotIdNull()` — id 0. Reached only by a caller that ignored the 1-base. */
export const SNAPSHOT_NULL_SELECTOR = `0x${selectorOf("SnapshotIdNull()")}`;

/* ---------------------------------------------------------------- batching */

/** Where the reads are aimed and how they are pinned. */
export interface ReadContext {
  request: EthRequest;
  chainId: number;
  /** The security's address on that chain. */
  token: string;
  /** `latest`, or a 0x-prefixed block number. */
  block: string;
  /** Host of whoever answered, for the provenance line. */
  host: () => string | undefined;
}

/**
 * One `aggregate3`, returning one outcome per call, in order, always.
 *
 * A caller zipping this against its own list must never have to check whether
 * the lengths still line up — so a batch that comes back with a different
 * number of results is discarded entirely rather than aligned optimistically.
 * A misaligned register attributes one holder's balance to another.
 */
export async function callBatch(
  ctx: ReadContext,
  calls: readonly Call3[],
): Promise<Outcome<string>[]> {
  if (calls.length === 0) return [];
  let results: Aggregate3Result[];
  try {
    results = decodeAggregate3Return(
      await ctx.request({
        method: "eth_call",
        params: [
          { to: multicall3Address(ctx.chainId), data: encodeAggregate3(calls) },
          ctx.block,
        ],
      }),
    );
  } catch (e) {
    const why = String((e as Error)?.message ?? e);
    return calls.map(() => unavailable<string>(why));
  }
  if (results.length !== calls.length) {
    return calls.map(() => unavailable<string>("the multicall answered about a different number of calls"));
  }
  return results.map((r) =>
    r.success
      ? ok(r.returnData)
      : ({ state: "unsupported", revert: r.returnData } as Outcome<string>),
  );
}

const call = (token: string, name: SigName, args: readonly string[] = []): Call3 => ({
  target: token,
  allowFailure: true,
  callData: encode(name, args),
});

/* -------------------------------------------------------------- the shapes */

/** One row of the register. Every figure is an outcome in its own right. */
export interface HolderRow {
  address: string;
  balance: Outcome<bigint>;
  /**
   * KYC as the contract reports it: 0 NOT_GRANTED, 1 GRANTED (IKyc.KycStatus).
   * Kept as the raw number rather than a boolean so an enum that grows a third
   * member later shows as an unknown code instead of silently reading false.
   */
  kycStatus: Outcome<number>;
  /** Whether the control list contains this address. What that MEANS depends
   *  on `ControlListView.whitelist` — the same bit is a permit or a ban. */
  inControlList: Outcome<boolean>;
}

export interface RoleRow {
  role: RoleInfo | { id: string };
  memberCount: Outcome<bigint>;
  members: Outcome<string[]>;
}

export interface ControlListView {
  /** true = allowlist (only members may hold), false = blocklist (members are barred). */
  whitelist: boolean;
  count: bigint;
  members: string[];
  /** True when `count` exceeds what one page fetched, so `members` is partial. */
  truncated: boolean;
}

export interface SnapshotRow {
  id: bigint;
  totalSupply: Outcome<bigint>;
  holderCount: Outcome<bigint>;
}

export interface SnapshotView {
  /**
   * The snapshots found, ascending. Ids are 1-based and contiguous: the
   * contracts assign them from a counter and reject 0 (`SnapshotIdNull`) and
   * anything past the last one (`SnapshotIdDoesNotExists`).
   */
  rows: SnapshotRow[];
  /**
   * True when the probe hit its ceiling before finding the end.
   *
   * There is no `currentSnapshotId()` view on the diamond — the id is only
   * returned by `takeSnapshot()`, which is a transaction. So the list is found
   * by probing upward until a call reverts with `SnapshotIdDoesNotExists`, and
   * the probe is bounded. When the bound is what stopped it, the UI must say
   * "at least N", never "N": an issuer reconciling a distribution against the
   * wrong final snapshot is the failure this whole section exists to prevent.
   */
  truncated: boolean;
}

/** Everything the dashboard shows, plus everything needed to date it. */
export interface RegisterView {
  chainId: number;
  address: string;
  /** `Date.now()` when the read finished. */
  fetchedAt: number;
  /** The block every call was pinned to, or undefined if the node refused. */
  pinnedBlock: bigint | undefined;
  /** Host of the operator that answered — who learned which security this is. */
  endpointHost: string | undefined;

  name: Outcome<string | undefined>;
  symbol: Outcome<string | undefined>;
  decimals: Outcome<number>;
  totalSupply: Outcome<bigint>;
  /** The cap. `0` means uncapped in the contracts; `maxSupplyIsCap()` says so. */
  maxSupply: Outcome<bigint>;
  paused: Outcome<boolean>;
  internalKyc: Outcome<boolean>;
  holderCount: Outcome<bigint>;
  holders: Outcome<HolderRow[]>;
  /** True when more holders exist than one page fetched. */
  holdersTruncated: boolean;
  roles: Outcome<RoleRow[]>;
  controlList: Outcome<ControlListView>;
  snapshots: Outcome<SnapshotView>;
}

/** `getMaxSupply()` returns 0 for "no cap". A cap of zero would be a dead token. */
export const maxSupplyIsCap = (maxSupply: bigint): boolean => maxSupply !== 0n;

/* ------------------------------------------------------------- the reading */

/** How many holders / control-list members / role members one page asks for. */
export const PAGE_SIZE = 100;

/**
 * How far the snapshot probe will walk before giving up and saying so.
 *
 * Bounded because the probe is a linear scan and an unbounded one against a
 * security with thousands of snapshots would be a self-inflicted rate limit.
 * 64 is two batches of 32 and covers any plausible testnet security; past it
 * the view is marked `truncated` rather than silently ending.
 */
export const SNAPSHOT_PROBE_LIMIT = 64;

/** Ids per snapshot probe batch. */
const SNAPSHOT_PROBE_STEP = 32;

/**
 * Read the whole register.
 *
 * Sequential batches rather than one giant one: the later batches need the
 * earlier answers (which roles have members, who the holders are), and a
 * single aggregate large enough to cover the worst case would exceed the
 * `eth_call` gas ceilings public relays impose and fail as a whole.
 */
export async function readRegister(
  request: EthRequest,
  chainId: number,
  token: string,
  host: () => string | undefined = () => undefined,
  now: () => number = Date.now,
): Promise<RegisterView> {
  // Validate before anything goes out. A malformed address would otherwise be
  // encoded into every call and disclosed to the operator.
  addressWord(token);

  const { block, pinnedBlock } = await pinBlock(request);
  const ctx: ReadContext = { request, chainId, token, block, host };

  const globals = await readGlobals(ctx);
  const holders = await readHolders(ctx, globals.holderCount);
  const roles = await readRoles(ctx, globals.roleCounts);
  const controlList = await readControlList(ctx, globals.controlListType, globals.controlListCount);
  const snapshots = await readSnapshots(ctx);

  return {
    chainId,
    address: token,
    fetchedAt: now(),
    pinnedBlock,
    endpointHost: host(),
    name: globals.name,
    symbol: globals.symbol,
    decimals: globals.decimals,
    totalSupply: globals.totalSupply,
    maxSupply: globals.maxSupply,
    paused: globals.paused,
    internalKyc: globals.internalKyc,
    holderCount: globals.holderCount,
    holders: holders.rows,
    holdersTruncated: holders.truncated,
    roles,
    controlList,
    snapshots,
  };
}

/**
 * The height to pin every call to.
 *
 * A failure here is not fatal: `latest` still produces a usable view, it just
 * cannot promise the fields were read at one instant, and `pinnedBlock:
 * undefined` is how the view admits that rather than quietly implying
 * consistency it does not have.
 */
async function pinBlock(request: EthRequest): Promise<{ block: string; pinnedBlock: bigint | undefined }> {
  try {
    const raw = await request({ method: "eth_blockNumber" });
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(raw)) {
      return { block: "latest", pinnedBlock: undefined };
    }
    return { block: raw, pinnedBlock: BigInt(raw) };
  } catch {
    return { block: "latest", pinnedBlock: undefined };
  }
}

interface Globals {
  name: Outcome<string | undefined>;
  symbol: Outcome<string | undefined>;
  decimals: Outcome<number>;
  totalSupply: Outcome<bigint>;
  maxSupply: Outcome<bigint>;
  paused: Outcome<boolean>;
  internalKyc: Outcome<boolean>;
  holderCount: Outcome<bigint>;
  controlListType: Outcome<boolean>;
  controlListCount: Outcome<bigint>;
  roleCounts: Outcome<bigint>[];
}

/** One batch: everything about the security that takes no arguments. */
async function readGlobals(ctx: ReadContext): Promise<Globals> {
  const fixed: SigName[] = [
    "name", "symbol", "decimals", "totalSupply", "getMaxSupply", "paused",
    "isInternalKycActivated", "getTotalSecurityHolders", "getControlListType",
    "getControlListCount",
  ];
  const calls: Call3[] = [
    ...fixed.map((n) => call(ctx.token, n)),
    ...ROLES.map((r) => call(ctx.token, "getRoleMemberCount", [bytes32Word(r.id)])),
  ];
  const out = await callBatch(ctx, calls);
  const at = (i: number): Outcome<string> =>
    out[i] ?? unavailable<string>("the multicall returned no entry for this call");

  return {
    // A missing name or symbol is `undefined`, never a placeholder string: the
    // point of decodeString is that untrusted text is either printable or
    // absent, and inventing "Unknown" would put a label on screen nobody read.
    name: mapOutcome(at(0), (d) => decodeString(d)),
    symbol: mapOutcome(at(1), (d) => decodeString(d, 16)),
    decimals: mapOutcome(at(2), decodeUint8),
    totalSupply: mapOutcome(at(3), decodeUint),
    maxSupply: mapOutcome(at(4), decodeUint),
    paused: mapOutcome(at(5), decodeBool),
    internalKyc: mapOutcome(at(6), decodeBool),
    holderCount: mapOutcome(at(7), decodeUint),
    controlListType: mapOutcome(at(8), decodeBool),
    controlListCount: mapOutcome(at(9), decodeUint),
    roleCounts: ROLES.map((_, i) => mapOutcome(at(fixed.length + i), decodeUint)),
  };
}

/**
 * The holder list, and each holder's balance, KYC status and control-list bit.
 *
 * `holderCount` being `unavailable` propagates: with no count there is nothing
 * to page over, and returning an empty list would be the exact lie this file
 * exists to avoid.
 */
async function readHolders(
  ctx: ReadContext,
  holderCount: Outcome<bigint>,
): Promise<{ rows: Outcome<HolderRow[]>; truncated: boolean }> {
  if (holderCount.state !== "ok") {
    return { rows: carry<HolderRow[]>(holderCount), truncated: false };
  }
  if (holderCount.value === 0n) return { rows: ok([]), truncated: false };

  const pageOutcome = (await callBatch(ctx, [
    call(ctx.token, "getSecurityHolders", [word(0n), word(BigInt(PAGE_SIZE))]),
  ]))[0] as Outcome<string>;
  const addressesOutcome = mapOutcome(pageOutcome, decodeAddressArray);
  if (addressesOutcome.state !== "ok") return { rows: addressesOutcome, truncated: false };
  const addresses = addressesOutcome.value;

  // Three calls per holder, interleaved so the index arithmetic below stays a
  // single stride rather than three separate offsets to keep in step.
  const calls: Call3[] = [];
  for (const a of addresses) {
    calls.push(call(ctx.token, "balanceOf", [addressWord(a)]));
    calls.push(call(ctx.token, "getKycStatusFor", [addressWord(a)]));
    calls.push(call(ctx.token, "isInControlList", [addressWord(a)]));
  }
  const per = await callBatch(ctx, calls);
  const rows: HolderRow[] = addresses.map((address, i) => ({
    address,
    balance: mapOutcome(per[i * 3] ?? unavailable<string>("no entry"), decodeUint),
    kycStatus: mapOutcome(per[i * 3 + 1] ?? unavailable<string>("no entry"), decodeUint8),
    inControlList: mapOutcome(per[i * 3 + 2] ?? unavailable<string>("no entry"), decodeBool),
  }));
  return { rows: ok(rows), truncated: holderCount.value > BigInt(addresses.length) };
}

/**
 * Role membership.
 *
 * Members are fetched only for roles the count says are non-empty, which is
 * the difference between one extra batch and thirty-seven wasted calls. A role
 * whose count is `unavailable` is NOT skipped as if it were empty — it is
 * reported unavailable, because "nobody holds the controller role" and "we
 * could not ask" are the two sentences this file refuses to conflate.
 */
async function readRoles(ctx: ReadContext, counts: Outcome<bigint>[]): Promise<Outcome<RoleRow[]>> {
  const wanted: number[] = [];
  counts.forEach((c, i) => {
    if (c.state === "ok" && c.value > 0n) wanted.push(i);
  });

  const memberOutcomes = await callBatch(
    ctx,
    wanted.map((i) =>
      call(ctx.token, "getRoleMembers", [
        bytes32Word((ROLES[i] as RoleInfo).id), word(0n), word(BigInt(PAGE_SIZE)),
      ]),
    ),
  );

  const rows: RoleRow[] = ROLES.map((role, i) => {
    const count = counts[i] ?? unavailable<bigint>("no entry");
    const slot = wanted.indexOf(i);
    const members: Outcome<string[]> =
      slot === -1
        ? count.state === "ok" ? ok<string[]>([]) : carry<string[]>(count)
        : mapOutcome(memberOutcomes[slot] ?? unavailable<string>("no entry"), decodeAddressArray);
    return { role, memberCount: count, members };
  });

  // The batch as a whole failing is reported as such; individual rows still
  // carry their own state, so a partially-answered read stays legible.
  return ok(rows);
}

async function readControlList(
  ctx: ReadContext,
  type: Outcome<boolean>,
  count: Outcome<bigint>,
): Promise<Outcome<ControlListView>> {
  if (type.state !== "ok") return carry<ControlListView>(type);
  if (count.state !== "ok") return carry<ControlListView>(count);
  if (count.value === 0n) {
    return ok({ whitelist: type.value, count: 0n, members: [], truncated: false });
  }
  const membersOutcome = mapOutcome(
    (await callBatch(ctx, [
      call(ctx.token, "getControlListMembers", [word(0n), word(BigInt(PAGE_SIZE))]),
    ]))[0] ?? unavailable<string>("no entry"),
    decodeAddressArray,
  );
  if (membersOutcome.state !== "ok") return carry<ControlListView>(membersOutcome);
  return ok({
    whitelist: type.value,
    count: count.value,
    members: membersOutcome.value,
    truncated: count.value > BigInt(membersOutcome.value.length),
  });
}

/**
 * Find the snapshots by probing.
 *
 * `totalSupplyAtSnapshot(id)` is the probe because it is the field a
 * distribution is later reconciled against — if the id resolves for the number
 * that matters, the snapshot is real for our purposes. Its revert selector is
 * what ends the walk:
 *
 *   - `SnapshotIdDoesNotExists` → we have passed the last snapshot. Stop, and
 *     the list is complete.
 *   - any other revert → the facet is not installed, or something else is
 *     wrong. That is NOT "no snapshots"; it is `unsupported`, said plainly.
 *   - no answer at all → `unavailable`. Never an empty list.
 *
 * The distinction is the entire point. An empty snapshot list on a security
 * that has taken three of them, shown because a relay hiccuped, would let an
 * issuer distribute against the wrong register.
 */
async function readSnapshots(ctx: ReadContext): Promise<Outcome<SnapshotView>> {
  const rows: SnapshotRow[] = [];
  let next = 1n;

  while (rows.length < SNAPSHOT_PROBE_LIMIT) {
    const step = Math.min(SNAPSHOT_PROBE_STEP, SNAPSHOT_PROBE_LIMIT - rows.length);
    const ids = Array.from({ length: step }, (_, k) => next + BigInt(k));
    const calls: Call3[] = [];
    for (const id of ids) {
      calls.push(call(ctx.token, "totalSupplyAtSnapshot", [word(id)]));
      calls.push(call(ctx.token, "getTotalTokenHoldersAtSnapshot", [word(id)]));
    }
    const out = await callBatch(ctx, calls);

    for (let k = 0; k < ids.length; k++) {
      const supply = out[k * 2] ?? unavailable<string>("no entry");
      const holders = out[k * 2 + 1] ?? unavailable<string>("no entry");

      if (supply.state === "unavailable") {
        // Nobody answered. If we already have rows they are still true, but
        // the list is not known to be complete — say truncated, not finished.
        return rows.length === 0
          ? unavailable<SnapshotView>(supply.why)
          : ok({ rows, truncated: true });
      }
      if (supply.state === "unsupported") {
        if (startsWithSelector(supply.revert, SNAPSHOT_ABSENT_SELECTOR)) {
          return ok({ rows, truncated: false }); // the end, and we know it
        }
        // Some other revert on the very first probe means the snapshot facet
        // is not there at all. Later on it means something changed underneath
        // us; either way it is not an assertion that there are no snapshots.
        return rows.length === 0
          ? { state: "unsupported", revert: supply.revert }
          : ok({ rows, truncated: true });
      }
      /* A successful call is NOT evidence the function exists — on Hedera.
       *
       * Observed against testnet.hashio.io: calling an unknown selector on an
       * HTS-backed token (USDC at 0x…1549, WHBAR at 0x…3aD2) does not revert.
       * The system contract answers with data that is not a uint256. Run
       * against those tokens, an earlier version of this walk recorded 64
       * "snapshots" for a plain ERC-20 and marked the list truncated — a
       * register with no snapshot facet at all, presented as one with more
       * snapshots than we could count.
       *
       * So the probe requires a value that DECODES, not merely a call that
       * returned. A reply that is not a uint256 ends the walk exactly like the
       * end-of-list revert does, and if nothing decoded then this security has
       * no snapshot facet. */
      const totalSupply = mapOutcome(supply, decodeUint);
      if (totalSupply.state !== "ok") {
        return rows.length === 0
          ? { state: "unsupported", revert: supply.value }
          : ok({ rows, truncated: true });
      }
      rows.push({
        id: ids[k] as bigint,
        totalSupply,
        holderCount: mapOutcome(holders, decodeUint),
      });
    }
    next += BigInt(step);
  }
  return ok({ rows, truncated: true });
}

/**
 * Every holder's balance AT one snapshot, for a distribution to reconcile to.
 *
 * A separate read rather than part of `readRegister`, because it is a different
 * question asked at a different time: the register view is "who holds what
 * now", and this is "who held what at snapshot #3", which only a distribution
 * cares about and which costs a call per page for a snapshot nobody is looking
 * at.
 *
 * `balancesOfAtSnapshot` returns `(address,uint256)[]` — the pair, in one call,
 * so the address and the balance cannot come from two different reads and be
 * zipped together wrongly. That is why it is used here in preference to
 * `getTokenHoldersAtSnapshot` plus a `balanceOfAtSnapshot` per holder.
 *
 * A snapshot with more holders than one page returns `unavailable` rather than
 * a partial list, and the sentence says so. `planDividend` would refuse a short
 * list anyway — it checks the count against the snapshot's own — but a partial
 * list should not travel that far: everything downstream of here treats a
 * holder list as the whole register at that instant.
 */
export async function readSnapshotHolders(
  request: EthRequest,
  chainId: number,
  token: string,
  snapshotId: bigint,
  host: () => string | undefined = () => undefined,
  block = "latest",
): Promise<Outcome<HolderBalance[]>> {
  addressWord(token);
  const ctx: ReadContext = { request, chainId, token, block, host };
  const out = await callBatch(ctx, [
    call(ctx.token, "getTotalTokenHoldersAtSnapshot", [word(snapshotId)]),
    call(ctx.token, "balancesOfAtSnapshot", [word(snapshotId), word(0n), word(BigInt(PAGE_SIZE))]),
  ]);
  const count = mapOutcome(out[0] ?? unavailable<string>("no entry"), decodeUint);
  if (count.state !== "ok") return carry<HolderBalance[]>(count);
  const rows = mapOutcome(out[1] ?? unavailable<string>("no entry"), decodeHolderBalanceArray);
  if (rows.state !== "ok") return rows;
  if (BigInt(rows.value.length) !== count.value) {
    return unavailable<HolderBalance[]>(
      `snapshot ${snapshotId} reports ${count.value} holders and one page returned ` +
      `${rows.value.length}. A distribution is not planned from part of a register.`,
    );
  }
  return ok(rows.value);
}

/** Does this revert payload begin with that error selector? */
export function startsWithSelector(revert: string, selector: string): boolean {
  return revert.toLowerCase().startsWith(selector.toLowerCase());
}

/* ------------------------------------------------------------- freshness */

/**
 * How long a privileged fact — a role member, a KYC status, the paused flag —
 * may be shown before it is labelled stale.
 *
 * Much shorter than core's 60 s balance window, and deliberately. A stale
 * balance costs a surprise; a stale role list is someone deciding that a key
 * they just revoked is still revoked, off a screen that has not asked since.
 * Fifteen seconds is roughly "since you last looked away".
 */
export const PRIVILEGED_STALE_AFTER_MS = 15_000;

/** Age of the privileged half of a view, with the shorter limit applied. */
export function privilegedFreshness(view: RegisterView, now: number): Freshness {
  const f = freshnessOf(view.fetchedAt, now);
  return { ...f, stale: f.ageMs >= PRIVILEGED_STALE_AFTER_MS };
}

/**
 * The sentence that goes next to the register. One function so no screen can
 * render the figures without the provenance and the age arriving with them.
 */
export function registerProvenance(view: RegisterView, now: number): string {
  const fresh = privilegedFreshness(view, now);
  const who = view.endpointHost ? `from ${view.endpointHost}` : "from an RPC endpoint";
  const at = view.pinnedBlock === undefined
    ? "at whatever height the node called latest"
    : `at block ${view.pinnedBlock}`;
  return `${fresh.stale ? "STALE — read " : "Read "}${fresh.text} ${who}, ${at}. ` +
    "Roles, KYC and the paused flag can change in one transaction; refresh before acting on them.";
}

/* ------------------------------------------------------------- diagnosis */

/**
 * One sentence about the read as a whole, said once, at the top.
 *
 * ---------------------------------------------------------------------------
 * The bug this fixes
 *
 * Pointing "Read register" at an address that is not an ATS security produced
 * FORTY identical rows of "unavailable — undecodable reply: a uint256 return
 * must be exactly one word": one per role, plus the globals. Every one of them
 * was correct. Together they were unreadable, and worse than unreadable — a
 * wall of the same sentence reads as a broken app, when what actually happened
 * is the HTS trap being caught exactly as designed. An unknown selector on an
 * HTS system contract answers `success` with data that does not decode (plan
 * §2b), so a non-ATS address answers every one of these calls, and every one of
 * the answers fails to decode for the same reason.
 *
 * The refusal is right. Repeating it forty times is what was wrong. So the
 * repetition is turned into the diagnosis it always was: *this address does not
 * answer like an ATS security*.
 *
 * ---------------------------------------------------------------------------
 * Why a count, and not a flag set during the read
 *
 * A flag would have to be decided at the moment of each failure, by code that
 * can see one call. Whether a read as a whole failed the same way everywhere is
 * only knowable once every call is back, which is here. It is also why this is
 * a pure function of a finished `RegisterView`: a test can build the view and
 * assert the sentence with no network at all.
 *
 * The threshold is deliberately not 1. One field failing to decode is a
 * security missing a facet, or a relay truncating one response, and saying "not
 * an ATS security" about that would be the same overreach in the other
 * direction.
 */
export interface RegisterDiagnosis {
  /** The sentence for the top of the page. */
  text: string;
  /** The reason all of them gave, kept so it is said once rather than never. */
  why: string;
  /** How many separate fields failed this same way. */
  count: number;
}

/**
 * How many fields must fail identically before it is a fact about the address.
 *
 * Six: more than any one facet contributes, well under the thirty-seven roles,
 * and above the largest group of fields that can plausibly go together for an
 * innocent reason.
 */
export const DIAGNOSIS_THRESHOLD = 6;

/**
 * The prefix `mapOutcome` puts on a reply that arrived and made no sense.
 *
 * This diagnosis fires on that and on nothing else, and the distinction is the
 * whole of its honesty. A dead endpoint ALSO fails every field identically —
 * thirty-seven copies of "no RPC endpoint answered" — and saying "this address
 * does not answer like an ATS security" about that would be a confident wrong
 * answer with the wrong remedy attached: the user would go looking for a better
 * address when what they need is a working connection.
 *
 * So the two are separated by the one thing that actually distinguishes them:
 * whether anybody replied. `undecodable` means a reply arrived, which on Hedera
 * is what an unknown selector produces. A transport failure keeps its own
 * per-field sentence and gets no banner.
 */
const UNDECODABLE_PREFIX = "undecodable reply:";

/** Every qualifying `why` in a finished view, roles and holders included. */
function unavailableReasons(view: RegisterView): string[] {
  const out: string[] = [];
  const add = (o: Outcome<unknown>): void => {
    if (o.state === "unavailable" && o.why.startsWith(UNDECODABLE_PREFIX)) out.push(o.why);
  };
  add(view.name); add(view.symbol); add(view.decimals); add(view.totalSupply);
  add(view.maxSupply); add(view.paused); add(view.internalKyc);
  add(view.holderCount); add(view.holders); add(view.controlList);
  add(view.snapshots); add(view.roles);
  if (view.roles.state === "ok") {
    for (const r of view.roles.value) { add(r.memberCount); add(r.members); }
  }
  if (view.holders.state === "ok") {
    for (const h of view.holders.value) {
      add(h.balance); add(h.kycStatus); add(h.inControlList);
    }
  }
  return out;
}

/**
 * The diagnosis, or undefined when the read has no single story.
 *
 * Undefined is the common case and the important one: a register that mostly
 * worked must not acquire a banner claiming it did not. Only a read where one
 * reason accounts for at least `DIAGNOSIS_THRESHOLD` separate fields gets a
 * sentence, and the sentence names the count so a reader can judge it.
 */
export function registerDiagnosis(view: RegisterView): RegisterDiagnosis | undefined {
  const counts = new Map<string, number>();
  for (const why of unavailableReasons(view)) {
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  let worst: { why: string; count: number } | undefined;
  for (const [why, count] of counts) {
    if (worst === undefined || count > worst.count) worst = { why, count };
  }
  if (worst === undefined || worst.count < DIAGNOSIS_THRESHOLD) return undefined;

  /* Named as a property of the ADDRESS, not of the network. "Could not reach
   * the endpoint" would be a different diagnosis with a different remedy, and
   * it is not this one: the calls were answered. They were answered with
   * something that is not what an ATS security returns. */
  return {
    text:
      `This address does not answer like an ATS security: ${worst.count} separate ` +
      "reads were answered, and every one of the answers failed to decode the " +
      "same way. On Hedera an unknown function does not revert — an HTS system " +
      "contract replies successfully with data that means nothing — so this is " +
      "what a plain token, or a wrong address, looks like from here.",
    why: worst.why,
    count: worst.count,
  };
}
