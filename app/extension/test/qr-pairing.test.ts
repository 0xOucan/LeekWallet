/**
 * QR pairing: the addresses a scanned account key yields, and the keys that
 * must not pair at all.
 */

import { privateKeyToAddress } from "viem/accounts";
import { toHex } from "viem";
import { pairingFromCbor, QR_ACCOUNT_COUNT } from "../src/qr-pairing.ts";
import { devicePrivateKey, hdkeyCbor } from "./qr-fixtures.ts";

let failures = 0;
const check = (ok: boolean, why: string): void => {
  if (!ok) { failures++; console.log(`  FAIL: ${why}`); }
};
const group = (name: string): void => console.log(`\n== ${name}`);

group("a scanned account key yields the device's own addresses");
{
  const p = pairingFromCbor(hdkeyCbor());
  check(p.accounts.length === QR_ACCOUNT_COUNT, `derived ${p.accounts.length} addresses`);
  check(p.describe === "m/44'/60'/0'", `described as ${p.describe}`);
  for (const a of p.accounts) {
    const want = privateKeyToAddress(toHex(devicePrivateKey(a.index)));
    check(a.address === want, `index ${a.index}: ${a.address} is not ${want}`);
  }
}

group("a private key is refused, so the tab rescans instead of pairing");
{
  let threw = false;
  try { pairingFromCbor(hdkeyCbor({ isPrivate: true })); } catch { threw = true; }
  check(threw, "an is-private key was paired");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
if (failures > 0) process.exit(1);
