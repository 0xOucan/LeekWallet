/**
 * Tests for when host-side derived state must be thrown away.
 *
 * Getting this wrong shows a user addresses belonging to a wallet the device
 * can no longer derive, with nothing on screen to distinguish them from real
 * ones.
 */

import { MockDevice } from "../src/mock-device.ts";
import { PROTOCOL_VERSION } from "../src/session.ts";
import { derivationsInvalidated, PERSIST_DERIVED_ADDRESSES, type DeviceStatus } from "../src/device-state.ts";
import { encodeCbor, decodeCbor, type CborValue } from "../src/cbor.ts";
import { encodeFrame, FrameDecoder, FrameType } from "../src/framing.ts";

let failures = 0;
const check = (c: boolean, m: string) => { if (!c) { console.log(`  FAIL: ${m}`); failures++; } };
const group = (n: string) => console.log(`== ${n}`);

const S = (o: Partial<DeviceStatus>): DeviceStatus => ({
  unlocked: true, walletCount: 1, activeWallet: 1, passphrase: false, account: 0, ...o,
});

async function call(dev: MockDevice, method: string, params: Record<string, CborValue> = {}) {
  return new Promise<Record<string, CborValue>>((resolve, reject) => {
    const d = new FrameDecoder();
    dev.onFrame((f) => {
      const fr = d.push(f)[0];
      if (!fr) return;
      const body = decodeCbor(fr.payload) as Record<string, CborValue>;
      if (fr.type === FrameType.Error) reject(new Error(String(body["message"])));
      else resolve((body["result"] ?? {}) as Record<string, CborValue>);
    });
    dev.send(encodeFrame(FrameType.Request, encodeCbor({ method, ...params }))).catch(reject);
  });
}

async function main() {
  group("locking invalidates everything derived");
  {
    check(derivationsInvalidated(S({}), S({ unlocked: false })), "lock should invalidate");
    check(derivationsInvalidated(S({ unlocked: false }), S({})),
      "a fresh unlock should invalidate too — the passphrase may differ from last time");
    check(derivationsInvalidated(S({}), S({ activeWallet: 2 })), "wallet switch should invalidate");
    check(derivationsInvalidated(S({}), S({ passphrase: true })), "applying a passphrase should invalidate");
    check(derivationsInvalidated(S({ passphrase: true }), S({})), "clearing one should invalidate");
    check(!derivationsInvalidated(S({}), S({})), "an unchanged status should not invalidate");
  }

  group("the device really does drop the passphrase on lock");
  {
    const dev = new MockDevice({ startUnlocked: true });
    await dev.open();
    await call(dev, "hello", { version: PROTOCOL_VERSION });
    await call(dev, "helloReveal");

    await call(dev, "setPassphrase", { passphrase: "hunter2" });
    const withPass = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });

    await call(dev, "lock");
    const afterLock = await call(dev, "getStatus");
    check(afterLock["passphrase"] === 0, "passphrase should be gone after lock");

    await call(dev, "unlock");
    const base = await call(dev, "getAddress", { path: "m/44'/60'/0'/0/0" });
    check(withPass["address"] !== base["address"],
      "the same path must derive differently once the passphrase is gone");
  }

  group("an auto-lock the app did not initiate is caught the same way");
  {
    const dev = new MockDevice({ startUnlocked: true });
    await dev.open();
    await call(dev, "hello", { version: PROTOCOL_VERSION });
    await call(dev, "helloReveal");
    await call(dev, "setPassphrase", { passphrase: "x" });

    // The device locked on its own timer; the app was not told.
    dev.autoLock();

    const s = await call(dev, "getStatus");
    const now: DeviceStatus = {
      unlocked: s["unlocked"] === 1,
      walletCount: Number(s["walletCount"]),
      activeWallet: Number(s["activeWallet"]),
      passphrase: s["passphrase"] === 1,
      account: Number(s["account"] ?? 0),
    };
    check(derivationsInvalidated(S({ passphrase: true }), now),
      "polling must notice a lock the app did not cause");
  }

  group("derived addresses are never persisted");
  {
    check(PERSIST_DERIVED_ADDRESSES === false,
      "persisting them would reveal that a hidden wallet exists, which is what the passphrase protects");
  }


  group("the account the device is browsing is part of the tuple");
  {
    /* The device's account selector is a separate identity off the same seed.
     * It was invisible to the host until it joined getStatus, which meant
     * turning it on the device left the app listing the previous account's
     * addresses with nothing saying so. Signing was never at risk -- the
     * confirmation screens render the whole path -- but a receive address read
     * off the app while the device browsed elsewhere is somebody watching the
     * wrong balance. */
    check(derivationsInvalidated(S({ account: 0 }), S({ account: 1 })),
      "changing the account did not invalidate derived addresses");
    check(!derivationsInvalidated(S({ account: 2 }), S({ account: 2 })),
      "the same account invalidated for no reason");

    const dev = new MockDevice({ startUnlocked: true });
    await dev.open();
    const before = await call(dev, "getStatus");
    dev.hdAccount = 3;                      // the user pressed the button
    const after = await call(dev, "getStatus");
    check(Number(before["account"]) === 0 && Number(after["account"]) === 3,
      `the device did not report its account (${String(before["account"])} -> ${String(after["account"])})`);
  }

  console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures ? 1 : 0);
}

main();
