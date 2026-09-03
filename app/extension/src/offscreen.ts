/**
 * The port owner. The only process in this extension that touches hardware.
 *
 * WHY AN OFFSCREEN DOCUMENT
 *
 * An MV3 service worker is not a background page. Chrome terminates it after
 * roughly thirty seconds without an event, and the termination is not
 * cooperative: whatever the worker was holding is gone. A `SerialPort` is
 * exactly the sort of thing that cannot survive that. Worse, the failure is
 * not a clean disconnect — a session with a device is a pair of nonce counters
 * that only mean anything while both ends agree, so a worker evicted between
 * two frames leaves the device holding a session the browser has forgotten,
 * and every later request fails to decrypt with nothing on either screen to
 * say why. Signing on a hardware wallet routinely takes longer than thirty
 * seconds, because it takes as long as a human takes to read four pages on a
 * small OLED and press a button.
 *
 * There is also the plain fact that a service worker has no `navigator.serial`
 * at all. Web Serial is exposed to documents, not to workers.
 *
 * An offscreen document is a real, hidden DOM document with the extension's
 * origin and the extension's permissions, created by the service worker and
 * outliving it. It has `navigator.serial`, it has `localStorage` (which
 * `chains.ts` and `rpc.ts` use for the endpoint preference), and it stays put
 * while the worker comes and goes. So the port lives here, and the worker
 * treats this document as a server it sends commands to.
 *
 * WHY THE POPUP STILL HAS TO ASK FOR THE PORT
 *
 * `navigator.serial.requestPort()` shows a chooser and therefore requires user
 * activation, which a hidden document by definition does not have. But a
 * granted port is remembered against the extension's ORIGIN, not against the
 * page that asked — so the popup asks once, with a real click behind it, and
 * from then on `navigator.serial.getPorts()` here returns it. That split is
 * not a workaround; it is the API working as designed. The human authorises
 * the device, the background holds it.
 *
 * WHAT THIS FILE IS NOT
 *
 * It is not a signer. Every key stays on the device, every signature is
 * produced there, and every confirmation is drawn there from the device's own
 * decode of the bytes. This file transcribes a dapp's request into CBOR, sends
 * it, and waits. If the device refuses, it refuses — there is no path here
 * that can talk it round.
 */

import {
  createPublicClient, custom, defineChain, serializeTransaction,
  type Address, type Hex,
} from "viem";
import type { CborValue } from "../../packages/core/src/cbor.ts";
import { DeviceError } from "../../packages/core/src/transport.ts";
import { getChain, type ChainInfo } from "../../packages/core/src/chains.ts";
import { FailoverRpc, fetchRpcSend } from "../../packages/core/src/rpc.ts";
import { toDeviceTypedData } from "../../packages/core/src/eip712.ts";
import {
  UNKNOWN_STATUS, derivationsInvalidated, type DeviceStatus,
} from "../../packages/core/src/device-state.ts";
import { DeviceClient } from "./device-client.ts";
import { SerialTransport, portLabel } from "./serial-transport.ts";
import { DEVICE_FILTERS } from "./env.ts";
import type { OwnerCommand, OwnerEnvelope, OwnerEvent, OwnerReply } from "./protocol.ts";

/** How many addresses to offer a dapp. Ten is what the desktop app derives. */
const ACCOUNT_COUNT = 10;

/** The device gives the user 120 s to approve; wait longer than it does. */
const SIGN_TIMEOUT_MS = 150_000;

/* ------------------------------------------------------------------ state */

let transport: SerialTransport | null = null;
let client: DeviceClient | null = null;
let passkey: string | null = null;
let confirmed = false;
let status: DeviceStatus = UNKNOWN_STATUS;
let addresses: string[] = [];
/** The BIP44 account the addresses above were derived under. */
let derivedAccount: number | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Never persisted, in memory only, and dropped on every invalidation.
 *
 * A passphrase wallet leaves no trace on the device by design, and writing its
 * addresses into extension storage undoes exactly that: anyone reading the
 * extension's data learns a hidden wallet exists, which is the fact the
 * passphrase was protecting. `PERSIST_DERIVED_ADDRESSES` in core says the same
 * thing; this is that rule applied here rather than merely imported.
 */
function invalidateDerived(reason: string): void {
  if (addresses.length === 0 && derivedAccount === null) return;
  addresses = [];
  derivedAccount = null;
  emit("log", `derived addresses discarded — ${reason}`);
  pushState();
}

/* ---------------------------------------------------------------- events */

function emit(event: OwnerEvent["event"], data: unknown): void {
  const message: OwnerEvent = { from: "leek-owner-event", event, data };
  /* Fire-and-forget. The service worker may be asleep, in which case this
   * wakes it; it may also have no listener yet, in which case Chrome rejects
   * the promise and there is nothing useful to do about it. The state the
   * worker rebuilds on its next `status` command is authoritative anyway. */
  void chrome.runtime.sendMessage(message).catch(() => {});
}

function log(line: string): void {
  emit("log", line);
}

function snapshot(): Record<string, unknown> {
  return {
    connected: client !== null && (transport?.isOpen ?? false),
    label: transport?.label ?? null,
    passkey: confirmed ? null : passkey,
    confirmed,
    unlocked: status.unlocked,
    walletCount: status.walletCount,
    activeWallet: status.activeWallet,
    temporary: status.temporary,
    passphrase: status.passphrase,
    account: status.account,
    addresses: [...addresses],
  };
}

function pushState(): void {
  emit("state", snapshot());
}

/* --------------------------------------------------------------- device */

async function readStatus(): Promise<DeviceStatus> {
  if (!client) throw new Error("no device connected");
  const s = await client.call("getStatus");
  return {
    unlocked: s["unlocked"] === 1,
    walletCount: Number(s["walletCount"] ?? 0),
    activeWallet: Number(s["activeWallet"] ?? 0),
    /* Absent on firmware that predates these fields, where they are also
     * always false/zero. Defaulting that way makes such a device look
     * permanently parked, which is what it effectively is from this side: it
     * never reports a change, so nothing is invalidated for a reason the
     * extension cannot see. */
    temporary: s["temporary"] === 1,
    passphrase: s["passphrase"] === 1,
    account: Number(s["account"] ?? 0),
  };
}

/**
 * Notice, on a timer, what the user did on the device.
 *
 * Locking it, switching wallet, applying a passphrase or turning the account
 * selector all change what an address at index N means, and none of them
 * produces a message to the host. Two seconds is frequent enough that a lock
 * is noticed before a dapp acts on a stale address, and rare enough not to
 * keep the link busy.
 */
function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void (async () => {
      if (!client || !confirmed) return;
      try {
        const next = await readStatus();
        if (derivationsInvalidated(status, next)) {
          invalidateDerived("the device's state changed");
        }
        const changed = JSON.stringify(next) !== JSON.stringify(status);
        status = next;
        if (changed) pushState();
      } catch {
        /* One missed poll is not evidence of anything. A link that is really
         * gone surfaces through the transport's own close callback, which is
         * the path that tears everything down. */
      }
    })();
  }, 2000);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function teardown(why: string): void {
  stopPolling();
  client = null;
  transport = null;
  passkey = null;
  confirmed = false;
  status = UNKNOWN_STATUS;
  addresses = [];
  derivedAccount = null;
  log(why);
  pushState();
}

/**
 * Open the port the user already granted, and handshake.
 *
 * `getPorts()` returns everything this extension has ever been granted, which
 * on a developer's machine is easily several boards. Filtering by Espressif's
 * vendor ID narrows it; the handshake and the passkey on the device's screen
 * are what actually decide whether the right thing is on the other end. A
 * vendor ID is shared by every ESP32 in the world and proves nothing.
 */
async function connect(): Promise<Record<string, unknown>> {
  if (client) return snapshot();

  const ports = await navigator.serial.getPorts();
  if (ports.length === 0) {
    throw new Error(
      "no serial port has been granted to this extension yet — open the " +
      "LeekWallet popup and choose the device",
    );
  }
  const preferred = ports.find((p) => {
    const vendor = p.getInfo().usbVendorId;
    return DEVICE_FILTERS.some((f) => f.usbVendorId === vendor);
  });
  const port = preferred ?? ports[0]!;

  const link = new SerialTransport(port, portLabel(port), (why) => {
    teardown(`the link closed — ${why}`);
  });
  await link.open();
  transport = link;

  const c = new DeviceClient(link, log);
  client = c;
  confirmed = false;

  try {
    passkey = await c.handshake();
  } catch (e) {
    await link.close().catch(() => {});
    client = null;
    transport = null;
    throw e;
  }

  log(`handshake complete on ${link.label}; compare the passkey`);
  pushState();
  return snapshot();
}

/**
 * The human has looked at both screens and pressed the button on the device.
 *
 * The popup cannot know whether they really did — there is no message from the
 * device that says "confirmed". So this is optimistic in exactly the way the
 * protocol intends: it starts sending encrypted traffic, and the device
 * refuses every frame until the button is actually pressed. The first
 * encrypted call that succeeds IS the confirmation.
 */
async function confirm(): Promise<Record<string, unknown>> {
  if (!client) throw new Error("no device connected");
  await client.waitForApproval();
  confirmed = true;
  passkey = null;
  status = await readStatus();
  startPolling();
  log("approved on the device; the channel is encrypted");
  pushState();
  return snapshot();
}

async function unlock(): Promise<Record<string, unknown>> {
  if (!client) throw new Error("no device connected");
  const reply = await client.call("unlock");

  /* The device only *prompts*. The PIN is typed there and never travels, so
   * the reply is `{prompted:1, unlocked:0}` and arrives long before the user
   * has touched the keypad. The status poll is the answer; `{unlocked:1}`
   * comes back only when the device was already unlocked. */
  if (reply["unlocked"] !== 1) {
    log("waiting for the PIN on the device…");
    const deadline = Date.now() + 120_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 750));
      const s = await readStatus();
      if (s.unlocked) break;
      if (Date.now() > deadline) throw new Error("timed out waiting for the PIN");
    }
  }

  const next = await readStatus();
  if (derivationsInvalidated(status, next)) invalidateDerived("the device unlocked");
  status = next;
  log("device unlocked");
  pushState();
  return snapshot();
}

const addressPath = (account: number, index: number): string =>
  `m/44'/60'/${account}'/0/${index}`;

/**
 * Derive the addresses a dapp may be offered.
 *
 * The account is pinned for the whole run. Reading it per iteration would let
 * a turn of the device's account selector land halfway down and produce a list
 * stitched from two accounts — the one shape of wrong that no address on
 * screen would betray.
 */
async function derive(count: number): Promise<string[]> {
  if (!client) throw new Error("no device connected");
  if (!status.unlocked) throw new Error("the device is locked");
  const account = status.account;
  if (derivedAccount === account && addresses.length >= count) return addresses.slice(0, count);

  const derived: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = await client.call("getAddress", { path: addressPath(account, i) });
    derived.push(String(r["address"]));
  }

  /* Re-read before committing. If the device moved while we were deriving, the
   * list we just built spans two states and belongs to neither. */
  const after = await readStatus();
  if (derivationsInvalidated(status, after)) {
    status = after;
    invalidateDerived("the device changed state while deriving");
    throw new Error("the device changed state while deriving — try again");
  }

  addresses = derived;
  derivedAccount = account;
  pushState();
  return [...addresses];
}

/**
 * The account to put on a signing request, or a refusal.
 *
 * Every signing call names the account explicitly rather than leaning on the
 * device's current selection happening to match — a default that agrees today
 * and disagrees the moment somebody turns the wheel is not a default, it is a
 * coincidence. And the address this extension is about to name an index into
 * was derived under one account: if that is no longer the account, the index
 * means a different key and nothing on either screen would look wrong.
 */
function signingAccount(): number {
  if (derivedAccount === null) {
    throw new Error("no addresses have been derived");
  }
  if (derivedAccount !== status.account) {
    throw new Error(
      "the addresses this dapp was given were derived under a different " +
      "account — reconnect before signing",
    );
  }
  return derivedAccount;
}

/* ------------------------------------------------------------ byte helpers */

const weiBytes = (v: bigint): Uint8Array => {
  if (v === 0n) return new Uint8Array(0);
  let hexDigits = v.toString(16);
  if (hexDigits.length % 2) hexDigits = "0" + hexDigits;
  return new Uint8Array((hexDigits.match(/../g) ?? []).map((h) => parseInt(h, 16)));
};

const hexBytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.replace(/^0x/, "").match(/../g) ?? []).map((h) => parseInt(h, 16)));

const toHex = (b: Uint8Array): Hex =>
  ("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("")) as Hex;

/**
 * Reassemble the device's `{r, s, yParity}` into a 65-byte signature.
 *
 * `yParity` is taken as sent rather than derived from a legacy `v` by masking
 * the low bit — that inverts the value, which produces a signature recovering
 * to an address with no funds, a failure that reads as "you are broke" rather
 * than "the signature is wrong".
 */
function signatureFrom(reply: Record<string, CborValue>): Hex {
  const flat = reply["signature"];
  if (flat instanceof Uint8Array && flat.length === 65) return toHex(flat);

  const r = reply["r"];
  const s = reply["s"];
  const yParity = reply["yParity"];
  if (!(r instanceof Uint8Array) || !(s instanceof Uint8Array)) {
    throw new Error("device returned no signature");
  }
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(`device returned yParity ${String(yParity)}, expected 0 or 1`);
  }
  // v = 27 + yParity, the encoding every EIP-191 verifier expects.
  return (toHex(r) + toHex(s).slice(2) + (27 + yParity).toString(16)) as Hex;
}

/* -------------------------------------------------------------- signing */

async function signMessage(index: number, message: string): Promise<string> {
  if (!client) throw new Error("no device connected");
  const reply = await client.call(
    "signMessage",
    { index, account: signingAccount(), message },
    SIGN_TIMEOUT_MS,
  );
  return signatureFrom(reply);
}

/**
 * EIP-712 typed data.
 *
 * `toDeviceTypedData` throws on anything it cannot transcribe faithfully, and
 * that throw is passed straight through as an invalid-params refusal. It is
 * the honest answer: a request the transcription had to guess about is one the
 * device would hash differently from what the dapp meant, and a signature over
 * the wrong digest is worse than no signature.
 */
async function signTypedData(index: number, doc: unknown): Promise<string> {
  if (!client) throw new Error("no device connected");
  const transcribed = toDeviceTypedData(doc);
  const reply = await client.call(
    /* Which key signs is decided after the spread, never inside it. The
     * document is a dapp's JSON, so an `account` or `index` key arriving in
     * there would otherwise choose the signing path — the one decision on this
     * call that the dapp does not get to make. */
    "signTypedData",
    { ...transcribed, index, account: signingAccount() },
    SIGN_TIMEOUT_MS,
  );
  return signatureFrom(reply);
}

/**
 * A viem client over the chain's public endpoints, with failover.
 *
 * Whoever answers learns which addresses this browser is interested in and
 * what it is about to send. That is the same disclosure any wallet makes to
 * whatever node it uses, and none of these operators can move funds. It is
 * still a disclosure, and it is why the endpoint list is curated in
 * `chains.ts` rather than taken from the dapp.
 */
function chainRpc(info: ChainInfo) {
  const failover = new FailoverRpc({
    chainId: info.id,
    rpcUrls: info.rpcUrls,
    send: fetchRpcSend(),
    onFailover: (a) => log(`rpc ${new URL(a.url).host} failed (${a.reason})`),
  });
  const viemChain = defineChain({
    id: info.id,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: [...info.rpcUrls] } },
  });
  return createPublicClient({
    chain: viemChain,
    transport: custom(
      { request: (args) => failover.request(args as { method: string; params?: unknown }) },
      { retryCount: 0 },
    ),
  });
}

/**
 * Sign a transaction a dapp asked for, and broadcast it.
 *
 * Nonce and fees are filled from the chain's public RPC when the dapp left
 * them out, and honoured when it supplied them: getting either wrong costs a
 * stuck transaction, not funds, and the device still decodes and draws what it
 * is about to sign from the bytes themselves. It is not taking this code's
 * word for what they mean.
 *
 * EIP-1559 only. A legacy-priced transaction is not offered, because every
 * chain in the curated registry supports 1559 and offering two fee models
 * doubles the number of shapes the device has to render for no user benefit.
 */
async function signTransaction(cmd: Extract<OwnerCommand, { cmd: "signTransaction" }>): Promise<string> {
  if (!client) throw new Error("no device connected");
  const account = signingAccount();
  const from = addresses[cmd.index];
  if (from === undefined) throw new Error("that address is not one this device has derived");

  const info = getChain(cmd.chainId);
  if (!info) throw new Error(`chain ${cmd.chainId} is not one this extension knows how to reach`);
  const rpc = chainRpc(info);

  const to = cmd.tx.to as Address;
  const value = cmd.tx.value === undefined ? 0n : BigInt(cmd.tx.value);
  const data = cmd.tx.data as Hex | undefined;

  const nonce = cmd.tx.nonce ?? (await rpc.getTransactionCount({ address: from as Address }));

  let maxFeePerGas = cmd.tx.maxFeePerGas === undefined ? undefined : BigInt(cmd.tx.maxFeePerGas);
  let maxPriorityFeePerGas =
    cmd.tx.maxPriorityFeePerGas === undefined ? undefined : BigInt(cmd.tx.maxPriorityFeePerGas);
  if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
    const fees = await rpc.estimateFeesPerGas();
    maxFeePerGas = maxFeePerGas ?? fees.maxFeePerGas ?? 30_000_000_000n;
    maxPriorityFeePerGas = maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas ?? 1_000_000_000n;
  }

  /* Estimating tells the node what is about to be signed. That is the same
   * disclosure the nonce lookup already made, and the alternative — guessing a
   * gas limit for arbitrary calldata — produces transactions that revert after
   * spending the gas. */
  const gas = cmd.tx.gas === undefined
    ? await rpc.estimateGas({
        account: from as Address,
        to,
        value,
        ...(data !== undefined ? { data } : {}),
      })
    : BigInt(cmd.tx.gas);

  log("check every page on the device, then approve");
  const reply = await client.call("signTransaction", {
    index: cmd.index,
    account,
    chainId: cmd.chainId,
    nonce,
    to: hexBytes(to),
    value: weiBytes(value),
    /* For a token send the recipient and the amount live in here. The device
     * decodes this itself and draws them; it is not taking this extension's
     * word for what the bytes mean. */
    ...(data !== undefined ? { data: hexBytes(data) } : {}),
    gas: weiBytes(gas),
    maxFeePerGas: weiBytes(maxFeePerGas),
    maxPriorityFeePerGas: weiBytes(maxPriorityFeePerGas),
  }, SIGN_TIMEOUT_MS);

  const r = reply["r"];
  const s = reply["s"];
  const yParity = reply["yParity"];
  if (!(r instanceof Uint8Array) || !(s instanceof Uint8Array)) {
    throw new Error("device returned no signature");
  }
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(`device returned yParity ${String(yParity)}, expected 0 or 1`);
  }

  /* Reassembled here rather than on the device: the signature covers the
   * digest the device computed from its own parse, so the serialised form
   * either matches or the network rejects it. */
  const raw = serializeTransaction(
    {
      chainId: cmd.chainId,
      nonce,
      to,
      value,
      ...(data !== undefined ? { data } : {}),
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: "eip1559" as const,
    },
    { r: toHex(r), s: toHex(s), yParity },
  );

  if (!cmd.broadcast) return raw;
  log("broadcasting…");
  const hash = await rpc.sendRawTransaction({ serializedTransaction: raw });
  log(`sent: ${hash}`);
  return hash;
}

/* ------------------------------------------------------------- dispatch */

async function run(command: OwnerCommand): Promise<unknown> {
  switch (command.cmd) {
    case "status":
      return snapshot();
    case "connect":
      return await connect();
    case "confirm":
      return await confirm();
    case "unlock":
      return await unlock();
    case "derive":
      return await derive(Math.min(Math.max(1, command.count), ACCOUNT_COUNT));
    case "disconnect": {
      await transport?.close().catch(() => {});
      teardown("disconnected");
      return snapshot();
    }
    case "signMessage":
      return await signMessage(command.index, command.message);
    case "signTypedData":
      return await signTypedData(command.index, command.doc);
    case "signTransaction":
      return await signTransaction(command);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const envelope = message as OwnerEnvelope;
  if (!envelope || envelope.to !== "leek-owner") return undefined;

  run(envelope.command).then(
    (ok) => sendResponse({ from: "leek-owner", id: envelope.id, ok } satisfies OwnerReply),
    (e: unknown) => {
      /* The protocol code survives the hop. 0x0200 is "the user pressed
       * reject" and the dapp has to be told that is a refusal rather than a
       * fault; flattening every failure to a string would lose it. */
      const reply: OwnerReply = {
        from: "leek-owner",
        id: envelope.id,
        err: String((e as Error)?.message ?? e),
      };
      if (e instanceof DeviceError) reply.errCode = e.code;
      sendResponse(reply);
    },
  );
  // Keep the message channel open for the async reply.
  return true;
});

log("port owner ready");
pushState();
