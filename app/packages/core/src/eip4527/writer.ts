/**
 * The encoding half of the EIP-4527 grammar.
 *
 * Separate from `cbor.ts` for the reason `reader.ts` is: that codec refuses
 * tags and booleans by design, and EIP-4527 needs both. This writer emits only
 * what `reader.ts` accepts — unsigned integers, byte and text strings, arrays,
 * maps, the two booleans, and a tag the caller names — so anything it produces
 * is something our own reader, and the firmware's, can be held to.
 *
 * Shortest-form heads only. Two encoders choosing different widths for the
 * same number produce different bytes for the same request, and a request id
 * or checksum computed over one would not match the other.
 */

const MT_UINT = 0;
const MT_BYTES = 2;
const MT_TEXT = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;
const MT_TAG = 6;

export class Writer {
  private out: number[] = [];

  private head(mt: number, value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      /* The reader refuses 64-bit arguments, so the writer must not emit one;
         anything past 32 bits here is a caller bug, not a wire case. */
      throw new Error(`eip4527 writer: ${value} is not a 32-bit unsigned integer`);
    }
    const m = mt << 5;
    if (value < 24) this.out.push(m | value);
    else if (value < 0x100) this.out.push(m | 24, value);
    else if (value < 0x10000) this.out.push(m | 25, value >> 8, value & 0xff);
    else {
      this.out.push(m | 26, value >>> 24, (value >>> 16) & 0xff,
        (value >>> 8) & 0xff, value & 0xff);
    }
    return this;
  }

  uint(v: number): this { return this.head(MT_UINT, v); }

  bytes(b: Uint8Array): this {
    this.head(MT_BYTES, b.length);
    for (const x of b) this.out.push(x);
    return this;
  }

  text(s: string): this {
    const b = new TextEncoder().encode(s);
    this.head(MT_TEXT, b.length);
    for (const x of b) this.out.push(x);
    return this;
  }

  bool(v: boolean): this {
    this.out.push(v ? 0xf5 : 0xf4);
    return this;
  }

  array(n: number): this { return this.head(MT_ARRAY, n); }
  map(pairs: number): this { return this.head(MT_MAP, pairs); }
  tag(t: number): this { return this.head(MT_TAG, t); }

  finish(): Uint8Array { return new Uint8Array(this.out); }
}
