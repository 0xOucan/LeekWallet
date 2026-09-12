/**
 * The request/response client, lifted from `app/src/main.ts` and stripped of
 * its UI.
 *
 * This is the one piece of the desktop app that is duplicated rather than
 * imported, and it is worth being honest about why: in `main.ts` the `Client`
 * class is entangled with the DOM — it calls `log()`, it calls
 * `setConnection()`, it flips a status bar. Importing it here would drag a
 * document into a context that sometimes does not have one. Extracting it into
 * `@leekwallet/core` would be the right long-term answer and would change a
 * file the brief for this work says not to touch, so the duplication is
 * deliberate, marked, and small.
 *
 * What is NOT duplicated: framing, CBOR, the X25519 handshake, the key
 * schedule, the passkey derivation, the nonce discipline. All of that is
 * `packages/core`, imported. The logic below is the ordering around it, and
 * every rule it enforces was learned against hardware:
 *
 *   - Requests are serialised, because the link has no request ids and a reply
 *     belongs to whichever request went out last. Two in flight means each
 *     resolves the other's promise and the session counters drift apart.
 *
 *   - The handshake is commit-then-reveal and every check in it aborts rather
 *     than degrades. A handshake that "worked except for the commitment" is
 *     the v1 handshake a relay ground through offline in 91 seconds.
 *
 *   - A send that throws kills the session. The device may still have
 *     processed the request, so its counters have moved and ours have not, and
 *     every later frame would fail to decrypt with nothing to say why.
 *
 *   - `waitForApproval` polls with an ENCRYPTED call, because a plaintext
 *     success would report a channel that was never established.
 */

import { encodeCbor, decodeCbor, type CborValue } from "../../packages/core/src/cbor.ts";
import { FrameType } from "../../packages/core/src/framing.ts";
/* USB framing, not the BLE framing in core/framing.ts. The device marks every
 * USB frame with 'L' 'K' because the protocol shares that stream with the
 * ESP-IDF console; BLE has a characteristic to itself and sends no marker.
 * This client is the only TypeScript that speaks USB, which is how it came to
 * import the wrong one. See usb-framing.ts. */
import { encodeUsbFrame, UsbFrameDecoder } from "./usb-framing.ts";
import { DeviceError, ErrorCode, type Transport } from "../../packages/core/src/transport.ts";
import {
  Session, deriveSession, generateKeypair, generateNonce, verifyCommitment,
  PROTOCOL_VERSION, NONCE_BYTES, COMMIT_BYTES,
} from "../../packages/core/src/session.ts";

export { PROTOCOL_VERSION };

export class DeviceClient {
  private readonly transport: Transport;
  private readonly decoder = new UsbFrameDecoder();
  private pending: ((v: { ok?: Record<string, CborValue>; err?: DeviceError }) => void) | null = null;
  /** Established after the handshake; null while everything is plaintext. */
  private session: Session | null = null;
  /** Serialises requests; see call(). */
  private queue: Promise<void> = Promise.resolve();
  /** True during waitForApproval, when a plaintext 0x0400 means "not yet". */
  private awaitingApproval = false;
  private readonly log: (line: string) => void;

  constructor(transport: Transport, log: (line: string) => void) {
    this.transport = transport;
    this.log = log;
    this.transport.onFrame((frame) => {
      let frames;
      try {
        frames = this.decoder.push(frame);
      } catch (e) {
        /* A bad length prefix is not something to resynchronise from. The
         * decoder has already dropped its buffer; failing the outstanding call
         * is what stops the next reply being matched to the wrong request. */
        const resolve = this.pending;
        this.pending = null;
        resolve?.({ err: new DeviceError(ErrorCode.MalformedFrame, String((e as Error).message)) });
        return;
      }

      for (const f of frames) {
        let payload = f.payload;

        const encrypted =
          f.type === FrameType.EncryptedResponse || f.type === FrameType.EncryptedError;

        /* An encrypted frame with no session to open it is ciphertext, and
         * ciphertext parsed as CBOR is noise — "unsupported major type 7",
         * "trailing bytes", whatever the random bytes happen to spell. Say
         * what actually happened instead of reporting the shape of the
         * garbage. */
        if (encrypted && !this.session) {
          const resolve = this.pending;
          this.pending = null;
          resolve?.({ err: new DeviceError(
            ErrorCode.SessionRequired,
            "the device replied encrypted but this side has no session; reconnect",
          ) });
          continue;
        }

        if (encrypted && this.session) {
          try {
            payload = this.session.decrypt(payload);
          } catch {
            this.killSession("a reply failed authentication");
            const resolve = this.pending;
            this.pending = null;
            resolve?.({ err: new DeviceError(0x0400, "authentication failed") });
            continue;
          }
        }

        let body: Record<string, CborValue>;
        try {
          body = decodeCbor(payload) as Record<string, CborValue>;
        } catch (e) {
          const resolve = this.pending;
          this.pending = null;
          resolve?.({ err: new DeviceError(
            ErrorCode.MalformedFrame,
            `could not decode the device's reply: ${String((e as Error).message)}`,
          ) });
          continue;
        }

        const resolve = this.pending;
        this.pending = null;
        if (!resolve) continue;

        if (f.type === FrameType.Error || f.type === FrameType.EncryptedError) {
          const code = Number(body["code"]);
          /* 0x0400 in PLAINTEXT after a session existed means the device threw
           * the session away — session_decrypt() resets on a failed tag, and a
           * failed tag is indistinguishable from an attack, so failing closed
           * there is right. But it leaves this side holding keys the device
           * has forgotten.
           *
           * Not while waiting for the button, though. A device that has not
           * been confirmed yet answers exactly this, in plaintext, every time
           * it is polled — it means "not yet", not "your session is gone". */
          if (code === ErrorCode.SessionRequired && f.type === FrameType.Error &&
              !this.awaitingApproval) {
            this.killSession("the device ended the session");
          }
          resolve({ err: new DeviceError(code, String(body["message"])) });
        } else {
          resolve({ ok: body["result"] as Record<string, CborValue> });
        }
      }
    });
  }

  /**
   * Send one request and await its reply, one at a time.
   *
   * The link has no request IDs, so a reply belongs to whichever request went
   * out last. With anything else in flight — a status poll, a second dapp —
   * each would resolve the other's promise, and because the nonce counter
   * advances on a completed exchange the two ends then drift apart and every
   * later frame fails.
   *
   * In this extension the risk is higher than in the desktop app, not lower:
   * any number of tabs can be talking to the same device through the same
   * offscreen document, and none of them knows the others exist. This queue is
   * the only thing standing between two dapps and a wedged session.
   */
  async call(
    method: string,
    params: Record<string, CborValue> = {},
    timeoutMs = 5000,
  ): Promise<Record<string, CborValue>> {
    const mine = this.queue.then(() => this.callNow(method, params, timeoutMs));
    // Keep the chain alive even when a call rejects, or one failure wedges
    // every request that follows.
    this.queue = mine.then(() => undefined, () => undefined);
    return mine;
  }

  private async callNow(
    method: string,
    params: Record<string, CborValue> = {},
    timeoutMs = 5000,
  ): Promise<Record<string, CborValue>> {
    /* Waiting longer than the device does is the only safe direction. If this
     * side gives up first, the device still processes the request and replies
     * to nobody: its counters move, ours do not, and the session is
     * unrecoverable. That is not a timeout, it is a broken connection with a
     * misleading message. */
    const t = this.transport as { timeoutMs?: number };
    if ("timeoutMs" in t) t.timeoutMs = timeoutMs;

    const reply = new Promise<{ ok?: Record<string, CborValue>; err?: DeviceError }>((r) => {
      this.pending = r;
    });

    /* Flat, per PROTOCOL.md section 4: fields sit beside `method` rather than
     * inside a `params` object. The firmware looks for them at the top level,
     * so a nested request would have had its arguments silently ignored. */
    const body = encodeCbor({ method, ...params });
    const [type, payload] = this.session?.isActive
      ? [FrameType.EncryptedRequest, this.session.encrypt(body)]
      : [FrameType.Request, body];

    try {
      await this.transport.send(encodeUsbFrame(type, payload));
    } catch (e) {
      this.session = null;
      this.pending = null;
      throw new Error(
        `${(e as Error).message}. The session is no longer usable; disconnect and reconnect.`,
      );
    }

    /* The deadline lives here rather than in the transport because Web Serial
     * has no per-read timeout to hand it to, and a promise that never settles
     * is a popup that says "waiting for the device" for ever. Losing the race
     * still poisons the session — see above — so this rejects AND kills it,
     * rather than pretending the next call can carry on. */
    const timer = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(
        `the device did not answer within ${timeoutMs}ms; disconnect and reconnect`,
      )), timeoutMs);
    });

    let settled: { ok?: Record<string, CborValue>; err?: DeviceError };
    try {
      settled = await Promise.race([reply, timer]);
    } catch (e) {
      this.pending = null;
      this.session = null;
      throw e;
    }
    if (settled.err) throw settled.err;
    return settled.ok ?? {};
  }

  /**
   * Run the commit-then-reveal handshake and return the passkey to compare.
   *
   * Two round trips, and the order is the security property rather than a
   * formality. The device commits to its nonce in `hello`; only then does this
   * side reveal its own in `helloReveal`; only then does the device reveal the
   * nonce it committed to. Neither end could have chosen its contribution
   * after seeing the other's, so a relay between them cannot search for a
   * value that makes both screens agree — it is down to one online guess at
   * 1 in 10^6, which is a mismatch the user sees.
   */
  /**
   * @param helloTimeoutMs How long to wait for the FIRST reply.
   *
   * Its own parameter, and much longer than the 5000ms default, because this
   * call is the one that can land while a person is busy with the board.
   * Opening the port resets the ESP32-S3 (see serial-transport.ts), so the
   * device comes back at its PIN screen and `hello` arrives while the user is
   * still typing — and a PIN takes longer than five seconds. Timing out there
   * reports "the device did not answer" about a device that is working
   * perfectly and waiting for its owner.
   */
  async handshake(helloTimeoutMs = 90_000): Promise<string> {
    const { privateKey, publicKey } = generateKeypair();
    const ack = await this.call("hello", {
      version: PROTOCOL_VERSION,
      hostPubkey: publicKey,
    }, helloTimeoutMs);

    const theirVersion = ack["version"];
    if (theirVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `this extension speaks protocol v${PROTOCOL_VERSION}; the device answered ` +
        `v${typeof theirVersion === "number" ? theirVersion : "none"} — update the older one`,
      );
    }

    const devicePubkey = ack["devicePubkey"];
    if (!(devicePubkey instanceof Uint8Array) || devicePubkey.length !== 32) {
      throw new Error("device did not return a public key");
    }
    const deviceCommit = ack["deviceCommit"];
    if (!(deviceCommit instanceof Uint8Array) || deviceCommit.length !== COMMIT_BYTES) {
      throw new Error("device did not commit to a nonce");
    }

    const hostNonce = generateNonce();
    const revealed = await this.call("helloReveal", { hostNonce });

    const deviceNonce = revealed["deviceNonce"];
    if (!(deviceNonce instanceof Uint8Array) || deviceNonce.length !== NONCE_BYTES) {
      throw new Error("device did not reveal its nonce");
    }

    /* The check that makes the commitment worth having. Failing it means the
     * nonce was chosen after the device saw ours, which is the whole attack —
     * so this is a refusal, never a warning. */
    if (!verifyCommitment(deviceCommit, devicePubkey, publicKey, deviceNonce)) {
      throw new Error(
        "the device's nonce does not match what it committed to — refusing to " +
        "pair; something is relaying this connection",
      );
    }

    this.session = new Session(
      deriveSession(privateKey, devicePubkey, {
        hostPublic: publicKey,
        devicePublic: devicePubkey,
        hostNonce,
        deviceNonce,
      }),
      "host",
    );
    return this.session.passkey;
  }

  /**
   * Wait for the user to compare the passkey and press the button.
   *
   * There is no "confirmed" message to wait for: the device simply starts
   * accepting encrypted traffic once the button is pressed. So this tries an
   * encrypted call until one succeeds, which is both the check and the first
   * real use of the channel.
   */
  async waitForApproval(timeoutMs = 60000): Promise<void> {
    if (!this.session) throw new Error("no handshake");
    this.session.confirm();
    this.awaitingApproval = true;
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (!this.session) {
          throw new Error("the session was lost while waiting for confirmation");
        }
        try {
          /* getStatus answers in plaintext too, so a plaintext success here
           * would report a channel that was never established. It is
           * encrypted because `this.session.isActive` is now true. */
          await this.call("getStatus");
          return;
        } catch {
          if (Date.now() > deadline) {
            throw new Error("timed out waiting for confirmation on the device");
          }
          await new Promise((r) => setTimeout(r, 750));
        }
      }
    } finally {
      this.awaitingApproval = false;
    }
  }

  /**
   * Forget the session. The next call goes out in plaintext and is refused,
   * which is the honest outcome: there is no channel until a new handshake,
   * and quietly re-establishing one would skip the passkey comparison that
   * makes the channel worth anything.
   */
  private killSession(why: string): void {
    if (!this.session) return;
    this.session = null;
    this.log(`session ended — ${why}. Reconnect to compare a new passkey.`);
  }

  get encrypted(): boolean {
    return this.session?.isActive ?? false;
  }
}
