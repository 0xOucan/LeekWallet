/**
 * Signing over the QR air gap: an unsigned transaction out as
 * `eth-sign-request`, a signature back as `eth-signature`.
 *
 * Kept out of the UI so the checks that decide whether a scanned signature is
 * used at all — right request, right signer — are code a test can break.
 *
 * What the companion shows is a suggestion. The device decodes the RLP itself
 * and draws what it will sign; nothing here is displayed by the device as the
 * companion's claim. That is why the whole unsigned transaction travels, not a
 * hash: a hash is something the device could only sign blind.
 */

import {
  keccak256, recoverAddress, serializeTransaction,
  type Address, type Hex,
} from "viem";
import {
  decodeEthSignature, encodeEthSignRequest, SignDataType, type Keypath,
} from "./eip4527/sign-request.ts";

/**
 * The one shape of unsigned transaction every signing path builds.
 *
 * It was an inline object literal in each builder, and the copies had
 * started to differ in which optional fields they carried. One type means
 * the USB path, the WalletConnect path and the QR path serialise the same
 * thing, and a field added to one is a compile error in the others.
 */
export interface UnsignedTransaction {
  chainId: number;
  nonce: number;
  to: Address;
  value: bigint;
  data?: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  type: "eip1559";
}

const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.replace(/^0x/, "").match(/../g) ?? []).map((h) => parseInt(h, 16)));

const bytesToHex = (b: Uint8Array): Hex =>
  ("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("")) as Hex;

/** A fresh RFC 4122 v4 UUID, as the 16 bytes tag 37 carries. */
export function newRequestId(): Uint8Array {
  const id = crypto.getRandomValues(new Uint8Array(16));
  id[6] = (id[6]! & 0x0f) | 0x40;
  id[8] = (id[8]! & 0x3f) | 0x80;
  return id;
}

/** Unsigned EIP-2718 bytes: `0x02 ‖ rlp([...])`, which is what the device hashes. */
export function unsignedBytes(tx: UnsignedTransaction): Uint8Array {
  return hexToBytes(serializeTransaction(tx));
}

/**
 * The CBOR body of an `eth-sign-request` for a transaction.
 *
 * data-type 4 (typed transaction), because the payload is EIP-1559 with its
 * type byte. `address` is included so a device can refuse before deriving
 * anything if the account is not one of its own.
 */
export function ethSignRequestForTx(
  tx: UnsignedTransaction,
  requestId: Uint8Array,
  path: Keypath,
  from: Address,
): Uint8Array {
  return encodeEthSignRequest({
    requestId,
    signData: unsignedBytes(tx),
    dataType: SignDataType.TypedTransaction,
    chainId: tx.chainId,
    derivationPath: path,
    address: hexToBytes(from),
  });
}

/**
 * Read a scanned `eth-signature`, and use it only if it answers this request
 * from this signer. Returns the signed, serialised transaction.
 *
 * The request-id check catches the ordinary failure: a signature for an
 * earlier request still on the device's screen, or a second device in view.
 * The recovery check is the one that cannot be argued with — whatever the
 * frame claims, a signature that does not recover to `from` over exactly
 * these unsigned bytes is not broadcast. Without it a wrong-account signature
 * would reach the network and fail there, or worse, succeed from an account
 * the user was not looking at.
 */
export async function signedTxFromEthSignature(
  cbor: Uint8Array,
  requestId: Uint8Array,
  tx: UnsignedTransaction,
  from: Address,
): Promise<Hex> {
  const sig = decodeEthSignature(cbor);
  if (sig.requestId.length !== requestId.length ||
      sig.requestId.some((b, i) => b !== requestId[i])) {
    throw new Error("that signature answers a different request; scan the one the device is showing now");
  }

  const r = bytesToHex(sig.signature.subarray(0, 32));
  const s = bytesToHex(sig.signature.subarray(32, 64));
  const v = sig.signature[64]!;
  /* Typed transactions carry yParity; some signers still write 27/28. Both
     are read, anything else is refused rather than masked — masking a low
     bit is how a legacy v became an inverted parity in this codebase once. */
  let yParity: number;
  if (v === 0 || v === 1) yParity = v;
  else if (v === 27 || v === 28) yParity = v - 27;
  else throw new Error(`signature v is ${v}; expected 0, 1, 27 or 28`);

  const hash = keccak256(bytesToHex(unsignedBytes(tx)));
  const signer = await recoverAddress({ hash, signature: { r, s, yParity } });
  if (signer.toLowerCase() !== from.toLowerCase()) {
    throw new Error(`the signature is from ${signer}, not ${from}; nothing was broadcast`);
  }
  return serializeTransaction(tx, { r, s, yParity });
}
