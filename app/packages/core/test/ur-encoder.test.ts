/**
 * The multipart UR encoder, against the reference and against our decoder.
 *
 * A round trip through our own decoder alone would prove only that the two
 * halves agree with each other. So the first group regenerates the parts
 * Blockchain Commons' UREncoder produced (recorded by the firmware suite in
 * ur-assembly-vectors.json) and requires the same strings, byte for byte —
 * including the fountain parts, whose subsets neither end ever transmits.
 */

import { readFileSync } from "node:fs";
import { UrEncoder, nominalFragmentLength, urFrames } from "../src/ur-encoder.ts";
import { UrDecoder } from "../src/ur-decoder.ts";
import { urDecode } from "../src/ur.ts";
import {
  decodeEthSignRequest, encodeEthSignRequest, parseKeypath, SignDataType,
  type EthSignRequest,
} from "../src/eip4527/sign-request.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

/* A fixed pseudo-random stream, so a failure reproduces. */
let seed = 0x1234567;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 8; };
const bytes = (n: number) => Uint8Array.from({ length: n }, () => rand() & 0xff);

group("byte-identical to the bc-ur reference parts");
{
  const v = JSON.parse(readFileSync(new URL("./ur-assembly-vectors.json", import.meta.url), "utf8")) as
    { messageHex: string; parts: string[] };
  const message = unhex(v.messageHex);
  const first = v.parts[0]!;
  const seqLen = Number(/\/\d+-(\d+)\//.exec(first)![1]);
  const enc = new UrEncoder("bytes", message, Math.ceil(message.length / seqLen));
  check(enc.seqLen === seqLen, `seqLen ${enc.seqLen}, reference ${seqLen}`);
  for (const part of v.parts) {
    const n = Number(/\/(\d+)-\d+\//.exec(part)![1]);
    check(enc.part(n) === part, `part ${n} differs from the reference`);
  }
}

group("nominal fragment length matches bc-ur's choice");
{
  check(nominalFragmentLength(250, 50) === 50, "250/50");
  check(nominalFragmentLength(250, 60) === 50, "250/60 should even out to 5x50");
  check(nominalFragmentLength(101, 50) === 34, "101/50 should be 3x34");
  check(nominalFragmentLength(10, 100) === 10, "fits one fragment");
}

function assemble(parts: Iterable<string>, limit = 2000): Uint8Array | null {
  const dec = new UrDecoder();
  let n = 0;
  for (const p of parts) {
    const r = dec.receive(p);
    if (r === "rejected") { check(false, `our decoder rejected our part ${p.slice(0, 30)}`); return null; }
    if (r === "complete") return dec.message;
    if (++n > limit) return null;
  }
  return null;
}

function* stream(enc: UrEncoder, from = 1): Generator<string> {
  for (let i = from; ; i++) yield enc.part(i);
}

group("round trip through UrDecoder, many sizes");
for (const len of [1, 2, 17, 49, 50, 51, 99, 100, 101, 257, 768, 1024]) {
  for (const max of [10, 50, 90, 200]) {
    const msg = bytes(len);
    const enc = new UrEncoder("bytes", msg, max);
    const got = assemble(stream(enc));
    check(got !== null && hex(got) === hex(msg), `len ${len} max ${max}: in-order round trip`);
  }
}

group("joining late: only fountain parts, never the plain ones");
for (const len of [120, 500, 1000]) {
  const msg = bytes(len);
  const enc = new UrEncoder("bytes", msg, 60);
  /* Starting past seqLen means every fragment has to be dug out of XORs. */
  const got = assemble(stream(enc, enc.seqLen + 1));
  check(got !== null && hex(got) === hex(msg), `len ${len}: fountain-only assembly`);
}

group("dropped frames: every third part lost");
{
  const msg = bytes(700);
  const enc = new UrEncoder("bytes", msg, 70);
  const lossy = (function* () { let i = 0; for (const p of stream(enc)) if (++i % 3 !== 0) yield p; })();
  const got = assemble(lossy);
  check(got !== null && hex(got) === hex(msg), "lossy assembly");
}

group("uppercase, as shown for QR alphanumeric mode");
{
  const msg = bytes(300);
  const enc = new UrEncoder("eth-sign-request", msg, 80);
  const got = assemble((function* () { for (const p of stream(enc)) yield p.toUpperCase(); })());
  check(got !== null && hex(got) === hex(msg), "uppercase parts assemble");
}

group("a small message is one static frame");
{
  const msg = bytes(20);
  const f = urFrames("bytes", msg, 100);
  check("single" in f, "expected a single part");
  if ("single" in f) check(hex(urDecode(f.single).payload) === hex(msg), "single part round trip");
}

group("eth-sign-request -> multipart UR -> UrDecoder -> frozen decoder");
{
  const req: EthSignRequest = {
    requestId: bytes(16),
    signData: bytes(400),
    dataType: SignDataType.TypedTransaction,
    chainId: 11155111,
    derivationPath: { components: parseKeypath("m/44'/60'/0'/0/7"), sourceFingerprint: 0xdeadbeef },
    address: bytes(20),
    origin: "leekwallet companion",
  };
  const cbor = encodeEthSignRequest(req);
  const enc = new UrEncoder("eth-sign-request", cbor, 100);
  check(enc.seqLen > 1, "should need several frames");
  const dec = new UrDecoder();
  let done = false;
  for (let i = 1; i < 500 && !done; i++) done = dec.receive(enc.part(i).toUpperCase()) === "complete";
  check(done && dec.type === "eth-sign-request", "assembled with the right type");
  const back = decodeEthSignRequest(dec.message!);
  check(hex(back.requestId!) === hex(req.requestId!), "request-id");
  check(hex(back.signData) === hex(req.signData), "sign-data");
  check(back.dataType === req.dataType, "data-type");
  check(back.chainId === req.chainId, "chain-id");
  check(JSON.stringify(back.derivationPath) === JSON.stringify(req.derivationPath), "derivation-path");
  check(hex(back.address!) === hex(req.address!), "address");
  check(back.origin === req.origin, "origin");
  console.log(`  ${cbor.length} bytes of eth-sign-request in ${enc.seqLen} fragments: fields identical`);

  /* The minimal request too: no id, no address, no origin. */
  const bare = { signData: bytes(3), dataType: SignDataType.Transaction, chainId: 1,
    derivationPath: { components: parseKeypath("m/44'/60'/0'/0/0") } } as EthSignRequest;
  const b2 = decodeEthSignRequest(encodeEthSignRequest(bare));
  check(b2.requestId === undefined && b2.address === undefined && b2.origin === undefined,
    "optional fields stay absent");
  check(JSON.stringify(b2.derivationPath) === JSON.stringify(bare.derivationPath), "bare keypath");
}

group("the encoder refuses what the decoder would refuse");
{
  const base = { signData: bytes(3), dataType: SignDataType.Transaction, chainId: 1,
    derivationPath: { components: parseKeypath("m/44'/60'/0'/0/0") } };
  const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  check(throws(() => encodeEthSignRequest({ ...base, signData: bytes(1025) })), "oversize sign-data");
  check(throws(() => encodeEthSignRequest({ ...base, dataType: 5 as SignDataType })), "data-type 5");
  check(throws(() => encodeEthSignRequest({ ...base, requestId: bytes(15) })), "short request-id");
  check(throws(() => encodeEthSignRequest({ ...base, address: bytes(19) })), "short address");
  check(throws(() => encodeEthSignRequest({ ...base, origin: "x".repeat(65) })), "long origin");
  check(throws(() => new UrEncoder("bytes", bytes(1000), 5)), "more than 128 fragments");
}

if (failures > 0) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nur-encoder: all passed");
