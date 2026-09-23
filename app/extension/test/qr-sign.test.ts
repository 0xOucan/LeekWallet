/**
 * Signing a dapp's transaction over QR, with a local key standing in for the
 * device: who may be routed to QR, which methods QR refuses, how the unsigned
 * transaction is filled, and which scanned signatures are allowed to reach
 * the network. Each refusal is a broadcast the user did not approve.
 */

import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeEthSignRequest, encodeEthSignature } from "../../packages/core/src/eip4527/sign-request.ts";
import { pairingFromCbor } from "../src/qr-pairing.ts";
import { qrSignJob, refuseOverQr, routeSigner, SignerRefused } from "../src/qr-sign.ts";
import { fillTransaction, type FillRpc } from "../src/tx-fill.ts";
import { QrJobs } from "../src/qr-job.ts";
import { devicePrivateKey, hdkeyCbor } from "./qr-fixtures.ts";

let failures = 0;
const check = (ok: boolean, why: string): void => {
  if (!ok) { failures++; console.log(`  FAIL: ${why}`); }
};
const group = (name: string): void => console.log(`\n== ${name}`);
const unhex = (h: string): Uint8Array => new Uint8Array((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

const pairing = pairingFromCbor(hdkeyCbor());
const mine = pairing.accounts[0]!;
const other = pairing.accounts[1]!;
const RECIPIENT = pairing.accounts[5]!.address as Address;
const code = (f: () => unknown): number | null => {
  try { f(); return null; } catch (e) { return e instanceof SignerRefused ? e.code : -1; }
};

group("routing: only a granted, offered address reaches a signer");
{
  const granted = [mine.address.toLowerCase()];
  const r = routeSigner(mine.address.toUpperCase().replace("0X", "0x"), granted, null, pairing.accounts);
  check(r.kind === "qr" && r.account.address === mine.address, "a granted QR address was not routed to QR");
  check(code(() => routeSigner(other.address, granted, null, pairing.accounts)) === 4100,
    "an address never granted to this origin was routed to a signer");
  check(code(() => routeSigner(mine.address, granted, null, null)) === 4100,
    "a granted address nobody is offering was routed");
  check(code(() => routeSigner(42, granted, null, pairing.accounts)) === -32602, "a non-string address was accepted");
  const d = routeSigner(mine.address, granted, ["0x0", mine.address], pairing.accounts);
  check(d.kind === "device" && d.index === 1, "the live USB session did not win over the QR pairing");
}

group("QR refuses everything but transactions, with a reason");
{
  check(refuseOverQr("eth_sendTransaction") === null, "transactions were refused over QR");
  for (const m of ["personal_sign", "eth_signTypedData_v4", "eth_signTypedData", "eth_sign"]) {
    const why = refuseOverQr(m);
    check(why !== null && why.includes("only reads transactions"), `${m} was not refused clearly: ${why}`);
  }
}

group("filling: nonce from `pending`, dapp values honoured");
const seen: string[] = [];
const rpc: FillRpc = {
  async getTransactionCount(a) { seen.push(`nonce:${a.blockTag}`); return 12; },
  async estimateFeesPerGas() { return { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }; },
  async estimateGas() { return 21_000n; },
};
const tx = await fillTransaction(rpc, 11155111, mine.address as Address, { to: RECIPIENT, value: "1000" });
{
  check(seen.includes("nonce:pending"), `nonce was not read at pending: ${seen.join(",")}`);
  check(tx.nonce === 12 && tx.gas === 21_000n && tx.maxFeePerGas === 5_000_000_000n, "filled fields wrong");
  check(tx.value === 1000n && tx.type === "eip1559" && tx.chainId === 11155111, "request fields not carried");
  const given = await fillTransaction(rpc, 1, mine.address as Address,
    { to: RECIPIENT, nonce: 3, gas: "50000", maxFeePerGas: "9", maxPriorityFeePerGas: "1" });
  check(given.nonce === 3 && given.gas === 50_000n && given.maxFeePerGas === 9n, "dapp-supplied values were overridden");
}

/** The device: decode the request it scanned, sign keccak(signData) with its own key. */
async function deviceAnswers(requestCbor: Uint8Array, index: number, requestId?: Uint8Array): Promise<Uint8Array> {
  const req = decodeEthSignRequest(requestCbor);
  const key = privateKeyToAccount(toHex(devicePrivateKey(index)));
  const sig = unhex(await key.sign({ hash: keccak256(toHex(req.signData)) }));
  sig[64] = sig[64]! - 27;
  return encodeEthSignature({ requestId: requestId ?? req.requestId!, signature: sig });
}

group("a QR job signs what it showed, and nothing else");
{
  const job = qrSignJob(tx, mine, "https://dapp.invalid");
  const requestCbor = unhex(job.view.show!.cbor);
  const req = decodeEthSignRequest(requestCbor);
  check(req.address !== undefined && toHex(req.address).toLowerCase() === mine.address.toLowerCase(),
    "the request does not name the signing address");
  check(job.view.scan.type === "eth-signature", "the tab is not asked to scan an eth-signature");

  const raw = await job.accept(await deviceAnswers(requestCbor, 0));
  const parsed = parseTransaction(raw as Hex);
  check(parsed.nonce === 12 && parsed.to?.toLowerCase() === RECIPIENT.toLowerCase(), "the broadcast is not the request");
  check(await recoverTransactionAddress({ serializedTransaction: raw as never }) === mine.address,
    "the signed transaction does not recover to the paired account");

  let refused = "";
  try { await job.accept(await deviceAnswers(requestCbor, 1)); } catch (e) { refused = String((e as Error).message); }
  check(refused.includes("nothing was broadcast"), `a signature from another account was accepted: ${refused}`);

  refused = "";
  const stale = new Uint8Array(16).fill(7);
  try { await job.accept(await deviceAnswers(requestCbor, 0, stale)); } catch (e) { refused = String((e as Error).message); }
  check(refused.includes("different request"), `a signature for another request was accepted: ${refused}`);
}

group("through the job: a wrong signature is a rescan, the right one resolves");
{
  let jobId = "";
  const jobs = new QrJobs({ async open(id) { jobId = id; return 1; }, close() {} });
  const job = qrSignJob(tx, mine, "https://dapp.invalid");
  const requestCbor = unhex(job.view.show!.cbor);
  let result: string | null = null;
  const done = jobs.run(job.view, job.accept).then((r) => { result = r; });
  await new Promise((r) => setTimeout(r, 0));
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const wrong = await jobs.done(jobId, hex(await deviceAnswers(requestCbor, 1)));
  check(!wrong.done && wrong.retry, "a wrong-account signature did not ask for a rescan");
  check(result === null, "a wrong-account signature settled the dapp's request");
  const right = await jobs.done(jobId, hex(await deviceAnswers(requestCbor, 0)));
  await done;
  check(right.done && typeof result === "string", "the right signature did not reach the dapp");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
if (failures > 0) process.exit(1);
