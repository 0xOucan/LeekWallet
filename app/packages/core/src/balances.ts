/**
 * Balances, and the ERC-20 calls behind them.
 *
 * Two jobs that look alike and are not:
 *
 * 1. **Reading numbers off a chain.** `eth_getBalance` and `eth_call` of
 *    `balanceOf(address)`. Both go through the failover client in rpc.ts —
 *    nothing here opens a socket, and nothing here decides which endpoint to
 *    ask. The number that comes back is whatever an untrusted operator chose
 *    to say (rpc.ts, limit 1): a wrong balance costs a confusing screen or a
 *    transaction that reverts, never custody, because the device re-derives
 *    and re-renders everything it signs.
 *
 * 2. **Deciding what a number *means*.** This is where the danger is, and the
 *    rule is PROTOCOL.md 6d: the host cannot verify a token's decimals or its
 *    symbol. `decimals()` and `symbol()` are ordinary contract calls answered
 *    by the contract itself, so a worthless contract can answer "USDC" and
 *    "6" and the app has learned exactly nothing. Therefore:
 *
 *      - the raw integer the contract returned is always kept and always
 *        renderable, and it is the only figure here that is a fact;
 *      - the contract address travels with every balance, because it is the
 *        thing that actually decides the outcome;
 *      - a scaled figure or a symbol is only ever produced inside a
 *        `TokenAmountView`, which cannot be constructed without `verified:
 *        false` and the notice. There is no function in this file that returns
 *        a bare scaled string. That is deliberate — a caller cannot get the
 *        pretty number without carrying the marking that says nobody checked
 *        it, the same trick `chainLabelDetailed()` plays for chain names.
 *
 * Refresh policy lives here too, as constants rather than as a timer: see
 * `BALANCE_STALE_AFTER_MS`. Every one of these calls tells whichever operator
 * answered which addresses the user cares about, so the app fetches on
 * demand and on the events that make an old answer wrong (connect, chain
 * change, address change) and never on a loop. Staleness is displayed instead
 * of being papered over by polling.
 */

import { formatUnits, tokenHint, type TokenHint } from "./chains.ts";
import { checksumAddress } from "./tx-interpret.ts";

/* ------------------------------------------------------------- ABI encoding
 *
 * Hand-rolled rather than pulled from viem: these four calls are the whole of
 * what this app does with an ABI, and the transfer encoding in particular has
 * to be byte-identical to what eth-decode.ts (and therefore the firmware)
 * reads back. A test asserts exactly that round trip.
 */

/** `transfer(address,uint256)` — the one write call. Mirrors eth-decode.ts. */
export const SELECTOR_TRANSFER = "a9059cbb";
/** `balanceOf(address)`. */
export const SELECTOR_BALANCE_OF = "70a08231";
/** `decimals()` — self-declared, see the header. */
export const SELECTOR_DECIMALS = "313ce567";
/** `symbol()` — self-declared, see the header. */
export const SELECTOR_SYMBOL = "95d89b41";

/** Anything a uint256 word cannot hold. Encoding it would silently truncate. */
const UINT256_MAX = (1n << 256n) - 1n;

export class AbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbiError";
  }
}

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

/** `balanceOf(owner)` calldata. */
export function encodeBalanceOf(owner: string): string {
  return `0x${SELECTOR_BALANCE_OF}${"0".repeat(24)}${requireAddress(owner, "owner")}`;
}

/**
 * `transfer(to, amount)` calldata.
 *
 * Exactly 68 bytes, which is what eth-decode.ts requires — it rejects a
 * recognised selector with anything extra behind it, and so does the firmware.
 */
export function encodeErc20Transfer(to: string, amount: bigint): string {
  return `0x${SELECTOR_TRANSFER}${"0".repeat(24)}${requireAddress(to, "recipient")}${word(amount)}`;
}

/** `decimals()` calldata. */
export const encodeDecimals = (): string => `0x${SELECTOR_DECIMALS}`;
/** `symbol()` calldata. */
export const encodeSymbol = (): string => `0x${SELECTOR_SYMBOL}`;

/* ------------------------------------------------------------- ABI decoding
 *
 * Strict on purpose. Every value here arrives from an operator nobody
 * verified, and a lenient parser turns a malformed answer into a plausible
 * number — which is worse than an error, because a number gets believed.
 */

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/**
 * A JSON-RPC `QUANTITY` (EIP-1474) as a bigint — what `eth_getBalance` returns.
 *
 * The spec says minimal hex, no leading zeros, "0x0" for zero. Leading zeros
 * are accepted anyway because nodes emit them and rejecting a balance over a
 * formatting nit would be a self-inflicted outage; everything else is refused.
 * A bare "0x" is not zero, it is a node that answered nothing.
 */
export function decodeQuantity(value: unknown): bigint {
  if (typeof value !== "string") {
    throw new DecodeError(`expected a hex quantity, got ${typeof value}`);
  }
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new DecodeError(`not a hex quantity: ${value.slice(0, 24)}`);
  }
  // 32 bytes is the width of everything on an EVM. Anything longer is not a
  // balance, and BigInt would happily parse it into a plausible-looking one.
  if (value.length > 66) throw new DecodeError("hex quantity is wider than 32 bytes");
  return BigInt(value);
}

function returnBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new DecodeError("eth_call did not return hex");
  }
  const hex = value.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const wordAt = (b: Uint8Array, i: number): bigint => {
  let v = 0n;
  for (let k = i; k < i + 32; k++) v = (v << 8n) | BigInt(b[k] as number);
  return v;
};

/**
 * A single uint256 return value — `balanceOf`'s answer.
 *
 * An empty return means the call hit an address with no code, or a contract
 * with no such function. Node clients report that as `0x`, and reading it as
 * zero would show "0 tokens" for a contract that is not a token at all.
 */
export function decodeUint256Return(value: unknown): bigint {
  const bytes = returnBytes(value);
  if (bytes.length === 0) throw new DecodeError("the contract returned nothing (no code, or not a token)");
  if (bytes.length < 32) throw new DecodeError("the contract returned less than one word");
  return wordAt(bytes, 0);
}

/**
 * The upper bound on a decimals() answer this app is willing to act on.
 *
 * Not a verification — a contract can say 6 and be worthless. It is a bound on
 * the damage of an absurd answer: 10^255 as a divisor renders every balance as
 * "0.000…" and every typed amount as zero, which looks like an empty wallet
 * rather than like a lying contract. Beyond this the app shows raw units only.
 */
export const MAX_PLAUSIBLE_DECIMALS = 36;

/** `decimals()`'s answer, or undefined if it is not one this app will scale by. */
export function decodeDecimalsReturn(value: unknown): number | undefined {
  let raw: bigint;
  try {
    raw = decodeUint256Return(value);
  } catch {
    return undefined;
  }
  if (raw > BigInt(MAX_PLAUSIBLE_DECIMALS)) return undefined;
  return Number(raw);
}

/**
 * `symbol()`'s answer, as a display string, or undefined.
 *
 * Handles both shapes in the wild: the ABI `string` return, and the bytes32
 * that predates it (MKR and friends). Whatever comes out is attacker-chosen
 * text, so it is filtered to printable ASCII and capped — a symbol containing
 * a newline, a right-to-left override or two hundred characters is a symbol
 * designed to rearrange the screen it is drawn on. Anything that does not
 * survive the filter is dropped entirely rather than shown mangled.
 */
export function decodeSymbolReturn(value: unknown): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = returnBytes(value);
  } catch {
    return undefined;
  }
  if (bytes.length === 0) return undefined;

  let text: string;
  if (bytes.length >= 64) {
    // Dynamic string: offset word, then length, then data.
    const offset = Number(wordAt(bytes, 0));
    if (offset % 32 !== 0 || offset + 32 > bytes.length) return undefined;
    const length = Number(wordAt(bytes, offset));
    if (!Number.isSafeInteger(length) || offset + 32 + length > bytes.length) return undefined;
    text = new TextDecoder().decode(bytes.subarray(offset + 32, offset + 32 + length));
  } else if (bytes.length === 32) {
    // bytes32: zero-padded on the right.
    let end = 32;
    while (end > 0 && bytes[end - 1] === 0) end--;
    text = new TextDecoder().decode(bytes.subarray(0, end));
  } else {
    return undefined;
  }

  return sanitiseSymbol(text);
}

/** Printable ASCII, trimmed, capped at 16. Anything else is not a ticker. */
export function sanitiseSymbol(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 16) return undefined;
  if (!/^[\x20-\x7e]+$/.test(trimmed)) return undefined;
  return trimmed;
}

/* ------------------------------------------------------ typed amount entry */

/**
 * A decimal string → raw integer units, exactly.
 *
 * Integer arithmetic only. `Number("0.1") * 1e18` is 100000000000000000**0**16
 * — off by sixteen wei on a good day and by far more at token scale, and a
 * float that rounds a transfer up is a transfer of somebody else's money.
 */
export function parseUnits(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new AbiError(`"${text}" is not a plain decimal amount`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_PLAUSIBLE_DECIMALS) {
    throw new AbiError(`implausible decimals: ${decimals}`);
  }
  const [whole = "", frac = ""] = trimmed.split(".");
  // Truncating would silently send a different amount than was typed. Refuse.
  if (frac.length > decimals) {
    throw new AbiError(
      `${trimmed} has ${frac.length} decimal places but this token claims only ${decimals}`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(`${whole === "" ? "0" : whole}${padded === "" ? "" : padded}`);
}

/* --------------------------------------------------------- token metadata */

/** Where a symbol/decimals guess came from. Neither source is evidence. */
export type TokenMetaSource =
  /** The short hand-typed table in chains.ts. Checked by whoever typed it. */
  | "app-hint"
  /** The contract's own `symbol()`/`decimals()`. Self-declared by the suspect. */
  | "contract";

/**
 * What this app thinks a token might be.
 *
 * `verified: false` is a literal type, not a boolean, for the same reason
 * `TokenHint.verified` is: no code path can construct one of these that claims
 * to have been checked, because there is no such code path to write.
 */
export interface TokenMeta {
  address: string;
  chainId: number;
  symbol?: string;
  decimals?: number;
  source: TokenMetaSource;
  verified: false;
}

/**
 * The sentence that must appear beside any scaled figure or symbol here.
 *
 * A constant so it cannot drift between screens and so a reviewer can grep for
 * whether it is being rendered. Distinct from `TOKEN_HINT_NOTICE` because the
 * failure mode is different: a hint was typed by this project, a contract's
 * own answer was typed by whoever deployed the contract.
 */
export const TOKEN_SCALE_NOTICE =
  "This token's symbol and decimals came from the contract itself or from an " +
  "unchecked list in this app — a worthless contract can call itself USDC. The " +
  "scaled amount is a guess; the raw units and the contract address above are " +
  "what you are actually signing.";

/** Said next to any balance, so a fetched number is never read as attested. */
export const BALANCE_SOURCE_NOTICE =
  "Balances are fetched by this app from a public RPC operator, which can answer " +
  "with anything. The device neither reports nor confirms balances.";

/**
 * A raw amount, plus — only if something claimed to know how to scale it — a
 * scaled rendering that carries its own disclaimer.
 *
 * The shape is the safety property. `raw` and `contract` are non-optional, so
 * a renderer that reads this object always has the facts to hand; `scaled` is
 * the only place a symbol or a decimal point exists, and it cannot be built
 * without `verified: false` and `notice`.
 */
export interface TokenAmountView {
  contract: string;
  raw: bigint;
  /** `raw` as a plain integer string. Always safe to show on its own. */
  rawText: string;
  scaled?: {
    text: string;
    decimals: number;
    symbol?: string;
    source: TokenMetaSource;
    verified: false;
    notice: string;
  };
}

/**
 * The only constructor for a scaled figure in this app.
 *
 * `contract` is a separate argument rather than read off `meta` so that it is
 * present even when nothing is known about the token — the address is the fact
 * and the metadata is the guess, and the fact must not be optional.
 */
export function describeTokenAmount(
  contract: string,
  raw: bigint,
  meta: TokenMeta | undefined,
): TokenAmountView {
  const view: TokenAmountView = {
    contract: checksumAddress(requireAddress(contract, "token contract")),
    raw,
    rawText: raw.toString(),
  };
  if (meta?.decimals === undefined) return view;
  view.scaled = {
    text: formatUnits(raw, meta.decimals),
    decimals: meta.decimals,
    ...(meta.symbol !== undefined ? { symbol: meta.symbol } : {}),
    source: meta.source,
    verified: false,
    notice: TOKEN_SCALE_NOTICE,
  };
  return view;
}

/** The bundled hint for a contract, as a `TokenMeta`. Undefined if unlisted. */
export function hintMeta(chainId: number, address: string): TokenMeta | undefined {
  const hint: TokenHint | undefined = tokenHint(chainId, address);
  if (!hint) return undefined;
  return {
    address,
    chainId,
    symbol: hint.symbol,
    decimals: hint.decimals,
    source: "app-hint",
    verified: false,
  };
}

/* ------------------------------------------------------------- the fetches */

/** An EIP-1193 `request`. `FailoverRpc` is one; a fake in a test is another. */
export type EthRequest = (args: { method: string; params?: unknown }) => Promise<unknown>;

/** Which block. "latest" everywhere: a wallet is asking about now. */
const LATEST = "latest";

/** Native balance in wei. One RPC call, one address disclosed. */
export async function fetchNativeBalance(
  request: EthRequest,
  address: string,
): Promise<bigint> {
  requireAddress(address, "address");
  return decodeQuantity(await request({ method: "eth_getBalance", params: [address, LATEST] }));
}

/** `balanceOf(owner)` in raw units. Throws rather than guessing zero. */
export async function fetchTokenBalance(
  request: EthRequest,
  token: string,
  owner: string,
): Promise<bigint> {
  requireAddress(token, "token");
  return decodeUint256Return(
    await request({ method: "eth_call", params: [{ to: token, data: encodeBalanceOf(owner) }, LATEST] }),
  );
}

/**
 * Ask a contract what it calls itself.
 *
 * Both calls are allowed to fail independently and silently: plenty of real
 * tokens implement neither, and a missing symbol only costs a less friendly
 * screen. What comes back is self-declared and is stamped `source:
 * "contract"`, which is the whole of what this function has established.
 *
 * The bundled hint wins when there is one — not because it is verified (it is
 * not, and it says so) but because it was at least typed by this project
 * rather than by the contract under examination.
 */
export async function fetchTokenMeta(
  request: EthRequest,
  chainId: number,
  token: string,
): Promise<TokenMeta> {
  const address = token.toLowerCase();
  const hint = hintMeta(chainId, address);
  if (hint) return hint;

  const [decimalsReply, symbolReply] = await Promise.all([
    request({ method: "eth_call", params: [{ to: token, data: encodeDecimals() }, LATEST] })
      .catch(() => undefined),
    request({ method: "eth_call", params: [{ to: token, data: encodeSymbol() }, LATEST] })
      .catch(() => undefined),
  ]);

  const decimals = decimalsReply === undefined ? undefined : decodeDecimalsReturn(decimalsReply);
  const symbol = symbolReply === undefined ? undefined : decodeSymbolReturn(symbolReply);
  return {
    address,
    chainId,
    ...(symbol !== undefined ? { symbol } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    source: "contract",
    verified: false,
  };
}

/* ------------------------------------------------------- refresh policy
 *
 * Why not a poll. Every fetch below names an address to whoever answers, and a
 * background refresh every few seconds would turn one disclosure into a
 * continuous stream of them — a timeline of when this wallet is open, from an
 * operator who was never told anything about the user in the first place. It
 * would also mean the app quietly re-asking after the window has been left
 * open all night.
 *
 * So the app fetches at the moments an old number becomes *wrong* rather than
 * merely old — the device connecting or its wallet changing, the chain
 * changing, the selected address changing, a transaction being broadcast — and
 * otherwise only when the user asks. In between, the age is displayed. A
 * number with a visible timestamp is honest; a number that refreshes itself
 * every ten seconds is a promise this app cannot keep anyway, since a balance
 * is one pending transaction away from being wrong the instant it arrives.
 */

/** Past this age, a balance is labelled stale rather than shown plainly. */
export const BALANCE_STALE_AFTER_MS = 60_000;

/** A fetched figure and everything needed to say how much to trust it. */
export interface BalanceSnapshot {
  chainId: number;
  address: string;
  /** `Date.now()` when the answer arrived. */
  fetchedAt: number;
  /** Host of the endpoint that answered — the operator that learned about it. */
  endpointHost?: string;
}

export interface Freshness {
  stale: boolean;
  /** Human phrase for the age, e.g. "12s ago". Never a bare number. */
  text: string;
  ageMs: number;
}

/** How old a snapshot is, in words. Pure, so the UI has nothing to decide. */
export function freshnessOf(fetchedAt: number, now: number): Freshness {
  const ageMs = Math.max(0, now - fetchedAt);
  const seconds = Math.floor(ageMs / 1000);
  const text =
    seconds < 5 ? "just now"
    : seconds < 90 ? `${seconds}s ago`
    : seconds < 5400 ? `${Math.floor(seconds / 60)} min ago`
    : `${Math.floor(seconds / 3600)} h ago`;
  return { stale: ageMs >= BALANCE_STALE_AFTER_MS, text, ageMs };
}

/**
 * The full line to put next to a balance. One function so no screen can render
 * the figure without the provenance and the age arriving in the same call.
 */
export function balanceProvenance(snapshot: BalanceSnapshot, now: number): string {
  const fresh = freshnessOf(snapshot.fetchedAt, now);
  const who = snapshot.endpointHost ? `from ${snapshot.endpointHost}` : "from an RPC endpoint";
  return `${fresh.stale ? "STALE — read " : "Read "}${fresh.text} ${who}. ${BALANCE_SOURCE_NOTICE}`;
}
