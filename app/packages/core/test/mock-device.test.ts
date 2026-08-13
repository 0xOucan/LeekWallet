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
    dev.enterPin();
    const ok = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
    check(typeof ok.result?.["address"] === "string", "unlocked getAddress should return one");
  }

  group("the PIN never crosses the wire");
  {
    const dev = await connected({ autoPin: false });
    const r = await call(dev, "unlock", { pin: "1234" } as Record<string, CborValue>);
    check(r.result?.["prompted"] === 1, "unlock should prompt");
    check(dev.confirmations.some((c) => c.includes("Enter PIN on device")),
      "unlock must prompt on the device rather than accept a PIN parameter");
  }

  group("unlock only prompts; the host learns the outcome by polling");
  {
    /* The device calls ui_request_unlock() and answers {prompted:1,unlocked:0}
     * immediately - the user has not touched the keypad yet. The mock used to
     * unlock synchronously and answer {unlocked:1}, so anything built against
     * it believed unlocking was instantaneous and had no polling path at all. */
    const dev = await connected({ autoPin: false });

    const r = await call(dev, "unlock");
    check(r.result?.["prompted"] === 1, `unlock did not report a prompt: ${JSON.stringify(r)}`);
    check(r.result?.["unlocked"] === 0,
      `unlock claimed success before the user typed anything: ${JSON.stringify(r)}`);

    // Still locked, and key operations still refused, while the pad is up.
    check((await call(dev, "getStatus")).result?.["unlocked"] === 0,
      "the device reported itself unlocked before the PIN was entered");
    const early = await call(dev, "getAddress", { index: 0 });
    check(early.error?.code === ErrorCode.NotUnlocked,
      `a prompting device served a key operation: ${JSON.stringify(early)}`);

    // The PIN is typed on the device. Nothing crosses the wire; the host only
    // finds out by asking again.
    dev.enterPin();
    check((await call(dev, "getStatus")).result?.["unlocked"] === 1,
      "the status poll never reported the unlock");

    // Already unlocked is the one case with an immediate answer, and no prompt.
    const again = await call(dev, "unlock");
    check(again.result?.["unlocked"] === 1 && again.result?.["prompted"] === undefined,
      `unlock on an unlocked device should answer {unlocked:1}: ${JSON.stringify(again)}`);

    // lock says what it did rather than answering an empty map.
    check((await call(dev, "lock")).result?.["unlocked"] === 0,
      "lock must report the new state");
  }

  group("a simulated user eventually types the PIN");
  {
    const dev = await connected({ autoPin: true, pinEntryMs: 20 });
    await call(dev, "unlock");
    check((await call(dev, "getStatus")).result?.["unlocked"] === 0,
      "autoPin unlocked the device synchronously, which is the bug being fixed");
    await new Promise((r) => setTimeout(r, 60));
    check((await call(dev, "getStatus")).result?.["unlocked"] === 1,
      "the simulated user never finished typing");
  }

  group("getFeatures invents nothing the device does not send");
  {
    const dev = await connected();
    const r = await call(dev, "getFeatures");
    check(r.result?.["blindSigning"] === 0, "blind signing must be off by default");
    check(typeof r.result?.["model"] === "string", "getFeatures names no model");
    /* `initialized` existed only here, so app code could branch on a field real
     * hardware never sends. protocol.c writes exactly three keys. */
    check(!("initialized" in (r.result ?? {})),
      `getFeatures invented a field: ${JSON.stringify(r.result)}`);
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
    check(dev.confirmations.some((c) => c.includes("m/44'/60'/0'/0/3")),
      "the confirmation must name the signing path, not just the destination");

    /* {index, r, s, yParity} - the device's shape. The mock used to answer
     * {signature, path}, and nothing that parses one parses the other. */
    check(r.result?.["r"] instanceof Uint8Array && (r.result["r"] as Uint8Array).length === 32,
      `r is not 32 bytes: ${JSON.stringify(r.result)}`);
    check(r.result?.["s"] instanceof Uint8Array && (r.result["s"] as Uint8Array).length === 32,
      `s is not 32 bytes: ${JSON.stringify(r.result)}`);
    check(r.result?.["index"] === 3, `the reply names index ${String(r.result?.["index"])}, not 3`);
    /* 0 or 1, never 27/28: a client masking the low bit of the legacy form
     * inverts it and recovers an address nobody owns. */
    const y = r.result?.["yParity"];
    check(y === 0 || y === 1, `yParity is ${String(y)} - that is the legacy v`);
    check(!("signature" in (r.result ?? {})), "the old 65-byte blob is still being sent");
  }

  group("getAddress answers {address, index}, as the device does");
  {
    const dev = await connected({ startUnlocked: true });
    const r = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/7" });
    check(r.result?.["index"] === 7,
      `the trailing path component was ignored: ${JSON.stringify(r.result)}`);
    check(typeof r.result?.["address"] === "string" &&
      (r.result["address"] as string).length === 42, "address is not a 42-character string");
    /* No `path` echo. The device keeps only the index, so a host reading a path
     * back would be reading its own request and believing the device agreed. */
    check(!("path" in (r.result ?? {})), `getAddress echoed a path: ${JSON.stringify(r.result)}`);

    // A bare index is accepted too, and wins over a path, as protocol.c reads them.
    const byIndex = await call(dev, "getAddress", { index: 4, path: "m/44'/60'/0'/0/9" });
    check(byIndex.result?.["index"] === 4, "index must take precedence over path");
  }

  group("chainId is mandatory for signing");
  {
    /* The same address exists on every EVM chain, so a signature made without
     * knowing the chain is a replay waiting to happen. The device answers
     * 0x0001 rather than defaulting to mainnet; the mock used to ignore the
     * field entirely. */
    const dev = await connected({ startUnlocked: true });
    const to = new Uint8Array(20).fill(0xab);
    const before = dev.confirmations.length;

    const missing = await call(dev, "signTransaction", { index: 0, to });
    check(missing.error?.code === ErrorCode.MalformedFrame,
      `a chainless transaction was accepted: ${JSON.stringify(missing)}`);

    const notAnInt = await call(dev, "signTransaction", { index: 0, to, chainId: "1" });
    check(notAnInt.error?.code === ErrorCode.MalformedFrame,
      `chainId as text was accepted: ${JSON.stringify(notAnInt)}`);

    check(dev.confirmations.length === before,
      "a transaction with no usable chain reached the confirmation screen");
  }

  group("oversized calldata is malformed, and is refused before decoding");
  {
    /* ETH_MAX_DATA is 256 bytes. The bound comes *before* the decodability
     * check because that is the order protocol.c applies them: an oversized
     * blob is 0x0001, not 0x0202, and a host that distinguishes the two has to
     * see the same code the device sends. */
    const dev = await connected({ startUnlocked: true });
    const to = new Uint8Array(20).fill(0xab);
    const before = dev.confirmations.length;

    const big = await call(dev, "signTransaction", {
      index: 0, to, chainId: 1, data: new Uint8Array(257).fill(0xcc),
    });
    check(big.error?.code === ErrorCode.MalformedFrame,
      `257 bytes of calldata should be 0x0001, got ${JSON.stringify(big)}`);

    // Same length, sent as a hex string: the bound is on bytes, not encoding.
    const bigHex = await call(dev, "signTransaction", {
      index: 0, to, chainId: 1, data: "0x" + "cc".repeat(257),
    });
    check(bigHex.error?.code === ErrorCode.MalformedFrame,
      `hex calldata escaped the bound: ${JSON.stringify(bigHex)}`);

    check(dev.confirmations.length === before,
      "calldata the device cannot hold reached the confirmation screen");
  }

  group("an address index above 0x7FFFFFFF is refused");
  {
    /* Above 0x7FFFFFFF is a hardened index, which BIP32 encodes differently.
     * The device refuses rather than deriving something else quietly; the mock
     * accepted any non-negative integer. */
    const dev = await connected({ startUnlocked: true });
    const hardened = 0x80000000;

    const addr = await call(dev, "getAddress", { index: hardened });
    check(addr.error?.code === ErrorCode.MalformedFrame,
      `getAddress accepted a hardened index: ${JSON.stringify(addr)}`);

    const before = dev.confirmations.length;
    const sig = await call(dev, "signTransaction", {
      index: hardened, to: new Uint8Array(20).fill(0xab), chainId: 1,
    });
    check(sig.error?.code === ErrorCode.MalformedFrame,
      `signTransaction accepted a hardened index: ${JSON.stringify(sig)}`);
    check(dev.confirmations.length === before, "an unreachable index reached the screen");

    // The boundary itself is still valid.
    const edge = await call(dev, "getAddress", { index: 0x7fffffff });
    check(edge.result?.["index"] === 0x7fffffff, "0x7FFFFFFF should still derive");
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
    check(r.result?.["r"] instanceof Uint8Array, "approval should be signable");
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
