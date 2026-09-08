/**
 * The payment request the cashier issues and the waiter can only read.
 *
 * ---------------------------------------------------------------------------
 * What this file is for
 *
 * La Caja runs on two devices. The cashier — the owner, or whoever is trusted
 * with the prices — enters the bill and the tip and issues a request. The
 * waiter carries a phone to the table, scans that request, and shows the
 * customer what to pay. Neither device holds the restaurant's LeekWallet.
 *
 * The one property that makes the split worth having: **a waiter cannot change
 * the amount or the recipient.** Not "the field is disabled" — there is no
 * field. The waiter's app receives this object and has no code path that
 * constructs one, so an amount it did not receive is an amount it cannot show.
 * `waiter.ts` holds the DOM side of that and `test/request.test.ts` holds the
 * proof.
 *
 * ---------------------------------------------------------------------------
 * The encoding, and why it is not JSON
 *
 *     caja1|<merchant>|<recipient>|<token>|<totalCents>|<marker>|<chains>|<issuedAt>|<digest>
 *
 * A QR is scanned by a camera in a restaurant and every byte costs resolution,
 * but that is not the reason. The reason is that the digest has to be over
 * *one* byte string, and JSON does not give you one: two encoders that disagree
 * about key order or about how they spell a number produce two documents that
 * mean the same thing and hash differently. A positional format has exactly one
 * spelling, so "re-encode it and compare" is a test anyone can write, and
 * `test/request.test.ts` does.
 *
 * Merchant name is base64url so a `|` in "Bar | Grill" cannot forge a field.
 * The total is cents as decimal digits, the same bigint the till has carried
 * since order.ts parsed it — no float touches a payable figure here either.
 *
 * ---------------------------------------------------------------------------
 * The digest is NOT a signature, and this is the honest part
 *
 * It is `sha256` of the canonical bytes, truncated, and it detects a request
 * that was corrupted in transit or edited after issue. It proves nothing about
 * *who* issued it. There is no key in the cashier's app to sign with: the
 * shell's `propose` needs the device, and the device is in a safe, not on the
 * till.
 *
 * So state it plainly. **Anyone who can display a QR can forge a request.** A
 * waiter with a phone and this source code can produce a well-formed request
 * for any amount they like.
 *
 * What stops that being theft is not cryptography, it is the recipient:
 *
 *  1. The recipient is the **restaurant's own address**, and the waiter's app
 *     refuses any request that does not name the address the terminal was
 *     configured with (`acceptRequest` below). A forged request therefore pays
 *     the restaurant. The forger's gain is zero.
 *  2. What a forger CAN do is overcharge a customer — bill $400 for a $40 meal
 *     — and the restaurant keeps the money. That is a dispute at the till, not
 *     an exfiltration, and it is the same exposure a paper bill pad has.
 *  3. Rewriting the recipient to the waiter's own address is the attack that
 *     would matter, and it is the one (1) refuses.
 *
 * What this design does not prevent, and no unsigned request can: a waiter
 * quietly issuing bills the cashier never saw, for amounts the cashier never
 * approved, into the restaurant's account. Reconciling those is accounting, not
 * cryptography, and the shift-close ledger is where it belongs.
 *
 * Signing the request is the obvious upgrade and it needs one thing this
 * milestone does not have: a key on the cashier's device. When the cashier is
 * an admin holding the LeekWallet, `propose` can sign an EIP-712 request and
 * the waiter can verify it against the merchant's published address. Until then
 * the digest is integrity, and the sentence in the UI says integrity.
 */

import { sha256 } from "@noble/hashes/sha256";
import { checksumAddress } from "@leekwallet/core/tx-interpret.ts";
import type { Cents } from "./order.ts";
import type { TillToken } from "./rails.ts";
import { TILL_TOKENS } from "./rails.ts";

/** The prefix a scanner uses to tell this apart from an address or a URI. */
export const REQUEST_PREFIX = "caja1";

/**
 * What the cashier issued. Every field is readonly, and `decodeRequest` freezes
 * the object it returns: a waiter's app that tried to write one gets a
 * TypeError in strict mode rather than a quietly different bill.
 */
export interface PaymentRequest {
  /** Display name. Cosmetic — nothing settles on it. */
  readonly merchant: string;
  /** Where the money must land. Checksummed. */
  readonly recipient: string;
  readonly token: TillToken;
  /** Bill plus tip, in cents. The waiter never sees the split; it cannot act on it. */
  readonly total: Cents;
  /** Sub-cent order marker, 0–99. See order.ts. */
  readonly marker: number;
  /** Chain ids the customer may pay on. All of them are shown, not just one. */
  readonly chains: readonly number[];
  /** Unix seconds at issue. Renders an age; nothing expires on it yet. */
  readonly issuedAt: number;
}

/** A request plus the exact bytes it was issued as, and their digest. */
export interface SealedRequest {
  readonly request: PaymentRequest;
  /** Truncated sha256 of `canonical`, lower-case hex. Integrity, not identity. */
  readonly digest: string;
  /** The scannable text. Re-encoding `request` must reproduce this exactly. */
  readonly text: string;
}

export type DecodeResult =
  | { ok: true; sealed: SealedRequest }
  | { ok: false; reason: string };

const enc = new TextEncoder();

/** URL-safe base64 without padding, so a name never carries `|`, `+` or `/`. */
function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The bytes that are hashed and the bytes that are scanned, minus the digest.
 *
 * One function, used by both the issuer and the verifier, because a canonical
 * form with two implementations is not canonical.
 */
export function canonicalRequest(request: PaymentRequest): string {
  return [
    REQUEST_PREFIX,
    b64url(enc.encode(request.merchant)),
    request.recipient,
    request.token,
    request.total.toString(),
    String(request.marker),
    request.chains.join("."),
    String(request.issuedAt),
  ].join("|");
}

/**
 * sha256 of the canonical bytes, first 8 bytes as hex.
 *
 * Truncated because it is a transcription check that has to fit on a screen a
 * cashier and a waiter can compare by eye, not a collision-resistance claim.
 * Sixteen hex characters is far beyond what a mis-scan produces and far below
 * what an attacker with no key needs to bother with — they can just issue their
 * own request, which is the point made at length above.
 */
export function digestOf(canonical: string): string {
  const hash = sha256(enc.encode(canonical));
  return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

function validate(request: PaymentRequest): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.recipient)) return "the recipient is not an address";
  if (!TILL_TOKENS.includes(request.token)) return `${request.token} is not a token this till takes`;
  if (request.total <= 0n) return "a request for nothing is not a request";
  if (!Number.isInteger(request.marker) || request.marker < 0 || request.marker > 99) {
    return "the order marker is out of range";
  }
  if (request.chains.length === 0) return "a request with no chain cannot be paid";
  if (request.chains.some((id) => !Number.isSafeInteger(id) || id <= 0)) return "a chain id is not a chain id";
  if (!Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0) return "the issue time is not a time";
  if (request.merchant.includes("\n")) return "the merchant name spans lines";
  return undefined;
}

/**
 * Seal a request for issue. Throws on anything malformed: a QR is the one place
 * a bad field must not reach, because from there it reaches a customer's wallet.
 */
export function sealRequest(request: PaymentRequest): SealedRequest {
  const bad = validate(request);
  if (bad !== undefined) throw new TypeError(`cannot issue this request: ${bad}`);
  const normalised: PaymentRequest = Object.freeze({
    ...request,
    recipient: checksumAddress(request.recipient.slice(2)),
    chains: Object.freeze([...request.chains]),
  });
  const canonical = canonicalRequest(normalised);
  const digest = digestOf(canonical);
  return Object.freeze({ request: normalised, digest, text: `${canonical}|${digest}` });
}

/**
 * Read a scanned request, or say why not.
 *
 * Never throws and never partially succeeds. A request whose digest does not
 * match its contents is refused outright rather than shown with a warning: a
 * waiter reading a warning under a large number will read the number.
 */
export function decodeRequest(text: string): DecodeResult {
  const trimmed = text.trim();
  const parts = trimmed.split("|");
  if (parts.length !== 9 || parts[0] !== REQUEST_PREFIX) {
    return { ok: false, reason: "That is not a La Caja payment request." };
  }
  const [, merchant64, recipient, token, total, marker, chains, issuedAt, digest] = parts as string[];
  let merchant: string;
  try {
    merchant = unb64url(merchant64 as string);
  } catch {
    return { ok: false, reason: "The merchant name in this request is unreadable." };
  }
  if (!/^\d+$/.test(total as string) || !/^\d+$/.test(marker as string) || !/^\d+$/.test(issuedAt as string)) {
    return { ok: false, reason: "A number in this request is not a number." };
  }
  if (!/^\d+(\.\d+)*$/.test(chains as string)) {
    return { ok: false, reason: "The chain list in this request is malformed." };
  }
  const request: PaymentRequest = Object.freeze({
    merchant,
    recipient: recipient as string,
    token: token as TillToken,
    total: BigInt(total as string),
    marker: Number(marker),
    chains: Object.freeze((chains as string).split(".").map(Number)),
    issuedAt: Number(issuedAt),
  });
  const bad = validate(request);
  if (bad !== undefined) return { ok: false, reason: `This request is not usable: ${bad}.` };

  const canonical = canonicalRequest(request);
  if (digestOf(canonical) !== digest) {
    /* Either a mis-scan or an edit. We cannot tell which and must not guess:
     * both mean the figure on this screen is not the figure that was issued. */
    return {
      ok: false,
      reason: "This request does not match its own checksum. It was altered or " +
        "misread after it was issued; ask the cashier to show it again.",
    };
  }
  return { ok: true, sealed: Object.freeze({ request, digest, text: canonical + "|" + digest }) };
}

export type AcceptResult =
  | { ok: true; sealed: SealedRequest }
  | { ok: false; reason: string };

/**
 * The waiter's admission check: decode, then insist the money goes where this
 * terminal was told the restaurant's money goes.
 *
 * This is the whole anti-forgery story and it is deliberately not cryptographic.
 * The request carries no signature (see the header), so a forged one is
 * indistinguishable from a genuine one — except in where it pays. Pinning the
 * recipient to the address the shell handed us reduces every forgery to
 * "someone made the restaurant a bill", which the restaurant can settle at the
 * counter, and eliminates the only version that loses the restaurant money.
 *
 * Case-insensitive because one side is checksummed and the other may not be;
 * these are the same 20 bytes and refusing on capitalisation would be a
 * security theatre that stops service.
 */
export function acceptRequest(text: string, expectedRecipient: string): AcceptResult {
  const decoded = decodeRequest(text);
  if (!decoded.ok) return decoded;
  const want = expectedRecipient.toLowerCase();
  const got = decoded.sealed.request.recipient.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(want)) {
    return { ok: false, reason: "This terminal has no merchant address to check the request against." };
  }
  if (want !== got) {
    return {
      ok: false,
      reason: `This request pays ${decoded.sealed.request.recipient}, which is not this ` +
        `restaurant's address. Refused — do not show it to a customer.`,
    };
  }
  return { ok: true, sealed: decoded.sealed };
}
