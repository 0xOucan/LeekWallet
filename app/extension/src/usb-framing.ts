/**
 * USB framing for the LeekWallet protocol.
 *
 * The device speaks TWO wire formats, and which one you get depends on the
 * link:
 *
 *   USB   'L' 'K' | len:u16 | type | CBOR      src/protocol.c:16
 *   BLE           | len:u16 | type | payload   packages/core/src/framing.ts
 *
 * They differ because the links differ. On USB the protocol shares one stream
 * with the ESP-IDF console — `sdkconfig.defaults` puts the console on
 * USB-Serial-JTAG — so a receiver needs a marker to find a frame among log
 * text, and needs to be able to resynchronise when it loses one. BLE carries
 * the protocol on its own characteristic with nothing else in it, so no marker
 * is needed there and none is sent.
 *
 * This file is the USB half, in TypeScript, mirroring
 * `app/transport-serial/src/wire.rs`. It exists because the extension is the
 * only TypeScript that ever talks USB: the desktop companion reaches serial
 * through Rust, so `framing.ts` — the BLE format — was the only one this
 * language had, and the extension imported it. That is the bug this replaces.
 * Reading two bytes of `I (1234) tag:` as a big-endian length is where
 * "invalid frame length 18720" came from: 18720 is 0x4920, ASCII "I ".
 *
 * `len` is big-endian and covers the type byte plus the payload — NOT the
 * marker and not itself.
 */

/** The two bytes that mark the start of a frame. `LK`, for LeekWallet. */
const SYNC = Uint8Array.of(0x4c, 0x4b); // 'L', 'K'

/** Matches MAX_FRAME in wire.rs and PROTOCOL.md. */
export const MAX_USB_FRAME = 4096;

/**
 * How much unparsed noise to keep before dropping the oldest.
 *
 * Console text between frames is normal, so the buffer must tolerate some;
 * without a cap a device that logged steadily and never framed would grow it
 * without bound.
 */
const MAX_BUFFER = MAX_USB_FRAME * 4;

export class UsbFrameError extends Error {}

/** Serialise one frame, ready to be written to the port. */
export function encodeUsbFrame(frameType: number, payload: Uint8Array): Uint8Array {
  const body = payload.length + 1; // the type byte counts toward the length
  if (body + 4 > MAX_USB_FRAME) {
    throw new UsbFrameError(`${body} bytes is over the ${MAX_USB_FRAME} cap`);
  }
  const out = new Uint8Array(body + 4);
  out.set(SYNC, 0);
  out[2] = (body >> 8) & 0xff;
  out[3] = body & 0xff;
  out[4] = frameType & 0xff;
  out.set(payload, 5);
  return out;
}

/**
 * Pulls frames out of a byte stream that also carries console text.
 *
 * The contract is the same as the Rust decoder's: feed whatever arrived, then
 * ask for frames until it says there are none. "None" always means "not yet",
 * never "never" — the caller loops against its own deadline.
 */
/** One decoded frame, in the same shape the BLE decoder yields. */
export interface DecodedUsbFrame {
  type: number;
  payload: Uint8Array;
}

export class UsbFrameDecoder {
  private buffer = new Uint8Array(0);

  /** Add bytes just read from the device. */
  push(bytes: Uint8Array): DecodedUsbFrame[] {
    if (bytes.length > 0) {
      const joined = new Uint8Array(this.buffer.length + bytes.length);
      joined.set(this.buffer, 0);
      joined.set(bytes, this.buffer.length);
      this.buffer = joined;
      if (this.buffer.length > MAX_BUFFER) {
        /* Drop the oldest. Anything that old is either console text or a frame
         * we already failed to complete. */
        this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER);
      }
    }

    const frames: DecodedUsbFrame[] = [];
    for (;;) {
      const frame = this.next();
      if (frame === null) return frames;
      frames.push(frame);
    }
  }

  /** Forget everything buffered. */
  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  /**
   * One frame, split into type and payload — the shape the caller already
   * expects from the BLE decoder, so nothing above this changes.
   */
  private next(): DecodedUsbFrame | null {
    for (;;) {
      /* Console output shares this stream, so leading text is expected. With
       * no marker present, keep the final byte: it may be the 'L' of a marker
       * whose 'K' has not arrived yet. */
      let start = -1;
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === SYNC[0] && this.buffer[i + 1] === SYNC[1]) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        /* Keep the LAST byte, always. It may be the 'L' of a marker whose 'K'
         * has not arrived yet, and a read really can split a two-byte marker —
         * dropping it loses the frame behind it and every frame after, because
         * the scan never finds a marker again. */
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 1));
        return null;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 4) return null;

      const body = ((this.buffer[2] as number) << 8) | (this.buffer[3] as number);
      if (body < 1 || body + 4 > MAX_USB_FRAME) {
        /* Not a length we would send. Drop the marker and rescan rather than
         * trusting it and waiting for ever for bytes that are not coming. */
        this.buffer = this.buffer.slice(2);
        continue;
      }
      if (this.buffer.length < body + 4) return null;

      const type = this.buffer[4] as number;
      const payload = this.buffer.slice(5, body + 4);
      this.buffer = this.buffer.slice(body + 4);
      return { type, payload };
    }
  }
}
