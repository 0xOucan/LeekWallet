/**
 * The ATS read surface, as calldata.
 *
 * ---------------------------------------------------------------------------
 * Why the ABIs and not `@hashgraph/asset-tokenization-sdk`
 *
 * The SDK's supported-wallet list contains `METAMASK`, and that is the useful
 * fact in it: a security issued by the Studio is an ordinary contract on an
 * EVM chain (296), reached over Hedera's JSON-RPC relay, and every call below
 * is a plain `eth_call`. Nothing about it needs a Hedera-specific client.
 *
 * What the SDK would cost is concrete rather than stylistic:
 *
 *   - It is a ports-and-adapters stack built on `reflect-metadata` and a DI
 *     container. Decorator metadata needs a TypeScript configuration this
 *     workspace does not have (`experimentalDecorators`,
 *     `emitDecoratorMetadata`), and the app is otherwise built by Vite with
 *     type stripping only. Adopting it is a build change felt by every package
 *     here, in exchange for calldata this file writes in one line each.
 *   - Its `METAMASK` path wants an injected EIP-1193 provider. Ours would have
 *     to be the browser extension, which is currently broken at the offscreen
 *     document — so taking that path would make a known-broken component
 *     load-bearing for an app that, read-only, needs no wallet at all.
 *
 * So the SDK is not a dependency, of this package or of the workspace. Its
 * *contracts* package is where the signatures below came from — read from the
 * compiled artifacts of `@hashgraph/asset-tokenization-contracts` 8.0.0 rather
 * than transcribed from documentation — and that is a one-time extraction, not
 * a runtime coupling. The selectors are derived from those signatures with
 * keccak at module load, not typed in, for the same reason eth-decode.ts does
 * it: a mistyped constant is a call to a different function that still looks
 * plausible in a diff.
 *
 * ---------------------------------------------------------------------------
 * Decoding rules, all of them for one reason
 *
 * Return data arrives from an operator nobody here verified, out of a contract
 * at an address the user typed. Every offset and length is bounds-checked
 * against the actual byte length before use, and anything that does not add up
 * is refused as a whole rather than read as far as it parses — a half-decoded
 * holder array silently reassigns balances to the wrong addresses, which is
 * exactly the mistake the register exists to prevent. This mirrors
 * multicall.ts, deliberately: same threat, same treatment.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { AbiError, DecodeError } from "@leekwallet/core/balances.ts";

/* --------------------------------------------------------------- selectors */

/** keccak-256 of a canonical signature, first four bytes, lower-case hex. */
export function selectorOf(canonical: string): string {
  return [...keccak_256(new TextEncoder().encode(canonical)).subarray(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Every function this app calls, by canonical signature.
 *
 * Grouped by the facet it lives on, because an ATS security is a diamond: all
 * of these are on the one token address, but they come from different facets
 * and a security that was deployed without a facet simply reverts that call.
 * That is a normal, expected outcome here — see `CallOutcome`.
 */
export const SIG = {
  /* Core (ERC-20 surface) */
  name: "name()",
  symbol: "symbol()",
  decimals: "decimals()",
  totalSupply: "totalSupply()",
  balanceOf: "balanceOf(address)",

  /* Cap */
  getMaxSupply: "getMaxSupply()",

  /* Pause */
  paused: "paused()",

  /* SecurityHolders — the register itself */
  getTotalSecurityHolders: "getTotalSecurityHolders()",
  getSecurityHolders: "getSecurityHolders(uint256,uint256)",

  /* AccessControl */
  getRoleMemberCount: "getRoleMemberCount(bytes32)",
  getRoleMembers: "getRoleMembers(bytes32,uint256,uint256)",
  hasRole: "hasRole(bytes32,address)",

  /* Kyc */
  isInternalKycActivated: "isInternalKycActivated()",
  getKycStatusFor: "getKycStatusFor(address)",

  /* ControlList */
  getControlListType: "getControlListType()",
  getControlListCount: "getControlListCount()",
  getControlListMembers: "getControlListMembers(uint256,uint256)",
  isInControlList: "isInControlList(address)",

  /* Snapshots */
  takeSnapshot: "takeSnapshot()",
  totalSupplyAtSnapshot: "totalSupplyAtSnapshot(uint256)",
  getTotalTokenHoldersAtSnapshot: "getTotalTokenHoldersAtSnapshot(uint256)",
  getTokenHoldersAtSnapshot: "getTokenHoldersAtSnapshot(uint256,uint256,uint256)",
  balanceOfAtSnapshot: "balanceOfAtSnapshot(uint256,address)",
  balancesOfAtSnapshot: "balancesOfAtSnapshot(uint256,uint256,uint256)",
} as const;

export type SigName = keyof typeof SIG;

/** Selectors, derived once. Never written down. */
export const SELECTOR: Readonly<Record<SigName, string>> = Object.fromEntries(
  Object.entries(SIG).map(([k, v]) => [k, selectorOf(v)]),
) as Record<SigName, string>;

/* ---------------------------------------------------------------- encoding */

const UINT256_MAX = (1n << 256n) - 1n;

/** A 32-byte word from a non-negative bigint. */
export function word(value: bigint): string {
  if (value < 0n) throw new AbiError("a uint256 cannot be negative");
  if (value > UINT256_MAX) throw new AbiError("value does not fit in a uint256");
  return value.toString(16).padStart(64, "0");
}

/** A left-padded address word. Validated: a bad address must not be disclosed. */
export function addressWord(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new AbiError(`not a 20-byte address: ${address}`);
  }
  return "0".repeat(24) + address.slice(2).toLowerCase();
}

/** A bytes32 word, exactly as given. Role ids are already 32 bytes. */
export function bytes32Word(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new AbiError(`not a bytes32: ${value}`);
  }
  return value.slice(2).toLowerCase();
}

/**
 * Calldata for one of the signatures above.
 *
 * Static arguments only, which is all of them: no call this app makes takes a
 * string or an array, so there is no head/tail layout to get wrong here.
 */
export function encode(name: SigName, args: readonly string[] = []): string {
  return `0x${SELECTOR[name]}${args.join("")}`;
}

/* ---------------------------------------------------------------- decoding */

function bytesOf(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new DecodeError("return data is not whole-byte hex");
  }
  const hex = value.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A 32-byte word, bounds-checked.
 *
 * Indexing past the end yields `undefined` and arithmetic on it yields NaN — a
 * silent wrong number rather than a refusal. Every read goes through here.
 */
function wordAt(bytes: Uint8Array, at: number): bigint {
  if (!Number.isSafeInteger(at) || at < 0 || at + 32 > bytes.length) {
    throw new DecodeError("return data is truncated");
  }
  let v = 0n;
  for (let k = at; k < at + 32; k++) v = (v << 8n) | BigInt(bytes[k] as number);
  return v;
}

/** A word used as an offset or a length, bounded by the buffer before use. */
function sizeAt(bytes: Uint8Array, at: number, what: string): number {
  const raw = wordAt(bytes, at);
  if (raw > BigInt(bytes.length)) throw new DecodeError(`${what} is out of range`);
  return Number(raw);
}

export function decodeUint(value: unknown): bigint {
  const bytes = bytesOf(value);
  if (bytes.length !== 32) throw new DecodeError("a uint256 return must be exactly one word");
  return wordAt(bytes, 0);
}

/**
 * A bool return.
 *
 * Solidity encodes exactly 0 or 1. Anything else is not a bool, and reading
 * "nonzero is true" would let a crafted return mark a security as unpaused, or
 * a stranger as KYC'd, out of a word that means nothing.
 */
export function decodeBool(value: unknown): boolean {
  const v = decodeUint(value);
  if (v > 1n) throw new DecodeError("a bool return is neither 0 nor 1");
  return v === 1n;
}

/** A uint8 return, range-checked rather than truncated. */
export function decodeUint8(value: unknown): number {
  const v = decodeUint(value);
  if (v > 255n) throw new DecodeError("a uint8 return does not fit in a byte");
  return Number(v);
}

const toAddress = (w: bigint): string => `0x${w.toString(16).padStart(64, "0").slice(24)}`;

/**
 * `address[]`.
 *
 * The high 12 bytes of each word must be zero. A dirty upper half is not an
 * address the EVM would have produced, and truncating it silently would let
 * two distinct returns render as the same holder.
 */
export function decodeAddressArray(value: unknown): string[] {
  const bytes = bytesOf(value);
  const at = sizeAt(bytes, 0, "array offset");
  const count = sizeAt(bytes, at, "array length");
  if (at + 32 + count * 32 > bytes.length) throw new DecodeError("address array is truncated");
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const w = wordAt(bytes, at + 32 + i * 32);
    if (w >> 160n) throw new DecodeError("an address word has dirty high bytes");
    out.push(toAddress(w));
  }
  return out;
}

/** One row of `balancesOfAtSnapshot`. */
export interface HolderBalance {
  address: string;
  raw: bigint;
}

/**
 * `(address,uint256)[]` — a static tuple array, so the elements are inline.
 *
 * Refused wholesale on any inconsistency: a row lost from the middle would
 * misattribute every balance after it, and a snapshot register that is wrong
 * about who holds what is worse than one that is missing.
 */
export function decodeHolderBalanceArray(value: unknown): HolderBalance[] {
  const bytes = bytesOf(value);
  const at = sizeAt(bytes, 0, "array offset");
  const count = sizeAt(bytes, at, "array length");
  if (at + 32 + count * 64 > bytes.length) {
    throw new DecodeError("holder/balance array is truncated");
  }
  const out: HolderBalance[] = [];
  for (let i = 0; i < count; i++) {
    const w = wordAt(bytes, at + 32 + i * 64);
    if (w >> 160n) throw new DecodeError("an address word has dirty high bytes");
    out.push({ address: toAddress(w), raw: wordAt(bytes, at + 32 + i * 64 + 32) });
  }
  return out;
}

/**
 * A `string` return, as far as it is safe to believe one.
 *
 * `name()` and `symbol()` are host-supplied text on a screen next to numbers,
 * so the same rule as balances.ts applies: control characters and
 * direction-overrides are stripped, and length is capped. A symbol that can
 * repaint the line it sits on is a label attack, not a label.
 */
export function decodeString(value: unknown, maxChars = 64): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = bytesOf(value);
  } catch {
    return undefined;
  }
  try {
    const at = sizeAt(bytes, 0, "string offset");
    const length = sizeAt(bytes, at, "string length");
    if (at + 32 + length > bytes.length) return undefined;
    const text = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(at + 32, at + 32 + length));
    return sanitiseText(text, maxChars);
  } catch {
    return undefined;
  }
}

/** Printable, single-line, bounded. Empty becomes undefined, never "". */
export function sanitiseText(text: string, maxChars: number): string | undefined {
  const cleaned = [...text]
    // C0/C1 controls, the bidi overrides, and the zero-width joiners: each of
    // them can make the rendered string differ from the string.
    .filter((ch) => {
      const c = ch.codePointAt(0) as number;
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
      if (c >= 0x200b && c <= 0x200f) return false;
      if (c >= 0x202a && c <= 0x202e) return false;
      if (c >= 0x2066 && c <= 0x2069) return false;
      return true;
    })
    .join("")
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}
