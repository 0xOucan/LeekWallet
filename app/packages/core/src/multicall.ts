/**
 * Multicall3 batching, so a wallet holding two hundred tokens costs one request.
 *
 * The problem this solves is not speed, it is disclosure and rate limits. Every
 * `eth_call` tells whichever operator answered that this address cares about
 * that contract (balances.ts, and rpc.ts limit 2); asking two hundred times
 * hands over the same list in two hundred separate observations and gets the
 * app throttled halfway through. One `aggregate3` discloses the same list once.
 *
 * Three properties are load-bearing here, in order of how badly they hurt:
 *
 * 1. **`allowFailure` is always true.** Token contracts in a user's wallet are
 *    arbitrary deployed code — airdropped junk, honeypots, proxies pointing at
 *    nothing. One of them reverting on `balanceOf` is normal. With
 *    `allowFailure: false` that single contract reverts the whole aggregate and
 *    the user sees *no* balances at all, which is both useless and a fine
 *    denial-of-service for anyone who can airdrop a token to a stranger.
 *
 * 2. **A failed call is not a zero balance.** This is the one mistake that
 *    turns a batching optimisation into a lie. `success: false` means nobody
 *    answered; `success: true` with a zero word means the token says you hold
 *    none. Conflating them shows a confident "0" for a contract that never
 *    spoke, and a user who is told they hold nothing behaves differently from a
 *    user who is told the app could not find out. So the result type is a union
 *    and there is no code path here that substitutes 0n for an absent answer.
 *
 * 3. **The return data is attacker-controlled.** It arrives from an unverified
 *    operator, through a contract at an address this app did not check. Every
 *    offset and length read below is bounds-checked against the actual byte
 *    length before it is used, and anything that does not add up is refused as
 *    a whole rather than parsed as far as it goes — a half-decoded array would
 *    silently reassign balances to the wrong tokens.
 *
 * ABI encoding is reused from balances.ts rather than re-derived: the inner
 * calldata is exactly `encodeBalanceOf` and the inner return is exactly
 * `decodeUint256Return`, so a batched balance and a single one cannot disagree.
 */

import {
  AbiError, DecodeError, decodeUint256Return, encodeBalanceOf, type EthRequest,
} from "./balances.ts";

/* --------------------------------------------------------------- deployment */

/**
 * Multicall3's canonical address, identical on every chain that has one.
 *
 * It is deployed deterministically (a pre-signed Nick's-method transaction), so
 * the same address on a different chain is the same bytecode. This is a
 * convenience, not an attestation: an operator can answer for that address with
 * whatever it likes, which is exactly why a batched balance is worth no more
 * trust than a single one.
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Chains whose Multicall3 is somewhere else, by chain id.
 *
 * Empty today because every chain in chains.ts uses the canonical address. It
 * exists so a chain that broke the pattern — a chain launched with a
 * pre-deployed multicall at a different address, or one whose deployer never
 * ran — is expressible as one line of data rather than a code change, and so
 * that `multicall3Address()` has a single place to look.
 */
export const MULTICALL3_OVERRIDES: Readonly<Record<number, string>> = {};

/** Where to send an aggregate on this chain. */
export function multicall3Address(chainId: number): string {
  return MULTICALL3_OVERRIDES[chainId] ?? MULTICALL3_ADDRESS;
}

/**
 * Calls per `eth_call`.
 *
 * Chosen for the node, not for us. A batch of 100 `balanceOf` calls is roughly
 * 100 * 3 words of calldata (~10 KB of hex in the request body) and executes
 * ~100 SLOADs inside one call — comfortably under the ~10 MB body limits and
 * the 50 M-gas `eth_call` caps that public providers impose, with room for the
 * slowest of them. Larger batches start hitting provider-specific gas ceilings
 * that surface as an opaque error for the *whole* batch, which costs more than
 * the extra round trip saved. 100 also keeps a single failure's blast radius
 * small: a rejected chunk loses 100 answers, not all of them.
 */
export const MULTICALL_CHUNK_SIZE = 100;

/* ------------------------------------------------------------- ABI encoding */

/** `aggregate3((address,bool,bytes)[])`. */
export const SELECTOR_AGGREGATE3 = "82ad56cb";

/** One entry of the batch. `allowFailure` is not optional — see the header. */
export interface Call3 {
  target: string;
  allowFailure: boolean;
  /** 0x-prefixed calldata, whole bytes. */
  callData: string;
}

const UINT256_MAX = (1n << 256n) - 1n;

function requireAddress(address: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new AbiError(`${what} is not a 20-byte address`);
  }
  return address.slice(2).toLowerCase();
}

function word(value: bigint): string {
  if (value < 0n) throw new AbiError("a uint256 cannot be negative");
  if (value > UINT256_MAX) throw new AbiError("value does not fit in a uint256");
  return value.toString(16).padStart(64, "0");
}

/** A `bytes` tail: length word then right-padded data. Head is written separately. */
function bytesTail(callData: string): string {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(callData)) {
    throw new AbiError("callData is not whole-byte hex");
  }
  const body = callData.slice(2).toLowerCase();
  const length = body.length / 2;
  const padded = body.padEnd(Math.ceil(length / 32) * 32 * 2, "0");
  return `${word(BigInt(length))}${padded}`;
}

/**
 * `aggregate3(calls)` calldata.
 *
 * Layout, written out because getting it wrong produces well-formed calldata
 * that decodes to different calls rather than an error: one head word holding
 * the offset to the array (0x20), the array length, then one offset per element
 * *relative to the start of the element block*, then the elements. Each element
 * is itself a dynamic tuple: target, allowFailure, offset to its bytes (0x60,
 * since three head words precede it), then the bytes tail.
 */
export function encodeAggregate3(calls: readonly Call3[]): string {
  const n = calls.length;
  const bodies = calls.map((call) => {
    const head = `${"0".repeat(24)}${requireAddress(call.target, "call target")}` +
      word(call.allowFailure ? 1n : 0n) + word(0x60n);
    return head + bytesTail(call.callData);
  });

  // Element offsets are measured from the first element-offset word, so the
  // first element starts after all n offset words.
  let cursor = BigInt(n) * 32n;
  let offsets = "";
  for (const body of bodies) {
    offsets += word(cursor);
    cursor += BigInt(body.length / 2);
  }

  return `0x${SELECTOR_AGGREGATE3}${word(0x20n)}${word(BigInt(n))}${offsets}${bodies.join("")}`;
}

/** Calldata for "every one of these tokens' balanceOf(owner)", allowFailure on. */
export function encodeBalanceOfBatch(owner: string, tokens: readonly string[]): string {
  const callData = encodeBalanceOf(owner);
  return encodeAggregate3(
    tokens.map((target) => ({ target, allowFailure: true, callData })),
  );
}

/* ------------------------------------------------------------- ABI decoding */

/** One `Result` from `aggregate3`. `returnData` is meaningless when !success. */
export interface Aggregate3Result {
  success: boolean;
  /** 0x-prefixed. Typically the revert reason, or empty, when success is false. */
  returnData: string;
}

function returnBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new DecodeError("aggregate3 did not return whole-byte hex");
  }
  const hex = value.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A 32-byte word, bounds-checked.
 *
 * Every read of attacker-supplied data goes through here rather than indexing
 * directly, because `bytes[i]` past the end is `undefined` and arithmetic on it
 * yields NaN — a silent wrong number instead of a refusal.
 */
function wordAt(bytes: Uint8Array, at: number): bigint {
  if (!Number.isSafeInteger(at) || at < 0 || at + 32 > bytes.length) {
    throw new DecodeError("aggregate3 return is truncated");
  }
  let v = 0n;
  for (let k = at; k < at + 32; k++) v = (v << 8n) | BigInt(bytes[k] as number);
  return v;
}

/**
 * A word used as a byte offset or a length.
 *
 * A hostile return can put 2^255 in an offset word. Bounding it by the actual
 * buffer length before it is ever added to anything keeps the arithmetic inside
 * safe-integer range and makes "absurd offset" a refusal rather than a
 * subarray() that quietly returns nothing.
 */
function sizeAt(bytes: Uint8Array, at: number, what: string): number {
  const raw = wordAt(bytes, at);
  if (raw > BigInt(bytes.length)) throw new DecodeError(`aggregate3 ${what} is out of range`);
  return Number(raw);
}

const toHex = (bytes: Uint8Array): string => {
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
};

/**
 * `(bool success, bytes returnData)[]` — aggregate3's return.
 *
 * Strict throughout, and refuses the whole array on any inconsistency. Partial
 * results would be worse than none: entries are matched to tokens by position,
 * so an array that decoded four of five entries would still align entries 0..3
 * correctly and then leave the caller guessing about the fifth, and an array
 * that lost an entry in the middle would misattribute every balance after it.
 */
export function decodeAggregate3Return(value: unknown): Aggregate3Result[] {
  const bytes = returnBytes(value);
  if (bytes.length === 0) {
    throw new DecodeError("aggregate3 returned nothing (no multicall deployed at that address?)");
  }

  const arrayAt = sizeAt(bytes, 0, "array offset");
  const count = sizeAt(bytes, arrayAt, "array length");
  // Each element is at least three words even when empty, so a length claiming
  // more entries than the buffer could physically hold is a lie worth catching
  // before allocating anything for it.
  if (count * 96 > bytes.length) throw new DecodeError("aggregate3 claims more results than it sent");

  const elementsAt = arrayAt + 32;
  const out: Aggregate3Result[] = [];
  for (let i = 0; i < count; i++) {
    const offset = sizeAt(bytes, elementsAt + i * 32, "element offset");
    const at = elementsAt + offset;

    const successWord = wordAt(bytes, at);
    // Solidity encodes a bool as exactly 0 or 1. Anything else is not a bool,
    // and treating a nonzero word as "true" would let a crafted return mark a
    // call that never happened as having answered.
    if (successWord > 1n) throw new DecodeError("aggregate3 success flag is not a bool");

    const dataAt = at + sizeAt(bytes, at + 32, "returnData offset");
    const length = sizeAt(bytes, dataAt, "returnData length");
    if (dataAt + 32 + length > bytes.length) throw new DecodeError("aggregate3 returnData is truncated");

    out.push({
      success: successWord === 1n,
      returnData: toHex(bytes.subarray(dataAt + 32, dataAt + 32 + length)),
    });
  }
  return out;
}

/* ----------------------------------------------------------- the high level */

/** Why a token has no balance to show. Never rendered as a number. */
export type BalanceFailure =
  /** The token's `balanceOf` reverted, or the address has no code. */
  | "call-failed"
  /** It answered, but not with something that is a uint256. */
  | "undecodable"
  /** The batch itself never came back — nobody asked this token anything. */
  | "batch-failed";

/**
 * One token's outcome. A discriminated union rather than `bigint | undefined`
 * so that no caller can reach a number without having looked at `ok` first, and
 * so "we do not know" carries a reason to put on screen.
 */
export type TokenBalanceResult =
  | { token: string; ok: true; raw: bigint }
  | { token: string; ok: false; reason: BalanceFailure };

/** Fixed-size slices, order preserved. Split out so the test can pin it. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new AbiError(`invalid chunk size: ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const LATEST = "latest";

/**
 * Every token's `balanceOf(owner)`, in as few requests as the node will take.
 *
 * Results come back in the order the tokens were given, one entry per token,
 * always — a caller zipping this against its own token list must never have to
 * check whether the lengths still line up.
 *
 * A chunk that fails as a whole (node down, gas cap, an operator that decided
 * to reject the batch) marks only its own tokens `batch-failed` and the
 * remaining chunks still run. The alternative — one rejected chunk throwing —
 * would let one flaky request erase balances the app had already obtained.
 */
export async function fetchTokenBalancesBatched(
  request: EthRequest,
  chainId: number,
  owner: string,
  tokens: readonly string[],
  chunkSize: number = MULTICALL_CHUNK_SIZE,
): Promise<TokenBalanceResult[]> {
  // Fail loudly on a bad owner before any request goes out: a malformed owner
  // would otherwise be encoded into every chunk and disclosed to the operator.
  encodeBalanceOf(owner);
  const to = multicall3Address(chainId);

  const out: TokenBalanceResult[] = [];
  for (const slice of chunk(tokens, chunkSize)) {
    let results: Aggregate3Result[];
    try {
      results = decodeAggregate3Return(
        await request({
          method: "eth_call",
          params: [{ to, data: encodeBalanceOfBatch(owner, slice) }, LATEST],
        }),
      );
    } catch {
      for (const token of slice) out.push({ token, ok: false, reason: "batch-failed" });
      continue;
    }

    // A multicall that answers about a different number of calls than it was
    // asked is not a multicall this app can align to its token list. Positional
    // matching is the only thing tying an answer to a token, so a mismatched
    // count is discarded wholesale rather than zipped optimistically.
    if (results.length !== slice.length) {
      for (const token of slice) out.push({ token, ok: false, reason: "batch-failed" });
      continue;
    }

    for (let i = 0; i < slice.length; i++) {
      const token = slice[i] as string;
      const result = results[i] as Aggregate3Result;
      if (!result.success) {
        out.push({ token, ok: false, reason: "call-failed" });
        continue;
      }
      try {
        out.push({ token, ok: true, raw: decodeUint256Return(result.returnData) });
      } catch {
        // It answered with something, but not a uint256. Reporting that as 0
        // would be inventing a balance out of a contract's malformed reply.
        out.push({ token, ok: false, reason: "undecodable" });
      }
    }
  }
  return out;
}
