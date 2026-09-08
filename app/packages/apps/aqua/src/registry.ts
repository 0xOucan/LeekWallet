/**
 * The Aqua registry, as calldata and as logs.
 *
 * Aqua is a shared liquidity layer in which the maker's tokens never move into
 * a pool. The registry holds *virtual* balances keyed
 * `_balances[maker][app][strategyHash][token]`, and real ERC-20 transfers only
 * happen at execution, when an app calls `pull()` against the maker's wallet.
 * That is the whole reason the app exists and also the whole reason it is
 * dangerous: what the registry stores is a permission to pull, and the amount
 * that can actually be pulled is bounded by the maker's ERC-20 *allowance* to
 * the registry, not by the number written here. See portfolio.ts.
 *
 * ---------------------------------------------------------------------------
 * Why this reads the chain directly instead of using @1inch/aqua-sdk
 *
 * The SDK was read before this was written (1inch/sdks, typescript/aqua). For
 * Q1 it offers three things: `calculateStrategyHash`, which is literally
 * `keccak256(strategy)`; `encodeShipCallData` / `encodeDockCallData`, which are
 * write paths this milestone deliberately does not have; and event decoders.
 * Against that it brings viem plus `@1inch/sdk-core`'s `Address`/`HexString`
 * wrapper classes into a package whose entire job is to be deletable, and it
 * hard-codes a chain enum this repo already has a reviewed answer for in
 * chains.ts. It also has no reader at all for `rawBalances`, which is the one
 * call this milestone is actually built on.
 *
 * So: signatures are typed out below and their selectors derived with keccak by
 * core's own `selectorOf`, the same way allowances.ts does it, and the decoders
 * are bounds-checked here. The SDK's published `Shipped` topic is pinned in the
 * tests as an independent check that the signature string is right — using it
 * as a cross-check costs nothing and using it as a dependency costs a lot.
 *
 * ---------------------------------------------------------------------------
 * `rawBalances`, not `safeBalances`
 *
 * docs/apps/AQUA-1INCH.md says to read `safeBalances(maker, app, hash, t0, t1)`.
 * That is the wrong call for a portfolio view and this file does not use it.
 * `safeBalances` **reverts** — `SafeBalancesForTokenNotInActiveStrategy` — for
 * any token that is not in an active strategy, which means a docked position
 * and a position that never existed both come back as a failed call. Inside a
 * multicall a failed call is also what an unreachable node produces. That
 * collapses three states the user must be able to tell apart into one, which is
 * exactly the failure this milestone is written to avoid.
 *
 * `rawBalances(maker, app, hash, token)` returns `(uint248 amount, uint8
 * tokensCount)` and answers for every state without reverting:
 *
 *   tokensCount == 0     no such position, ever
 *   tokensCount == 0xff  docked: closed by the maker on purpose
 *   otherwise            active, in a strategy of that many tokens; `amount`
 *                        may legitimately be 0 if it has all been pulled
 *
 * A revert here therefore still means what a revert should mean: nobody
 * answered.
 */

import { selectorOf } from "@leekwallet/core/allowances.ts";
import { AbiError, DecodeError } from "@leekwallet/core/balances.ts";
import { keccak_256 } from "@noble/hashes/sha3";

/* ------------------------------------------------------------- deployment */

/**
 * The registry, identical on every chain it is deployed to.
 *
 * A shared address across chains is a deployment convenience and not an
 * attestation — see multicall.ts's header on the same point. Nothing here
 * checks that the code at this address is Aqua; an operator can answer for it
 * with whatever it likes, which is why a reading from it is worth exactly as
 * much as the endpoint that served it.
 */
export const AQUA_REGISTRY = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";

/** The SwapVM router. Recorded for Q3; nothing in Q1 calls it. */
export const AQUA_SWAPVM_ROUTER = "0x111111338c5091e8440b67b168bae16a668ac0de";

/**
 * Chains where Aqua is deployed AND this repo already has vetted RPCs.
 *
 * The intersection, not the union. The SDK lists chains chains.ts does not
 * carry (Monad, Cronos, HyperEVM, Robinhood); offering those here would mean
 * inventing endpoints, and chains.ts's header is explicit that being listed is
 * a claim. Adding one is one line here after one entry there.
 */
/* The twelve mainnets Aqua's README lists, plus Ethereum Sepolia (11155111),
   which it does not.
 
   Sepolia is here on evidence rather than documentation: eth_getCode at the
   registry address returns runtime bytecode whose hash is identical to
   Polygon's and Gnosis's (4c886bff...), which follows from the deterministic
   deployment the README describes, and it emitted 25 events in 9000 blocks. It
   is a live deployment that the docs simply do not mention.
 
   That matters because it is the only chain where this app can be exercised
   without mainnet funds -- the SwapVM router really is mainnet-only, so Q3
   still needs a fork, but the registry alone is enough for ship and dock. */
export const AQUA_CHAIN_IDS: readonly number[] =
  [1, 10, 56, 100, 130, 137, 146, 324, 8453, 42161, 43114, 59144, 11155111];

export const isAquaChain = (chainId: number): boolean => AQUA_CHAIN_IDS.includes(chainId);

/* ------------------------------------------------------------ ABI helpers */

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function addressWord(address: string, what: string): string {
  if (!HEX40.test(address)) throw new AbiError(`${what} is not a 20-byte address`);
  return "0".repeat(24) + address.slice(2).toLowerCase();
}

function bytes32Word(value: string, what: string): string {
  if (!HEX32.test(value)) throw new AbiError(`${what} is not a 32-byte value`);
  return value.slice(2).toLowerCase();
}

/** `rawBalances(address,address,bytes32,address)` — four static words. */
export const SELECTOR_RAW_BALANCES = selectorOf("rawBalances(address,address,bytes32,address)");

/**
 * `safeBalances(...)`. Derived so the tests can prove it differs from
 * `rawBalances`, and so a reader can see which one was chosen. Not called.
 */
export const SELECTOR_SAFE_BALANCES =
  selectorOf("safeBalances(address,address,bytes32,address,address)");

export function encodeRawBalances(
  maker: string, app: string, strategyHash: string, token: string,
): string {
  return `0x${SELECTOR_RAW_BALANCES}${addressWord(maker, "maker")}` +
    `${addressWord(app, "app")}${bytes32Word(strategyHash, "strategyHash")}` +
    `${addressWord(token, "token")}`;
}

/* ------------------------------------------------------------- the writes
 *
 * `ship` and `dock`, encoded canonically -- the exact layout solc emits, which
 * is the only one the device's decoder accepts (src/eth-decode.c). Producing
 * anything else here would produce calldata this wallet refuses to sign, which
 * is a better failure than the alternative but still a failure, so the encoder
 * and the decoder are written from the same description of the layout.
 *
 * Selectors are derived by hashing, like every other one in this file. Note
 * that neither of these was in the SDK's documented surface at the time: they
 * were read off the deployed dispatcher on Sepolia and confirmed against the
 * `Shipped` topic the contract emits, which is why they are derived rather
 * than pinned.
 */

/** `ship(address app, bytes strategy, address[] tokens, uint256[] amounts)`. */
export const SELECTOR_SHIP = selectorOf("ship(address,bytes,address[],uint256[])");

/** `dock(address app, bytes32 strategyHash, address[] tokens)`. */
export const SELECTOR_DOCK = selectorOf("dock(address,bytes32,address[])");

/**
 * The most legs this wallet will ship or dock in one call.
 *
 * `ETH_AQUA_MAX_LEGS` on the device, where it is one confirmation page per leg
 * and a strategy with more is refused rather than summarised. Repeated here as
 * a named constant so the app refuses first, with a sentence, instead of
 * building calldata the device will reject without explaining why.
 */
export const AQUA_MAX_LEGS = 4;

const HEX_BYTES = /^0x([0-9a-fA-F]{2})*$/;

function legWords(tokens: readonly string[]): string {
  return tokens.map((t, i) => addressWord(t, `tokens[${i}]`)).join("");
}

function uintWord(value: bigint, what: string): string {
  if (value < 0n) throw new AbiError(`${what} is negative`);
  if (value > (1n << 256n) - 1n) throw new AbiError(`${what} does not fit a uint256`);
  return value.toString(16).padStart(64, "0");
}

export interface ShipLeg {
  token: string;
  /** Raw units. What the strategy is credited with, not what can be pulled. */
  amount: bigint;
}

export function encodeShip(
  app: string, strategy: string, legs: readonly ShipLeg[],
): string {
  if (!HEX_BYTES.test(strategy)) throw new AbiError("strategy is not whole-byte hex");
  if (legs.length === 0) throw new AbiError("a ship with no legs provides nothing");
  if (legs.length > AQUA_MAX_LEGS) {
    throw new AbiError(`the device draws at most ${AQUA_MAX_LEGS} legs per strategy`);
  }

  const body = strategy.slice(2).toLowerCase();
  const length = body.length / 2;
  const padded = body.padEnd(Math.ceil(length / 32) * 64, "0");

  const offS = 4 * 32;
  const offT = offS + 32 + padded.length / 2;
  const offA = offT + 32 + legs.length * 32;

  return `0x${SELECTOR_SHIP}` +
    addressWord(app, "app") +
    uintWord(BigInt(offS), "strategy offset") +
    uintWord(BigInt(offT), "tokens offset") +
    uintWord(BigInt(offA), "amounts offset") +
    uintWord(BigInt(length), "strategy length") + padded +
    uintWord(BigInt(legs.length), "tokens length") +
    legWords(legs.map((l) => l.token)) +
    uintWord(BigInt(legs.length), "amounts length") +
    legs.map((l, i) => uintWord(l.amount, `amounts[${i}]`)).join("");
}

export function encodeDock(
  app: string, hash: string, tokens: readonly string[],
): string {
  if (tokens.length === 0) throw new AbiError("a dock with no tokens returns nothing");
  if (tokens.length > AQUA_MAX_LEGS) {
    throw new AbiError(`the device draws at most ${AQUA_MAX_LEGS} legs per strategy`);
  }
  return `0x${SELECTOR_DOCK}` +
    addressWord(app, "app") +
    bytes32Word(hash, "strategyHash") +
    uintWord(BigInt(3 * 32), "tokens offset") +
    uintWord(BigInt(tokens.length), "tokens length") +
    legWords(tokens);
}

/** `tokensCount` sentinel: the maker docked this strategy. */
export const DOCKED = 0xff;

const UINT248_MAX = (1n << 248n) - 1n;

/**
 * One slot of the registry, unpacked into the three states it can be in.
 *
 * A discriminated union rather than a nullable amount, for the reason
 * multicall.ts gives at length: the caller must not be able to render a number
 * without first having decided what kind of nothing it is looking at. "docked"
 * and "absent" both mean zero pullable, but only one of them means the maker
 * did something, and telling an LP their position is "absent" when they docked
 * it themselves is as wrong as the reverse.
 */
export type RegistrySlot =
  | { state: "active"; amount: bigint; tokensCount: number }
  | { state: "docked" }
  | { state: "absent" };

/** `(uint248 amount, uint8 tokensCount)` — two words, both narrow. */
export function decodeRawBalances(value: unknown): RegistrySlot {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{128}$/.test(value)) {
    throw new DecodeError("rawBalances did not return two words");
  }
  const amount = BigInt(`0x${value.slice(2, 66)}`);
  const tokensCount = BigInt(`0x${value.slice(66, 130)}`);
  /* Both fields are narrower than the words carrying them. A return that
   * overflows a declared width did not come from this contract, and masking it
   * would report a plausible balance nobody legitimate produced. */
  if (amount > UINT248_MAX || tokensCount > 0xffn) {
    throw new DecodeError("rawBalances fields do not fit their declared widths");
  }
  const count = Number(tokensCount);
  if (count === 0) return { state: "absent" };
  if (count === DOCKED) return { state: "docked" };
  return { state: "active", amount, tokensCount: count };
}

/* ---------------------------------------------------------------- hashing */

/**
 * `strategyHash = keccak256(strategy)`. Identical to the SDK's
 * `calculateStrategyHash`, which is why the SDK is not imported for it.
 *
 * Note what this hash does NOT contain: the maker. `Aqua.ship` keys the slot by
 * `msg.sender` separately, so the same strategy bytes shipped by two makers
 * produce the same hash under different keys. AQUA-1INCH.md's claim that the
 * hash "is unique per user" is a property of the *app's* strategy struct — the
 * example app carries `maker` and a `salt` in it — not of the registry. Q2's
 * refusal to sign a strategy naming another maker has to read the decoded
 * struct; it cannot be derived from this hash.
 */
export function strategyHash(strategy: string): string {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(strategy)) {
    throw new AbiError("strategy is not whole-byte hex");
  }
  const bytes = new Uint8Array(
    (strategy.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)),
  );
  return `0x${[...keccak_256(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/* ----------------------------------------------------------------- events */

const topicOf = (signature: string): string =>
  `0x${[...keccak_256(new TextEncoder().encode(signature))]
    .map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** `Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)`. */
export const TOPIC_SHIPPED = topicOf("Shipped(address,address,bytes32,bytes)");
/** `Docked(address maker, address app, bytes32 strategyHash)`. */
export const TOPIC_DOCKED = topicOf("Docked(address,address,bytes32)");
/** `Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)`. */
export const TOPIC_PUSHED =
  topicOf("Pushed(address,address,bytes32,address,uint256)");

/**
 * **None of Aqua's event parameters are indexed.** Not one, including `maker`.
 *
 * This is the single most consequential fact about discovering positions, and
 * it is not in the plan document. `eth_getLogs` can filter on topics only, so
 * there is no way to ask a node for "this maker's Shipped events": the filter
 * has to be `{address: registry, topics: [TOPIC_SHIPPED]}` — every maker's —
 * and the maker comparison happens here, after the fact, on the data words.
 *
 * Two consequences the caller must live with, both handled in positions.ts:
 * the response is proportional to the whole protocol's activity rather than to
 * this user's, and the RPC operator learns only that somebody asked for all
 * Aqua ships, which is a smaller disclosure than usual rather than a larger
 * one.
 */
export interface ShippedLog {
  maker: string;
  app: string;
  strategyHash: string;
  /** The strategy bytes, verbatim. Not decoded here — that is Q3's job. */
  strategy: string;
}

/** `Pushed`, which is also what `ship` emits per token — see positions.ts. */
export interface PushedLog {
  maker: string;
  app: string;
  strategyHash: string;
  token: string;
  amount: bigint;
}

/** One `eth_getLogs` entry, as much of it as is used. */
export interface RawLog {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
}

const wordAt = (body: string, i: number): string => body.slice(i * 64, (i + 1) * 64);

/** A word that must hold a left-padded address, checked rather than truncated. */
function addressFromWord(word: string, what: string): string {
  if (word.length !== 64) throw new DecodeError(`${what}: truncated word`);
  if (!/^0{24}/.test(word)) throw new DecodeError(`${what}: word has dirty high bytes`);
  return `0x${word.slice(24)}`;
}

function logBody(log: RawLog, topic: string, name: string): string | undefined {
  const topics = log.topics;
  if (!Array.isArray(topics) || typeof topics[0] !== "string") return undefined;
  if ((topics[0] as string).toLowerCase() !== topic) return undefined;
  /* An event with no indexed parameters must carry exactly one topic. More
   * than one means this is not the event whose layout is assumed below, and
   * decoding it anyway would assign words to the wrong fields. */
  if (topics.length !== 1) throw new DecodeError(`${name}: unexpected indexed topics`);
  const data = log.data;
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new DecodeError(`${name}: data is not whole-byte hex`);
  }
  return data.slice(2).toLowerCase();
}

/**
 * Decode a `Shipped` log, or undefined if it is a different event.
 *
 * `strategy` is `bytes`, so the fourth head word is an offset into the tail and
 * every offset and length is bounds-checked against the actual body length
 * before it is used. The data is attacker-controlled in the ordinary sense:
 * an unverified operator answered for a contract nobody here checked, and a
 * half-decoded log would attach one maker's strategy bytes to another's hash.
 */
export function decodeShipped(log: RawLog): ShippedLog | undefined {
  const body = logBody(log, TOPIC_SHIPPED, "Shipped");
  if (body === undefined) return undefined;
  if (body.length < 4 * 64) throw new DecodeError("Shipped: fewer than four words");

  const maker = addressFromWord(wordAt(body, 0), "Shipped.maker");
  const app = addressFromWord(wordAt(body, 1), "Shipped.app");
  const hash = `0x${wordAt(body, 2)}`;

  const offset = BigInt(`0x${wordAt(body, 3)}`);
  const bytesLength = BigInt(body.length / 2);
  if (offset > bytesLength || offset % 32n !== 0n) {
    throw new DecodeError("Shipped: strategy offset out of range");
  }
  const at = Number(offset) * 2;
  if (body.length < at + 64) throw new DecodeError("Shipped: strategy length word missing");
  const length = BigInt(`0x${body.slice(at, at + 64)}`);
  if (length > bytesLength) throw new DecodeError("Shipped: strategy length out of range");
  const start = at + 64;
  const end = start + Number(length) * 2;
  if (body.length < end) throw new DecodeError("Shipped: strategy body truncated");

  return { maker, app, strategyHash: hash, strategy: `0x${body.slice(start, end)}` };
}

/** Decode a `Pushed` log, or undefined if it is a different event. */
export function decodePushed(log: RawLog): PushedLog | undefined {
  const body = logBody(log, TOPIC_PUSHED, "Pushed");
  if (body === undefined) return undefined;
  if (body.length !== 5 * 64) throw new DecodeError("Pushed: expected exactly five words");
  return {
    maker: addressFromWord(wordAt(body, 0), "Pushed.maker"),
    app: addressFromWord(wordAt(body, 1), "Pushed.app"),
    strategyHash: `0x${wordAt(body, 2)}`,
    token: addressFromWord(wordAt(body, 3), "Pushed.token"),
    amount: BigInt(`0x${wordAt(body, 4)}`),
  };
}
