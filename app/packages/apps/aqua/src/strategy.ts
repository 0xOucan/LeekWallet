/**
 * The strategy blob: how to read a maker out of it, and why that is the one
 * refusal this milestone is built around.
 *
 * ---------------------------------------------------------------------------
 * The fact that makes this necessary
 *
 * `strategyHash = keccak256(strategy)` and **the maker is not in it**. Aqua
 * files balances as `_balances[msg.sender][app][strategyHash][token]`, so the
 * sender is keyed separately and the same strategy bytes shipped by two makers
 * produce the same hash under two different keys. AQUA-1INCH.md says the hash
 * "is unique per user"; it is not, and registry.ts's header sets that out.
 *
 * The consequence is specific and unpleasant. A strategy struct carries its own
 * `maker` field, which is what the *app* acts on. Nothing on chain reconciles
 * that field with `msg.sender`. So a strategy naming somebody else, shipped
 * from this device, creates a position filed under this device's key while
 * instructing the app about another address — and the strategy hash, the only
 * short identifier anywhere in the flow, is identical either way. There is no
 * way to detect it from the hash. The struct has to be decoded.
 *
 * Whether that is an attack or a copy-paste mistake does not matter here.
 * Neither should reach a signature, so it is refused outright rather than
 * warned about.
 *
 * ---------------------------------------------------------------------------
 * What "decode" can honestly mean without an ABI
 *
 * The strategy is opaque to Aqua: the registry hashes it and hands it to the
 * app, and each app defines its own struct. There is no universal schema to
 * appeal to, so this module claims exactly one thing, and it is a thing that
 * can be checked against the chain rather than assumed:
 *
 *   Every `Shipped` event read off Sepolia and Polygon carries a strategy that
 *   is `abi.encode(struct)` for a struct with at least one dynamic member — a
 *   0x20 head word, then the struct's own first field, an address, and that
 *   address equals the `maker` in the same event.
 *
 * Two different apps, two entirely different struct bodies, same first field.
 * So: read word 0 as a head that must be 0x20, read word 1 as an address, and
 * refuse anything else. Refusing is not a gap in coverage — a strategy this
 * cannot read is one nobody can say whose position it creates, and that is
 * exactly the question the refusal exists to answer.
 *
 * The firmware applies the identical rule in `aqua_strategy_maker()`, so the
 * device refuses the same bytes on its own screen. That matters: a refusal
 * only the host makes is a refusal a compromised host can skip.
 */

import { AbiError } from "@leekwallet/core/balances.ts";
import { strategyHash } from "./registry.ts";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x([0-9a-fA-F]{2})*$/;

/** Why a strategy could not be read. Each is a refusal, never a warning. */
export type StrategyRefusal =
  /** Not whole-byte hex, or too short to hold a head word and an address. */
  | { kind: "malformed"; why: string }
  /** Word 0 is not the 0x20 head `abi.encode` puts in front of a tuple. */
  | { kind: "not-a-tuple" }
  /** Word 1 has dirty high bytes, so it is not a left-padded address. */
  | { kind: "no-maker" };

export type StrategyReading =
  | { ok: true; maker: string; hash: string }
  | { ok: false; refusal: StrategyRefusal };

/**
 * Read the maker a strategy names, and the hash it will be filed under.
 *
 * Case-insensitive input, lower-case output: an address that differs only in
 * case is the same address, and comparing the two forms as strings is how a
 * check like this quietly stops checking.
 */
export function readStrategy(strategy: string): StrategyReading {
  if (typeof strategy !== "string" || !HEX_BYTES.test(strategy)) {
    return { ok: false, refusal: { kind: "malformed", why: "not whole-byte hex" } };
  }
  const body = strategy.slice(2).toLowerCase();
  if (body.length < 2 * 64) {
    return { ok: false, refusal: { kind: "malformed", why: "shorter than two words" } };
  }
  if (body.slice(0, 64) !== "0".repeat(62) + "20") {
    return { ok: false, refusal: { kind: "not-a-tuple" } };
  }
  const word = body.slice(64, 128);
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) {
    return { ok: false, refusal: { kind: "no-maker" } };
  }
  return { ok: true, maker: `0x${word.slice(24)}`, hash: strategyHash(strategy) };
}

/** The sentence a user sees when a strategy names somebody else. */
export const WRONG_MAKER_NOTICE =
  "This strategy names a different address as its maker. Aqua files the " +
  "position under whoever signs, but the app acts for the address written " +
  "inside the strategy — so signing this would put your tokens behind " +
  "somebody else's instructions, and the strategy hash looks identical either " +
  "way. There is no version of this that is safe to sign, so it is refused " +
  "rather than warned about.";

/** The sentence when the strategy cannot be read at all. */
export const UNREADABLE_STRATEGY_NOTICE =
  "This strategy is not in a shape this wallet can find a maker in, so it " +
  "cannot tell you whose position it would create. The device applies the same " +
  "rule and would refuse it too. Nothing is signed.";

/* --------------------------------------------------------------- B3: the tail
 *
 * readStrategy() above is unchanged: same two checks, same refusal kinds. What
 * follows reaches further into the SAME bytes for a caller that already knows
 * why it wants to — program.ts's readOrderProgram(), once it has separately
 * decided the `ship` app is the SwapVM router (spec §6.6). Nothing here is
 * consulted by readStrategy() and nothing here changes what it accepts.
 *
 * The wire shape past the maker is exactly what encodeStrategy() below
 * writes, because Aqua's own `ISwapVM.Order` — `(address maker,
 * MakerTraits traits, bytes data)` — is the same `(address, uint256, bytes)`
 * layout as `(address maker, bytes32 config, bytes program)`: a head word,
 * then three struct words (maker, a 32-byte word, an in-struct offset that
 * must be 0x60), then the dynamic tail's length and bytes. See spec §4.
 */

/** `readStrategy()`'s result, plus the SwapVM-Order-shaped tail past the maker. */
export interface StrategyData {
  maker: string;
  hash: string;
  /** Word 2 of the struct: `MakerTraits`, as a packed `uint256`. */
  traits: bigint;
  /** The struct's `data` field, verbatim — tokens, hook slices, then the program. */
  data: Uint8Array;
}

export type StrategyDataReading =
  | { ok: true; value: StrategyData }
  | { ok: false; refusal: StrategyRefusal };

/**
 * `readStrategy()`, extended to `traits` and `data`. Every check
 * `readStrategy()` already makes still runs, unchanged, via the call to it
 * below — this only adds checks past the point where `readStrategy()` stops
 * reading.
 */
export function readStrategyData(strategy: string): StrategyDataReading {
  const base = readStrategy(strategy);
  if (!base.ok) return base;

  /* readStrategy() already proved this is whole-byte hex of at least two
   * words with a 0x20 head, so body exists and is even-length from here on. */
  const body = strategy.slice(2).toLowerCase();
  if (body.length < 5 * 64) {
    return { ok: false, refusal: { kind: "malformed", why: "shorter than five words" } };
  }

  const traits = BigInt(`0x${body.slice(128, 192)}`);

  /* The in-struct offset of `data`. abi.encode always puts it at 0x60 for
   * this shape; anything else is not this struct. */
  if (body.slice(192, 256) !== `${"0".repeat(62)}60`) {
    return { ok: false, refusal: { kind: "malformed", why: "data offset is not 0x60" } };
  }

  const lenWord = body.slice(256, 320);
  const length = Number(BigInt(`0x${lenWord}`));
  if (!Number.isSafeInteger(length)) {
    return { ok: false, refusal: { kind: "malformed", why: "data length is not representable" } };
  }
  const dataStart = 320;
  const dataHexLen = length * 2;
  if (body.length < dataStart + dataHexLen) {
    return { ok: false, refusal: { kind: "malformed", why: "data runs past the strategy's end" } };
  }

  const dataHex = body.slice(dataStart, dataStart + dataHexLen);
  const data = Uint8Array.from(dataHex.match(/../g) ?? [], (b) => parseInt(b, 16));

  return { ok: true, value: { maker: base.maker, hash: base.hash, traits, data } };
}

/**
 * Does this strategy name `maker`, and nothing else?
 *
 * Separate from `readStrategy` so the comparison has a name a reviewer can
 * grep for, and so the two failure kinds — unreadable, and readable but wrong
 * — stay distinguishable to the caller. They mean different things to a user:
 * one is "this app cannot describe what you built", the other is "this is not
 * yours".
 */
export type MakerCheck =
  | { ok: true; hash: string }
  | { ok: false; reason: "wrong-maker"; named: string; expected: string }
  | { ok: false; reason: "unreadable"; refusal: StrategyRefusal };

export function checkMaker(strategy: string, expected: string): MakerCheck {
  if (!HEX40.test(expected)) {
    throw new AbiError("the expected maker is not a 20-byte address");
  }
  const reading = readStrategy(strategy);
  if (!reading.ok) return { ok: false, reason: "unreadable", refusal: reading.refusal };
  if (reading.maker !== expected.toLowerCase()) {
    return {
      ok: false,
      reason: "wrong-maker",
      named: reading.maker,
      expected: expected.toLowerCase(),
    };
  }
  return { ok: true, hash: reading.hash };
}

/* ------------------------------------------------------------- building one */

/**
 * `abi.encode((address maker, bytes32 config, bytes program))` — the shape
 * every strategy observed on chain uses.
 *
 * Offered as a convenience and not as a claim about any particular Aqua app:
 * the struct after the first field is the app's business, and an app whose
 * struct differs must have its bytes built elsewhere and handed in. What this
 * function guarantees is only the part `readStrategy` depends on — the 0x20
 * head and the maker in the first field — which is why building and reading
 * live in the same file and are tested against each other.
 *
 * `program` is the SwapVM blob. This milestone does not decode it, and does not
 * pretend to: Q3 is where an unknown opcode starts refusing to render. Until
 * then it travels as opaque bytes and the device draws the strategy's hash
 * rather than its meaning.
 */
export function encodeStrategy(
  maker: string, config: string, program: string,
): string {
  if (!HEX40.test(maker)) throw new AbiError("maker is not a 20-byte address");
  if (!HEX64.test(config)) throw new AbiError("config is not a 32-byte value");
  if (!HEX_BYTES.test(program)) throw new AbiError("program is not whole-byte hex");

  const body = program.slice(2).toLowerCase();
  const length = body.length / 2;
  const padded = body.padEnd(Math.ceil(length / 32) * 64, "0");
  const word = (v: string) => v.padStart(64, "0");

  return "0x" +
    word("20") +                                   /* head of the dynamic tuple */
    word(maker.slice(2).toLowerCase()) +
    config.slice(2).toLowerCase() +
    word("60") +                                   /* offset of `program`, in-struct */
    word(length.toString(16)) +
    padded;
}
