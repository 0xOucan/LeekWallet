/**
 * Which signer answers a dapp's request, and what signing over QR is.
 *
 * Kept out of the worker so the decisions that matter are code a test can
 * break: which account an address resolves to, which methods QR refuses,
 * and which scanned signature is allowed anywhere near the network.
 */

import type { Address, Hex } from "viem";
import {
  ethSignRequestForTx, newRequestId, signedTxFromEthSignature,
  type UnsignedTransaction,
} from "../../packages/core/src/qr-signing.ts";
import type { DerivedAccount } from "../../packages/core/src/eip4527/hdkey.ts";
import { EIP1193, type QrJobView } from "./protocol.ts";

export class SignerRefused extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "SignerRefused";
  }
}

export type SignerRoute =
  | { kind: "device"; index: number }
  | { kind: "qr"; account: DerivedAccount };

/**
 * Resolve the address a signing request names, or refuse.
 *
 * Case-insensitive, because dapps send checksummed, lowercase and (rarely)
 * uppercase forms of the same address. But it must be one this origin was
 * granted: an origin that could name any address the wallet knows could ask
 * for a signature from an account the user never connected to it.
 *
 * `device` is the live USB session's addresses, or null with none; `qr` is
 * the QR pairing's accounts, or null. The session wins when both offer the
 * address, as it does everywhere else.
 */
export function routeSigner(
  address: unknown,
  granted: readonly string[],
  device: readonly string[] | null,
  qr: readonly DerivedAccount[] | null,
): SignerRoute {
  if (typeof address !== "string") {
    throw new SignerRefused(EIP1193.invalidParams, "no address was given");
  }
  const want = address.toLowerCase();
  if (!granted.includes(want)) {
    throw new SignerRefused(EIP1193.unauthorized, "that address has not been connected to this site");
  }
  const index = device?.findIndex((a) => a.toLowerCase() === want) ?? -1;
  if (index >= 0) return { kind: "device", index };
  const account = qr?.find((a) => a.address.toLowerCase() === want);
  if (account !== undefined) return { kind: "qr", account };
  throw new SignerRefused(
    EIP1193.unauthorized,
    "the device is not currently offering that address — it may be locked, " +
    "or on a different wallet or account than when this site connected",
  );
}

/**
 * Why a method cannot be signed over QR, or null if it can.
 *
 * Only transactions go over QR. The device's QR path decodes and draws an
 * `eth-sign-request` carrying a typed transaction and nothing else yet; a
 * message or typed data sent to it would be refused on the device, or worse,
 * drawn by a path that was never built to show it. Refusing here says so to
 * the dapp at once instead of sending the user to a device that will say no.
 */
export function refuseOverQr(method: string): string | null {
  if (method === "eth_sendTransaction") return null;
  return `${method} is not available for a QR-paired account yet: the device only ` +
    "reads transactions over QR. Connect it over USB to sign messages or typed data.";
}

/**
 * The QR job for one transaction: the view the scan tab draws, and the check
 * that decides whether a scanned signature is used.
 *
 * The request id is fresh per call and never leaves this closure except
 * inside the request QR, so a signature left over from an earlier request -
 * still on the device's screen - cannot answer this one. The check itself is
 * core's: request id first, then recovery to `from` over exactly these
 * unsigned bytes. Nothing the tab says about the signature is trusted.
 */
export function qrSignJob(
  tx: UnsignedTransaction,
  account: DerivedAccount,
  origin: string,
): { view: Omit<QrJobView, "id">; accept: (cbor: Uint8Array) => Promise<Hex> } {
  const from = account.address as Address;
  const requestId = newRequestId();
  const cbor = ethSignRequestForTx(tx, requestId, account.path, from);
  const hex = [...cbor].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    view: {
      title: "Sign on the device",
      summary: [
        `requested by ${origin}`,
        `from ${from}`,
        `to ${tx.to}`,
        `value ${tx.value} wei`,
        `chain ${tx.chainId}, nonce ${tx.nonce}`,
        `gas ${tx.gas}, max fee ${tx.maxFeePerGas} wei, priority ${tx.maxPriorityFeePerGas} wei`,
        tx.data === undefined ? "no calldata" : `calldata ${(tx.data.length - 2) / 2} bytes`,
      ],
      show: {
        type: "eth-sign-request",
        cbor: hex,
        instructions:
          "Scan this with the device. Check every page it shows — chain, nonce, recipient " +
          "and amount — then approve there. It will answer with a QR code of its own.",
      },
      scan: {
        type: "eth-signature",
        instructions: "Hold the device's signature QR in front of this camera.",
      },
    },
    accept: (body) => signedTxFromEthSignature(body, requestId, tx, from),
  };
}
