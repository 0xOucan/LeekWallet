/**
 * Host side of the LeekWallet session — the counterpart to `src/session.c`.
 *
 * X25519, HKDF-SHA256 into two directional keys, ChaCha20-Poly1305 with counter
 * nonces, and a six-digit passkey derived from the shared secret. See
 * docs/PROTOCOL.md section 3.
 *
 * The passkey is derived rather than chosen, and that is the entire mechanism.
 * An attacker relaying between the host and the device holds two different
 * shared secrets, so the code it can display cannot match the one on the OLED.
 * Encryption alone would protect a conversation with an impostor perfectly
 * well; a human comparing two screens is what notices one.
 *
 * Uses @noble/*, which viem already depends on — no new supply-chain surface
 * for the one part of this codebase where that would matter most.
 */

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { chacha20poly1305 } from "@noble/ciphers/chacha";

/* Must match src/session.c exactly. Distinct labels are what keep the two
 * directional keys and the passkey independent outputs of one secret. */
const LABEL_H2D = "leek-session-h2d-v1";
const LABEL_D2H = "leek-session-d2h-v1";
const LABEL_PASSKEY = "leek-session-passkey-v1";

export interface SessionKeys {
  /** Host to device. */
  h2d: Uint8Array;
  /** Device to host. */
  d2h: Uint8Array;
  /** Six digits the user compares against the device screen. */
  passkey: string;
}

/** Empty salt, matching the firmware's HKDF-Extract. */
const EMPTY_SALT = new Uint8Array(32);

function derive(shared: Uint8Array, label: string): Uint8Array {
  return hkdf(sha256, shared, EMPTY_SALT, label, 32);
}

/**
 * Derive session keys and the passkey from a completed X25519 exchange.
 *
 * Throws on a degenerate shared secret: an all-zero result means a small-order
 * peer key, so the "agreement" is a value the attacker chose rather than
 * anything negotiated.
 */
export function deriveSession(privateKey: Uint8Array, peerPublic: Uint8Array): SessionKeys {
  const shared = x25519.getSharedSecret(privateKey, peerPublic);

  if (shared.every((b) => b === 0)) {
    throw new Error("degenerate shared secret: peer key is small-order");
  }

  const passkeyBytes = derive(shared, LABEL_PASSKEY);
  const n =
    ((passkeyBytes[0]! << 24) >>> 0) +
    (passkeyBytes[1]! << 16) +
    (passkeyBytes[2]! << 8) +
    passkeyBytes[3]!;

  return {
    h2d: derive(shared, LABEL_H2D),
    d2h: derive(shared, LABEL_D2H),
    passkey: String(n % 1000000).padStart(6, "0"),
  };
}

export function generateKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = x25519.utils.randomPrivateKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** Nonce = 4 zero bytes || 8-byte big-endian counter, as the firmware builds it. */
function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[8] = (counter >>> 24) & 0xff;
  nonce[9] = (counter >>> 16) & 0xff;
  nonce[10] = (counter >>> 8) & 0xff;
  nonce[11] = counter & 0xff;
  return nonce;
}

/**
 * An established session.
 *
 * Counters never reset and never repeat within a session. A reused nonce does
 * not degrade ChaCha20-Poly1305, it breaks it: two messages under one key and
 * nonce leak the keystream and the authentication key.
 */
export type SessionRole = "host" | "device";

export class Session {
  private readonly keys: SessionKeys;
  /* Which key each direction uses depends on which end you are.
   * The host sends under h2d and receives under d2h; the device is the mirror.
   * A single mapping for both ends looks symmetric and silently fails to
   * decrypt, which is how this was found. */
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;
  /** Host only: hold the send counter back until a reply confirms delivery. */
  private readonly deferSend: boolean;
  private txCounter = 0;
  private rxCounter = 0;
  private active = false;

  constructor(keys: SessionKeys, role: SessionRole = "host") {
    this.keys = keys;
    this.sendKey = role === "host" ? keys.h2d : keys.d2h;
    this.recvKey = role === "host" ? keys.d2h : keys.h2d;
    this.deferSend = role === "host";
  }

  get passkey(): string {
    return this.keys.passkey;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Mark the session usable, once the user has compared the passkey.
   *
   * The host cannot observe the button press, so this is optimistic: it
   * permits encrypted traffic and the device rejects it until the user
   * actually approves. That is safe only because a rejected frame does not
   * advance the send counter - see encrypt().
   */
  confirm(): void {
    this.active = true;
  }

  /**
   * Seal an outgoing frame.
   *
   * The host defers advancing its send counter until a reply proves the frame
   * was accepted. The device advances immediately, mirroring `session_encrypt`
   * in the firmware.
   *
   * The asymmetry exists because only the host retries. It polls an encrypted
   * call while waiting for the user to press ALLOW, and the device rejects
   * every attempt until then without advancing its receive counter. A host
   * that advanced on send would be one ahead before the button was touched,
   * and every later frame would fail to decrypt with nothing to indicate why.
   * Hardware testing found precisely that.
   */
  encrypt(plaintext: Uint8Array): Uint8Array {
    if (!this.active) throw new Error("session not confirmed");
    const out = chacha20poly1305(this.sendKey, nonceFor(this.txCounter)).encrypt(plaintext);
    if (!this.deferSend) {
      this.txCounter++;
    }
    return out;
  }

  /**
   * Open an incoming frame.
   *
   * For the host this is also the acknowledgement that its request was
   * accepted, so the send counter catches up here. For the device only the
   * receive counter moves, as in the firmware.
   */
  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (!this.active) throw new Error("session not confirmed");
    // A failed tag throws. That is correct: a forged frame means the channel is
    // no longer trustworthy, and skipping it and carrying on would be wrong.
    const out = chacha20poly1305(this.recvKey, nonceFor(this.rxCounter)).decrypt(ciphertext);
    this.rxCounter++;
    if (this.deferSend) {
      this.txCounter++;
    }
    return out;
  }
}
