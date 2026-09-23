/**
 * `eth-sign-request` and `eth-signature` (EIP-4527).
 *
 * The schemas, read with the strict reader in `reader.ts`. Field numbers and
 * the tag placement come from the reference implementations rather than from
 * the ERC's CDDL, which writes `data-type: #3.401(...)` and
 * `derivation-path: #5.304(...)` — major types 3 and 5 are a text string and a
 * map, not semantic tags, so those lines cannot mean what they appear to.
 *
 * Structure, which the spec never states plainly:
 *
 *   ur:eth-sign-request/<bare CBOR map>     <- top level is NOT tagged
 *       1 request-id     37(bstr .size 16)  <- nested items ARE tagged
 *       2 sign-data      bstr
 *       3 data-type      uint 1..4
 *       4 chain-id       uint
 *       5 derivation-path 304(crypto-keypath)
 *       6 address        bstr .size 20
 *       7 origin         tstr
 */

import { E4527 } from "./errors.ts";

/* The same limits as src/eip4527.h. They are schema properties, not C buffer
   sizes: a frame the device refuses must not be one the companion forwards. */
export const MAX_SIGN_DATA = 1024;
export const MAX_ORIGIN = 64;
import {
  Reader,
  TAG_UUID,
  TAG_CRYPTO_KEYPATH,
} from "./reader.ts";
import { Writer } from "./writer.ts";

/** The four values EIP-4527 defines. Anything else is a refusal. */
export const SignDataType = {
  Transaction: 1,
  TypedData: 2,
  PersonalMessage: 3,
  TypedTransaction: 4,
} as const;

export type SignDataType = (typeof SignDataType)[keyof typeof SignDataType];

export interface Keypath {
  /** Indices with their hardened flag, in order. A wildcard has no index. */
  components: { index?: number; hardened: boolean }[];
  sourceFingerprint?: number;
  depth?: number;
}

export interface EthSignRequest {
  requestId?: Uint8Array;
  signData: Uint8Array;
  dataType: SignDataType;
  chainId: number;
  derivationPath: Keypath;
  address?: Uint8Array;
  origin?: string;
}

export interface EthSignature {
  requestId: Uint8Array;
  /** r ‖ s ‖ v, which EIP-4527 fixes at 65 bytes. */
  signature: Uint8Array;
  origin?: string;
}

const KEYPATH_KEYS = new Set([1, 2, 3]);

/**
 * A crypto-keypath, already positioned past its tag.
 *
 * Exported for crypto-hdkey, whose origin and children are the same
 * structure. Sharing it is the point: one keypath grammar, not one per
 * message that happens to carry a path.
 */
export function readKeypathBody(r: Reader): Keypath {
  const out: Keypath = { components: [] };
  r.readIntKeyedMap(KEYPATH_KEYS, (key) => {
    switch (key) {
      case 1: {
        r.in("derivation-path.components", () => {
          const n = r.expectArray();
          /* Flat pairs: index (or an empty array for a wildcard), then the
             hardened flag as a boolean. The flag is encoded as a CBOR simple
             value, which this grammar does not contain, so it arrives as the
             one-byte forms 0xF4/0xF5 and is read directly. */
          if (n % 2 !== 0) {
            r.fail(E4527.MALFORMED, "components is not a sequence of pairs");
          }
          for (let i = 0; i < n; i += 2) {
            let index: number | undefined;
            if (r.peekIsEmptyArray()) {
              r.expectArray();
            } else {
              index = r.expectUint();
            }
            const hardened = r.expectBool();
            out.components.push(index === undefined ? { hardened } : { index, hardened });
          }
        });
        break;
      }
      case 2:
        out.sourceFingerprint = r.in("derivation-path.source-fingerprint", () => r.expectUint());
        break;
      case 3:
        out.depth = r.in("derivation-path.depth", () => r.expectUint());
        break;
    }
  });
  return out;
}

const REQUEST_KEYS = new Set([1, 2, 3, 4, 5, 6, 7]);

/** Decode the body of a `ur:eth-sign-request`. */
export function decodeEthSignRequest(cbor: Uint8Array): EthSignRequest {
  const r = new Reader(cbor, "eth-sign-request");

  /* The UR type name is the discriminator; the body is a bare map. A tagged
     top level would mean somebody made this reader generic and changed the
     protocol model without noticing. */
  r.expectUntagged();

  let requestId: Uint8Array | undefined;
  let signData: Uint8Array | undefined;
  let dataType: number | undefined;
  let chainId: number | undefined;
  let derivationPath: Keypath | undefined;
  let address: Uint8Array | undefined;
  let origin: string | undefined;

  r.readIntKeyedMap(REQUEST_KEYS, (key) => {
    switch (key) {
      case 1:
        requestId = r.in("request-id", () => {
          r.expectTag(TAG_UUID);
          return r.expectBytes(16);
        });
        break;
      case 2:
        signData = r.in("sign-data", () => r.expectBytes(undefined, MAX_SIGN_DATA));
        break;
      case 3:
        dataType = r.in("data-type", () => {
          const v = r.expectUint();
          if (v < 1 || v > 4) {
            r.fail(E4527.INVALID_DATA_TYPE,
              `expected unsigned integer 1..4, got ${v}`);
          }
          return v;
        });
        break;
      case 4:
        chainId = r.in("chain-id", () => r.expectUint());
        break;
      case 5:
        derivationPath = r.in("derivation-path", () => {
          r.expectTag(TAG_CRYPTO_KEYPATH);
          return readKeypathBody(r);
        });
        break;
      case 6:
        address = r.in("address", () => r.expectBytes(20));
        break;
      case 7:
        origin = r.in("origin", () => r.expectText(MAX_ORIGIN));
        break;
    }
  });

  r.expectEnd();

  if (signData === undefined) r.in("sign-data", () => r.fail(E4527.MISSING_FIELD, "required"));
  if (dataType === undefined) r.in("data-type", () => r.fail(E4527.MISSING_FIELD, "required"));
  if (derivationPath === undefined) {
    r.in("derivation-path", () => r.fail(E4527.MISSING_FIELD, "required"));
  }

  return {
    ...(requestId !== undefined ? { requestId } : {}),
    signData: signData!,
    dataType: dataType! as SignDataType,
    /* The ERC defaults chain-id to 1 when absent. Defaulting a chain is a
       choice with consequences, so it is written here rather than implied. */
    chainId: chainId ?? 1,
    derivationPath: derivationPath!,
    ...(address !== undefined ? { address } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

const SIGNATURE_KEYS = new Set([1, 2, 3]);

/** Decode the body of a `ur:eth-signature`. */
export function decodeEthSignature(cbor: Uint8Array): EthSignature {
  const r = new Reader(cbor, "eth-signature");
  r.expectUntagged();

  let requestId: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  let origin: string | undefined;

  r.readIntKeyedMap(SIGNATURE_KEYS, (key) => {
    switch (key) {
      case 1:
        requestId = r.in("request-id", () => {
          r.expectTag(TAG_UUID);
          return r.expectBytes(16);
        });
        break;
      case 2:
        /* 65 bytes, r ‖ s ‖ v. Fixed by the ERC, so the reader is inflexible
           rather than merely checking that it is a byte string. */
        signature = r.in("signature", () => r.expectBytes(65));
        break;
      case 3:
        origin = r.in("origin", () => r.expectText(MAX_ORIGIN));
        break;
    }
  });

  r.expectEnd();

  if (requestId === undefined) r.in("request-id", () => r.fail(E4527.MISSING_FIELD, "required"));
  if (signature === undefined) r.in("signature", () => r.fail(E4527.MISSING_FIELD, "required"));

  return {
    requestId: requestId!,
    signature: signature!,
    ...(origin !== undefined ? { origin } : {}),
  };
}

/* ------------------------------------------------------------------ encode */

/** `m/44'/60'/0'/0/3` as keypath components. Wildcards are not writable. */
export function parseKeypath(path: string): Keypath["components"] {
  const parts = path.split("/");
  if (parts[0] === "m") parts.shift();
  return parts.map((p) => {
    const m = /^(\d+)(['h]?)$/.exec(p);
    if (m === null) throw new Error(`keypath: "${p}" is not a path component`);
    const index = Number(m[1]);
    if (index >= 0x80000000) throw new Error(`keypath: ${index} is out of range`);
    return { index, hardened: m[2] !== "" };
  });
}

/** The inverse of `parseKeypath`, for display and logs. */
export function formatKeypath(components: Keypath["components"]): string {
  return ["m", ...components.map((c) =>
    `${c.index === undefined ? "*" : c.index}${c.hardened ? "'" : ""}`)].join("/");
}

export function writeKeypath(w: Writer, k: Keypath): void {
  const pairs = 1 + (k.sourceFingerprint !== undefined ? 1 : 0) + (k.depth !== undefined ? 1 : 0);
  w.tag(TAG_CRYPTO_KEYPATH).map(pairs);
  w.uint(1).array(k.components.length * 2);
  for (const c of k.components) {
    if (c.index === undefined) w.array(0);
    else w.uint(c.index);
    w.bool(c.hardened);
  }
  if (k.sourceFingerprint !== undefined) w.uint(2).uint(k.sourceFingerprint);
  if (k.depth !== undefined) w.uint(3).uint(k.depth);
}

/**
 * Encode the body of a `ur:eth-sign-request`.
 *
 * Refuses, rather than emits, anything `decodeEthSignRequest` would refuse:
 * a request the companion shows that the device then rejects is a dead end
 * the user meets at the far end of an animation, with nothing on either
 * screen saying which side was wrong.
 *
 * Keys ascend, which is the canonical order and what the reference encoders
 * produce, so the same request is the same bytes wherever it was built.
 */
export function encodeEthSignRequest(req: EthSignRequest): Uint8Array {
  if (req.requestId !== undefined && req.requestId.length !== 16) {
    throw new Error("eth-sign-request: request-id must be 16 bytes");
  }
  if (req.signData.length > MAX_SIGN_DATA) {
    throw new Error(`eth-sign-request: sign-data exceeds ${MAX_SIGN_DATA} bytes`);
  }
  if (!Number.isInteger(req.dataType) || req.dataType < 1 || req.dataType > 4) {
    throw new Error(`eth-sign-request: data-type ${req.dataType} is not 1..4`);
  }
  if (req.address !== undefined && req.address.length !== 20) {
    throw new Error("eth-sign-request: address must be 20 bytes");
  }
  if (req.origin !== undefined && new TextEncoder().encode(req.origin).length > MAX_ORIGIN) {
    throw new Error(`eth-sign-request: origin exceeds ${MAX_ORIGIN} bytes`);
  }

  const w = new Writer();
  const pairs = 4 + (req.requestId !== undefined ? 1 : 0) +
    (req.address !== undefined ? 1 : 0) + (req.origin !== undefined ? 1 : 0);
  w.map(pairs);
  if (req.requestId !== undefined) w.uint(1).tag(TAG_UUID).bytes(req.requestId);
  w.uint(2).bytes(req.signData);
  w.uint(3).uint(req.dataType);
  /* Always written, never left to the ERC's default of 1: a request built for
     a testnet that omitted it would be read as mainnet. */
  w.uint(4).uint(req.chainId);
  w.uint(5);
  writeKeypath(w, req.derivationPath);
  if (req.address !== undefined) w.uint(6).bytes(req.address);
  if (req.origin !== undefined) w.uint(7).text(req.origin);
  return w.finish();
}

/**
 * Encode the body of a `ur:eth-signature`.
 *
 * The device produces these, not the companion. It lives here so tests and
 * the mock can stand in for the device with bytes the frozen reader accepts.
 */
export function encodeEthSignature(sig: EthSignature): Uint8Array {
  if (sig.requestId.length !== 16) throw new Error("eth-signature: request-id must be 16 bytes");
  if (sig.signature.length !== 65) throw new Error("eth-signature: signature must be 65 bytes");
  const w = new Writer();
  w.map(sig.origin !== undefined ? 3 : 2);
  w.uint(1).tag(TAG_UUID).bytes(sig.requestId);
  w.uint(2).bytes(sig.signature);
  if (sig.origin !== undefined) w.uint(3).text(sig.origin);
  return w.finish();
}
