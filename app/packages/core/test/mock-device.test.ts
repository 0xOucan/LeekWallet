/**
 * Mock device tests.
 *
 * These check the mock behaves like the protocol says the firmware must, so UI
 * built against it does not acquire habits real hardware will break.
 */

import { encodeCbor, decodeCbor, type CborValue } from "../src/cbor.ts";
import { encodeFrame, FrameDecoder, FrameType } from "../src/framing.ts";
import { MockDevice } from "../src/mock-device.ts";
import { ErrorCode } from "../src/transport.ts";

let failures = 0;
const check = (c: boolean, m: string) => { if (!c) { console.log(`  FAIL: ${m}`); failures++; } };
const group = (n: string) => console.log(`== ${n}`);

/** Send one request, await one reply. */
async function call(
  dev: MockDevice,
  method: string,
  params: Record<string, CborValue> = {},
): Promise<{ result?: Record<string, CborValue>; error?: { code: number; message: string } }> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    dev.onFrame((frame) => {
      const frames = decoder.push(frame);
      const f = frames[0];
      if (!f) return;
      const body = decodeCbor(f.payload) as Record<string, CborValue>;
      if (f.type === FrameType.Error) {
        resolve({ error: { code: Number(body["code"]), message: String(body["message"]) } });
      } else {
        resolve({ result: body["result"] as Record<string, CborValue> });
      }
    });
    dev.send(encodeFrame(FrameType.Request, encodeCbor({ method, ...params }))).catch(reject);
  });
}

async function connected(opts = {}): Promise<MockDevice> {
  const dev = new MockDevice(opts);
  await dev.open();
  await call(dev, "hello");
  return dev;
}

async function main(): Promise<void> {
  group("session must be established first");
  {
    const dev = new MockDevice();
    await dev.open();
    const r = await call(dev, "getStatus");
    check(r.error?.code === ErrorCode.SessionRequired,
      `expected SessionRequired, got ${JSON.stringify(r)}`);

    const hello = await call(dev, "hello");
    check(hello.result?.["passkey"] === "314159", "hello should return a passkey to compare");

    const ok = await call(dev, "getStatus");
    check(ok.result !== undefined, "getStatus should work after hello");
  }

  group("locked device refuses key operations");
  {
    const dev = await connected();
    const r = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
    check(r.error?.code === ErrorCode.NotUnlocked,
      `locked getAddress should fail, got ${JSON.stringify(r)}`);

    await call(dev, "unlock");
    const ok = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
    check(typeof ok.result?.["address"] === "string", "unlocked getAddress should return one");
  }

  group("the PIN never crosses the wire");
  {
    const dev = await connected();
    const r = await call(dev, "unlock", { pin: "1234" } as Record<string, CborValue>);
    check(r.result?.["unlocked"] === 1, "unlock should succeed");
    check(dev.confirmations.some((c) => c.includes("Enter PIN on device")),
      "unlock must prompt on the device rather than accept a PIN parameter");
  }

  group("addresses vary by path, wallet and passphrase");
  {
    const dev = await connected({ startUnlocked: true, walletCount: 2 });
    const a0 = (await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" })).result?.["address"];
    const a1 = (await call(dev, "getAddress", { path: "m/44'/60'/0'/0/1" })).result?.["address"];
    check(a0 !== a1, "different paths should give different addresses");

    await call(dev, "selectWallet", { index: 2 });
    const b0 = (await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" })).result?.["address"];
    check(a0 !== b0, "different wallets should give different addresses");

    await call(dev, "setPassphrase", { passphrase: "x" });
    const c0 = (await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" })).result?.["address"];
    check(b0 !== c0, "a passphrase should give a different address");
  }

  group("switching wallets drops the passphrase");
  {
    const dev = await connected({ startUnlocked: true, walletCount: 2 });
    await call(dev, "setPassphrase", { passphrase: "x" });
    check((await call(dev, "getStatus")).result?.["passphrase"] === 1, "passphrase should be active");

    await call(dev, "selectWallet", { index: 2 });
    check((await call(dev, "getStatus")).result?.["passphrase"] === 0,
      "passphrase must not survive a wallet switch");
  }

  group("signing is confirmed on the device and names the source");
  {
    const dev = await connected({ startUnlocked: true });
    const r = await call(dev, "signTransaction", {
      path: "m/44'/60'/0'/0/3",
      to: new Uint8Array(20).fill(0xab),
      chainId: 1,
    });
    check(r.result?.["signature"] instanceof Uint8Array, "should return a signature");
    check(dev.confirmations.some((c) => c.includes("m/44'/60'/0'/0/3")),
      "the confirmation must name the signing path, not just the destination");
  }

  group("user rejection surfaces as an error");
  {
    const dev = await connected({ startUnlocked: true, autoApprove: false });
    const r = await call(dev, "signTransaction", { path: "m/44'/60'/0'/0/0" });
    check(r.error?.code === ErrorCode.UserRejected,
      `expected UserRejected, got ${JSON.stringify(r)}`);
  }

  group("malformed input is rejected, not guessed at");
  {
    const dev = await connected({ startUnlocked: true });
    check((await call(dev, "notARealMethod")).error !== undefined, "unknown method should error");

    const r = await call(dev, "selectWallet", { index: 99 });
    check(r.error?.code === ErrorCode.NoWallet, "out-of-range wallet should error");
  }

  group("disconnect clears session state");
  {
    const dev = await connected({ startUnlocked: true });
    await call(dev, "setPassphrase", { passphrase: "x" });
    await dev.close();
    await dev.open();
    const r = await call(dev, "getStatus");
    check(r.error?.code === ErrorCode.SessionRequired, "a new connection needs a new session");
  }

  group("latency is modelled");
  {
    const dev = await connected({ startUnlocked: true, latencyMs: 40 });
    const t0 = Date.now();
    await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
    check(Date.now() - t0 >= 35, "the mock should be slow enough to reveal missing spinners");
  }

  console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures ? 1 : 0);
}

main();
