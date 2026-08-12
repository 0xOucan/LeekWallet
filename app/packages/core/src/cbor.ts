/**
 * Minimal CBOR (RFC 8949), covering only what the LeekWallet protocol uses:
 * unsigned/negative integers, byte strings, text strings, arrays and maps.
 *
 * Deliberately not a general CBOR library. A signing device's parser is attack
 * surface, and the firmware side has to implement whatever this does — so the
 * grammar stays small enough to audit in one sitting. Tags, floats, indefinite
 * lengths and bignums are all rejected rather than tolerated.
 *
 * Encoding is canonical: shortest-form integers, map keys sorted. Two clients
 * building the same request produce identical bytes, which matters when those
 * bytes are what a user is asked to approve.
 */

export type CborValue =
  | number
  | string
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue };

const MAJOR_UINT = 0;
const MAJOR_NEGINT = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;

/* ------------------------------------------------------------------ encode */

class Writer {
  private chunks: number[] = [];

  byte(b: number): void {
    this.chunks.push(b & 0xff);
  }

  bytes(b: Uint8Array): void {
    for (const x of b) this.chunks.push(x);
  }

  /** Type byte plus length, in the shortest form that fits. */
  head(major: number, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`head requires a non-negative integer, got ${value}`);
    }
    const m = major << 5;
    if (value < 24) {
      this.byte(m | value);
    } else if (value < 0x100) {
      this.byte(m | 24);
      this.byte(value);
    } else if (value < 0x10000) {
      this.byte(m | 25);
      this.byte(value >> 8);
      this.byte(value);
    } else if (value <= 0xffffffff) {
      this.byte(m | 26);
      this.byte(value >>> 24);
      this.byte(value >>> 16);
      this.byte(value >>> 8);
      this.byte(value);
    } else {
      // 64-bit lengths would mean payloads no embedded device can hold.
      throw new Error(`value ${value} exceeds the 32-bit encoding limit`);
    }
  }

  finish(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

function encodeInto(w: Writer, value: CborValue): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`non-integer number ${value}: floats are not supported`);
    }
    if (value >= 0) w.head(MAJOR_UINT, value);
    else w.head(MAJOR_NEGINT, -value - 1);
    return;
  }

  if (typeof value === "string") {
    const utf8 = new TextEncoder().encode(value);
    w.head(MAJOR_TEXT, utf8.length);
    w.bytes(utf8);
    return;
  }

  if (value instanceof Uint8Array) {
    w.head(MAJOR_BYTES, value.length);
    w.bytes(value);
    return;
  }

  if (Array.isArray(value)) {
    w.head(MAJOR_ARRAY, value.length);
    for (const item of value) encodeInto(w, item);
    return;
  }

  if (value !== null && typeof value === "object") {
    // Sorted keys keep the encoding canonical.
    const keys = Object.keys(value).sort();
    w.head(MAJOR_MAP, keys.length);
    for (const k of keys) {
      encodeInto(w, k);
      encodeInto(w, value[k] as CborValue);
    }
    return;
  }

  throw new Error(`cannot encode value of type ${typeof value}`);
}

export function encodeCbor(value: CborValue): Uint8Array {
  const w = new Writer();
  encodeInto(w, value);
  return w.finish();
}

/* ------------------------------------------------------------------ decode */

class Reader {
  /* Explicit fields rather than constructor parameter properties: those are a
   * TypeScript-only construct needing code generation, which blocks Node's
   * native type stripping. Same reason FrameType is a const object. */
  private readonly buf: Uint8Array;
  pos: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.pos = 0;
  }

  byte(): number {
    const b = this.buf[this.pos];
    if (b === undefined) throw new Error("truncated CBOR");
    this.pos++;
    return b;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error("truncated CBOR");
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Read the argument that follows a type byte. */
  argument(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return (this.byte() << 8) | this.byte();
    if (info === 26) {
      return (
        this.byte() * 0x1000000 +
        (this.byte() << 16) +
        (this.byte() << 8) +
        this.byte()
      );
    }
    if (info === 27) throw new Error("64-bit CBOR arguments are not supported");
    if (info === 31) throw new Error("indefinite-length CBOR is not supported");
    throw new Error(`reserved CBOR additional info ${info}`);
  }
}

function decodeFrom(r: Reader, depth: number): CborValue {
  // Nesting is bounded so a hostile payload cannot exhaust the stack.
  if (depth > 8) throw new Error("CBOR nesting too deep");

  const initial = r.byte();
  const major = initial >> 5;
  const info = initial & 0x1f;
  const arg = r.argument(info);

  switch (major) {
    case MAJOR_UINT:
      return arg;
    case MAJOR_NEGINT:
      return -arg - 1;
    case MAJOR_BYTES:
      return r.take(arg);
    case MAJOR_TEXT:
      return new TextDecoder("utf-8", { fatal: true }).decode(r.take(arg));
    case MAJOR_ARRAY: {
      const out: CborValue[] = [];
      for (let i = 0; i < arg; i++) out.push(decodeFrom(r, depth + 1));
      return out;
    }
    case MAJOR_MAP: {
      const out: { [k: string]: CborValue } = {};
      for (let i = 0; i < arg; i++) {
        const key = decodeFrom(r, depth + 1);
        if (typeof key !== "string") {
          throw new Error("CBOR map keys must be text strings");
        }
        out[key] = decodeFrom(r, depth + 1);
      }
      return out;
    }
    default:
      throw new Error(`unsupported CBOR major type ${major}`);
  }
}

export function decodeCbor(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const value = decodeFrom(r, 0);
  // Trailing bytes mean the sender and receiver disagree about the message.
  if (r.pos !== bytes.length) {
    throw new Error(`${bytes.length - r.pos} trailing bytes after CBOR value`);
  }
  return value;
}
