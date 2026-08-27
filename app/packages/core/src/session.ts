/**
 * Host side of the LeekWallet session — the counterpart to `src/session.c`.
 *
 * X25519, HKDF-SHA256 into two directional keys, ChaCha20-Poly1305 with counter
 * nonces, and a six-digit passkey. See docs/PROTOCOL.md section 3.
 *
 * The passkey is derived rather than chosen, but that alone was never the
 * mechanism, and v1 of this file claimed it was. Deriving it from the shared
 * secret and nothing else let a relay pick its own key material and search
 * offline for a value reproducing the digits already on the OLED —
 * `sim/passkey_grind.c` did it in 91 seconds on one core. What makes the
 * comparison mean something is the pair of properties this file now
 * implements, taken from BLE Secure Connections numeric comparison (Bluetooth
 * Core Specification v5.4, Vol 3, Part H, §2.3.5.6.4) and ZRTP (RFC 6189
 * §4.4.1.1 and §4.5.2):
 *
 *   - both ends contribute a fresh nonce, and the passkey is bound to the full
 *     transcript — both public keys and both nonces — so substituting any one
 *     of them changes what both screens show;
 *   - the device commits to its nonce before this side reveals its own, so a
 *     relay's every input is fixed before the value that randomises the answer
 *     arrives. It cannot search. It can guess once, online, at 1 in 10^6, in
 *     front of a user who is reading the screen.
 *
 * `verifyCommitment` below is not optional decoration: skipping it puts the
 * offline search straight back, because an uncommitted device nonce is a value
 * a relay may choose after seeing everything else.
 *
 * Uses @noble/*, which viem already depends on — no new supply-chain surface
 * for the one part of this codebase where that would matter most.
 */

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { chacha20poly1305 } from "@noble/ciphers/chacha";

/* Must match src/session.c exactly. Distinct labels are what keep the two
 * directional keys and the passkey independent outputs of one secret; the v2
 * suffix is what stops a v1 peer and a v2 peer deriving anything usable out of
 * half a handshake if the version check were ever bypassed. */
const LABEL_H2D = "leek-session-h2d-v2";
const LABEL_D2H = "leek-session-d2h-v2";
const LABEL_PASSKEY = "leek-session-passkey-v2";
const LABEL_COMMIT = "leek-session-commit-v2";
const LABEL_TRANSCRIPT = "leek-session-transcript-v2";

/**
 * The wire protocol this client speaks. Must equal PROTOCOL_VERSION in
 * src/protocol.h.
 *
 * v1 had no nonces and no commitment; v2 has both, and the two cannot
 * interoperate. Sent in `hello` and checked in the reply, on both ends, so a
 * mismatched pair says so plainly instead of failing later with "decrypt
 * failed" — which is what v1 did, since it put a version on the wire that
 * nothing ever read.
 */
export const PROTOCOL_VERSION = 2;

/** 128 bits each, as SESSION_NONCE_SIZE in session.h. */
export const NONCE_BYTES = 16;
export const COMMIT_BYTES = 32;

export interface SessionKeys {
  /** Host to device. */
  h2d: Uint8Array;
  /** Device to host. */
  d2h: Uint8Array;
  /** Six digits the user compares against the device screen. */
  passkey: string;
}

/**
 * Everything the derivation is bound to, in the order both ends hash it.
 *
 * By role, never by "mine and theirs": a transcript that depended on who was
 * looking at it would bind nothing, because the two ends would hash different
 * bytes and simply fail to agree.
 */
export interface SessionTranscript {
  hostPublic: Uint8Array;
  devicePublic: Uint8Array;
  hostNonce: Uint8Array;
  deviceNonce: Uint8Array;
}

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * The device's commitment to its nonce: H(label ‖ PKb ‖ PKa ‖ Nb).
 *
 * Both public keys are inside the hash for the same reason LESC's f4 takes
 * both: a commitment over the nonce alone could be replayed under a
 * substituted public key.
 */
export function commitment(
  devicePublic: Uint8Array,
  hostPublic: Uint8Array,
  deviceNonce: Uint8Array,
): Uint8Array {
  return sha256(concat(enc.encode(LABEL_COMMIT), devicePublic, hostPublic, deviceNonce));
}

/**
 * Check what the device sent in `helloAck` against what it revealed afterwards.
 *
 * Not constant-time and it does not need to be: both operands are public, and
 * the value being protected is the ORDER of the exchange rather than a secret.
 * Returns false rather than throwing so the caller decides how loudly to fail.
 */
export function verifyCommitment(
  claimed: Uint8Array,
  devicePublic: Uint8Array,
  hostPublic: Uint8Array,
  deviceNonce: Uint8Array,
): boolean {
  const expected = commitment(devicePublic, hostPublic, deviceNonce);
  if (claimed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= claimed[i]! ^ expected[i]!;
  return diff === 0;
}

/** The whole handshake hashed in a fixed order — the HKDF salt for everything. */
function transcriptHash(t: SessionTranscript): Uint8Array {
  return sha256(concat(
    enc.encode(LABEL_TRANSCRIPT),
    t.hostPublic, t.devicePublic, t.hostNonce, t.deviceNonce,
  ));
}

function derive(shared: Uint8Array, salt: Uint8Array, label: string): Uint8Array {
  return hkdf(sha256, shared, salt, label, 32);
}

/** 128 bits of freshness for this side of the comparison. */
export function generateNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

/**
 * Derive session keys and the passkey from a completed X25519 exchange.
 *
 * Throws on a degenerate shared secret: an all-zero result means a small-order
 * peer key, so the "agreement" is a value the attacker chose rather than
 * anything negotiated. Throws too on a transcript of the wrong shape, which is
 * a caller bug rather than a peer one — deriving over a short nonce would
 * silently weaken the very binding this exists for.
 */
export function deriveSession(
  privateKey: Uint8Array,
  peerPublic: Uint8Array,
  transcript: SessionTranscript,
): SessionKeys {
  if (transcript.hostPublic.length !== 32 || transcript.devicePublic.length !== 32 ||
      transcript.hostNonce.length !== NONCE_BYTES ||
      transcript.deviceNonce.length !== NONCE_BYTES) {
    throw new Error("transcript fields are the wrong length");
  }

  const shared = x25519.getSharedSecret(privateKey, peerPublic);

  if (shared.every((b) => b === 0)) {
    throw new Error("degenerate shared secret: peer key is small-order");
  }

  const salt = transcriptHash(transcript);
  const passkeyBytes = derive(shared, salt, LABEL_PASSKEY);
  const n =
    ((passkeyBytes[0]! << 24) >>> 0) +
    (passkeyBytes[1]! << 16) +
    (passkeyBytes[2]! << 8) +
    passkeyBytes[3]!;

  return {
    h2d: derive(shared, salt, LABEL_H2D),
    d2h: derive(shared, salt, LABEL_D2H),
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
  /** What was sealed at the held counter, so a retry can be told from a reuse. */
  private heldPlaintext: Uint8Array | null = null;
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

    /* Deferring the counter means the same nonce is used again on a retry, and
     * that is only safe while the plaintext is the same too. Two DIFFERENT
     * messages under one key and nonce is not a degradation of
     * ChaCha20-Poly1305, it is the end of it: the keystreams XOR to the
     * plaintexts and the Poly1305 key falls out, so an eavesdropper reads both
     * messages and can forge a third.
     *
     * Nothing above this class enforces the rule — the client serialises calls
     * and does not poll while it waits for the button, but that is a property
     * of today's caller rather than of the session, and it is invisible to
     * anyone else importing this package. So the rule lives where the nonce
     * does. A retry of the identical request still returns identical bytes,
     * which is what the retry loop relies on; anything else is refused rather
     * than sealed. */
    if (this.deferSend && this.heldPlaintext !== null &&
        !sameBytes(this.heldPlaintext, plaintext)) {
      throw new Error(
        "refusing to seal a second message under one nonce: the previous " +
        "request has not been answered, so the counter has not advanced",
      );
    }

    const out = chacha20poly1305(this.sendKey, nonceFor(this.txCounter)).encrypt(plaintext);
    if (this.deferSend) {
      this.heldPlaintext = plaintext.slice();
    } else {
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
      /* The held message has been answered, so the nonce it used is spent and
       * the next one is free for anything. */
      this.heldPlaintext = null;
    }
    return out;
  }
}

/**
 * Byte equality. Not constant-time, and it does not need to be: both operands
 * are messages this side composed, so there is no secret here to leak a
 * comparison against.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
