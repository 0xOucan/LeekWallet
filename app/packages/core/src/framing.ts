/**
 * Wire framing for the LeekWallet protocol.
 *
 * Frame layout, per docs/PROTOCOL.md section 2:
 *
 *   ┌────────┬────────┬──────────────────────┐
 *   │ len:u16│ type:u8│ payload              │
 *   └────────┴────────┴──────────────────────┘
 *
 * `len` is big-endian and covers type + payload.
 *
 * Transport-blind by design: USB CDC writes frames directly, BLE adds the
 * chunking layer below. Everything above this file is identical on both.
 */

export const MAX_FRAME_BYTES = 4096;

/* A const object rather than an enum: `enum` needs code generation, so it
 * blocks Node's native type stripping and bloats the bundle. This erases to
 * nothing and tree-shakes. */
export const FrameType = {
  Request: 0x01,
  Response: 0x02,
  EncryptedRequest: 0x11,
  EncryptedResponse: 0x12,
  Event: 0x13,
  Error: 0x7f,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const length = payload.length + 1; // type byte is counted
  if (length + 2 > MAX_FRAME_BYTES) {
    throw new Error(`frame of ${length + 2} bytes exceeds ${MAX_FRAME_BYTES}`);
  }

  const out = new Uint8Array(length + 2);
  out[0] = (length >> 8) & 0xff;
  out[1] = length & 0xff;
  out[2] = type;
  out.set(payload, 3);
  return out;
}

export interface DecodedFrame {
  type: FrameType;
  payload: Uint8Array;
}

/**
 * Incremental decoder. Transports deliver arbitrary chunk boundaries — a serial
 * read can split a frame or carry two — so bytes accumulate here until whole
 * frames can be handed off.
 */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): DecodedFrame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames: DecodedFrame[] = [];

    for (;;) {
      if (this.buffer.length < 3) break;

      const hi = this.buffer[0];
      const lo = this.buffer[1];
      if (hi === undefined || lo === undefined) break;
      const length = (hi << 8) | lo;

      // Reject before allocating. A signing device must never let the peer
      // dictate a buffer size, and neither should its client.
      if (length + 2 > MAX_FRAME_BYTES || length < 1) {
        this.buffer = new Uint8Array(0);
        throw new Error(`invalid frame length ${length}`);
      }

      if (this.buffer.length < length + 2) break; // incomplete, wait for more

      frames.push({
        type: (this.buffer[2] ?? 0) as FrameType,
        payload: this.buffer.slice(3, length + 2),
      });
      this.buffer = this.buffer.slice(length + 2);
    }

    return frames;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  get pending(): number {
    return this.buffer.length;
  }
}

/* ------------------------------------------------------------ BLE chunking */

/**
 * BLE GATT writes are capped at MTU-3, so frames are split with a one-byte
 * header: bit 7 signals "more follows", bits 0-6 carry a sequence number.
 * USB CDC skips this entirely.
 */
export const CHUNK_HEADER_MORE = 0x80;
export const CHUNK_SEQ_MASK = 0x7f;

export function chunkForBle(frame: Uint8Array, mtu: number): Uint8Array[] {
  const capacity = mtu - 3 - 1; // ATT overhead, then our chunk header
  if (capacity < 1) throw new Error(`MTU ${mtu} is too small`);

  const chunks: Uint8Array[] = [];
  for (let offset = 0, seq = 0; offset < frame.length; offset += capacity, seq++) {
    const slice = frame.slice(offset, offset + capacity);
    const more = offset + capacity < frame.length;
    const chunk = new Uint8Array(slice.length + 1);
    chunk[0] = (more ? CHUNK_HEADER_MORE : 0) | (seq & CHUNK_SEQ_MASK);
    chunk.set(slice, 1);
    chunks.push(chunk);
  }
  return chunks;
}

/** Reassembles BLE chunks, verifying sequence continuity. */
export class ChunkReassembler {
  private parts: Uint8Array[] = [];
  private expectedSeq = 0;

  push(chunk: Uint8Array): Uint8Array | null {
    const header = chunk[0];
    if (header === undefined) throw new Error("empty chunk");

    const seq = header & CHUNK_SEQ_MASK;
    const more = (header & CHUNK_HEADER_MORE) !== 0;

    if (seq !== this.expectedSeq) {
      this.reset();
      throw new Error(`out-of-order chunk: expected ${this.expectedSeq}, got ${seq}`);
    }

    this.parts.push(chunk.slice(1));
    this.expectedSeq = (this.expectedSeq + 1) & CHUNK_SEQ_MASK;

    if (more) return null;

    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of this.parts) {
      out.set(p, offset);
      offset += p.length;
    }
    this.reset();
    return out;
  }

  reset(): void {
    this.parts = [];
    this.expectedSeq = 0;
  }
}
