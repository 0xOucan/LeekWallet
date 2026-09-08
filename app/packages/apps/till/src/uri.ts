/**
 * The customer-facing artefacts: an EIP-681 payment URI, and a link that can be
 * sent over WhatsApp.
 *
 * ---------------------------------------------------------------------------
 * Why this writes a URI when core only reads one
 *
 * `core/src/payment-uri.ts` parses EIP-681 — it is the wallet's scanner, and it
 * has no writer, because until now nothing in this project ever asked anyone
 * for money. This is the writer, and it lives in the app because being a payee
 * is what the app is; the wallet remains a payer with it deleted.
 *
 * The two are held together by test/uri.test.ts, which parses everything this
 * emits with core's parser and asserts the four fields come back identical.
 * That round trip is the real specification: an emitter that agreed with its
 * own idea of the grammar and with no reader's would be worthless, and every
 * customer wallet in the world is a reader we cannot test against.
 *
 * ---------------------------------------------------------------------------
 * The one field order that matters
 *
 *     ethereum:<TOKEN>@<chain>/transfer?address=<RECIPIENT>&uint256=<raw>
 *
 * The path target is the TOKEN CONTRACT and `address=` is the RECIPIENT.
 * Backwards, this is a transfer of the merchant's takings to the token
 * contract, where they stay forever. core's parser keeps the two in separately
 * named fields for exactly this reason, and the round-trip test checks the
 * mapping in the direction this file writes it.
 *
 * `uint256` is written as plain digits, never EIP-681's `1.2e6` exponent form.
 * The grammar allows it, some readers get it wrong, and there is no upside to
 * a compact spelling in a QR that has room.
 */

import { checksumAddress } from "@leekwallet/core/tx-interpret.ts";

/**
 * The four fields an EIP-681 transfer URI carries.
 *
 * Named for the URI rather than for the bill: `PaymentRequest` in request.ts is
 * the thing the cashier issues and the waiter displays, and two types with one
 * name in one package is how a recipient ends up in an amount's place.
 */
export interface PaymentUriParts {
  chainId: number;
  /** The ERC-20 being transferred. */
  token: string;
  /** Where the money lands. In C5 this becomes the chain's CajaInbox. */
  recipient: string;
  /** Raw token units, already scaled and already carrying the order marker. */
  amount: bigint;
}

/** EIP-55 form, or a throw. A malformed address must never reach a QR. */
function address20(raw: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new TypeError(`${what} is not a 20-byte address: ${raw.slice(0, 24)}`);
  return checksumAddress(raw.slice(2));
}

export function buildPaymentUri(req: PaymentUriParts): string {
  if (req.amount <= 0n) throw new RangeError("a payment request must be for a positive amount");
  if (!Number.isSafeInteger(req.chainId) || req.chainId <= 0) throw new RangeError("bad chain id");
  const token = address20(req.token, "token contract");
  const recipient = address20(req.recipient, "recipient");
  return `ethereum:${token}@${req.chainId}/transfer?address=${recipient}&uint256=${req.amount}`;
}

/**
 * What gets pasted into a chat.
 *
 * A bill in Latin America is settled over WhatsApp as often as at the table, so
 * the shareable form is a first-class output and not a developer convenience.
 * It is plain text with the URI on its own line: a customer whose wallet
 * handles `ethereum:` taps it, and one whose wallet does not can still read the
 * amount and the chain and pay by hand. A link that only worked in one wallet
 * would be worse than the QR it duplicates.
 */
export function shareMessage(opts: {
  merchant: string;
  totalText: string;
  token: string;
  chainName: string;
  uri: string;
}): string {
  return [
    `${opts.merchant} — ${opts.totalText} ${opts.token}`,
    `Pay on ${opts.chainName}:`,
    opts.uri,
  ].join("\n");
}

/**
 * A wa.me link for that message. `wa.me` is WhatsApp's own share endpoint and
 * needs no app id, no SDK and no script on the page — the terminal opens a URL
 * and WhatsApp does the rest. Nothing about the bill leaves the device until
 * the waiter presses it.
 */
export function whatsappLink(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
