/**
 * Approval hygiene, in the spirit of revoke.cash — the other side of the clock.
 *
 * The rule engine (rules.ts) works before a signature exists. This works after:
 * it enumerates what is already outstanding, and builds the transactions that
 * take it back. docs/ANTI-SCAM.md is blunt about why the second one matters
 * most — `invalidateNonces` is the only remedy that exists between "signed a
 * phishing permit" and "the drain lands". An off-chain permit sits in the
 * attacker's pocket with a far-future deadline; there is no pending
 * transaction to outbid and nothing on chain to point at. Burning the nonce the
 * signature commits to is the single action that makes it worthless, and it
 * only works while the attacker has not yet submitted it.
 *
 * ---------------------------------------------------------------------------
 * This module never signs and never sends
 *
 * Every remedy here is a `UnsignedTx` — `to`, `value`, `data` — handed back to
 * the caller to put through the ordinary signing path, so it appears on the
 * device screen and is approved there like anything else. That is not
 * ceremony. A "revoke" button that signed on the user's behalf would be a code
 * path in the companion app that produces signatures without a device
 * confirmation, which is precisely the property this whole project exists to
 * not have. The convenience of one less button press is not worth owning that
 * path.
 *
 * ---------------------------------------------------------------------------
 * Why the caller supplies the spenders
 *
 * There is no `getAllowances(owner)` on chain. Real allowance enumeration means
 * indexing `Approval` logs, and the honest ways to get that are running an
 * indexer or asking somebody else's — the second being exactly the "hand every
 * address you touch to a stranger" trade ANTI-SCAM.md refuses. So this reads
 * allowances for a *known set of pairs*: the curated token list crossed with
 * spenders the caller knows about (Permit2 plus whatever approvals this app has
 * itself seen the user sign). That is a floor, not a census, and callers must
 * say so — an empty result means "none among the pairs we asked about", never
 * "you have no outstanding approvals".
 *
 * Batched through multicall.ts, for the reason in that file's header: two
 * hundred `eth_call`s hand the operator the same list in two hundred separate
 * observations and get the app throttled halfway through.
 */

import { keccak_256 } from "@noble/hashes/sha3";

import { AbiError, DecodeError, decodeUint256Return, type EthRequest } from "./balances.ts";
import {
  chunk, decodeAggregate3Return, encodeAggregate3, MULTICALL_CHUNK_SIZE,
  multicall3Address, type Aggregate3Result, type Call3,
} from "./multicall.ts";
import { PERMIT2_ADDRESS } from "./rules.ts";

/* ------------------------------------------------------------- ABI helpers
 *
 * Selectors are derived from their signatures with keccak rather than typed in
 * as hex. Four bytes copied from a blog post is a class of bug with no
 * symptom: the call encodes cleanly, the contract does not recognise it, and
 * `allowFailure` turns the mistake into "no allowances found", which reads as
 * good news. Deriving them means the signature string is the thing under
 * review, and a reader can check it against the contract source.
 */

export const selectorOf = (signature: string): string =>
  [...keccak_256(new TextEncoder().encode(signature)).subarray(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

/** `allowance(address owner, address spender)` — ERC-20. */
export const SELECTOR_ERC20_ALLOWANCE = selectorOf("allowance(address,address)");
/** `approve(address spender, uint256 amount)` — ERC-20, the revoke path. */
export const SELECTOR_ERC20_APPROVE = selectorOf("approve(address,uint256)");
/** `allowance(address owner, address token, address spender)` — Permit2. */
export const SELECTOR_PERMIT2_ALLOWANCE = selectorOf("allowance(address,address,address)");
/** `lockdown((address token, address spender)[])` — Permit2 batch revoke. */
export const SELECTOR_PERMIT2_LOCKDOWN = selectorOf("lockdown((address,address)[])");
/** `invalidateNonces(address token, address spender, uint48 newNonce)` — Permit2. */
export const SELECTOR_PERMIT2_INVALIDATE = selectorOf("invalidateNonces(address,address,uint48)");

const UINT256_MAX = (1n << 256n) - 1n;
const HEX40 = /^0x[0-9a-fA-F]{40}$/;

function addressWord(address: string, what: string): string {
  if (!HEX40.test(address)) throw new AbiError(`${what} is not a 20-byte address`);
  return "0".repeat(24) + address.slice(2).toLowerCase();
}

function word(value: bigint): string {
  if (value < 0n) throw new AbiError("a uint cannot be negative");
  if (value > UINT256_MAX) throw new AbiError("value does not fit in a uint256");
  return value.toString(16).padStart(64, "0");
}

/* ------------------------------------------------------------- encoding */

export const encodeErc20Allowance = (owner: string, spender: string): string =>
  `0x${SELECTOR_ERC20_ALLOWANCE}${addressWord(owner, "owner")}${addressWord(spender, "spender")}`;

export const encodeErc20Approve = (spender: string, amount: bigint): string =>
  `0x${SELECTOR_ERC20_APPROVE}${addressWord(spender, "spender")}${word(amount)}`;

export const encodePermit2Allowance = (owner: string, token: string, spender: string): string =>
  `0x${SELECTOR_PERMIT2_ALLOWANCE}${addressWord(owner, "owner")}` +
  `${addressWord(token, "token")}${addressWord(spender, "spender")}`;

/**
 * `lockdown` over an array of `(token, spender)` structs.
 *
 * A dynamic array of *static* tuples, so the layout is one offset word, one
 * length word, then the pairs inline — no per-element offsets, unlike
 * `aggregate3` whose tuples carry `bytes`. Getting that wrong produces
 * well-formed calldata that revokes different pairs than intended, which is
 * the failure mode multicall.ts's header warns about in the same words.
 */
export function encodePermit2Lockdown(
  approvals: readonly { token: string; spender: string }[],
): string {
  const body = approvals
    .map((a) => addressWord(a.token, "token") + addressWord(a.spender, "spender"))
    .join("");
  return `0x${SELECTOR_PERMIT2_LOCKDOWN}${word(0x20n)}${word(BigInt(approvals.length))}${body}`;
}

/** uint48's ceiling. A nonce past it is not a Permit2 nonce. */
export const UINT48_MAX = (1n << 48n) - 1n;

/**
 * `invalidateNonces(token, spender, newNonce)`.
 *
 * Permit2 nonces for an (owner, token, spender) triple are sequential, and this
 * sets the current one *forward*: every signature committing to a nonce below
 * `newNonce` becomes unspendable at once. It is therefore the remedy for a
 * permit already signed and not yet submitted.
 *
 * `newNonce` must be greater than the on-chain nonce or the contract reverts
 * (`InvalidNonce`), so it is taken from a reading of the current allowance
 * rather than invented — `invalidateNoncesTx` below does exactly that. Nothing
 * here bumps it by a large margin: Permit2 caps the jump, and a revert costs
 * gas and a confused user.
 */
export function encodePermit2InvalidateNonces(
  token: string, spender: string, newNonce: bigint,
): string {
  if (newNonce < 0n || newNonce > UINT48_MAX) throw new AbiError("nonce does not fit a uint48");
  return `0x${SELECTOR_PERMIT2_INVALIDATE}${addressWord(token, "token")}` +
    `${addressWord(spender, "spender")}${word(newNonce)}`;
}

/* ------------------------------------------------------------- decoding */

/** Permit2's `allowance` return: `(uint160 amount, uint48 expiration, uint48 nonce)`. */
export interface Permit2Allowance {
  amount: bigint;
  /** Unix seconds. Zero means the approval is not usable. */
  expiration: bigint;
  nonce: bigint;
}

const UINT160_MAX = (1n << 160n) - 1n;

export function decodePermit2Allowance(value: unknown): Permit2Allowance {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{192}$/.test(value)) {
    throw new DecodeError("Permit2 allowance did not return three words");
  }
  const at = (i: number): bigint => BigInt(`0x${value.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
  const amount = at(0);
  const expiration = at(1);
  const nonce = at(2);
  /* Each field is narrower than the word carrying it. A value that overflows
   * its declared width is not something this contract can have returned, so it
   * is refused rather than masked — masking would report a plausible allowance
   * derived from a return nobody legitimate produced. */
  if (amount > UINT160_MAX || expiration > UINT48_MAX || nonce > UINT48_MAX) {
    throw new DecodeError("Permit2 allowance fields do not fit their declared widths");
  }
  return { amount, expiration, nonce };
}

/* ------------------------------------------------------------ the reading */

/** One (token, spender) pair to ask about, on one of the two paths. */
export interface AllowanceQuery {
  token: string;
  spender: string;
  /** `erc20`: the token's own allowance. `permit2`: Permit2's ledger. */
  via: "erc20" | "permit2";
}

export type AllowanceFailure = "call-failed" | "undecodable" | "batch-failed";

/**
 * One pair's outcome.
 *
 * A union for the reason multicall.ts spells out at length: a token that never
 * answered and a token with no allowance must never come out of here looking
 * the same. Here the stakes are inverted and worse — a failed call rendered as
 * "no allowance" tells a user their exposure is closed when it is open.
 */
export type AllowanceResult =
  | {
      query: AllowanceQuery;
      ok: true;
      /** Raw units. Decimals are not knowable and are never guessed. */
      amount: bigint;
      /** At or beyond half the field's width — the drainer's pattern. */
      unlimited: boolean;
      /** Permit2 only: when the approval lapses, and the nonce to invalidate. */
      expiration?: bigint;
      nonce?: bigint;
    }
  | { query: AllowanceQuery; ok: false; reason: AllowanceFailure };

/** The same "beyond any real supply" test eip712.ts applies, per field width. */
const isUnlimited = (value: bigint, bits: number): boolean => value >= 1n << BigInt(bits - 1);

function encodeQuery(owner: string, query: AllowanceQuery): Call3 {
  return query.via === "permit2"
    ? {
        target: PERMIT2_ADDRESS,
        allowFailure: true,
        callData: encodePermit2Allowance(owner, query.token, query.spender),
      }
    : {
        target: query.token,
        allowFailure: true,
        callData: encodeErc20Allowance(owner, query.spender),
      };
}

/**
 * Read every pair's outstanding allowance, batched.
 *
 * One result per query, in the order given, always — the caller zips this
 * against its own list and must never have to check whether the lengths still
 * line up. A chunk that fails as a whole marks only its own pairs and the rest
 * still run, so one flaky request cannot erase exposure the app had already
 * found.
 */
export async function fetchAllowances(
  request: EthRequest,
  chainId: number,
  owner: string,
  queries: readonly AllowanceQuery[],
  chunkSize: number = MULTICALL_CHUNK_SIZE,
): Promise<AllowanceResult[]> {
  // Refuse a bad owner before anything is disclosed to an operator.
  addressWord(owner, "owner");
  const to = multicall3Address(chainId);

  const out: AllowanceResult[] = [];
  for (const slice of chunk(queries, chunkSize)) {
    let results: Aggregate3Result[];
    try {
      results = decodeAggregate3Return(
        await request({
          method: "eth_call",
          params: [
            { to, data: encodeAggregate3(slice.map((q) => encodeQuery(owner, q))) },
            "latest",
          ],
        }),
      );
    } catch {
      for (const query of slice) out.push({ query, ok: false, reason: "batch-failed" });
      continue;
    }
    if (results.length !== slice.length) {
      for (const query of slice) out.push({ query, ok: false, reason: "batch-failed" });
      continue;
    }

    for (let i = 0; i < slice.length; i++) {
      const query = slice[i] as AllowanceQuery;
      const result = results[i] as Aggregate3Result;
      if (!result.success) {
        out.push({ query, ok: false, reason: "call-failed" });
        continue;
      }
      try {
        if (query.via === "permit2") {
          const a = decodePermit2Allowance(result.returnData);
          out.push({
            query, ok: true, amount: a.amount, unlimited: isUnlimited(a.amount, 160),
            expiration: a.expiration, nonce: a.nonce,
          });
        } else {
          const amount = decodeUint256Return(result.returnData);
          out.push({ query, ok: true, amount, unlimited: isUnlimited(amount, 256) });
        }
      } catch {
        out.push({ query, ok: false, reason: "undecodable" });
      }
    }
  }
  return out;
}

/** Pairs worth showing: an allowance that is actually outstanding. */
export const isOutstanding = (r: AllowanceResult): boolean => r.ok && r.amount > 0n;

/**
 * The tokens × spenders cross product, as queries.
 *
 * Both paths for every pair: a token can be approved to a spender directly and
 * *also* through Permit2, and the two are separately revocable. Revoking one
 * and reporting the exposure closed would be the same lie as reporting a failed
 * call as zero.
 */
export function buildQueries(
  tokens: readonly string[],
  spenders: readonly string[],
): AllowanceQuery[] {
  const out: AllowanceQuery[] = [];
  for (const token of tokens) {
    for (const spender of spenders) {
      /* Permit2 as a *spender* of the token is the approval that lets Permit2
       * move it at all; Permit2's own ledger is asked about separately below.
       * Asking Permit2 for its allowance to itself is meaningless. */
      out.push({ token, spender, via: "erc20" });
      if (spender.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase()) {
        out.push({ token, spender, via: "permit2" });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------- the remedies */

/**
 * A transaction for the DEVICE to sign. Never signed or sent here.
 *
 * `why` exists so the caller can put the reason next to the button, in this
 * app's own words — nothing in it comes from a dapp, a token list or an RPC.
 */
export interface UnsignedTx {
  to: string;
  value: bigint;
  data: string;
  why: string;
}

/** Set an ERC-20 allowance to zero. The ordinary revoke. */
export function revokeErc20Tx(token: string, spender: string): UnsignedTx {
  return {
    to: token,
    value: 0n,
    data: encodeErc20Approve(spender, 0n),
    why: `Set this token's allowance for ${spender} to zero. Existing off-chain ` +
      "permits for it are not affected — those need invalidateNonces.",
  };
}

/**
 * Permit2 `lockdown`: revoke many (token, spender) allowances in one
 * transaction.
 *
 * The batch is the point. Once a wallet has approved a dozen tokens to Permit2,
 * closing them one at a time is a dozen device confirmations and a dozen gas
 * payments, and the realistic outcome is that the user stops halfway.
 */
export function permit2LockdownTx(
  approvals: readonly { token: string; spender: string }[],
): UnsignedTx {
  if (approvals.length === 0) throw new AbiError("lockdown needs at least one approval to revoke");
  return {
    to: PERMIT2_ADDRESS,
    value: 0n,
    data: encodePermit2Lockdown(approvals),
    why: `Revoke ${approvals.length} Permit2 allowance(s) in one transaction. This ` +
      "stops future transfers, but does not cancel a permit signature that has " +
      "already been given and not yet submitted.",
  };
}

/**
 * Permit2 `invalidateNonces`: kill a signature that has been given but not
 * used.
 *
 * `current` is the nonce read back from `fetchAllowances`, and the new nonce is
 * exactly one past it — the smallest step that invalidates the outstanding
 * signature. Anything larger buys nothing and Permit2 bounds the jump anyway.
 *
 * This is the remedy that has a clock on it. It works only while the attacker
 * has not yet submitted the permit, and it recovers nothing already taken.
 */
export function invalidateNoncesTx(
  token: string, spender: string, current: bigint,
): UnsignedTx {
  const next = current + 1n;
  if (next > UINT48_MAX) throw new AbiError("this nonce cannot be advanced any further");
  return {
    to: PERMIT2_ADDRESS,
    value: 0n,
    data: encodePermit2InvalidateNonces(token, spender, next),
    why: "Burn the Permit2 nonce this token and spender are on, making any permit " +
      "signature already given for them unusable. Only works if it has not been " +
      "submitted yet, and recovers nothing already taken.",
  };
}

/**
 * The sentence that must accompany any allowance list.
 *
 * The floor-not-census point from the header, in one line, because it is the
 * one thing a user could most easily read backwards.
 */
export const ALLOWANCE_NOTICE =
  "These are the token and spender pairs this app knew to ask about — the " +
  "curated token list crossed with spenders it has seen. It is not a complete " +
  "list of your approvals, and an empty result does not mean you have none. " +
  "Every revoke below is an ordinary transaction you approve on the device.";
