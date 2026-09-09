/**
 * A `Transport` over Web Serial.
 *
 * This is the whole of what the extension adds to the protocol. Everything
 * above it — framing, CBOR, the X25519 handshake, the session, the address
 * derivation, the refusals — is `@leekwallet/core` unchanged, because
 * `Transport` is deliberately two methods wide (`send` and `onFrame`) and a
 * link that can move bytes in both directions is a complete implementation of
 * it. The desktop app hands the same interface to Rust and the Android build
 * hands it to BLE; this hands it to `navigator.serial`. Nothing else in the
 * stack knows or needs to know which.
 *
 * WHERE THIS RUNS, AND WHY IT MATTERS
 *
 * In the offscreen document, and only there. An MV3 service worker is torn
 * down after roughly thirty seconds of idle and cannot own a resource that has
 * to outlive that — a `SerialPort` held by a worker that is about to be
 * evicted is a port that closes mid-signature. See background.ts for the full
 * argument.
 *
 * Two smaller decisions that cost time to learn:
 *
 * - `port.readable` is replaced when the port is reopened, so the read loop
 *   captures the reader it started with and stops when that one ends, rather
 *   than reaching for `this.port.readable` on each iteration and quietly
 *   reading from a stream that belongs to a later connection.
 *
 * - `reader.cancel()` is what unblocks a pending `read()`. Closing the port
 *   without it hangs, because `close()` waits for the streams to be released
 *   and the read loop is still holding one.
 *
 * - DTR/RTS are explicitly deasserted right after `open()`. This is the fix
 *   for the "did not answer within 5000ms" defect: Web Serial does not
 *   specify a default signal state, and on the platform serial backends
 *   Chromium sits on top of, opening a port commonly raises DTR as a side
 *   effect of the OS-level open call. On the ESP32-S3's USB-Serial-JTAG
 *   peripheral that toggle is wired to the chip's reset line, so the very act
 *   of opening the port reboots the device — it never gets to answer `hello`
 *   within the 5 s the handshake allows, because it is still coming back up.
 *   The Rust desktop transport (`app/transport-serial/src/transport.rs`)
 *   already documents and avoids exactly this for the same hardware
 *   (`.dtr_on_open(false)`); this is that same fix, expressed the way Web
 *   Serial requires it — asserted low immediately after `open()`, since the
 *   API gives no way to suppress the initial toggle itself.
 */

import type { Transport } from "../../packages/core/src/transport.ts";

/**
 * USB CDC-ACM ignores the line rate — there is no UART on the other side of an
 * ESP32-S3's USB-serial-JTAG peripheral for it to configure. Web Serial
 * requires the field anyway, so it is set to the value the Android transport
 * uses, for no reason beyond keeping the two implementations readable side by
 * side.
 */
const BAUD_RATE = 115200;

/**
 * How long to drain the line, in plaintext-boot-noise mode, after opening.
 *
 * Matches `app/transport-serial/src/transport.rs`'s 250ms sleep-then-clear: if
 * opening the port reset the device, this is enough for the reboot's stray
 * bytes (if any) to have arrived and be discarded before the handshake sends
 * anything the device would otherwise never see or reply to in time.
 */
const SETTLE_MS = 250;

export class SerialTransport implements Transport {
  readonly kind = "usb" as const;
  readonly label: string;

  /**
   * How long the client is currently willing to wait.
   *
   * Written by `Client` before every call — it probes transports for this
   * field — and never read here, because Web Serial has no per-read deadline
   * to hand it to. Kept anyway so the probe finds what it expects and so a
   * reader of the transport can see that the deadline is the caller's, not
   * this layer's. The alternative, silently swallowing the write onto an
   * object that has no such property, is how a timeout goes missing.
   */
  timeoutMs = 5000;

  private readonly port: SerialPort;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private handler: ((frame: Uint8Array) => void) | null = null;
  private opened = false;
  /** Called when the link dies underneath us — an unplug, or a stream error. */
  private readonly onClosed: (why: string) => void;

  constructor(port: SerialPort, label: string, onClosed: (why: string) => void) {
    this.port = port;
    this.label = label;
    this.onClosed = onClosed;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await this.port.open({ baudRate: BAUD_RATE });
    if (!this.port.readable || !this.port.writable) {
      await this.port.close().catch(() => {});
      throw new Error("the serial port opened without readable and writable streams");
    }
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.opened = true;

    /* See the file header. Deasserted as early as the API allows — Web Serial
     * only exposes `setSignals()` on an already-open port, so this cannot
     * prevent a reset the open() call itself triggered, only stop the port
     * from sitting there asserted afterwards. Best-effort: not every backend
     * implements it, and failure here is not a reason to fail the connection
     * over two lines this device does not even use for flow control. */
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      /* Nothing to do about it; see above. */
    }

    await this.settle(this.reader);
    void this.pump(this.reader);
  }

  /**
   * Drain and discard whatever lands in the first `SETTLE_MS`.
   *
   * Nothing has been sent yet, so anything read here cannot be a reply to a
   * request — it is boot noise from a reset `open()` may have just caused, or
   * simply nothing at all. Feeding it to the frame decoder instead would risk
   * failing the very first real exchange on a malformed-frame error that has
   * nothing to do with the device's actual answer.
   */
  private async settle(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const deadline = Date.now() + SETTLE_MS;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const timedOut = Symbol("settle-timeout");
      const timer = new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => resolve(timedOut), remaining);
      });
      let result;
      try {
        result = await Promise.race([reader.read(), timer]);
      } catch {
        // The port errored before anything was ever sent; the real pump loop
        // below will hit the same error and report it properly.
        return;
      }
      if (result === timedOut || result.done) return;
      // Discard result.value and keep draining until the window closes.
    }
  }

  /**
   * The read loop.
   *
   * Chunk boundaries are meaningless here — a USB read can split a frame down
   * the middle or carry two of them — so nothing in this function tries to
   * interpret what it received. Reassembly is `FrameDecoder`'s job, one layer
   * up, where it is already written and already tested.
   */
  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) this.handler?.(value);
      }
      this.fail("the device closed the connection");
    } catch (e) {
      /* An unplug surfaces here as a stream error, and it is not recoverable:
       * the session's counters are bound to a channel that no longer exists.
       * Report it and let the layer above throw the session away rather than
       * retrying into a link that is gone. */
      this.fail((e as Error)?.message ?? "the serial link failed");
    }
  }

  private fail(why: string): void {
    if (!this.opened) return;
    this.opened = false;
    this.onClosed(why);
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!this.opened || !this.writer) throw new Error("the serial port is not open");
    await this.writer.write(frame);
  }

  onFrame(handler: (frame: Uint8Array) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.opened = false;
    /* Order matters. Cancelling the reader is what unblocks the pending
     * `read()` in `pump`; without it `port.close()` waits for a stream lock
     * that nothing is ever going to release. */
    try {
      await this.reader?.cancel();
    } catch {
      /* Already errored out. Nothing to release. */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* Ditto. */
    }
    try {
      await this.writer?.close();
    } catch {
      /* A writer on a vanished device rejects; the port still has to close. */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* Ditto. */
    }
    this.reader = null;
    this.writer = null;
    try {
      await this.port.close();
    } catch {
      /* Unplugged mid-close. The port object is dead either way. */
    }
  }
}

/**
 * A short human label for a port.
 *
 * Web Serial deliberately exposes almost nothing — vendor and product IDs and
 * nothing else — because a richer identity would be a fingerprinting surface.
 * That is the right trade and it means the label cannot be more specific than
 * this. It is a label, not an identification: what proves the thing on the
 * other end is a LeekWallet is the handshake and the passkey on its screen.
 */
export function portLabel(port: SerialPort): string {
  const info = port.getInfo();
  const vendor = info.usbVendorId;
  const product = info.usbProductId;
  if (vendor === undefined) return "Serial port";
  const hex = (n: number): string => n.toString(16).padStart(4, "0");
  return product === undefined
    ? `USB ${hex(vendor)}`
    : `USB ${hex(vendor)}:${hex(product)}`;
}
