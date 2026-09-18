/**
 * The QR signing round, with a local key standing in for the device.
 *
 * What is under test is the companion's refusal to use a signature it cannot
 * account for: one answering another request, one from another key, one with
 * a v it would have to guess at. Each of those, if accepted, is a broadcast
 * the user did not approve on the screen they were looking at.
 */

import { privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex } from "viem";
import {
  ethSignRequestForTx, newRequestId, signedTxFromEthSignature, unsignedBytes,
  type UnsignedTransaction,
} from "../src/qr-signing.ts";
import {
  decodeEthSignRequest, encodeEthSignature, formatKeypath, parseKeypath, SignDataType,
} from "../src/eip4527/sign-request.ts";
import { UrEncoder } from "../src/ur-encoder.ts";
import { UrDecoder } from "../src/ur-decoder.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const unhex = (h: string) => new Uint8Array((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

/* Throwaway keys, used nowhere else. */
const device = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);

const tx: UnsignedTransaction = {
  chainId: 11155111, nonce: 7, to: stranger.address, value: 10n ** 15n,
  data: "0xa9059cbb", gas: 60000n, maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n, type: "eip1559",
};
const path = { components: parseKeypath("m/44'/60'/0'/0/0"), sourceFingerprint: 0x12345678 };

/** What a device does: sign keccak(unsigned bytes), answer r ‖ s ‖ v. */
async function deviceSigns(signer: typeof device, t: UnsignedTransaction, vStyle: "parity" | "legacy" = "parity") {
  const sig = await signer.sign({ hash: keccak256(toHex(unsignedBytes(t))) });
  const bytes = unhex(sig);
  const yParity = bytes[64]! - 27;
  bytes[64] = vStyle === "parity" ? yParity : 27 + yParity;
  return bytes;
}

const rejects = async (p: Promise<unknown>, what: string, needle: string) => {
  try { await p; check(false, `${what}: accepted`); }
  catch (e) { check(String((e as Error).message).includes(needle), `${what}: wrong reason: ${(e as Error).message}`); }
};

group("request carries the transaction, not a hash of it");
const id = newRequestId();
{
  check(id.length === 16 && (id[6]! >> 4) === 4 && (id[8]! >> 6) === 2, "request-id is a v4 UUID");
  check(newRequestId().some((b, i) => b !== id[i]), "request-ids are fresh");
  const req = decodeEthSignRequest(ethSignRequestForTx(tx, id, path, device.address));
  check(req.dataType === SignDataType.TypedTransaction, "data-type 4");
  check(req.signData[0] === 0x02, "EIP-1559 type byte leads");
  check(req.chainId === tx.chainId, "chain id");
  check(formatKeypath(req.derivationPath.components) === "m/44'/60'/0'/0/0", "path");
  check(toHex(req.address!).toLowerCase() === device.address.toLowerCase(), "address");
  const parsed = parseTransaction(toHex(req.signData) as Hex);
  check(parsed.nonce === 7 && parsed.to?.toLowerCase() === tx.to.toLowerCase() && parsed.value === tx.value, "device reads back the same fields");
}

group("full round: animated request out, animated signature back");
{
  const reqUr = new UrEncoder("eth-sign-request", ethSignRequestForTx(tx, id, path, device.address), 60);
  const devDec = new UrDecoder();
  for (let i = 1; devDec.receive(reqUr.part(i).toUpperCase()) !== "complete"; i++) if (i > 300) break;
  const seen = decodeEthSignRequest(devDec.message!);
  const sig = await deviceSigns(device, tx);
  const back = new UrEncoder("eth-signature", encodeEthSignature({ requestId: seen.requestId!, signature: sig }), 30);
  const appDec = new UrDecoder();
  for (let i = 1; appDec.receive(back.part(i)) !== "complete"; i++) if (i > 300) break;
  const raw = await signedTxFromEthSignature(appDec.message!, id, tx, device.address);
  check(await recoverTransactionAddress({ serializedTransaction: raw as never }) === device.address,
    "broadcastable transaction recovers to the device's address");
}

group("v as 27/28 is read too");
{
  const sig = await deviceSigns(device, tx, "legacy");
  const raw = await signedTxFromEthSignature(encodeEthSignature({ requestId: id, signature: sig }), id, tx, device.address);
  check(await recoverTransactionAddress({ serializedTransaction: raw as never }) === device.address, "legacy v");
}

group("refusals");
{
  const sig = await deviceSigns(device, tx);
  const other = newRequestId();
  await rejects(signedTxFromEthSignature(encodeEthSignature({ requestId: other, signature: sig }), id, tx, device.address),
    "a different request-id", "different request");
  await rejects(signedTxFromEthSignature(encodeEthSignature({ requestId: id, signature: await deviceSigns(stranger, tx) }),
    id, tx, device.address), "another key signed it", "nothing was broadcast");
  /* Right key, right id, but over a different transaction than the one about
     to be broadcast: recovery lands on a random address. */
  await rejects(signedTxFromEthSignature(encodeEthSignature({ requestId: id, signature: await deviceSigns(device, { ...tx, nonce: 8 }) }),
    id, tx, device.address), "signed a different nonce", "nothing was broadcast");
  const badV = sig.slice(); badV[64] = 37;
  await rejects(signedTxFromEthSignature(encodeEthSignature({ requestId: id, signature: badV }), id, tx, device.address),
    "v = 37", "expected 0, 1, 27 or 28");
}

if (failures > 0) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nqr-signing: all passed");
