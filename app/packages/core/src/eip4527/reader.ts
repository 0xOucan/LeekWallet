/**
 * A strict CBOR reader for EIP-4527, separate from `cbor.ts` on purpose.
 *
 * `cbor.ts` says in its own header that tags, floats, indefinite lengths and
 * bignums are rejected rather than tolerated, because a signing device's
 * parser is attack surface. EIP-4527 needs tags. Rather than make that
 * sentence untrue, this is a second grammar — also small enough to audit in
 * one sitting — in which the accepted semantic tags are properties of
 * *specific fields*, not capabilities of CBOR.
 *
 * ---------------------------------------------------------------------------
 * Schema-driven, never tag-driven
 *
 * There is deliberately no `readAnyTag()`. The caller says what it expects
 * where it expects it:
 *
 *     expectTag(r, TAG_CRYPTO_KEYPATH);
 *
 * so a value carrying tag 303 where a keypath belongs is refused at that
 * position, exactly as hard as a value carrying tag 9999. A reader that
 * returned `{ tag, value }` for any known tag would accept both and leave the
 * question of which was allowed to some later code that may not ask.
 *
 * ---------------------------------------------------------------------------
 * Not in this grammar, at all
 *
 * Floats, indefinite lengths, bignums, simple values other than none, negative
 * integers, and any tag a schema does not name. Definite lengths only.
 */

import { E4527, E4527Error } from "./errors.ts";

/** uuid, per the IANA CBOR tag registry. */
export const TAG_UUID = 37;
/** crypto-hdkey. */
export const TAG_CRYPTO_HDKEY = 303;
/** crypto-keypath. */
export const TAG_CRYPTO_KEYPATH = 304;
/** crypto-coin-info. */
export const TAG_CRYPTO_COIN_INFO = 305;
/**
 * crypto-multi-accounts.
 *
 * A Keystone extension rather than part of EIP-4527's signing protocol, which
 * is built on crypto-hdkey, crypto-keypath, eth-sign-request and
 * eth-signature. Listed so it is supported knowingly, and labelled so nobody
 * later cites it as evidence that the ERC requires it.
 */
export const TAG_CRYPTO_MULTI_ACCOUNTS = 1103;

const MT_UINT = 0;
const MT_BYTES = 2;
const MT_TEXT = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;
const MT_TAG = 6;

export class Reader {
  private pos = 0;

  private readonly buf: Uint8Array;
  private field: string;

  constructor(buf: Uint8Array, field = "(root)") {
    this.buf = buf;
    this.field = field;
  }

  /** Name the field being read, so a refusal says where it happened. */
  in<T>(field: string, fn: () => T): T {
    const previous = this.field;
    this.field = field;
    try {
      return fn();
    } finally {
      this.field = previous;
    }
  }

  fail(code: E4527, detail: string): never {
    throw new E4527Error(code, this.field, detail);
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Every byte must be consumed; leftovers mean this is not what it claims. */
  expectEnd(): void {
    if (!this.done) {
      this.fail(E4527.TRAILING_DATA, `${this.buf.length - this.pos} bytes left over`);
    }
  }

  private byte(): number {
    if (this.pos >= this.buf.length) {
      this.fail(E4527.MALFORMED, "input ended mid-item");
    }
    return this.buf[this.pos++]!;
  }

  /** Major type and argument. Definite lengths only; no indefinite, no floats. */
  private head(): { mt: number; arg: number } {
    const ib = this.byte();
    const mt = ib >> 5;
    const ai = ib & 0x1f;

    if (mt === 7) {
      this.fail(E4527.MALFORMED, "floats and simple values are not in this grammar");
    }
    if (ai === 31) {
      this.fail(E4527.MALFORMED, "indefinite lengths are not in this grammar");
    }
    if (ai === 28 || ai === 29 || ai === 30) {
      this.fail(E4527.MALFORMED, `reserved additional information ${ai}`);
    }

    let arg = ai;
    if (ai >= 24) {
      const n = 1 << (ai - 24);
      if (n > 4) {
        /* 64-bit arguments would need BigInt to be represented, and nothing in
           these schemas is that large. Refusing is honest; silently truncating
           would not be. */
        this.fail(E4527.MALFORMED, "64-bit arguments are not in this grammar");
      }
      arg = 0;
      for (let i = 0; i < n; i++) arg = arg * 256 + this.byte();
    }
    return { mt, arg };
  }

  private expect(mt: number, what: string): number {
    const h = this.head();
    if (h.mt !== mt) {
      this.fail(E4527.MALFORMED, `expected ${what}, got major type ${h.mt}`);
    }
    return h.arg;
  }

  /** Require exactly this tag. There is no "read whatever tag is here". */
  expectTag(tag: number): void {
    const got = this.expect(MT_TAG, `tag ${tag}`);
    if (got !== tag) {
      this.fail(E4527.WRONG_TAG, `expected tag ${tag}, got tag ${got}`);
    }
  }

  /** Refuse if the next item is tagged at all. */
  expectUntagged(): void {
    if (this.pos < this.buf.length && this.buf[this.pos]! >> 5 === MT_TAG) {
      this.fail(E4527.WRONG_TAG, "a tag is present where a bare item is required");
    }
  }

  expectUint(): number {
    return this.expect(MT_UINT, "an unsigned integer");
  }

  expectBytes(exactLength?: number): Uint8Array {
    const len = this.expect(MT_BYTES, "a byte string");
    if (this.pos + len > this.buf.length) {
      this.fail(E4527.MALFORMED, "byte string runs past the end of the input");
    }
    if (exactLength !== undefined && len !== exactLength) {
      this.fail(E4527.BAD_LENGTH, `expected ${exactLength} bytes, got ${len}`);
    }
    const out = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  expectText(): string {
    const len = this.expect(MT_TEXT, "a text string");
    if (this.pos + len > this.buf.length) {
      this.fail(E4527.MALFORMED, "text string runs past the end of the input");
    }
    const out = new TextDecoder("utf-8", { fatal: true }).decode(
      this.buf.subarray(this.pos, this.pos + len),
    );
    this.pos += len;
    return out;
  }

  /**
   * Exactly `false` or `true`, and nothing else from major type 7.
   *
   * Booleans are CBOR simple values, which this grammar otherwise refuses
   * outright along with floats and `null`. crypto-keypath needs them for the
   * hardened flag, so the two byte values are named here rather than the major
   * type being opened up: `expectBool` accepts 0xF4 and 0xF5 and nothing else,
   * so `null`, `undefined` and every float stay refused.
   */
  expectBool(): boolean {
    const b = this.byte();
    if (b === 0xf4) return false;
    if (b === 0xf5) return true;
    this.fail(E4527.MALFORMED, `expected a boolean, got byte 0x${b.toString(16)}`);
  }

  /** Is the next item a zero-length array? A keypath wildcard is encoded so. */
  peekIsEmptyArray(): boolean {
    return this.pos < this.buf.length && this.buf[this.pos] === 0x80;
  }

  expectArray(): number {
    return this.expect(MT_ARRAY, "an array");
  }

  expectMap(): number {
    return this.expect(MT_MAP, "a map");
  }

  /**
   * Read a map of small unsigned-integer keys, refusing duplicates.
   *
   * Duplicates are a refusal rather than a precedence rule on purpose. "First
   * wins" in one implementation and "last wins" in another is two readings of
   * one frame, and the disagreement shows up on a device rather than in CI.
   */
  readIntKeyedMap(
    known: ReadonlySet<number>,
    onField: (key: number) => void,
  ): Set<number> {
    const pairs = this.expectMap();
    const seen = new Set<number>();
    for (let i = 0; i < pairs; i++) {
      const key = this.expectUint();
      if (seen.has(key)) {
        this.fail(E4527.DUPLICATE_FIELD, `key ${key} appeared twice`);
      }
      if (!known.has(key)) {
        this.fail(E4527.UNKNOWN_FIELD, `key ${key} is not in this schema`);
      }
      seen.add(key);
      onField(key);
    }
    return seen;
  }
}
