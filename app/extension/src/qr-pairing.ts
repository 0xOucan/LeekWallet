/**
 * A device paired by QR: the account key it exported, and the addresses
 * derived from it.
 *
 * There is no session behind this. The device showed a `ur:crypto-hdkey`
 * once, and everything here is computed from that public key. It can derive
 * every address in the account and sign nothing; each signature is a request
 * QR the device scans, decodes and shows on its own screen.
 */

import {
  decodeCryptoHdkey, deriveAccounts, describeHdkey,
  type CryptoHdkey, type DerivedAccount,
} from "../../packages/core/src/eip4527/hdkey.ts";

/** As many addresses as the USB path derives, so the pickers look the same. */
export const QR_ACCOUNT_COUNT = 10;

export interface QrPairing {
  key: CryptoHdkey;
  accounts: DerivedAccount[];
  /** The exported key's origin path, e.g. m/44'/60'/0'. */
  describe: string;
}

/**
 * Decode a scanned `crypto-hdkey` body and derive its addresses.
 *
 * Throws on anything core refuses - a private key, a master key, a key for
 * another coin - so the scan tab says why and keeps scanning rather than
 * pairing with something that cannot be signed for.
 */
export function pairingFromCbor(cbor: Uint8Array): QrPairing {
  const key = decodeCryptoHdkey(cbor);
  return {
    key,
    accounts: deriveAccounts(key, QR_ACCOUNT_COUNT),
    describe: describeHdkey(key),
  };
}
