/**
 * crypto-hdkey: the handshake decoder and the addresses it yields.
 *
 * Addresses are checked against an independent BIP-32 (@scure/bip32, through
 * viem) deriving the full path from the master seed, not against our own
 * CKDpub run twice. The seed is BIP-32 test vector 1, public by design.
 *
 * If the firmware branch has emitted test/hdkey-vectors.json, it is replayed
 * too: the frames the device actually shows must decode to the addresses it
 * says they are. Absent that file this still runs, on vectors built here.
 */

import { existsSync, readFileSync } from "node:fs";
import { HDKey, privateKeyToAddress } from "viem/accounts";
import { toHex } from "viem";
import {
  decodeCryptoHdkey, deriveAccounts, HdkeyRefusal, HdkeyRefused, publicKeyToAddress,
} from "../src/eip4527/hdkey.ts";
import { E4527, E4527Error } from "../src/eip4527/errors.ts";
import { Writer } from "../src/eip4527/writer.ts";
import {
  formatKeypath, parseKeypath, writeKeypath, type Keypath,
} from "../src/eip4527/sign-request.ts";
import { TAG_CRYPTO_COIN_INFO } from "../src/eip4527/reader.ts";
import { UrDecoder } from "../src/ur-decoder.ts";
import { urEncode } from "../src/ur.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const unhex = (h: string) => new Uint8Array((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

const seed = unhex("000102030405060708090a0b0c0d0e0f");
const master = HDKey.fromMasterSeed(seed);
const account = master.derive("m/44'/60'/0'");
/* From the PRIVATE key, down the hardened path: nothing in common with the
   public-only derivation under test except the answer. */
const reference = (i: number) =>
  privateKeyToAddress(toHex(master.derive(`m/44'/60'/0'/0/${i}`).privateKey!));

interface Fields {
  isMaster?: boolean | undefined; isPrivate?: boolean | undefined; key?: Uint8Array | undefined;
  chain?: Uint8Array | undefined; coin?: number | undefined; origin?: Keypath | undefined;
  children?: Keypath | undefined; parent?: number | undefined; name?: string | undefined;
}
/* A hand encoder so a test can write the frames a correct device never
   would — a private key, a wrong coin — as easily as the one it does. */
function hdkey(f: Fields): Uint8Array {
  const w = new Writer();
  const entries: [number, () => void][] = [];
  if (f.isMaster !== undefined) entries.push([1, () => w.bool(f.isMaster!)]);
  if (f.isPrivate !== undefined) entries.push([2, () => w.bool(f.isPrivate!)]);
  if (f.key) entries.push([3, () => w.bytes(f.key!)]);
  if (f.chain) entries.push([4, () => w.bytes(f.chain!)]);
  if (f.coin !== undefined) entries.push([5, () => w.tag(TAG_CRYPTO_COIN_INFO).map(2).uint(1).uint(f.coin!).uint(2).uint(0)]);
  if (f.origin) entries.push([6, () => writeKeypath(w, f.origin!)]);
  if (f.children) entries.push([7, () => writeKeypath(w, f.children!)]);
  if (f.parent !== undefined) entries.push([8, () => w.uint(f.parent!)]);
  if (f.name !== undefined) entries.push([9, () => w.text(f.name!)]);
  w.map(entries.length);
  for (const [k, v] of entries) { w.uint(k); v(); }
  return w.finish();
}

const good: Fields = {
  key: account.publicKey!, chain: account.chainCode!, coin: 60,
  origin: { components: parseKeypath("m/44'/60'/0'"), sourceFingerprint: master.fingerprint, depth: 3 },
  parent: account.parentFingerprint, name: "LeekWallet",
};

group("account xpub -> addresses, against an independent BIP-32");
{
  const key = decodeCryptoHdkey(hdkey(good));
  const derived = deriveAccounts(key, 10);
  for (const d of derived) {
    check(d.address === reference(d.index), `index ${d.index}: ${d.address} != ${reference(d.index)}`);
  }
  check(formatKeypath(derived[3]!.path.components) === "m/44'/60'/0'/0/3", "full path carried");
  check(derived[3]!.path.sourceFingerprint === master.fingerprint, "source fingerprint carried");
  check(key.name === "LeekWallet", "name read");
  check(publicKeyToAddress(master.derive("m/44'/60'/0'/0/0").publicKey!) === reference(0),
    "EIP-55 checksum matches viem");
}

group("explicit children 0/* is the default; offsets work");
{
  const key = decodeCryptoHdkey(hdkey({ ...good,
    children: { components: [{ index: 0, hardened: false }, { hardened: false }] } }));
  const d = deriveAccounts(key, 3, 5);
  check(d.map((x) => x.index).join() === "5,6,7", "indices 5..7");
  check(d.every((x) => x.address === reference(x.index)), "offset addresses");
}

group("through a UR, as the camera delivers it");
{
  const dec = new UrDecoder();
  check(dec.receive(urEncode("crypto-hdkey", hdkey(good)).toUpperCase()) === "complete", "single-frame UR");
  check(dec.type === "crypto-hdkey", "type");
  check(deriveAccounts(decodeCryptoHdkey(dec.message!), 1)[0]!.address === reference(0), "address 0");
}

const refused = (f: Fields | Uint8Array, code: string, what: string) => {
  try {
    decodeCryptoHdkey(f instanceof Uint8Array ? f : hdkey(f));
    check(false, `${what}: accepted`);
  } catch (e) {
    const got = (e as HdkeyRefused | E4527Error).code;
    check(got === code, `${what}: expected ${code}, got ${got ?? (e as Error).message}`);
  }
};

group("refusals");
{
  /* The one that matters most: a companion must never accept a private key,
     whatever else the frame gets right. */
  refused({ ...good, isPrivate: true }, HdkeyRefusal.PRIVATE, "is-private true");
  refused({ ...good, isPrivate: true, origin: undefined }, HdkeyRefusal.PRIVATE,
    "private is reported ahead of other problems");
  refused({ ...good, isMaster: true }, HdkeyRefusal.NO_ORIGIN, "master key");
  refused({ ...good, origin: undefined }, HdkeyRefusal.NO_ORIGIN, "no origin");
  refused({ ...good, chain: undefined }, HdkeyRefusal.NO_CHAIN_CODE, "no chain code");
  refused({ ...good, coin: 0 }, HdkeyRefusal.WRONG_COIN, "bitcoin use-info");
  const notAPoint = new Uint8Array(33); notAPoint[0] = 2; notAPoint.fill(0xff, 1);
  refused({ ...good, key: notAPoint }, HdkeyRefusal.BAD_KEY, "not on the curve");
  refused({ ...good, children: { components: [{ index: 0, hardened: false }] } },
    HdkeyRefusal.CHILDREN, "children with no wildcard");
  refused({ ...good, children: { components: [{ index: 0, hardened: true }, { hardened: false }] } },
    HdkeyRefusal.CHILDREN, "hardened child step");
  refused({ ...good, key: good.key!.subarray(0, 32) }, E4527.BAD_LENGTH, "32-byte key");
  refused({ ...good, key: undefined }, E4527.MISSING_FIELD, "no key");
  refused({ ...good, name: "x".repeat(65) }, E4527.BAD_LENGTH, "long name");
  const body = hdkey(good);
  refused(Uint8Array.from([0xd9, 0x01, 0x2f, ...body]), E4527.WRONG_TAG, "tagged top level");
  refused(Uint8Array.from([...body, 0x00]), E4527.TRAILING_DATA, "trailing byte");
  const unknown = body.slice(); unknown[0] = unknown[0]! + 1;
  refused(Uint8Array.from([...unknown, 0x0b, 0x00]), E4527.UNKNOWN_FIELD, "key 11");
}

group("firmware vectors (test/hdkey-vectors.json)");
{
  const url = new URL("./hdkey-vectors.json", import.meta.url);
  if (!existsSync(url)) {
    console.log("  absent: the firmware branch has not emitted them here; skipped");
  } else {
    /* Tolerant of the shape: the firmware decides it. Each vector names its
       frame as `ur`, `parts` or `cborHex`, and optionally the addresses and
       path it expects them to yield. */
    const raw = JSON.parse(readFileSync(url, "utf8")) as unknown;
    const list = (Array.isArray(raw) ? raw : (raw as { vectors?: unknown[] }).vectors ?? []) as {
      name?: string; ur?: string; parts?: string[]; cborHex?: string;
      addresses?: string[]; path?: string; refusal?: string;
    }[];
    check(list.length > 0, "the vector file is present but holds no vectors");
    for (const [i, v] of list.entries()) {
      const label = v.name ?? `vector ${i}`;
      let cbor: Uint8Array | null = null;
      if (v.cborHex) cbor = unhex(v.cborHex);
      else {
        const dec = new UrDecoder();
        for (const p of v.parts ?? (v.ur ? [v.ur] : [])) if (dec.receive(p) === "complete") break;
        check(dec.type === "crypto-hdkey", `${label}: not a crypto-hdkey UR`);
        cbor = dec.message;
      }
      if (cbor === null) { check(false, `${label}: never assembled`); continue; }
      if (v.refusal) { refused(cbor, v.refusal, label); continue; }
      const key = decodeCryptoHdkey(cbor);
      if (v.path) check(formatKeypath(key.origin.components) === v.path, `${label}: origin path`);
      const want = v.addresses ?? [];
      const got = deriveAccounts(key, want.length);
      want.forEach((a, j) => check(got[j]!.address.toLowerCase() === a.toLowerCase(),
        `${label}: address ${j}`));
    }
    console.log(`  replayed ${list.length} firmware vector(s)`);
  }
}

if (failures > 0) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nhdkey: all passed");
