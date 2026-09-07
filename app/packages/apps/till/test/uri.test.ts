/**
 * The URI, checked by parsing it back with the wallet's own reader.
 *
 * `core/src/payment-uri.ts` is the code that decides what a scanned payment
 * code means in this project, and it was written before there was anything
 * that emitted one. Round-tripping through it is therefore the closest thing
 * available to testing against a customer's wallet: if the emitter and the
 * reader disagree about which field is the recipient, this test is where it
 * shows, and the failure mode it guards is a transfer to the token contract —
 * money burned with no recovery.
 */

import { parsePaymentUri } from "@leekwallet/core/payment-uri.ts";
import { buildPaymentUri, shareMessage, whatsappLink } from "../src/uri.ts";
import { buildOrder, payableUnits } from "../src/order.ts";
import { deploymentFor, TILL_CHAIN_IDS } from "../src/rails.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const eq = (got: unknown, want: unknown, msg: string) =>
  check(got === want, `${msg}: got ${String(got)}, want ${String(want)}`);
const group = (n: string) => console.log(`== ${n}`);

const MERCHANT = "0x7a3f1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3";

group("the emitted URI is EIP-681, and the reader agrees field for field");
{
  const order = buildOrder(28453n, { kind: "percent", percent: 15 });
  for (const chainId of TILL_CHAIN_IDS) {
    for (const token of ["USDC", "EURC"] as const) {
      const deployment = deploymentFor(chainId, token);
      if (!deployment.ok) continue;   // an impossible combination emits nothing
      const units = payableUnits(order.total, deployment.decimals, 17);
      const uri = buildPaymentUri({
        chainId, token: deployment.address, recipient: MERCHANT, amount: units,
      });
      const parsed = parsePaymentUri(uri);
      if (!parsed.ok) { check(false, `${token} on ${chainId} did not parse: ${parsed.reason}`); continue; }
      const p = parsed.payment;
      if (p.kind !== "token-transfer") { check(false, `${token} on ${chainId} parsed as ${p.kind}`); continue; }
      // The trap, asserted in the direction this code writes it: the path
      // target is the TOKEN and `address=` is the RECIPIENT.
      eq(p.token.toLowerCase(), deployment.address, `token contract for ${token} on ${chainId}`);
      eq(p.recipient.toLowerCase(), MERCHANT, `recipient for ${token} on ${chainId}`);
      eq(p.chainId, chainId, `chain id for ${token} on ${chainId}`);
      eq(p.amount, units, `amount for ${token} on ${chainId}`);
    }
  }
}

group("the amount survives exactly, sub-cent digits included");
{
  const usdc = deploymentFor(5042002, "USDC");
  if (!usdc.ok) check(false, "Arc USDC missing"); else {
    const units = payableUnits(28453n, usdc.decimals, 17);
    const uri = buildPaymentUri({ chainId: 5042002, token: usdc.address, recipient: MERCHANT, amount: units });
    // Plain digits, never `2.845317e8`: the exponent form is legal and some
    // readers get it wrong, and a QR has room.
    check(uri.includes("uint256=284531700"), `plain digits expected, got ${uri}`);
    const parsed = parsePaymentUri(uri);
    check(parsed.ok && parsed.payment.kind === "token-transfer" && parsed.payment.amount === 284531700n,
      "the sub-cent marker must survive the round trip");
  }
}

group("addresses come out EIP-55 checksummed");
{
  const uri = buildPaymentUri({
    chainId: 84532, token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    recipient: MERCHANT, amount: 1n,
  });
  check(/ethereum:0x[0-9a-fA-F]{40}@84532\/transfer\?address=0x[0-9a-fA-F]{40}&uint256=1$/.test(uri), uri);
  check(uri !== uri.toLowerCase(), "a checksummed address has mixed case, which is 30 bits of error detection");
  // And the reader verifies that checksum, so a mis-cased emitter would fail here.
  check(parsePaymentUri(uri).ok, "our own output must pass the reader's checksum test");
}

group("a malformed request throws rather than reaching a QR");
{
  const bad = [
    () => buildPaymentUri({ chainId: 84532, token: "0x00", recipient: MERCHANT, amount: 1n }),
    () => buildPaymentUri({ chainId: 84532, token: MERCHANT, recipient: "nope", amount: 1n }),
    () => buildPaymentUri({ chainId: 84532, token: MERCHANT, recipient: MERCHANT, amount: 0n }),
    () => buildPaymentUri({ chainId: 0, token: MERCHANT, recipient: MERCHANT, amount: 1n }),
  ];
  for (const [i, fn] of bad.entries()) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(threw, `bad request ${i} should throw`);
  }
}

group("the share message carries the URI on its own line");
{
  const uri = buildPaymentUri({ chainId: 84532, token: MERCHANT, recipient: MERCHANT, amount: 1n });
  const message = shareMessage({
    merchant: "Tacos del Parque", totalText: "284.5317", token: "USDC",
    chainName: "Base Sepolia", uri,
  });
  check(message.split("\n").includes(uri), "the URI must be a line by itself, tappable and copyable");
  check(message.includes("284.5317 USDC") && message.includes("Base Sepolia"),
    "a customer whose wallet ignores ethereum: links must still be able to pay by hand");
  const link = whatsappLink(message);
  check(link.startsWith("https://wa.me/?text="), link);
  eq(decodeURIComponent(link.slice("https://wa.me/?text=".length)), message, "the link round-trips");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
