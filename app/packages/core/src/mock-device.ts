/**
 * In-process mock of the LeekWallet firmware.
 *
 * Implements the wire protocol from docs/PROTOCOL.md faithfully enough that the
 * companion app can be built, demoed and tested with no hardware attached — the
 * single highest-leverage thing for parallel work, since UI development stops
 * waiting on firmware.
 *
 * It is a protocol mock, not a wallet: derivation is deterministic nonsense and
 * signatures are not real. Anything that needs true BIP32 or secp256k1 belongs
 * on hardware or in the C host suite, which already has both.
 *
 * The parts modelled carefully are the ones that catch UI bugs: permission
 * tiers, the confirmation round-trip, user rejection, and the fact that the
 * device is slow. A mock that answers instantly hides every missing spinner.
 */

import { encodeCbor, decodeCbor, type CborValue } from "./cbor.ts";
import { encodeFrame, FrameDecoder, FrameType } from "./framing.ts";
import { ErrorCode, type Transport } from "./transport.ts";
import { describeCall, isDecodable } from "./eth-decode.ts";

export interface MockOptions {
  /** Milliseconds each command takes. Real key derivation costs ~1 s. */
  latencyMs?: number;
  /** Auto-approve confirmations. Set false to exercise the rejection path. */
  autoApprove?: boolean;
  /** Start already unlocked, skipping the PIN prompt. */
  startUnlocked?: boolean;
  /** How many seeds the device holds. */
  walletCount?: number;
}

type Handler = (params: Record<string, CborValue>) => CborValue;

const DEVICE_LABEL = "LeekWallet (mock)";

export class MockDevice implements Transport {
  readonly kind = "mock" as const;
  readonly label = DEVICE_LABEL;

  private opened = false;
  private sessionEstablished = false;
  private unlocked: boolean;
  private handler: ((frame: Uint8Array) => void) | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly opts: Required<MockOptions>;

  private activeWallet = 1;
  private passphraseActive = false;

  /** Requests the device is "showing" — inspect in tests. */
  readonly confirmations: string[] = [];

  /** Test hook: simulate the device auto-locking on its idle timer. */
  autoLock(): void {
    this.unlocked = false;
    this.passphraseActive = false;
  }

  constructor(options: MockOptions = {}) {
    this.opts = {
      latencyMs: options.latencyMs ?? 0,
      autoApprove: options.autoApprove ?? true,
      startUnlocked: options.startUnlocked ?? false,
      walletCount: options.walletCount ?? 1,
    };
    this.unlocked = this.opts.startUnlocked;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    this.opened = true;
    this.sessionEstablished = false;
    this.decoder.reset();
  }

  async close(): Promise<void> {
    this.opened = false;
    this.sessionEstablished = false;
    // Disconnect clears session secrets, as the firmware does.
    this.passphraseActive = false;
  }

  onFrame(handler: (frame: Uint8Array) => void): void {
    this.handler = handler;
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!this.opened) throw new Error("transport is not open");

    for (const decoded of this.decoder.push(frame)) {
      const reply = this.dispatch(decoded.type, decoded.payload);
      if (this.opts.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, this.opts.latencyMs));
      }
      this.handler?.(reply);
    }
  }

  /* ------------------------------------------------------------ dispatch */

  private dispatch(type: number, payload: Uint8Array): Uint8Array {
    let request: CborValue;
    try {
      request = decodeCbor(payload);
    } catch {
      return this.error(ErrorCode.MalformedFrame, "undecodable CBOR");
    }

    // Uint8Array is also `typeof "object"`, so exclude it explicitly or the
    // map access below is unsound.
    if (
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request) ||
      request instanceof Uint8Array
    ) {
      return this.error(ErrorCode.MalformedFrame, "request must be a map");
    }

    const map = request as Record<string, CborValue>;
    const method = map["method"];
    if (typeof method !== "string") {
      return this.error(ErrorCode.MalformedFrame, "missing method");
    }
    /* Fields are top-level, beside `method` - the same shape the firmware
     * parses. Reading them from a nested `params` object would let the mock
     * accept requests real hardware ignores. */
    const params = map;

    // Session must be established before anything encrypted.
    const preSession = method === "hello" || method === "getFeatures";
    if (!preSession && !this.sessionEstablished) {
      return this.error(ErrorCode.SessionRequired, "no session");
    }

    const handler = this.handlers[method];
    if (!handler) {
      return this.error(ErrorCode.MalformedFrame, `unknown method ${method}`);
    }

    try {
      return this.ok(handler(params), type === FrameType.Request);
    } catch (e) {
      if (e instanceof MockRejection) return this.error(e.code, e.message);
      throw e;
    }
  }

  private requireUnlocked(): void {
    if (!this.unlocked) throw new MockRejection(ErrorCode.NotUnlocked, "device is locked");
  }

  /** Model the confirm-on-device round trip, including refusal. */
  private confirm(description: string): void {
    this.confirmations.push(description);
    if (!this.opts.autoApprove) {
      throw new MockRejection(ErrorCode.UserRejected, "rejected on device");
    }
  }

  private readonly handlers: Record<string, Handler> = {
    hello: () => {
      this.sessionEstablished = true;
      // A real device shows a passkey here; the mock reports a fixed one so
      // the pairing UI has something to render.
      return { version: 1, deviceId: "mock-0001", passkey: "314159" };
    },

    getFeatures: () => ({
      model: "LeekWallet-mock",
      firmware: "0.1.0-mock",
      initialized: 1,
      blindSigning: 0,
    }),

    getStatus: () => ({
      unlocked: this.unlocked ? 1 : 0,
      walletCount: this.opts.walletCount,
      activeWallet: this.activeWallet,
      passphrase: this.passphraseActive ? 1 : 0,
    }),

    unlock: () => {
      // The PIN is entered on the device, never sent. This just prompts.
      this.confirm("Enter PIN on device");
      this.unlocked = true;
      return { unlocked: 1 };
    },

    lock: () => {
      this.unlocked = false;
      /* The passphrase dies with the session, as it does on the device. A host
       * that kept deriving addresses from it would be showing a wallet the
       * device can no longer produce. */
      this.passphraseActive = false;
      return {};
    },

    selectWallet: (p) => {
      this.requireUnlocked();
      const index = Number(p["index"] ?? 1);
      if (index < 1 || index > this.opts.walletCount) {
        throw new MockRejection(ErrorCode.NoWallet, `no wallet ${index}`);
      }
      this.activeWallet = index;
      // Switching seeds drops the passphrase, as the firmware does.
      this.passphraseActive = false;
      return { activeWallet: index };
    },

    setPassphrase: () => {
      this.requireUnlocked();
      this.confirm("Confirm wallet fingerprint on device");
      this.passphraseActive = true;
      return { fingerprint: "3A7B1C22" };
    },

    getAddress: (p) => {
      this.requireUnlocked();
      const path = String(p["path"] ?? "m/44'/60'/0'/0/0");

      /* Derive from the trailing index exactly as the firmware does. Deriving
       * from the whole path string would make the mock distinguish addresses
       * the device cannot, hiding a parsing bug rather than reproducing it -
       * which is what happened: the device read only "index", ignored "path",
       * and returned address zero ten times while the mock looked fine. */
      const tail = path.slice(path.lastIndexOf("/") + 1);
      const index = Number.parseInt(tail, 10);
      if (!Number.isFinite(index) || index < 0) {
        throw new MockRejection(ErrorCode.MalformedFrame, `bad path ${path}`);
      }

      if (p["display"]) this.confirm(`Show address for ${path}`);
      return {
        path,
        address: mockAddress(String(index), this.activeWallet, this.passphraseActive),
      };
    },

    signTransaction: (p) => {
      this.requireUnlocked();
      const path = String(p["path"] ?? "m/44'/60'/0'/0/0");
      const to = p["to"];
      const toHex = to instanceof Uint8Array ? "0x" + hex(to) : String(to ?? "");

      /* Refuse what the firmware refuses (T50), and never less. A mock that is
       * more permissive than the device certifies code the device rejects -
       * which has happened twice. */
      const { ok, call } = isDecodable({ to, data: p["data"] });
      if (!ok) {
        throw new MockRejection(
          ErrorCode.Undecodable,
          "this device cannot show what that call does",
        );
      }

      // The confirmation names the source as well as the destination: a host
      // that quietly changes the path must be visible on the device (T47).
      this.confirm(`Sign ${describeCall(call)} from ${path} to ${toHex}`);
      return { signature: new Uint8Array(65).fill(0x11), path };
    },

    signMessage: (p) => {
      this.requireUnlocked();
      const message = String(p["message"] ?? "");
      this.confirm(`Sign message: ${message.slice(0, 40)}`);
      return { signature: new Uint8Array(65).fill(0x22) };
    },
  };

  /* -------------------------------------------------------------- framing */

  private ok(result: CborValue, plaintext: boolean): Uint8Array {
    return encodeFrame(
      plaintext ? FrameType.Response : FrameType.EncryptedResponse,
      encodeCbor({ result }),
    );
  }

  private error(code: number, message: string): Uint8Array {
    return encodeFrame(FrameType.Error, encodeCbor({ code, message }));
  }
}

class MockRejection extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Deterministic stand-in for a derived address.
 *
 * NOT a real derivation — it exists so the UI has stable, distinct addresses to
 * render, and so that changing wallet, path or passphrase visibly changes the
 * result the way a real device would.
 */
function mockAddress(path: string, wallet: number, passphrase: boolean): string {
  const seed = `${path}|${wallet}|${passphrase ? "pp" : "no"}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = "";
  let state = h;
  for (let i = 0; i < 40; i++) {
    state = Math.imul(state ^ (state >>> 15), 0x2545f491) >>> 0;
    out += (state & 0xf).toString(16);
  }
  return "0x" + out;
}
