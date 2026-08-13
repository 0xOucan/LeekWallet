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
      /* Both error frame types, or an encrypted error reads as an empty
       * success - which is the exact client bug the firmware's send_error
       * comment describes, and which this helper had. */
      if (f.type === FrameType.Error || f.type === FrameType.EncryptedError) {
        resolve({ error: { code: Number(body["code"]), message: String(body["message"]) } });
      } else {
        resolve({ result: body["result"] as Record<string, CborValue> });
      }
    });
    dev.send(encodeFrame(FrameType.Request, encodeCbor({ method, ...params }))).catch(reject);
  });
}

/** The frame TYPE of the reply, for tests that care how an error is carried. */
async function rawFrame(dev: MockDevice, method: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    dev.onFrame((frame) => {
      const f = decoder.push(frame)[0];
      if (f) resolve(f.type);
    });
    dev.send(encodeFrame(FrameType.Request, encodeCbor({ method }))).catch(reject);
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

    /* getStatus is in the "always" tier - PROTOCOL.md section 5 tells the app
     * to poll it, and the firmware answers it in plaintext with no session. It
     * is the KEY operations that must be refused, so assert on one of those. */
    const early = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
    check(early.error?.code === ErrorCode.SessionRequired,
      `expected SessionRequired, got ${JSON.stringify(early)}`);

    const hello = await call(dev, "hello");
    check(hello.result?.["passkey"] === "314159", "hello should return a passkey to compare");

    const ok = await call(dev, "getStatus");
    check(ok.result !== undefined, "getStatus should work after hello");
  }

  group("a session is pending until the passkey is compared");
  {
    /* The mock used to mark the session established the moment `hello` was
     * answered, so the passkey comparison - the entire defence against a
     * machine in the middle - could be skipped and app code still passed.
     * The firmware goes to PENDING and refuses everything until the user
     * confirms. Found by running the real protocol.c on the host. */
    const dev = new MockDevice({ autoConfirmSession: false, startUnlocked: true });
    await dev.open();

    const hello = await call(dev, "hello");
    check(hello.result?.["passkey"] === "314159", "hello should offer a passkey");
    check(dev.session === "pending", `session went to ${dev.session}, not pending`);
    check(dev.confirmations.some((c) => c.includes("passkey")),
      "the passkey comparison was never shown");

    const early = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
    check(early.error?.code === ErrorCode.SessionRequired,
      `pending session served a key operation: ${JSON.stringify(early)}`);

    dev.confirmSession();
    const ok = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
    check(ok.result?.["address"] !== undefined, "confirming the passkey did not open the session");
  }

  group("an in-session error is encrypted, not plaintext");
  {
    /* Counters, not secrecy. The device advances its receive counter whenever
     * a frame decrypts, error or not; the host advances on opening a reply. A
     * plaintext error leaves them one apart and every later frame fails to
     * decrypt. The mock answered in plaintext, so a client that mishandled the
     * encrypted form passed here and desynced against real hardware. */
    const dev = await connected({ startUnlocked: true });
    const raw = await rawFrame(dev, "definitelyNotAMethod");
    check(raw === FrameType.EncryptedError,
      `error came back as frame type 0x${raw.toString(16)}, expected 0x7e`);

    /* And the channel still works afterwards. */
    const after = await call(dev, "getStatus");
    check(after.result !== undefined, "the session did not survive an error");
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
    const r = await call(dev, "signTransaction", {
      path: "m/44'/60'/0'/0/0",
      to: new Uint8Array(20).fill(0xab),
      chainId: 1,
    });
    check(r.error?.code === ErrorCode.UserRejected,
      `expected UserRejected, got ${JSON.stringify(r)}`);
  }

  group("undecodable calls are refused before any confirmation");
  {
    /* The mock must be no more permissive than the firmware (T50), and the
     * refusal has to come *before* the prompt: asking the user to approve
     * something the device will then reject is the blind-signing habit wearing
     * a different hat. */
    const dev = await connected({ startUnlocked: true });
    const to = new Uint8Array(20).fill(0xab);
    /* Pairing already recorded a passkey comparison, so count from here: what
     * must not appear is a *signing* prompt. */
    const before = dev.confirmations.length;

    const unknown = await call(dev, "signTransaction", {
      path: "m/44'/60'/0'/0/0", to, chainId: 1,
      data: "0x" + "deadbeef" + "0".repeat(128),
    });
    check(unknown.error?.code === ErrorCode.Undecodable,
      `unknown selector should be refused, got ${JSON.stringify(unknown)}`);
    check(dev.confirmations.length === before,
      "an undecodable call must not reach the confirmation screen");

    const creation = await call(dev, "signTransaction", {
      path: "m/44'/60'/0'/0/0", chainId: 1, data: "0x60806040",
    });
    check(creation.error?.code === ErrorCode.Undecodable,
      `contract creation should be refused, got ${JSON.stringify(creation)}`);
  }

  group("an unlimited approval is named as such on the device");
  {
    const dev = await connected({ startUnlocked: true });
    const r = await call(dev, "signTransaction", {
      path: "m/44'/60'/0'/0/0",
      to: new Uint8Array(20).fill(0xab),
      chainId: 1,
      data: "0x095ea7b3" + "0".repeat(24) + "cc".repeat(20) + "f".repeat(64),
    });
    check(r.result?.["signature"] instanceof Uint8Array, "approval should be signable");
    check(dev.confirmations.some((c) => c.includes("UNLIMITED")),
      `the confirmation must warn: ${JSON.stringify(dev.confirmations)}`);
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
    check(dev.session === "none", "reopening left a session behind");
    const r = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
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
