/**
 * The sealed request: canonical bytes, integrity, and the recipient pin.
 *
 * The claim being defended is narrow and stated as such in request.ts: the
 * digest proves the request was not ALTERED, not that it was ISSUED by anyone.
 * So the tests here are about tamper detection and about the recipient check
 * that makes an unsigned request safe enough to hand a stranger — not about
 * authenticity, which this design does not provide and must not appear to.
 */

import {
  acceptRequest, canonicalRequest, decodeRequest, digestOf, sealRequest,
  type PaymentRequest,
} from "../src/request.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const MERCHANT = "0x7a3f1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3";
const OTHER = "0x00112233445566778899aabbccddeeff00112233";

const base: PaymentRequest = {
  merchant: "Tacos del Parque",
  recipient: MERCHANT,
  token: "USDC",
  total: 32721n,
  marker: 17,
  chains: [84532, 5042002, 80002],
  issuedAt: 1_789_000_000,
};

group("a sealed request round-trips exactly");
{
  const sealed = sealRequest(base);
  const decoded = decodeRequest(sealed.text);
  check(decoded.ok, "a request this app issued must decode");
  if (decoded.ok) {
    const r = decoded.sealed.request;
    check(r.total === base.total, `total came back as ${r.total}`);
    check(r.marker === base.marker, "marker survived");
    check(r.merchant === base.merchant, `merchant came back as ${r.merchant}`);
    check(r.recipient.toLowerCase() === MERCHANT, "recipient survived");
    check(r.chains.join(",") === base.chains.join(","), "the chain list survived in order");
    check(decoded.sealed.digest === sealed.digest, "the digest is stable");
    check(decoded.sealed.text === sealed.text, "re-encoding produces the same bytes");
  }
}

group("the encoding is canonical: same request, same bytes");
{
  const a = sealRequest(base);
  const b = sealRequest({ ...base, chains: [...base.chains] });
  check(a.text === b.text, "two seals of the same request differ");
  check(digestOf(canonicalRequest(a.request)) === a.digest, "the digest is not over the canonical form");
}

group("a name containing the delimiter cannot forge a field");
{
  const sealed = sealRequest({ ...base, merchant: "Bar | Grill|999999|" });
  const decoded = decodeRequest(sealed.text);
  check(decoded.ok, "a merchant name with pipes must still decode");
  if (decoded.ok) {
    check(decoded.sealed.request.merchant === "Bar | Grill|999999|", "the name was mangled");
    check(decoded.sealed.request.total === base.total, "the name changed the total — field injection");
  }
}

group("every edit to the text is refused");
{
  const sealed = sealRequest(base);
  const parts = sealed.text.split("|");
  /* Field by field: the amount, the recipient, the marker, the chain list.
   * Each is a thing somebody would want to change, and each has to fail. */
  const edits: [string, string[]][] = [
    ["the total", parts.map((p, i) => (i === 4 ? "100" : p))],
    ["the recipient", parts.map((p, i) => (i === 2 ? OTHER : p))],
    ["the marker", parts.map((p, i) => (i === 5 ? "42" : p))],
    ["the chain list", parts.map((p, i) => (i === 6 ? "84532" : p))],
  ];
  for (const [what, edited] of edits) {
    const result = decodeRequest(edited.join("|"));
    check(!result.ok, `editing ${what} was accepted`);
    if (!result.ok) check(/checksum|not usable|not a/.test(result.reason), `${what}: unhelpful reason "${result.reason}"`);
  }
  // Editing the digest to match nothing is equally refused.
  check(!decodeRequest(parts.slice(0, 8).join("|") + "|0000000000000000").ok, "a wrong digest was accepted");
}

group("a re-sealed edit decodes — which is exactly why the digest is not a signature");
{
  /* Stated as a test so nobody reads request.ts and hopes otherwise: anyone
   * with this source can seal a request of their own. The mitigation is the
   * recipient pin below, not this digest. */
  const forged = sealRequest({ ...base, total: 4_000_00n });
  check(decodeRequest(forged.text).ok, "a forged-but-well-formed request must decode");
  check(acceptRequest(forged.text, MERCHANT).ok,
    "and a terminal cannot tell it from a genuine one — this is the documented limit");
}

group("the recipient pin is what actually protects the restaurant");
{
  const toWaiter = sealRequest({ ...base, recipient: OTHER });
  const result = acceptRequest(toWaiter.text, MERCHANT);
  check(!result.ok, "a request paying somewhere else was accepted");
  if (!result.ok) check(/not this restaurant's address/.test(result.reason), `unclear refusal: ${result.reason}`);

  check(acceptRequest(sealRequest(base).text, MERCHANT.toUpperCase().replace("0X", "0x")).ok,
    "the pin must not turn on capitalisation");
  check(!acceptRequest(sealRequest(base).text, "not-an-address").ok,
    "a terminal with no address must refuse rather than accept anything");
}

group("a decoded request is frozen");
{
  const decoded = decodeRequest(sealRequest(base).text);
  check(decoded.ok, "decode failed");
  if (decoded.ok) {
    const r = decoded.sealed.request as { total: bigint };
    check(Object.isFrozen(decoded.sealed), "the seal is not frozen");
    check(Object.isFrozen(decoded.sealed.request), "the request is not frozen");
    check(Object.isFrozen(decoded.sealed.request.chains), "the chain list is not frozen");
    let threw = false;
    try { r.total = 1n; } catch { threw = true; }
    check(threw && decoded.sealed.request.total === base.total, "writing to a decoded request succeeded");
  }
}

group("malformed input never throws");
{
  for (const bad of ["", "hello", "caja1|", "caja1|a|b|c|d|e|f|g|h|i", "ethereum:0x00@1/transfer",
                     "caja1|x|" + MERCHANT + "|USDC|x|0|1|0|00"]) {
    let threw = false;
    let result;
    try { result = decodeRequest(bad); } catch { threw = true; }
    check(!threw, `decodeRequest threw on ${JSON.stringify(bad.slice(0, 20))}`);
    check(result !== undefined && !result.ok, `garbage was accepted: ${JSON.stringify(bad.slice(0, 20))}`);
  }
}

group("a request that cannot be paid is never issued");
{
  for (const [what, req] of [
    ["a zero total", { ...base, total: 0n }],
    ["no chains", { ...base, chains: [] }],
    ["a bad marker", { ...base, marker: 100 }],
    ["a bad recipient", { ...base, recipient: "0xdead" }],
  ] as [string, PaymentRequest][]) {
    let threw = false;
    try { sealRequest(req); } catch { threw = true; }
    check(threw, `${what} was sealed into a QR`);
  }
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
