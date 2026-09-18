/**
 * `crypto-hdkey` (BCR-2020-007), read with the strict reader: the handshake.
 *
 * The device shows its account xpub once as `ur:crypto-hdkey`; the companion
 * derives addresses from it and holds them watch-only. Field numbers from
 * Keystone's ur-registry `CryptoHDKey.ts`:
 *
 *   ur:crypto-hdkey/<bare CBOR map>
 *       1  is-master           bool
 *       2  is-private          bool
 *       3  key-data            bstr .size 33
 *       4  chain-code          bstr .size 32
 *       5  use-info            305(crypto-coin-info)
 *       6  origin              304(crypto-keypath)
 *       7  children            304(crypto-keypath)
 *       8  parent-fingerprint  uint32
 *       9  name                tstr
 *       10 note                tstr
 *
 * Refusals beyond the grammar live in `HdkeyRefused` rather than as new
 * E4527 codes, because the E4527 codes are shared with the firmware's
 * decoder and the firmware never reads a crypto-hdkey — it only writes one.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";
import { keccak_256 } from "@noble/hashes/sha3";
import { E4527 } from "./errors.ts";
import { Reader, TAG_CRYPTO_COIN_INFO, TAG_CRYPTO_KEYPATH } from "./reader.ts";
import { readKeypathBody, formatKeypath, type Keypath } from "./sign-request.ts";

/** Longest name or note we keep. Display text from an untrusted frame. */
export const MAX_HDKEY_TEXT = 64;

/** SLIP-44 coin type for Ether. */
const COIN_ETH = 60;

export interface CryptoHdkey {
  /** Compressed secp256k1 public key. */
  keyData: Uint8Array;
  chainCode: Uint8Array;
  /** Coin type from use-info; 60 (Ether) when the key omits it. */
  coinType: number;
  network: number;
  origin: Keypath;
  /** How children are named below this key; defaults to `0/*`. */
  children?: Keypath;
  parentFingerprint?: number;
  name?: string;
  note?: string;
}

export const HdkeyRefusal = {
  /** is-private true. A companion must never be handed a private key. */
  PRIVATE: "HDKEY_PRIVATE",
  /** A master key, or a key with no origin: nothing to put in a sign request. */
  NO_ORIGIN: "HDKEY_NO_ORIGIN",
  /** No chain code, so no child can be derived. */
  NO_CHAIN_CODE: "HDKEY_NO_CHAIN_CODE",
  /** key-data is not a point on secp256k1. */
  BAD_KEY: "HDKEY_BAD_KEY",
  /** use-info names a coin other than Ether. */
  WRONG_COIN: "HDKEY_WRONG_COIN",
  /** A children path this companion cannot derive (hardened, or no trailing wildcard). */
  CHILDREN: "HDKEY_CHILDREN",
} as const;
export type HdkeyRefusal = (typeof HdkeyRefusal)[keyof typeof HdkeyRefusal];

export class HdkeyRefused extends Error {
  readonly code: HdkeyRefusal;
  constructor(code: HdkeyRefusal, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "HdkeyRefused";
    this.code = code;
  }
}

const HDKEY_KEYS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const COIN_INFO_KEYS = new Set([1, 2]);

/** Decode the body of a `ur:crypto-hdkey` and apply the companion's refusals. */
export function decodeCryptoHdkey(cbor: Uint8Array): CryptoHdkey {
  const r = new Reader(cbor, "crypto-hdkey");
  r.expectUntagged();

  let isMaster = false;
  let isPrivate = false;
  let keyData: Uint8Array | undefined;
  let chainCode: Uint8Array | undefined;
  let coinType = COIN_ETH;
  let network = 0;
  let origin: Keypath | undefined;
  let children: Keypath | undefined;
  let parentFingerprint: number | undefined;
  let name: string | undefined;
  let note: string | undefined;

  r.readIntKeyedMap(HDKEY_KEYS, (key) => {
    switch (key) {
      case 1: isMaster = r.in("is-master", () => r.expectBool()); break;
      case 2: isPrivate = r.in("is-private", () => r.expectBool()); break;
      case 3: keyData = r.in("key-data", () => r.expectBytes(33)); break;
      case 4: chainCode = r.in("chain-code", () => r.expectBytes(32)); break;
      case 5:
        r.in("use-info", () => {
          r.expectTag(TAG_CRYPTO_COIN_INFO);
          r.readIntKeyedMap(COIN_INFO_KEYS, (k) => {
            if (k === 1) coinType = r.in("use-info.type", () => r.expectUint());
            else network = r.in("use-info.network", () => r.expectUint());
          });
        });
        break;
      case 6:
        origin = r.in("origin", () => { r.expectTag(TAG_CRYPTO_KEYPATH); return readKeypathBody(r); });
        break;
      case 7:
        children = r.in("children", () => { r.expectTag(TAG_CRYPTO_KEYPATH); return readKeypathBody(r); });
        break;
      case 8: parentFingerprint = r.in("parent-fingerprint", () => r.expectUint()); break;
      case 9: name = r.in("name", () => r.expectText(MAX_HDKEY_TEXT)); break;
      case 10: note = r.in("note", () => r.expectText(MAX_HDKEY_TEXT)); break;
    }
  });
  r.expectEnd();

  if (keyData === undefined) r.in("key-data", () => r.fail(E4527.MISSING_FIELD, "required"));

  /* Checked before anything else about the key: whatever else is wrong with a
     frame carrying a private key, the thing to say is that it carried one. */
  if (isPrivate) {
    throw new HdkeyRefused(HdkeyRefusal.PRIVATE,
      "this is a private key; a companion only ever takes a public one");
  }
  if (isMaster || origin === undefined || origin.components.length === 0) {
    /* The origin path is echoed back in every eth-sign-request so the device
       can re-derive and check the signer. Without it there is no path to
       send, and guessing m/44'/60'/0' would sign with whatever key that is. */
    throw new HdkeyRefused(HdkeyRefusal.NO_ORIGIN,
      "the key has no origin path, so requests could not name the signing key");
  }
  if (origin.components.some((c) => c.index === undefined)) {
    throw new HdkeyRefused(HdkeyRefusal.NO_ORIGIN, "the origin path contains a wildcard");
  }
  if (chainCode === undefined) {
    throw new HdkeyRefused(HdkeyRefusal.NO_CHAIN_CODE, "no chain code, so no address can be derived");
  }
  if (coinType !== COIN_ETH) {
    throw new HdkeyRefused(HdkeyRefusal.WRONG_COIN, `use-info names coin ${coinType}, not Ether (60)`);
  }
  try {
    secp256k1.ProjectivePoint.fromHex(keyData!);
  } catch {
    throw new HdkeyRefused(HdkeyRefusal.BAD_KEY, "key-data is not a secp256k1 public key");
  }
  if (children !== undefined) childPrefix(children);

  return {
    keyData: keyData!,
    chainCode,
    coinType,
    network,
    origin,
    ...(children !== undefined ? { children } : {}),
    ...(parentFingerprint !== undefined ? { parentFingerprint } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * The fixed, non-hardened indices before the trailing wildcard of `children`.
 *
 * Hardened steps cannot be derived from a public key at all, and a children
 * path with no wildcard names one address rather than a list; both are
 * refused rather than approximated.
 */
function childPrefix(children: Keypath): number[] {
  const c = children.components;
  const last = c[c.length - 1];
  if (last === undefined || last.index !== undefined || last.hardened) {
    throw new HdkeyRefused(HdkeyRefusal.CHILDREN, "children must end in a non-hardened wildcard");
  }
  const prefix = c.slice(0, -1);
  if (prefix.some((s) => s.index === undefined || s.hardened)) {
    throw new HdkeyRefused(HdkeyRefusal.CHILDREN,
      "children may only contain non-hardened indices before the wildcard");
  }
  return prefix.map((s) => s.index!);
}

/** BIP-32 CKDpub: one non-hardened step from a compressed public key. */
function ckdPub(key: Uint8Array, chainCode: Uint8Array, index: number): { key: Uint8Array; chainCode: Uint8Array } {
  if (index < 0 || index >= 0x80000000) throw new Error("hdkey: hardened derivation needs a private key");
  const data = new Uint8Array(37);
  data.set(key, 0);
  new DataView(data.buffer).setUint32(33, index, false);
  const I = hmac(sha512, chainCode, data);
  const il = BigInt("0x" + [...I.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  /* BIP-32 says to skip to the next index when IL >= n or the child is the
     point at infinity. Probability ~2^-127; refusing is simpler than a skip
     rule both ends would have to agree on, and it will not happen. */
  if (il === 0n || il >= secp256k1.CURVE.n) throw new Error("hdkey: invalid child, try another index");
  const child = secp256k1.ProjectivePoint.BASE.multiply(il)
    .add(secp256k1.ProjectivePoint.fromHex(key));
  return { key: child.toRawBytes(true), chainCode: I.slice(32) };
}

/** EIP-55 checksummed address of a compressed public key. */
export function publicKeyToAddress(compressed: Uint8Array): string {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  const hex = [...hash.subarray(12)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const check = keccak_256(new TextEncoder().encode(hex));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (check[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? hex[i]!.toUpperCase() : hex[i]!;
  }
  return out;
}

export interface DerivedAccount {
  index: number;
  address: string;
  /** Full path from the master key, as it goes into an eth-sign-request. */
  path: Keypath;
}

/**
 * Addresses `first` .. `first + count - 1` below an exported account key.
 *
 * Each carries its full path — origin plus children — because the device
 * re-derives from that path and refuses when the result is not the address
 * it was asked to sign for. The source fingerprint travels with it for the
 * same reason Keystone's requests carry it: it lets a device holding several
 * seeds say "not mine" instead of signing with the wrong one.
 */
export function deriveAccounts(key: CryptoHdkey, count: number, first = 0): DerivedAccount[] {
  const prefix = key.children !== undefined ? childPrefix(key.children) : [0];
  let node = { key: key.keyData, chainCode: key.chainCode };
  for (const i of prefix) node = ckdPub(node.key, node.chainCode, i);

  const out: DerivedAccount[] = [];
  for (let i = first; i < first + count; i++) {
    const child = ckdPub(node.key, node.chainCode, i);
    const components = [
      ...key.origin.components,
      ...prefix.map((index) => ({ index, hardened: false })),
      { index: i, hardened: false },
    ];
    out.push({
      index: i,
      address: publicKeyToAddress(child.key),
      path: {
        components,
        ...(key.origin.sourceFingerprint !== undefined
          ? { sourceFingerprint: key.origin.sourceFingerprint } : {}),
      },
    });
  }
  return out;
}

/** The origin path as text, for a UI that has to say what was exported. */
export function describeHdkey(key: CryptoHdkey): string {
  return formatKeypath(key.origin.components);
}
