/**
 * A stand-in device for the QR tests: BIP-32 test vector 1's seed, public by
 * design, exported the way the device exports an account key.
 */

import { HDKey } from "viem/accounts";
import { Writer } from "../../packages/core/src/eip4527/writer.ts";
import { TAG_CRYPTO_COIN_INFO } from "../../packages/core/src/eip4527/reader.ts";
import { parseKeypath, writeKeypath } from "../../packages/core/src/eip4527/sign-request.ts";

const unhex = (h: string): Uint8Array =>
  new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

export const master = HDKey.fromMasterSeed(unhex("000102030405060708090a0b0c0d0e0f"));
export const account = master.derive("m/44'/60'/0'");

/** The body of a `ur:crypto-hdkey` for m/44'/60'/0', optionally marked private. */
export function hdkeyCbor(opts: { isPrivate?: boolean } = {}): Uint8Array {
  const w = new Writer();
  const entries: [number, () => void][] = [];
  if (opts.isPrivate) entries.push([2, () => w.bool(true)]);
  entries.push([3, () => w.bytes(account.publicKey!)]);
  entries.push([4, () => w.bytes(account.chainCode!)]);
  entries.push([5, () => w.tag(TAG_CRYPTO_COIN_INFO).map(2).uint(1).uint(60).uint(2).uint(0)]);
  entries.push([6, () => writeKeypath(w, {
    components: parseKeypath("m/44'/60'/0'"), sourceFingerprint: master.fingerprint, depth: 3,
  })]);
  w.map(entries.length);
  for (const [k, v] of entries) { w.uint(k); v(); }
  return w.finish();
}

/** The private key the device would sign index `i` with. */
export function devicePrivateKey(i: number): Uint8Array {
  return master.derive(`m/44'/60'/0'/0/${i}`).privateKey!;
}
