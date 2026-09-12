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
import { PROTOCOL_VERSION } from "./session.ts";
import { describeCall, isDecodable } from "./eth-decode.ts";
import { describeTypedData, inspectTypedData } from "./eip712.ts";

export interface MockOptions {
  /** Milliseconds each command takes. Real key derivation costs ~1 s. */
  latencyMs?: number;
  /** Auto-approve confirmations. Set false to exercise the rejection path. */
  autoApprove?: boolean;
  /** Start already unlocked, skipping the PIN prompt. */
  startUnlocked?: boolean;

  /**
   * Whether the simulated user eventually types the PIN after `unlock`.
   *
   * `unlock` only prompts — the device answers `{prompted:1, unlocked:0}` and
   * the host polls `getStatus` (PROTOCOL.md 6e #1). Default true so the demo
   * app makes progress; set false to drive `enterPin()` by hand, which is the
   * only way to assert on the window where the device is prompting and still
   * locked.
   */
  autoPin?: boolean;

  /** How long the simulated user takes to type the PIN, when `autoPin`. */
  pinEntryMs?: number;
  /** How many seeds the device holds. */
  walletCount?: number;

  /**
   * Whether `helloReveal` completes the passkey comparison by itself.
   *
   * Default true, because pairing is not what most tests are about. Set false
   * to leave the session PENDING and drive `confirmSession()` yourself - that
   * is the path where a machine in the middle gets caught, so something should
   * exercise it.
   */
  autoConfirmSession?: boolean;

  /**
   * Whether the simulated device has blind signing switched on (T16).
   *
   * Default false, which is a real device out of the box. On the hardware this
   * is five deliberate button presses behind a warning screen and no command
   * can change it, so it is an option here rather than a method: a test asks
   * for a device that is already in the weaker mode, it does not put one there
   * over the wire.
   */
  blindSigning?: boolean;
}

type Handler = (params: Record<string, CborValue>) => CborValue;

const DEVICE_LABEL = "LeekWallet (mock)";

/* Six rows of twenty characters — what the OLED can actually show, and so what
 * the firmware will accept. See eth_message_is_displayable(). */
const MESSAGE_MAX_BYTES = 120;

/* Fixed so the pairing UI has something stable to render. A real device
 * derives this from the handshake; see session.ts. */
const MOCK_PASSKEY = "314159";

export class MockDevice implements Transport {
  readonly kind = "mock" as const;
  readonly label = DEVICE_LABEL;

  private opened = false;

  /* Four states, as session.c has them. The mock used to jump straight from
   * nothing to established on `hello`, which skipped the passkey comparison
   * entirely - the whole defence against a machine in the middle. Anything
   * built against that mock would pass without ever exercising it.
   * `awaitingReveal` is the v2 addition: the device has committed to its nonce
   * and nothing is derived or displayed until the host reveals its own. */
  private sessionState: "none" | "awaitingReveal" | "pending" | "active" = "none";
  private unlocked: boolean;
  /** The PIN pad is on screen and the device is waiting for the user. */
  private pinPrompted = false;
  private handler: ((frame: Uint8Array) => void) | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly opts: Required<MockOptions>;

  private activeWallet = 1;
  private passphraseActive = false;

  /** Requests the device is "showing" — inspect in tests. */
  readonly confirmations: string[] = [];

  /** The user confirmed the passkey matches. Nothing encrypted works before. */
  confirmSession(): void {
    if (this.sessionState === "pending") this.sessionState = "active";
  }

  /** Session state, for tests that care about the pending step. */
  get session(): "none" | "awaitingReveal" | "pending" | "active" {
    return this.sessionState;
  }

  /** Test hook: simulate the device auto-locking on its idle timer. */
  autoLock(): void {
    this.unlocked = false;
    this.passphraseActive = false;
    this.pinPrompted = false;
  }

  /**
   * Test hook: the user finished typing the PIN on the device keypad.
   *
   * Nothing crosses the wire when this happens — the host only learns about it
   * by polling `getStatus`, which is exactly the behaviour app code has to be
   * built against.
   */
  enterPin(): void {
    if (this.pinPrompted) {
      this.pinPrompted = false;
      this.unlocked = true;
    }
  }

  /** Whether the device is currently showing its PIN pad. */
  get promptingForPin(): boolean {
    return this.pinPrompted;
  }

  constructor(options: MockOptions = {}) {
    this.opts = {
      latencyMs: options.latencyMs ?? 0,
      autoApprove: options.autoApprove ?? true,
      startUnlocked: options.startUnlocked ?? false,
      walletCount: options.walletCount ?? 1,
      autoConfirmSession: options.autoConfirmSession ?? true,
      autoPin: options.autoPin ?? true,
      pinEntryMs: options.pinEntryMs ?? 400,
      blindSigning: options.blindSigning ?? false,
    };
    this.unlocked = this.opts.startUnlocked;
  }

  /**
   * The BIP44 account the simulated device's own screens are on.
   *
   * Settable so a test can do what a user does with the button: change it
   * behind the app's back and check the app notices.
   */
  hdAccount = 0;

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    this.opened = true;
    this.sessionState = "none";
    this.decoder.reset();
  }

  async close(): Promise<void> {
    this.opened = false;
    this.sessionState = "none";
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

    /* The "always" tier from PROTOCOL.md section 4: answerable with no session
     * because they reveal nothing. `getStatus` belongs here - section 5 tells
     * the app to poll it, and the firmware answers it in plaintext - and
     * `ping` exists on the device and was simply missing here. */
    const preSession =
      method === "hello" || method === "helloReveal" ||
      method === "getFeatures" || method === "getStatus" || method === "ping";

    /* A method that does not exist is malformed BEFORE it is unauthorised, and
     * that order is the firmware's rather than the tidier-looking one: dispatch
     * in protocol.c matches the name first and only the handlers it found check
     * the session. So `getMnemonic` with no session is 0x0001 on the device and
     * was 0x0400 here — the mock telling a host that a method it does not have
     * exists and merely needs pairing. */
    const handler = this.handlers[method];
    if (!handler) {
      return this.error(ErrorCode.MalformedFrame, `unknown method ${method}`);
    }

    /* PENDING is not established. Until the user has compared the passkey,
     * the device refuses everything else, and so must this. */
    if (!preSession && this.sessionState !== "active") {
      return this.error(ErrorCode.SessionRequired, "no session");
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
    /* Two legs, as PROTOCOL.md §3 and src/protocol.c have them. The mock has
     * no key agreement, so it cannot produce a real public key, commitment or
     * nonce — but it can and must model the STATE MACHINE, because the ordering
     * is the security property. A mock that established a session from `hello`
     * alone would let host code skip the reveal and the commitment check and
     * still pass every test here, which is precisely how the mock has twice
     * certified behaviour the firmware refuses. */
    hello: (params) => {
      if (params["version"] !== PROTOCOL_VERSION) {
        throw new MockRejection(
          ErrorCode.UnsupportedVersion,
          `this device speaks protocol v${PROTOCOL_VERSION}; the app offered ` +
          `v${typeof params["version"] === "number" ? params["version"] : "none"}`,
        );
      }
      this.sessionState = "awaitingReveal";
      return { version: PROTOCOL_VERSION, deviceId: "mock-0001" };
    },

    helloReveal: () => {
      if (this.sessionState !== "awaitingReveal") {
        throw new MockRejection(
          ErrorCode.SessionRequired, "no handshake is waiting for a nonce",
        );
      }
      /* PENDING, not established. The device shows a passkey and waits for the
       * user to confirm it matches; nothing encrypted is accepted until then. */
      this.sessionState = "pending";
      this.confirmations.push(`Compare passkey ${MOCK_PASSKEY}`);
      if (this.opts.autoConfirmSession) {
        this.sessionState = "active";
      }
      return { passkey: MOCK_PASSKEY };
    },

    ping: () => ({ pong: 1 }),

    /* Exactly the three fields protocol.c writes. `initialized` was invented
     * here and existed nowhere else, so app code could branch on a field real
     * hardware never sends. */
    getFeatures: () => ({
      model: "LeekWallet-mock",
      firmware: "0.1.0-mock",
      /* The real state, as the device reports it. An app that decides whether
       * to refuse a call before the walk to the device reads this field, so a
       * mock that always said 0 would never exercise the other branch. */
      blindSigning: this.opts.blindSigning ? 1 : 0,
    }),

    getStatus: () => ({
      unlocked: this.unlocked ? 1 : 0,
      walletCount: this.opts.walletCount,
      activeWallet: this.activeWallet,
      /* The mock has no temporary mode -- it is a device-side flow with no
       * host half -- but the field has to be here, because the app decides
       * what to render from it and a mock that omits it certifies an app that
       * would show `wallet 0/N` against real firmware. */
      temporary: 0,
      passphrase: this.passphraseActive ? 1 : 0,
      /* Reported like the real device, so the mock cannot certify an app that
       * ignores the field -- the failure this suite exists to catch. */
      account: this.hdAccount,
    }),

    /**
     * Prompt, and say nothing about the outcome.
     *
     * The PIN is typed on the device, so the reply cannot carry the result —
     * it is sent long before the user has touched a button. The device answers
     * `{prompted:1, unlocked:0}` and the host polls `getStatus`. The mock used
     * to unlock synchronously and return `{unlocked:1}`, which taught every app
     * built on it that unlocking is instantaneous.
     *
     * Already unlocked is the one case with an immediate answer, and protocol.c
     * takes it: no prompt, `{unlocked:1}`.
     */
    unlock: () => {
      if (this.unlocked) return { unlocked: 1 };

      /* Recorded, not confirm()ed: a PIN pad is not an approve/reject screen,
       * and `autoApprove` governs signing decisions. Whether the user types the
       * PIN is `autoPin`. */
      this.confirmations.push("Enter PIN on device");
      this.pinPrompted = true;
      if (this.opts.autoPin) {
        setTimeout(() => this.enterPin(), this.opts.pinEntryMs);
      }
      return { prompted: 1, unlocked: 0 };
    },

    lock: () => {
      this.unlocked = false;
      this.pinPrompted = false;
      /* The passphrase dies with the session, as it does on the device. A host
       * that kept deriving addresses from it would be showing a wallet the
       * device can no longer produce. */
      this.passphraseActive = false;
      // `{unlocked:0}`, as protocol.c answers - an empty map told the host
      // nothing about the state it had just changed.
      return { unlocked: 0 };
    },

    selectWallet: (p) => {
      this.requireUnlocked();
      /* No index is a malformed request, not wallet 1. Defaulting made the
       * mock answer `{activeWallet:1}` where the device answers 0x0001, and a
       * host that lost the field would look correct here and select nothing
       * there. */
      const index = p["index"];
      if (typeof index !== "number" || !Number.isInteger(index)) {
        throw new MockRejection(ErrorCode.MalformedFrame, "index required");
      }
      if (index < 1 || index > this.opts.walletCount) {
        throw new MockRejection(ErrorCode.NoWallet, `no wallet ${index}`);
      }
      this.activeWallet = index;
      // Switching seeds drops the passphrase, as the firmware does.
      this.passphraseActive = false;
      return { activeWallet: index };
    },

    setPassphrase: (p) => {
      this.requireUnlocked();

      /* The passphrase was not looked at here at all: any request applied one,
       * including an empty one and one the device's own keyboard cannot type.
       * protocol.c bounds it at 1..63 printable-ASCII bytes and refuses the
       * rest as malformed — an empty string is the base wallet, not a
       * passphrase, and a wallet reachable from the app but not from the device
       * is one the owner cannot get back to without the app. */
      const raw = p["passphrase"];
      if (typeof raw !== "string") {
        throw new MockRejection(ErrorCode.MalformedFrame, "passphrase required");
      }
      if (raw.length === 0 || raw.length > PASSPHRASE_MAX_BYTES) {
        throw new MockRejection(ErrorCode.MalformedFrame, "passphrase length out of range");
      }
      if (!/^[\x20-\x7e]+$/.test(raw)) {
        throw new MockRejection(ErrorCode.MalformedFrame, "passphrase must be printable ASCII");
      }

      /* The device applies it, derives the resulting wallet and asks the owner
       * to recognise the ADDRESS. That address is the whole safety argument for
       * letting a host type a passphrase at all, so it is what the reply
       * carries. The mock used to answer `{fingerprint}`, a field no firmware
       * ever sends, which meant app code could be written against a
       * confirmation the device cannot produce.
       *
       * Account 0 whatever the device is browsing, as protocol.c does: the
       * question the screen asks is which SEED, and the answer must not depend
       * on an unrelated menu setting. */
      const address = mockAddress("0", this.activeWallet, true);
      this.confirm(`Confirm passphrase wallet ${address} on device`);
      /* Set only after the confirmation: a rejection must leave the device in
       * the wallet it was already in, or the owner ends up signing from one
       * they refused. confirm() throws on refusal, so this line is the
       * approval. */
      this.passphraseActive = true;
      return { address, passphrase: 1 };
    },

    getAddress: (p) => {
      this.requireUnlocked();
      const index = addressIndex(p);
      const path = String(p["path"] ?? `m/44'/60'/0'/0/${index}`);

      if (p["display"]) this.confirm(`Show address for ${path}`);
      /* `{address, index}`, the device's shape, and nothing else. Echoing the
       * requested `path` back would let host code read a field real hardware
       * never sends - and worse, believe the device agreed with its reading of
       * the path when all the device ever kept was the trailing index. */
      return {
        address: mockAddress(String(index), this.activeWallet, this.passphraseActive),
        index,
      };
    },

    signTransaction: (p) => {
      this.requireUnlocked();
      const index = addressIndex(p);
      const path = `m/44'/60'/0'/0/${index}`;
      const to = p["to"];
      const toHex = to instanceof Uint8Array ? "0x" + hex(to) : String(to ?? "");

      /* chainId is mandatory and must be an unsigned integer. The same address
       * exists on every EVM chain, so a signature made without knowing the
       * chain is a replay waiting to happen; protocol.c refuses rather than
       * defaulting to 1. */
      const chainId = p["chainId"];
      if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId < 0) {
        throw new MockRejection(ErrorCode.MalformedFrame, "chainId required");
      }

      /* The size bound comes before the decodability check, in that order,
       * because that is the order protocol.c applies them: an oversized blob is
       * a malformed request (0x0001), not an undecodable call (0x0202), and a
       * client that distinguishes the two must see the same code the device
       * sends. It also refuses to let the host choose the device's memory
       * usage. */
      const dataLength = byteLength(p["data"]);
      if (dataLength > ETH_MAX_DATA) {
        throw new MockRejection(ErrorCode.MalformedFrame, "calldata too large to display");
      }

      /* Refuse what the firmware refuses (T50), and never less. A mock that is
       * more permissive than the device certifies code the device rejects -
       * which has happened twice. */
      const { ok, call } = isDecodable({ to, data: p["data"] });
      if (!ok) {
        /* The escape hatch (T16), and exactly as narrow as protocol.c makes it:
         * blind signing on AND a recipient still present. The mock refused
         * both cases unconditionally, which reads as the safer error to make
         * but is the same class of bug in the other direction — an app whose
         * blind-signing branch nothing ever executed, certified by a mock that
         * could not reach it. Contract creation stays refused however the
         * setting is set: with no recipient the confirmation has nothing true
         * left on it. */
        const hasTo = to instanceof Uint8Array ? to.length === 20 : typeof to === "string" && to.length > 2;
        if (!(hasTo && this.opts.blindSigning)) {
          throw new MockRejection(
            ErrorCode.Undecodable,
            "this device cannot show what that call does",
          );
        }
      }

      // The confirmation names the source as well as the destination: a host
      // that quietly changes the path must be visible on the device (T47).
      /* A blind confirmation is a different screen, not a vaguer one: it leads
       * with the warning, because the only true things left on it are the
       * recipient and the amount. */
      this.confirm(
        ok
          ? `Sign ${describeCall(call)} from ${path} to ${toHex}`
          : `BLIND call from ${path} to ${toHex}`,
      );
      /* `{index, r, s, yParity}` - the device's shape. yParity is 0 or 1 and
       * never the legacy 27/28: a client that masks the low bit of 27 inverts
       * it, and the resulting signature recovers to an address nobody owns,
       * which reads as "you have no funds" rather than "the signature is
       * wrong". Emitting the same values here means the reassembly code is
       * exercised before it meets hardware. */
      return {
        index,
        r: new Uint8Array(32).fill(0x11),
        s: new Uint8Array(32).fill(0x22),
        yParity: index & 1,
      };
    },

    signMessage: (p) => {
      this.requireUnlocked();
      const index = addressIndex(p);
      const raw = p["message"];
      if (typeof raw !== "string") {
        throw new MockRejection(ErrorCode.MalformedFrame, "message must be text");
      }

      /* The device displays the whole message and signs exactly what it
       * displayed, so it refuses anything it cannot render: printable ASCII
       * only, and no longer than the six twenty-character rows the screen has
       * (PROTOCOL.md 6e). Accepting more here than protocol.c accepts is the
       * mock being more permissive than the device, which is the one thing it
       * must never be - an emoji in a message would pass every test and fail
       * on hardware. */
      /* Length in BYTES, not in whatever byteLength() makes of a hex-looking
       * string - it is written for calldata and reads text as hex. Printable
       * ASCII makes the two the same number, which is exactly why the
       * printability check comes first. */
      /* Two refusals, two codes, and in the firmware's order. Too long is
       * MALFORMED: the host built a request the device could not have held,
       * and no setting reopens it. Unrenderable is UNDECODABLE: the bytes
       * fitted, the screen has no glyphs for them. The mock answered 0x0202 to
       * both, so a client branching on the two — and the app does, since one is
       * worth retrying shorter and the other is not — was tested against a
       * distinction that did not exist here. */
      if (raw.length > MESSAGE_MAX_BYTES) {
        throw new MockRejection(ErrorCode.MalformedFrame, "message too long to display");
      }
      /* `*`, not `+`: the empty message is displayable and the device signs it.
       * personal_sign("") is a request dapps really make, and a mock that
       * refused it meant app code could carry a branch for an error the
       * hardware never sends. */
      if (!/^[\x20-\x7e]*$/.test(raw)) {
        throw new MockRejection(
          ErrorCode.Undecodable,
          "this device cannot display that message",
        );
      }

      this.confirm(`Sign message from m/44'/60'/0'/0/${index}: ${raw.slice(0, 40)}`);

      /* Same shape as signTransaction. One reply format for one kind of
       * answer; a client that parses one parses the other. */
      return {
        index,
        r: new Uint8Array(32).fill(0x33),
        s: new Uint8Array(32).fill(0x44),
        yParity: index & 1,
      };
    },

    signTypedData: (p) => {
      this.requireUnlocked();
      const index = addressIndex(p);

      /* The order of these three refusals is the order protocol.c applies
       * them, and the codes differ because they mean different things to a
       * client. A request with no `types` is malformed (0x0001) — the host
       * built it wrong. A document the device cannot hash and one it cannot
       * show are both 0x0202, but only the second is reopened by blind
       * signing, and getting that backwards would let a host believe an array
       * document becomes signable once the owner opts in. It never does: the
       * only way to sign it would be to take a digest from the host, which is
       * the thing this device exists not to do. */
      const verdict = inspectTypedData(p);
      if (verdict.kind === "malformed") {
        throw new MockRejection(ErrorCode.MalformedFrame, "typed data request is incomplete");
      }
      if (verdict.kind === "unhashable") {
        throw new MockRejection(
          ErrorCode.Undecodable,
          "this device cannot compute that structure's hash",
        );
      }
      if (verdict.kind === "unrenderable" && !this.opts.blindSigning) {
        throw new MockRejection(
          ErrorCode.Undecodable,
          "this device cannot show all of that structure",
        );
      }

      /* What the device screen would say. Blind is a different screen, not a
       * shorter one: it leads with the warning and shows the digest rather
       * than a field list that would read as complete. */
      const where = `from m/44'/60'/0'/0/${index}`;
      this.confirm(
        verdict.kind === "unrenderable"
          ? `BLIND typed data ${verdict.render.primaryType} ${where}`
          : `Sign ${describeTypedData(verdict.render)} ${where}`,
      );

      return {
        index,
        r: new Uint8Array(32).fill(0x55),
        s: new Uint8Array(32).fill(0x66),
        yParity: index & 1,
      };
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
    /* Once a session is active an error is encrypted like any other reply, and
     * carries its own frame type.
     *
     * Not for secrecy - for counters. The device advances its receive counter
     * the moment a frame decrypts, error or not, while the host only advances
     * on opening a reply. A plaintext error leaves the two one apart and every
     * later frame fails to decrypt. The firmware learned this on hardware; the
     * mock kept answering in plaintext, so a client that mishandled it passed
     * here and desynced against the real device. */
    const type =
      this.sessionState === "active" ? FrameType.EncryptedError : FrameType.Error;
    return encodeFrame(type, encodeCbor({ code, message }));
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
 * `ETH_MAX_DATA` in src/eth-tx.h — what the device can hold and describe.
 *
 * 640 since Aqua: a ship() is about 600 bytes and the old 256 refused it for
 * capacity while the screen could have drawn every field.
 *
 * 768 since 2026-09-10, and the reason is a caution about that "about". A
 * ONE-leg ship is 612 bytes; a TWO-leg ship is 676, and 640 sits between them.
 * So the limit was set from the smaller of the two shapes this app actually
 * builds, and the real position -- two-sided, the one the runbook calls a real
 * market rather than a demonstration -- was refused on hardware with 0x0001.
 * No test caught it because none pushed a two-leg ship through this mock.
 *
 * Must not drift from the firmware — a mock that accepts more than the device
 * certifies broken code, and a mock that accepts less refuses requests the
 * device would take.
 */
const ETH_MAX_DATA = 768;

/** Longest passphrase protocol.c will accept: 63 bytes plus its terminator. */
const PASSPHRASE_MAX_BYTES = 63;

/** Highest address index the device will derive; see protocol.c. */
const MAX_ADDRESS_INDEX = 0x7fffffff;

/** Calldata as the device measures it, in bytes, whatever form it arrived in. */
function byteLength(data: CborValue | undefined): number {
  if (data instanceof Uint8Array) return data.length;
  if (typeof data === "string") {
    const body = data.startsWith("0x") ? data.slice(2) : data;
    // Round up: an odd nibble count is malformed anyway and eth-decode.ts
    // rejects it, so err towards "too long" rather than "just fits".
    return Math.ceil(body.length / 2);
  }
  return 0;
}

/**
 * Which address the request names, with the device's precedence.
 *
 * `index` wins over `path`, exactly as protocol.c reads them — the firmware
 * once read only `index`, ignored `path`, and derived address zero ten times,
 * so the mock resolves it the same way rather than parsing the whole path and
 * hiding the difference.
 */
function addressIndex(p: Record<string, CborValue>): number {
  let index: number;
  if (typeof p["index"] === "number") {
    index = p["index"];
  } else if (typeof p["path"] === "string") {
    const tail = p["path"].slice(p["path"].lastIndexOf("/") + 1);
    index = Number.parseInt(tail, 10);
  } else {
    index = 0;
  }

  /* Above 0x7FFFFFFF is a hardened index, which BIP32 encodes differently and
   * the device refuses rather than silently deriving a different key. */
  if (!Number.isInteger(index) || index < 0 || index > MAX_ADDRESS_INDEX) {
    throw new MockRejection(ErrorCode.MalformedFrame, "address index out of range");
  }
  return index;
}

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
