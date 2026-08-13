/**
 * viem adapter tests.
 *
 * These check the translation, not the cryptography: that viem's shapes reach
 * the device intact, that a string message and a raw one stay distinguishable,
 * and that a rejection on the device surfaces as a rejection rather than a
 * silent failure.
 */

import {
  assembleSignature, createLeekAccount, type SigningDevice,
} from "../src/viem-account.ts";
import type { Address, Hex } from "viem";

let failures = 0;
const check = (c: boolean, m: string) => { if (!c) { console.log(`  FAIL: ${m}`); failures++; } };
const group = (n: string) => console.log(`== ${n}`);

interface Recorded {
  addressCalls: number[];
  transactions: Record<string, unknown>[];
  messages: unknown[];
  typedData: Record<string, unknown>[];
}

function fakeDevice(rejectAll = false): { device: SigningDevice; log: Recorded } {
  const log: Recorded = { addressCalls: [], transactions: [], messages: [], typedData: [] };
  const reject = () => { throw new Error("rejected on device"); };

  return {
    log,
    device: {
      async getAddress(index) {
        log.addressCalls.push(index);
        return `0x${index.toString(16).padStart(40, "0")}` as Address;
      },
      async signTransaction(req) {
        log.transactions.push(req);
        if (rejectAll) reject();
        // The device's shape: two 32-byte halves and a parity bit.
        return { r: `0x${"11".repeat(32)}` as Hex, s: `0x${"22".repeat(32)}` as Hex, yParity: 1 };
      },
      async signMessage(msg) {
        log.messages.push(msg);
        if (rejectAll) reject();
        return "0xcafe" as Hex;
      },
      async signTypedData(td) {
        log.typedData.push(td);
        if (rejectAll) reject();
        return "0xbeef" as Hex;
      },
    },
  };
}

async function main() {
  group("the account binds to one address index");
  {
    const { device, log } = fakeDevice();
    const account = await createLeekAccount(device, { index: 3 });
    check(log.addressCalls[0] === 3, `asked for index ${log.addressCalls[0]}`);
    check(account.address.endsWith("003"), `address is ${account.address}`);
    check(account.type === "local", `viem sees type ${account.type}`);
  }

  group("transactions reach the device as structured fields");
  {
    const { device, log } = fakeDevice();
    const account = await createLeekAccount(device, { index: 1 });

    const signed = await account.signTransaction({
      chainId: 8453,
      nonce: 7,
      to: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      value: 1000000000000000000n,
      gas: 21000n,
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n,
    } as never);

    const sent = log.transactions[0];
    check(sent !== undefined, "nothing reached the device");
    check(sent?.["chainId"] === 8453, `chainId became ${String(sent?.["chainId"])}`);
    check(sent?.["nonce"] === 7, "nonce did not survive");
    check(sent?.["index"] === 1, "the address index was not included");
    // A pre-serialised payload would make the host the authority on what is
    // signed, which is exactly what the device exists to prevent.
    check(!("serialized" in (sent ?? {})), "a serialised blob was sent");
    check(!("hash" in (sent ?? {})), "a pre-computed hash was sent");

    // r ‖ s ‖ yParity, reassembled from the three fields the device sends.
    check(signed === `0x${"11".repeat(32)}${"22".repeat(32)}01`,
      `assembled signature is ${signed}`);
  }

  group("the parity byte is taken as sent, never masked down");
  {
    const r = `0x${"11".repeat(32)}` as Hex;
    const s = `0x${"22".repeat(32)}` as Hex;

    check(assembleSignature({ r, s, yParity: 0 }).endsWith("00"), "yParity 0 was not written");
    check(assembleSignature({ r, s, yParity: 1 }).endsWith("01"), "yParity 1 was not written");
    check(assembleSignature({ r, s, yParity: 1 }).length === 2 + 130,
      "the compact form must be 65 bytes");

    /* 27 is the legacy v. Masking its low bit gives 1, which is the *opposite*
     * parity, and the signature then recovers to an address nobody owns - a
     * failure that reads as "you have no funds". Refuse rather than normalise:
     * a device speaking the legacy form is a bug to find, not to paper over. */
    for (const bad of [27, 28, -1, 2]) {
      let threw = false;
      try {
        assembleSignature({ r, s, yParity: bad });
      } catch {
        threw = true;
      }
      check(threw, `yParity ${bad} was accepted`);
    }

    // A short half is a truncated signature, not something to pad.
    let threw = false;
    try {
      assembleSignature({ r: "0x1122" as Hex, s, yParity: 0 });
    } catch {
      threw = true;
    }
    check(threw, "a 2-byte r was accepted as 32 bytes");
  }

  group("string and raw messages stay distinguishable");
  {
    const { device, log } = fakeDevice();
    const account = await createLeekAccount(device);

    await account.signMessage({ message: "hello" });
    check(log.messages[0] === "hello", `string message became ${String(log.messages[0])}`);

    await account.signMessage({ message: { raw: "0x1234" as Hex } });
    const raw = log.messages[1] as { raw?: string };
    // A string is prefixed per EIP-191 and raw bytes are not; conflating them
    // signs a different digest than the caller asked for.
    check(raw?.raw === "0x1234", `raw message became ${JSON.stringify(log.messages[1])}`);
  }

  group("typed data carries the index");
  {
    const { device, log } = fakeDevice();
    const account = await createLeekAccount(device, { index: 2 });
    await account.signTypedData({
      domain: { name: "Test", chainId: 1 },
      types: { Mail: [{ name: "to", type: "address" }] },
      primaryType: "Mail",
      message: { to: "0x0000000000000000000000000000000000000001" },
    } as never);

    const td = log.typedData[0];
    check(td?.["index"] === 2, "the address index was not included");
    check(td?.["primaryType"] === "Mail", "primaryType did not survive");
  }

  group("a rejection on the device surfaces as an error");
  {
    const { device } = fakeDevice(true);
    const account = await createLeekAccount(device);

    let threw = false;
    try {
      await account.signMessage({ message: "no" });
    } catch {
      threw = true;
    }
    // Swallowing this would leave a caller waiting for a signature that is
    // never coming, or worse, treating undefined as success.
    check(threw, "a device rejection was swallowed");
  }

  console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures ? 1 : 0);
}

main();
