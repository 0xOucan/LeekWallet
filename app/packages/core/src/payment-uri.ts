/**
 * Recipient scanning: what a camera hands the send form.
 *
 * A QR code aimed at a send form is the one place in this app where a string
 * of unknown origin becomes a destination for money. A camera does not know
 * what it is looking at — it will happily decode a dapp's website, a bitcoin
 * invoice, a token contract, or a scan that lost a character to glare — so
 * everything here is written to refuse rather than to guess. There is no
 * recovery from sending to the wrong address, and no amount of convenience is
 * worth widening the set of strings that parse.
 *
 * Three shapes are understood, all of them EIP-681 or a subset:
 *
 *   0x…                                        a bare address
 *   ethereum:0x…[@chain][?value=…]             a native payment
 *   ethereum:<token>@chain/transfer?address=…  an ERC-20 payment
 *
 * The last one is the trap. Its path target is the TOKEN CONTRACT and its
 * `address` parameter is the RECIPIENT; reading it the obvious way sends the
 * tokens to the token, which is the classic way to burn them forever. The
 * result type keeps the two in separately named fields so a caller cannot mix
 * them up by accident, and a test asserts the mapping directly.
 *
 * Checksums are the other safety property. EIP-55 casing turns a 40-hex string
 * into a string with roughly 30 bits of error detection, which is exactly what
 * catches a scan that misread a character. So: mixed case is checked and a
 * mismatch is refused. Single-case input carries no such information and is
 * accepted, because that is what plenty of legitimate sources emit — it is
 * unchecked, not wrong.
 *
 * Names (`vitalik.eth`) are refused by name. Resolving one needs a network
 * lookup this app cannot perform and could not verify if it did, and a name
 * that silently resolved through an untrusted answer would be a redirect of
 * funds that looks identical to a correct send.
 *
 * Amounts are BigInt end to end, including EIP-681's exponent form. `1e18`
 * through `Number` is fine by luck and `1.1e21` is not; at token scale a float
 * quietly changes the amount, so no value here ever touches one.
 *
 * Pure and network-free. Never throws on bad input: every rejection is a
 * sentence for the user.
 */

import { checksumAddress } from "./tx-interpret.ts";

/** What the scan turned out to be. A string union — this codebase strips types. */
export type PaymentUriKind =
  /** A plain recipient. No chain, no amount was stated. */
  | "address"
  /** A native-currency payment: recipient, maybe a chain, maybe a value. */
  | "native"
  /** An ERC-20 `transfer`: recipient AND the token contract it goes through. */
  | "token-transfer";

export interface PaymentAddress {
  kind: "address";
  /** EIP-55 checksummed. Always the party that receives the money. */
  recipient: string;
}

export interface PaymentNative {
  kind: "native";
  recipient: string;
  /** EIP-681 `@chainId`, absent when the URI did not say. */
  chainId?: number;
  /** Wei, exact. Absent when the URI named no amount. */
  value?: bigint;
}

export interface PaymentTokenTransfer {
  kind: "token-transfer";
  /** The `address=` parameter — where the tokens land. NOT the path target. */
  recipient: string;
  /** The path target — the ERC-20 the transfer is called on. */
  token: string;
  chainId?: number;
  /** `uint256=`, in the token's own raw units. Undecoded: decimals are unknown. */
  amount?: bigint;
}

export type Payment = PaymentAddress | PaymentNative | PaymentTokenTransfer;

export type PaymentUriResult =
  | { ok: true; payment: Payment }
  /** `reason` is written to be shown to a user, not to a developer. */
  | { ok: false; reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Schemes seen often enough on a wallet screen to be worth naming back. */
const KNOWN_OTHER_SCHEMES: Record<string, string> = {
  bitcoin: "That is a Bitcoin address. This wallet signs Ethereum transactions only.",
  wc: "That is a WalletConnect pairing link, not an address. Use the Connect screen for it.",
  http: "That is a web address, not an Ethereum address.",
  https: "That is a web address, not an Ethereum address.",
};

const fail = (reason: string): PaymentUriResult => ({ ok: false, reason });

/**
 * A 20-byte address, checksum-checked when the input carries a checksum.
 *
 * Returns the EIP-55 form so everything downstream compares and displays one
 * canonical spelling, which is also the spelling a user can check by eye
 * against a device screen.
 */
function normaliseAddress(raw: string, what: string): { ok: true; address: string } | { ok: false; reason: string } {
  if (raw === "") return { ok: false, reason: `No ${what} in that code.` };
  if (!raw.startsWith("0x")) {
    // The commonest cause by far, and the one with a real workaround.
    if (/^[0-9a-zA-Z-]+\.[a-zA-Z]{2,}$/.test(raw)) {
      return {
        ok: false,
        reason: `"${raw.slice(0, 40)}" is a name, not an address. This app has no name ` +
          `resolution and could not check the answer if it did — a lookup could point ` +
          `anywhere. Paste or scan the 0x… address itself.`,
      };
    }
    return { ok: false, reason: `That ${what} does not start with 0x, so it is not an Ethereum address.` };
  }

  const body = raw.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    return { ok: false, reason: `That ${what} contains characters that are not hex digits; the scan may be damaged.` };
  }
  if (body.length !== 40) {
    return {
      ok: false,
      reason: `That ${what} is ${body.length} hex digits, not 40 — it looks ` +
        `${body.length < 40 ? "truncated" : "too long"}. Scan it again.`,
    };
  }

  const canonical = checksumAddress(body);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  // Single-case input simply has no checksum to check; mixed case has one, and
  // a mismatch means a character changed since it was written down.
  if (mixed && raw !== canonical) {
    return {
      ok: false,
      reason: `That ${what} fails its EIP-55 checksum, which means at least one character ` +
        `is wrong — a misread scan or a bad copy. It has NOT been accepted. Scan it again.`,
    };
  }
  return { ok: true, address: canonical };
}

/**
 * EIP-681's number grammar, exactly, as a bigint.
 *
 * The spec allows a trailing `e<exponent>`, so `2.014e18` is a legal way to
 * write 2014000000000000000 wei. Implemented as digit shifting rather than
 * arithmetic on a float: `Number("1e18")` happens to be exact and
 * `Number("1.000000000000000001e18")` is not, and there is no way to tell
 * which one a scan contained.
 */
function parseEip681Number(text: string): bigint | undefined {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE](\d+))?$/.exec(text);
  if (!m) return undefined;
  const whole = m[1] as string;
  const frac = m[2] ?? "";
  const exp = m[3] === undefined ? 0 : Number(m[3]);
  // A ludicrous exponent is a denial-of-service dressed as an amount.
  if (exp > 78) return undefined;
  if (frac.length > exp) return undefined; // would truncate: not our call to make
  return BigInt(`${whole}${frac.padEnd(exp, "0")}`);
}

/**
 * Parse a scanned or pasted recipient. Never throws.
 *
 * Strict throughout: an unrecognised EIP-681 function, an unparseable amount or
 * an unknown chain id are refusals, not fields quietly dropped, because a
 * dropped field is a payment that differs from the one the payee asked for.
 */
export function parsePaymentUri(input: string): PaymentUriResult {
  const raw = input.trim();
  if (raw === "") return fail("Nothing scanned — point the camera at the payment code.");

  const colon = raw.indexOf(":");
  if (colon < 0) {
    // No scheme: it is meant to be a bare address (or a name, refused there).
    const addr = normaliseAddress(raw, "address");
    return addr.ok ? { ok: true, payment: { kind: "address", recipient: addr.address } } : fail(addr.reason);
  }

  const scheme = raw.slice(0, colon).toLowerCase();
  if (scheme !== "ethereum") {
    const known = KNOWN_OTHER_SCHEMES[scheme];
    return fail(
      known ?? `That code uses the "${scheme.slice(0, 16)}:" scheme, which this wallet does not ` +
        `understand. It accepts an Ethereum address or an ethereum: payment code.`,
    );
  }

  let body = raw.slice(colon + 1);
  // EIP-681's `pay-` prefix marks the payment form explicitly; it carries no
  // extra meaning here, since the shape that follows says the same thing.
  if (body.toLowerCase().startsWith("pay-")) body = body.slice(4);

  const q = body.indexOf("?");
  const path = q < 0 ? body : body.slice(0, q);
  const params = new URLSearchParams(q < 0 ? "" : body.slice(q + 1));

  const slash = path.indexOf("/");
  const target = slash < 0 ? path : path.slice(0, slash);
  const fn = slash < 0 ? "" : path.slice(slash + 1);

  const at = target.indexOf("@");
  const targetAddress = at < 0 ? target : target.slice(0, at);
  let chainId: number | undefined;
  if (at >= 0) {
    const chainText = target.slice(at + 1);
    // Decimal only. EIP-681 permits it, and a hex chain id here would more
    // likely be a mangled scan than an intentional one.
    if (!/^\d+$/.test(chainText)) {
      return fail(`"${chainText.slice(0, 16)}" is not a chain number, so this payment code cannot be read.`);
    }
    chainId = Number(chainText);
    if (!Number.isSafeInteger(chainId)) return fail("That payment code names an impossible chain number.");
  }

  const targetParsed = normaliseAddress(targetAddress, fn === "" ? "address" : "token contract");
  if (!targetParsed.ok) return fail(targetParsed.reason);

  if (fn === "") {
    const payment: PaymentNative = { kind: "native", recipient: targetParsed.address };
    if (chainId !== undefined) payment.chainId = chainId;
    const value = params.get("value");
    if (value !== null) {
      const wei = parseEip681Number(value);
      if (wei === undefined) {
        return fail(`This payment code asks for "${value.slice(0, 24)}", which is not an amount this app can read exactly. Enter the amount by hand.`);
      }
      payment.value = wei;
    }
    return { ok: true, payment };
  }

  if (fn !== "transfer") {
    // Refusing beats guessing: an `approve` code parsed as a send would set an
    // allowance while the user believed they were paying someone.
    return fail(
      `This payment code calls "${fn.slice(0, 24)}", which this wallet will not run from a scan. ` +
        `Only a plain payment or an ERC-20 transfer can be scanned.`,
    );
  }

  // The recipient is the PARAMETER; the path target is the token. Backwards
  // would send to the contract, where the tokens stay forever.
  const to = params.get("address");
  if (to === null) {
    return fail("This token payment code names no recipient, only a token contract. It looks truncated.");
  }
  const recipient = normaliseAddress(to, "recipient");
  if (!recipient.ok) return fail(recipient.reason);

  const payment: PaymentTokenTransfer = {
    kind: "token-transfer",
    recipient: recipient.address,
    token: targetParsed.address,
  };
  if (chainId !== undefined) payment.chainId = chainId;
  const amountText = params.get("uint256");
  if (amountText !== null) {
    const amount = parseEip681Number(amountText);
    if (amount === undefined) {
      return fail(`This payment code asks for "${amountText.slice(0, 24)}" tokens, which is not an amount this app can read exactly. Enter the amount by hand.`);
    }
    payment.amount = amount;
  }
  return { ok: true, payment };
}
