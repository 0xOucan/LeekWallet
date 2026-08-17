/**
 * The decodable set, host side — a mirror of `src/eth-decode.c` (T50).
 *
 * Two jobs, and only one of them is security. The mock device uses this to
 * refuse exactly what the firmware refuses: a mock that accepts more than the
 * device certifies broken code, and has twice already. The app uses it to
 * label a transaction before sending it, which is advisory only — a compromised
 * app can render whatever it likes, and the device screen is the authority.
 *
 * Keep the two implementations in step. If this file grows a selector the
 * firmware does not have, the mock stops being a lower bound.
 */

import { keccak_256 } from "@noble/hashes/sha3";

export const CallKind = {
  Empty: "empty",
  Erc20Transfer: "erc20-transfer",
  Erc20Approve: "erc20-approve",
  Erc20TransferFrom: "erc20-transfer-from",
  SetApprovalForAll: "set-approval-for-all",
  WethDeposit: "weth-deposit",
  WethWithdraw: "weth-withdraw",
  MintTo: "mint-to",
  Mint: "mint",
  MintTokenTo: "mint-token-to",
  /** A signature from the table, decoded from its own declared types. */
  Generic: "generic",
  Unknown: "unknown",
} as const;

export type CallKind = (typeof CallKind)[keyof typeof CallKind];

export interface DecodedCall {
  kind: CallKind;
  /**
   * The first address argument: recipient for a transfer, spender for an
   * approval, source for transferFrom, operator for setApprovalForAll.
   */
  address?: string;
  /** transferFrom's destination. Absent when the call has no second address. */
  second?: string;
  /** Raw token units — decimals are not knowable without calling the contract. */
  amount?: bigint;
  /** An allowance beyond any real supply: the pattern behind most drains. */
  unlimited?: boolean;
  /** setApprovalForAll's bool: true grants, false revokes. */
  flag?: boolean;
  /** Generic calls only: the canonical signature that hashed to the selector. */
  signature?: string;
  /** Generic calls only: the function name, without its parenthesised types. */
  functionName?: string;
  /** Generic calls only: one entry per declared argument, in order. */
  args?: DecodedArg[];
}

/** One argument of a generic call, mirroring EthArg in the C decoder. */
export interface DecodedArg {
  name: string;
  type: string;
  /** address as 0x-hex; uint/int/bytesN as a bigint; bool as a boolean. */
  value: string | bigint | boolean;
  /** Set on a uint at or past the halfway mark of its own declared width. */
  unlimited?: boolean;
}

/** Argument shapes, mirroring ArgShape in the C decoder. */
const Shape = {
  None: 0,
  Uint: 1,
  AddrUint: 2,
  AddrBool: 3,
  AddrAddrUint: 4,
  FromSignature: 5,
} as const;
type Shape = (typeof Shape)[keyof typeof Shape];

const WORDS: Record<Shape, number> = { 0: 0, 1: 1, 2: 2, 3: 2, 4: 3, 5: 0 };

/* The same table as src/eth-decode.c, in the same order, with the same
 * argument shapes and - this is the part that matters - the same signature
 * STRINGS. No selector is written down on either side: each one is
 * keccak256(signature)[0:4], computed below, so a row mistyped here cannot
 * match the row it was copied from and the conformance suite says so at once.
 * Drifting from that C file is the bug this mirror exists to catch. */
const KNOWN: ReadonlyArray<{
  sig: string;
  names: string;
  kind: CallKind;
  shape: Shape;
}> = [
  { sig: "transfer(address,uint256)", names: "to,amount", kind: CallKind.Erc20Transfer, shape: Shape.AddrUint },
  { sig: "approve(address,uint256)", names: "spender,amount", kind: CallKind.Erc20Approve, shape: Shape.AddrUint },
  { sig: "transferFrom(address,address,uint256)", names: "from,to,amount", kind: CallKind.Erc20TransferFrom, shape: Shape.AddrAddrUint },
  { sig: "setApprovalForAll(address,bool)", names: "operator,approved", kind: CallKind.SetApprovalForAll, shape: Shape.AddrBool },
  { sig: "deposit()", names: "", kind: CallKind.WethDeposit, shape: Shape.None },
  { sig: "withdraw(uint256)", names: "amount", kind: CallKind.WethWithdraw, shape: Shape.Uint },
  { sig: "mint(address,uint256)", names: "to,amount", kind: CallKind.MintTo, shape: Shape.AddrUint },
  { sig: "mint(uint256)", names: "amount", kind: CallKind.Mint, shape: Shape.Uint },
  { sig: "mint(address,address,uint256)", names: "token,to,amount", kind: CallKind.MintTokenTo, shape: Shape.AddrAddrUint },

  { sig: "supply(address,uint256,address,uint16)", names: "asset,amount,onBehalfOf,referral", kind: CallKind.Generic, shape: Shape.FromSignature },
  { sig: "withdraw(address,uint256,address)", names: "asset,amount,to", kind: CallKind.Generic, shape: Shape.FromSignature },
  { sig: "borrow(address,uint256,uint256,uint16,address)", names: "asset,amount,rateMode,referral,onBehalfOf", kind: CallKind.Generic, shape: Shape.FromSignature },
  { sig: "repay(address,uint256,uint256,address)", names: "asset,amount,rateMode,onBehalfOf", kind: CallKind.Generic, shape: Shape.FromSignature },
  { sig: "safeTransferFrom(address,address,uint256)", names: "from,to,tokenId", kind: CallKind.Generic, shape: Shape.FromSignature },
  { sig: "approve(address,address,uint160,uint48)", names: "token,spender,amount,expiration", kind: CallKind.Generic, shape: Shape.FromSignature },
];

/** keccak256(signature)[0:4], lower-case hex. Computed once per row. */
const selectorOf = (sig: string) =>
  [...keccak_256(new TextEncoder().encode(sig)).subarray(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const SELECTORS: readonly string[] = KNOWN.map((k) => selectorOf(k.sig));

/** Six, as in the C decoder: a longer signature is refused, not truncated. */
export const MAX_ARGS = 6;

interface ParsedArg {
  type: string;
  kind: "address" | "uint" | "int" | "bool" | "bytes";
  bits: number;
}

/* The static ABI types only, mirroring parse_arg_type() in the C decoder. A
 * dynamic type (`bytes`, `string`, an array, a tuple) is an offset into a tail
 * this decoder does not read, so a signature containing one refuses the whole
 * call rather than showing the arguments it did understand. */
function parseArgType(type: string): ParsedArg | null {
  if (type === "address") return { type, kind: "address", bits: 160 };
  if (type === "bool") return { type, kind: "bool", bits: 8 };

  const m = /^(uint|int|bytes)([0-9]+)$/.exec(type);
  if (!m) return null;
  const head = m[1] as "uint" | "int" | "bytes";
  const n = Number(m[2]);
  if (head === "bytes") {
    if (n < 1 || n > 32) return null;
    return { type, kind: "bytes", bits: n * 8 };
  }
  if (n < 8 || n > 256 || n % 8 !== 0) return null;
  return { type, kind: head, bits: n };
}

/** The declared argument types of a signature, or null if any is unreadable. */
function parseSignatureArgs(sig: string): ParsedArg[] | null {
  const open = sig.indexOf("(");
  if (open < 0 || !sig.endsWith(")")) return null;
  const inner = sig.slice(open + 1, -1);
  if (inner === "") return [];

  const parts = inner.split(",");
  if (parts.length > MAX_ARGS) return null;
  const out: ParsedArg[] = [];
  for (const part of parts) {
    const arg = parseArgType(part);
    if (arg === null) return null;
    out.push(arg);
  }
  return out;
}

/** Anything from 2^255 up. See the C implementation for why not just 2^256-1. */
const UNLIMITED_THRESHOLD = 1n << 255n;

function toBytes(data: unknown): Uint8Array | null {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    if (hex.length === 0) return new Uint8Array(0);
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return null;
}

const toHex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function decodeCall(data: unknown): DecodedCall {
  const bytes = toBytes(data);
  if (bytes === null) return { kind: CallKind.Unknown };
  if (bytes.length === 0) return { kind: CallKind.Empty };
  if (bytes.length < 4) return { kind: CallKind.Unknown };

  /* Matching IS verification, exactly as in the firmware: the selector on the
   * wire is compared against the hash of each candidate signature, and a row
   * that does not hash to it is not a candidate at all. */
  const selector = toHex(bytes.subarray(0, 4));
  const index = SELECTORS.indexOf(selector);
  if (index < 0) return { kind: CallKind.Unknown };
  const known = KNOWN[index]!;

  if (known.shape === Shape.FromSignature) return decodeGeneric(known, bytes);

  /* Exact, not "at least". A recognised selector with anything extra behind it
   * is a call that is only half read. */
  if (bytes.length !== 4 + WORDS[known.shape] * 32) return { kind: CallKind.Unknown };

  /* An ABI address is left-padded with zeros. Non-zero padding is not an
   * address, and accepting it lets bytes past the screen. */
  const addressAt = (word: number): string | null => {
    const off = 4 + word * 32;
    for (let i = off; i < off + 12; i++) {
      if (bytes[i] !== 0) return null;
    }
    return "0x" + toHex(bytes.subarray(off + 12, off + 32));
  };
  const uintAt = (word: number): bigint =>
    BigInt("0x" + toHex(bytes.subarray(4 + word * 32, 4 + word * 32 + 32)));

  /* An ABI bool is 0 or 1 and nothing else. Anything else would have to be
   * drawn as "true-ish", and a contract may well read the raw word. */
  const boolAt = (word: number): boolean | null => {
    const off = 4 + word * 32;
    for (let i = off; i < off + 31; i++) {
      if (bytes[i] !== 0) return null;
    }
    const last = bytes[off + 31] as number;
    return last > 1 ? null : last === 1;
  };

  switch (known.shape) {
    case Shape.None:
      return { kind: known.kind };

    case Shape.Uint:
      return { kind: known.kind, amount: uintAt(0) };

    case Shape.AddrUint: {
      const address = addressAt(0);
      if (address === null) return { kind: CallKind.Unknown };
      const amount = uintAt(1);
      return {
        kind: known.kind,
        address,
        amount,
        /* Only an allowance can be unlimited. A mint of 2^255 is absurd but it
         * is still a specific number, and calling it unlimited would name the
         * wrong risk. */
        unlimited: known.kind === CallKind.Erc20Approve && amount >= UNLIMITED_THRESHOLD,
      };
    }

    case Shape.AddrBool: {
      const address = addressAt(0);
      const flag = boolAt(1);
      if (address === null || flag === null) return { kind: CallKind.Unknown };
      return { kind: known.kind, address, flag };
    }

    case Shape.AddrAddrUint: {
      const address = addressAt(0);
      const second = addressAt(1);
      if (address === null || second === null) return { kind: CallKind.Unknown };
      return { kind: known.kind, address, second, amount: uintAt(2) };
    }

    default:
      return { kind: CallKind.Unknown };
  }
}

/**
 * A generic call: the arguments come from the types the matched signature
 * declares, and each is checked against the type it was declared with.
 *
 * Refusing a call whose signature this decoder cannot read in full is
 * deliberate and is the rule the firmware follows too - a screen that omits
 * one of five arguments is a screen that lies by omission.
 */
function decodeGeneric(
  known: { sig: string; names: string },
  bytes: Uint8Array,
): DecodedCall {
  const types = parseSignatureArgs(known.sig);
  if (types === null) return { kind: CallKind.Unknown };
  if (bytes.length !== 4 + types.length * 32) return { kind: CallKind.Unknown };

  const names = known.names === "" ? [] : known.names.split(",");
  const args: DecodedArg[] = [];

  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    const off = 4 + i * 32;
    const word = bytes.subarray(off, off + 32);
    const used = t.bits / 8;
    const name = names[i] ?? "";

    if (t.kind === "bool") {
      for (let j = 0; j < 31; j++) if (word[j] !== 0) return { kind: CallKind.Unknown };
      const last = word[31] as number;
      if (last > 1) return { kind: CallKind.Unknown };
      args.push({ name, type: t.type, value: last === 1 });
      continue;
    }

    if (t.kind === "bytes") {
      /* Left-aligned, so the padding is at the other end. */
      for (let j = used; j < 32; j++) if (word[j] !== 0) return { kind: CallKind.Unknown };
      args.push({ name, type: t.type, value: BigInt("0x" + toHex(word)) });
      continue;
    }

    if (t.kind === "int") {
      /* Sign-extended: the padding is all zeros or all ones, and which one is
       * decided by the top bit of the value itself. */
      const fill = ((word[32 - used] as number) & 0x80) !== 0 ? 0xff : 0x00;
      for (let j = 0; j < 32 - used; j++) if (word[j] !== fill) return { kind: CallKind.Unknown };
      args.push({ name, type: t.type, value: BigInt("0x" + toHex(word)) });
      continue;
    }

    /* address and uint<N>: everything above the declared width must be zero. */
    for (let j = 0; j < 32 - used; j++) if (word[j] !== 0) return { kind: CallKind.Unknown };
    if (t.kind === "address") {
      args.push({ name, type: t.type, value: "0x" + toHex(word.subarray(12)) });
    } else {
      const value = BigInt("0x" + toHex(word));
      /* Against its OWN declared width: Permit2's infinite allowance is a
       * uint160, an ordinary number in 256 bits. Narrow fields are never
       * called unlimited - a uint48 with its top bit set is a date. */
      const unlimited = t.bits >= 64 && value >= 1n << BigInt(t.bits - 1);
      args.push({ name, type: t.type, value, unlimited });
    }
  }

  return {
    kind: CallKind.Generic,
    signature: known.sig,
    functionName: known.sig.slice(0, known.sig.indexOf("(")),
    args,
  };
}

/**
 * Whether the device would agree to show this transaction at all.
 *
 * Contract creation is refused for the same reason an unknown selector is:
 * there is nothing the device can name.
 */
export function isDecodable(tx: {
  to?: unknown;
  data?: unknown;
}): { ok: boolean; call: DecodedCall } {
  const to = tx.to;
  const hasTo =
    to instanceof Uint8Array ? to.length === 20 : typeof to === "string" && to.length > 2;
  if (!hasTo) return { ok: false, call: { kind: CallKind.Unknown } };

  const call = decodeCall(tx.data);
  return { ok: call.kind !== CallKind.Unknown, call };
}

/** A short label for the call, for advisory host-side display. */
export function describeCall(call: DecodedCall): string {
  switch (call.kind) {
    case CallKind.Empty:
      return "transfer";
    case CallKind.Erc20Transfer:
      return "token transfer";
    case CallKind.Erc20Approve:
      return call.unlimited ? "UNLIMITED token approval" : "token approval";
    case CallKind.Erc20TransferFrom:
      return "token transfer from another account";
    case CallKind.SetApprovalForAll:
      return call.flag ? "APPROVAL FOR ALL tokens" : "revoke approval for all";
    case CallKind.WethDeposit:
      return "wrap";
    case CallKind.WethWithdraw:
      return "unwrap";
    case CallKind.MintTo:
    case CallKind.Mint:
    case CallKind.MintTokenTo:
      return "mint";
    /* The name, and nothing more. The device's own screen says the same thing
     * in more words: a verified signature proves what a function is CALLED,
     * never what it does. */
    case CallKind.Generic:
      return call.functionName ?? "contract call";
    default:
      return "unknown call";
  }
}
