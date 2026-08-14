/**
 * LeekWallet companion — shell.
 *
 * Talks to a Transport, nothing else. The mock is wired in here today; the
 * serial and BLE transports arrive as Rust behind a Tauri command and drop into
 * the same slot. No device logic lives in this file, which is what keeps the
 * shell replaceable.
 */

import { encodeCbor, decodeCbor, type CborValue } from "../packages/core/src/cbor.ts";
import { encodeFrame, FrameDecoder, FrameType } from "../packages/core/src/framing.ts";
import { MockDevice } from "../packages/core/src/mock-device.ts";
import { DeviceError, ErrorCode, type Transport } from "../packages/core/src/transport.ts";
import {
  derivationsInvalidated, UNKNOWN_STATUS, type DeviceStatus,
} from "../packages/core/src/device-state.ts";
import {
  availableTransports, listPorts, TauriSerialTransport, type HardwareKind,
} from "./tauri-transport.ts";
import { BleTransport, scanBle, BLE_NOT_FOUND } from "./ble-transport.ts";
import { createPublicClient, defineChain, http, parseEther, serializeTransaction,
         isAddress, type Chain, type Hex, type Address } from "viem";
import { CHAINS, getChain, type ChainInfo } from "../packages/core/src/chains.ts";
import {
  deriveSession, generateKeypair, Session,
} from "../packages/core/src/session.ts";
import {
  interpretTransaction, type TxInterpretation,
} from "../packages/core/src/tx-interpret.ts";
import { chunk, renderInterpretation } from "./interpretation-view.ts";
import { initWalletConnect, type WalletBridge } from "./wc/ui.ts";
import { resolveProjectId } from "./wc/project-id.ts";
import type { PlannedTx } from "./wc/requests.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const log = (line: string): void => {
  const el = $("log");
  const stamp = new Date().toLocaleTimeString();
  el.textContent = `${stamp}  ${line}\n${el.textContent === "Nothing yet." ? "" : el.textContent}`;
};

/* ------------------------------------------------------------------ client */

/** Minimal request/response client over a Transport. */
class Client {
  private readonly transport: Transport;
  private readonly decoder = new FrameDecoder();
  private pending: ((v: { ok?: Record<string, CborValue>; err?: DeviceError }) => void) | null = null;
  /** Established after the handshake; null while everything is plaintext. */
  private session: Session | null = null;
  /** Serialises requests; see call(). */
  private queue: Promise<void> = Promise.resolve();
  /** True during waitForApproval, when a plaintext 0x0400 means "not yet". */
  private awaitingApproval = false;

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onFrame((frame) => {
      for (const f of this.decoder.push(frame)) {
        let payload = f.payload;

        /* Encrypted replies are unsealed before parsing. A failed tag throws
         * and is surfaced rather than retried: a forged frame means the
         * channel is no longer trustworthy. */
        const encrypted =
          f.type === FrameType.EncryptedResponse || f.type === FrameType.EncryptedError;

        /* An encrypted frame with no session to open it is ciphertext, and
         * ciphertext parsed as CBOR is noise - "unsupported major type 7",
         * "trailing bytes", whatever the random bytes happen to spell. Say
         * what actually happened instead of reporting the shape of the
         * garbage. */
        if (encrypted && !this.session) {
          const resolve = this.pending;
          this.pending = null;
          resolve?.({ err: new DeviceError(
            ErrorCode.SessionRequired,
            "the device replied encrypted but this side has no session; reconnect",
          ) });
          continue;
        }

        if (encrypted && this.session) {
          try {
            payload = this.session.decrypt(payload);
          } catch {
            this.killSession("a reply failed authentication");
            const resolve = this.pending;
            this.pending = null;
            resolve?.({ err: new DeviceError(0x0400, "authentication failed") });
            continue;
          }
        }

        const body = decodeCbor(payload) as Record<string, CborValue>;
        const resolve = this.pending;
        this.pending = null;
        if (!resolve) continue;
        if (f.type === FrameType.Error || f.type === FrameType.EncryptedError) {
          const code = Number(body["code"]);
          /* 0x0400 in PLAINTEXT after a session existed means the device threw
           * the session away - session_decrypt() resets on a failed tag, and a
           * failed tag is indistinguishable from an attack, so failing closed
           * there is right. But it leaves this side holding keys the device has
           * forgotten, and every later request gets the same "decrypt failed"
           * against a session that is already gone. Retrying into that is what
           * made an unlock fail twice and look like the PIN was wrong.
           *
           * One corrupted frame is rare on a cable and entirely ordinary on a
           * radio, which is why this only ever showed up over BLE. */
          /* Not while waiting for the button. A device that has not been
           * confirmed yet answers exactly this, in plaintext, every time it is
           * polled - it means "not yet", not "your session is gone". Killing
           * the session here deleted the one that was about to become valid,
           * and the poll then succeeded in plaintext and reported an encrypted
           * channel that did not exist. */
          if (code === ErrorCode.SessionRequired && f.type === FrameType.Error &&
              !this.awaitingApproval) {
            this.killSession("the device ended the session");
          }
          resolve({ err: new DeviceError(code, String(body["message"])) });
        } else {
          resolve({ ok: body["result"] as Record<string, CborValue> });
        }
      }
    });
  }

  /**
   * Send one request and await its reply, one at a time.
   *
   * The link has no request IDs, so a reply belongs to whichever request went
   * out last. With a background poll running, a user action could overlap it
   * and each would resolve the other's promise — and because the nonce counter
   * advances on a completed exchange, the two ends then drift apart and every
   * later frame fails. That is what "clicked Unlock and it hung" was.
   *
   * Serialising here is the fix rather than removing the poll: the poll exists
   * to notice changes made on the device, which is exactly when a user is also
   * touching the app.
   */
  async call(
    method: string,
    params: Record<string, CborValue> = {},
    timeoutMs = 5000,
  ): Promise<Record<string, CborValue>> {
    const mine = this.queue.then(() => this.callNow(method, params, timeoutMs));
    // Keep the chain alive even when a call rejects, or one failure wedges
    // every request that follows.
    this.queue = mine.then(() => undefined, () => undefined);
    return mine;
  }

  private async callNow(
    method: string,
    params: Record<string, CborValue> = {},
    timeoutMs = 5000,
  ): Promise<Record<string, CborValue>> {
    /* Waiting longer than the device does is the only safe direction. If the
     * transport gives up first, the device still processes the request and
     * replies to nobody: its counters move, the host's do not, and the session
     * is unrecoverable. That is not a timeout, it is a broken connection with
     * a misleading message. */
    const t = this.transport as { timeoutMs?: number };
    if ("timeoutMs" in t) t.timeoutMs = timeoutMs;

    const reply = new Promise<{ ok?: Record<string, CborValue>; err?: DeviceError }>((r) => {
      this.pending = r;
    });

    /* Flat, per PROTOCOL.md section 4: fields sit beside `method` rather than
     * inside a `params` object. The firmware looks for them at the top level,
     * so a nested request would have had its arguments silently ignored. */
    const body = encodeCbor({ method, ...params });
    const [type, payload] = this.session?.isActive
      ? [FrameType.EncryptedRequest, this.session.encrypt(body)]
      : [FrameType.Request, body];

    try {
      await this.transport.send(encodeFrame(type, payload));
    } catch (e) {
      /* The device may still be processing. Its counters will have moved and
       * ours have not, so the session cannot be reused - fail loudly rather
       * than leaving the next request to die with "decrypt failed". */
      this.session = null;
      this.pending = null;
      throw new Error(
        `${(e as Error).message}. The session is no longer usable; disconnect and reconnect.`,
      );
    }
    const { ok, err } = await reply;
    if (err) throw err;
    return ok ?? {};
  }

  /**
   * Run the X25519 handshake and return the passkey to compare.
   *
   * The device shows the same six digits on its own screen. They match only if
   * nobody is relaying between the two, which is the whole reason the user is
   * asked to look — encryption alone would protect a conversation with an
   * impostor perfectly well.
   */
  async handshake(): Promise<string> {
    const { privateKey, publicKey } = generateKeypair();
    const reply = await this.call("hello", { hostPubkey: publicKey });

    const devicePubkey = reply["devicePubkey"];
    if (!(devicePubkey instanceof Uint8Array) || devicePubkey.length !== 32) {
      throw new Error("device did not return a public key");
    }

    this.session = new Session(deriveSession(privateKey, devicePubkey), "host");
    return this.session.passkey;
  }

  /**
   * Wait for the user to approve on the device.
   *
   * There is no "confirmed" message to wait for: the device simply starts
   * accepting encrypted traffic once the button is pressed. So the host tries
   * an encrypted call until one succeeds, which is both the check and the
   * first real use of the channel.
   */
  async waitForApproval(timeoutMs = 60000): Promise<void> {
    if (!this.session) throw new Error("no handshake");
    this.session.confirm();
    this.awaitingApproval = true;
    try {

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        /* The first encrypted call to succeed IS the confirmation - there is
         * no "confirmed" message to wait for. So it must be an encrypted one:
         * getStatus answers in plaintext too, and a plaintext success here
         * would report a channel that was never established. */
        if (!this.session) {
          throw new Error("the session was lost while waiting for confirmation");
        }
        try {
          await this.call("getStatus");
          return;
        } catch {
          if (Date.now() > deadline) {
            throw new Error("timed out waiting for confirmation on the device");
          }
          await new Promise((r) => setTimeout(r, 750));
        }
      }
    } finally {
      this.awaitingApproval = false;
    }
  }

  /**
   * Forget the session. The next call goes out in plaintext and is refused,
   * which is the honest outcome: there is no channel until a new handshake,
   * and quietly re-establishing one would skip the passkey comparison that
   * makes the channel worth anything.
   */
  private killSession(why: string): void {
    if (!this.session) return;
    this.session = null;
    log(`session ended — ${why}. Reconnect to compare a new passkey.`);
    setConnection("connecting", "Session ended — reconnect");
  }

  get encrypted(): boolean {
    return this.session?.isActive ?? false;
  }
}

/* ------------------------------------------------------------------- state */

let transport: Transport | null = null;
let client: Client | null = null;

/**
 * What the backend says it can do. Empty in a browser tab and on Android,
 * where the mock is the only honest option.
 */
let available: HardwareKind[] = [];

type LinkKind = HardwareKind | "mock";

/** Whatever the Link selector currently reads. */
function selectedKind(): LinkKind {
  const value = ($("transport") as HTMLSelectElement).value;
  return value === "usb" || value === "ble" ? value : "mock";
}
let selectedIndex = 0;
const addresses: string[] = [];

/* Last known device state, and a poll to notice changes the app did not cause
 * - an auto-lock on the device's own timer, or a wallet switched by hand. */
let lastStatus: DeviceStatus = UNKNOWN_STATUS;

/* Whether the DEVICE will accept a call it cannot decode.
 *
 * Read from getFeatures rather than assumed, and re-read on every status poll
 * because the setting lives on the device and its owner can change it mid
 * session - which is exactly what someone does the moment a dapp is refused.
 * Defaults to false so a device that has not answered yet is treated as
 * protected: the safe direction to be wrong in. */
let deviceBlindSigning = false;

async function readBlindSigning(): Promise<boolean> {
  try {
    const f = await (client as Client).call("getFeatures");
    return f["blindSigning"] === 1;
  } catch {
    return false;
  }
}
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Bumped whenever a derivation is superseded or discarded. */
let loadGeneration = 0;

async function readStatus(): Promise<DeviceStatus> {
  deviceBlindSigning = await readBlindSigning();
  const s = await (client as Client).call("getStatus");
  return {
    unlocked: s["unlocked"] === 1,
    walletCount: Number(s["walletCount"] ?? 0),
    activeWallet: Number(s["activeWallet"] ?? 0),
    passphrase: s["passphrase"] === 1,
  };
}

/**
 * Forget everything derived.
 *
 * Called whenever the device state moves in a way that changes derivation. The
 * addresses on screen would otherwise belong to a wallet the device can no
 * longer produce, and nothing about them would look wrong.
 */
function invalidateDerived(reason: string): void {
  // Retire any in-flight derivation as well as the current list.
  loadGeneration++;
  addresses.length = 0;
  $("addrs").textContent = "";
  $("addrpanel").hidden = true;
  $("signpanel").hidden = true;
  $("sfrom").textContent = "—";
  log(`derived addresses cleared: ${reason}`);
  // A locked device offers no accounts, so a proposal on screen has to say so.
  walletConnect.accountsChanged();
}

let polling = false;

/** Why the previous state no longer applies. Ordered most specific first. */
function invalidationReason(before: DeviceStatus, after: DeviceStatus): string {
  if (!after.unlocked) return "device locked";
  if (!before.unlocked) return "device unlocked";
  if (before.activeWallet !== after.activeWallet) return "wallet changed on device";
  if (before.passphrase !== after.passphrase) {
    return after.passphrase ? "passphrase applied on device" : "passphrase cleared on device";
  }
  return "device state changed";
}

async function poll(): Promise<void> {
  if (!client) return;

  /* setInterval does not wait. Deriving ten addresses takes seconds, so
   * without this guard the next tick re-enters while the previous run is still
   * working, and each one starts another derivation. */
  if (polling) return;
  polling = true;

  try {
    const now = await readStatus();
    const changed = derivationsInvalidated(lastStatus, now);

    /* Record the new state *before* the slow part. Updating it afterwards
     * meant every tick during a derivation still compared against the old
     * status, decided things had changed again, and kicked off another
     * derivation - forty-two addresses and climbing. */
    const reason = changed ? invalidationReason(lastStatus, now) : "";
    lastStatus = now;

    $("wallet").textContent = now.unlocked
      ? `wallet ${now.activeWallet}/${now.walletCount}${now.passphrase ? " + passphrase" : ""}`
      : "locked";

    if (changed) {
      invalidateDerived(reason);
      if (now.unlocked) {
        await loadAddresses();
        $("addrpanel").hidden = false;
        $("signpanel").hidden = false;
      }
    }
  } catch {
    /* A poll failing is not itself news; the connection state covers it. */
  } finally {
    polling = false;
  }
}

const setConnection = (state: string, label: string): void => {
  $("dot").dataset["state"] = state;
  $("conn").textContent = label;
};

const busy = (on: boolean): void => {
  for (const id of ["connect", "unlock", "disconnect", "sign"]) {
    ($(id) as HTMLButtonElement).disabled = on;
  }
};

/* ----------------------------------------------------------------- actions */

/**
 * Find a device on the selected link.
 *
 * Returns null having already explained itself, because the two failures need
 * different explanations: no serial port is usually a cable or a permissions
 * problem, while nothing advertising over BLE is usually a device that is
 * simply in USB mode and therefore silent on the radio (PROTOCOL.md 3b).
 * Collapsing both into "no device found" would send someone hunting a fault
 * that does not exist.
 */
async function findDevice(kind: LinkKind): Promise<Transport | null> {
  if (kind === "usb") {
    /* Enumeration *rejects* rather than returning empty when the platform has
     * something specific to say - on Android, the cable and USB-host checks
     * that a laptop's dialout-group advice would send someone past. Same shape
     * as the BLE branch below, and for the same reason: swallowing the message
     * would leave the user staring at an empty list. */
    let ports;
    try {
      ports = await listPorts();
    } catch (e) {
      setConnection("error", "No device over USB");
      log(String((e as Error).message ?? e));
      return null;
    }
    const port = ports.find((p) => p.likely_device) ?? ports[0];
    if (!port) {
      setConnection("error", "No device over USB");
      log("no USB serial ports; check the cable, and that you are in the dialout group");
      return null;
    }
    /* More than one candidate is unusual and worth saying out loud rather than
     * silently taking the first - the same rule the BLE branch follows. It is
     * not hypothetical on a phone: a USB-C dock or a second dev board is a
     * whole extra Espressif device on the bus, and the user should know a
     * choice was made for them before they approve a signature on it. */
    const candidates = ports.filter((p) => p.likely_device);
    if (candidates.length > 1) {
      log(`${candidates.length} Espressif devices attached; using ${port.name}`);
    } else if (!port.likely_device) {
      log(`no Espressif device among ${ports.length} port(s); trying ${port.name} anyway`);
    }
    log(`found ${port.name} — ${port.description}`);
    /* A port existing does not mean the device is listening on it. With Link
     * set to Bluetooth the firmware drains this port and parses nothing
     * (PROTOCOL.md 3b), so the cable enumerates exactly as it always does and
     * every request goes unanswered. There is no way to ask the device which
     * link it is on over the link it has switched off, so the silence is the
     * signal - see the handshake timeout below. */
    return new TauriSerialTransport(port.name);
  }

  if (kind === "ble") {
    log("scanning for Bluetooth devices…");
    let found;
    try {
      found = await scanBle();
    } catch (e) {
      setConnection("error", "Bluetooth unavailable");
      log(String((e as Error).message ?? e));
      return null;
    }
    const device = found[0];
    if (!device) {
      setConnection("error", "No device over Bluetooth");
      log(BLE_NOT_FOUND);
      return null;
    }
    // More than one is unusual and worth saying out loud rather than silently
    // taking the first: the user should know a choice was made for them.
    if (found.length > 1) {
      log(`${found.length} devices advertising; using ${device.name ?? device.id}`);
    }
    log(`found ${device.name ?? "(unnamed)"} — ${device.id}`);
    return new BleTransport(device);
  }

  /* Latency is deliberate: a mock that answers instantly hides every place
   * the UI forgot to show that it is waiting. `pinEntryMs` is the same idea
   * applied to unlocking - the device only prompts, and the seconds the user
   * spends on the keypad are seconds this app has to keep polling and keep
   * saying so. */
  return new MockDevice({ latencyMs: 250, walletCount: 1, pinEntryMs: 2000 });
}

async function connect(): Promise<void> {
  /* Real hardware over whichever link the user picked, the mock when there is
   * none. All three are interchangeable by construction — if they were not,
   * everything built against the mock would need revisiting the first time a
   * device was plugged in, and everything proven over USB would prove nothing
   * about BLE. */
  const kind = selectedKind();
  const found = await findDevice(kind);
  if (!found) return;
  transport = found;
  client = new Client(transport);
  setMode(transport);

  setConnection("connecting", "Connecting…");
  busy(true);
  try {
    await transport.open();
  } catch (e) {
    setConnection("error", "Connection failed");
    log(String((e as Error).message ?? e));
    transport = null;
    client = null;
    setMode(null);
    busy(false);
    return;
  }

  if (kind !== "mock") {
    /* Nothing stale may survive into a new attempt. A passkey left on screen
     * from a previous session is worse than none: the whole point is that the
     * user compares it against the device, and a number the device is not
     * showing invites them to conclude the comparison failed for some other
     * reason - or, worse, to stop checking. */
    $("passkey").textContent = "";
    $("pairing").hidden = true;

    /* Real firmware: derive the passkey from the exchange and wait for the
     * user to compare it against the OLED. */
    let passkey: string;
    try {
      passkey = await client.handshake();
    } catch (e) {
      /* On USB this is nearly always a device whose Link is set to Bluetooth:
       * the port opened, the bytes went out, and nothing was listening. */
      setConnection("error", "Device did not answer");
      if (kind === "usb") {
        log("the port opened but the device never answered.");
        log("if the device's Link setting is Bluetooth, USB is silent by design —");
        log("check Settings → Link on the device, or switch this app to Bluetooth.");
      } else {
        log(`handshake failed: ${String((e as Error).message ?? e)}`);
      }
      await transport.close().catch(() => {});
      return;
    }
    $("passkey").textContent = `${passkey.slice(0, 3)} ${passkey.slice(3)}`;
    $("pairing").hidden = false;
    log(`handshake done — compare ${passkey} with the device screen`);
    log("press ALLOW on the device to continue");
    setConnection("connecting", "Confirm on device…");

    await client.waitForApproval();
    log("approved on device; channel encrypted");
  } else {
    const hello = await client.call("hello");
    const passkey = hello["passkey"];
    $("passkey").textContent =
      typeof passkey === "string" ? passkey : "(mock: nothing to compare)";
    $("pairing").hidden = false;
    log(`session established with ${transport.label}`);
  }

  setConnection("connected", transport.label);
  $("devicehint").textContent = kind !== "mock"
    ? `Connected over ${transport.label}. The device confirms everything it signs on its own screen.`
    : "Connected to the mock. Behaviour matches the protocol, but keys and signatures are not real.";
  busy(false);
  ($("connect") as HTMLButtonElement).disabled = true;
  // Switching links mid-session would tear down the device's session anyway;
  // shutting the selector says so before it happens.
  ($("transport") as HTMLSelectElement).disabled = true;
  ($("unlock") as HTMLButtonElement).disabled = false;
  ($("disconnect") as HTMLButtonElement).disabled = false;
}

async function unlock(): Promise<void> {
  if (!client) return;
  busy(true);
  log("enter your PIN on the device…");
  try {
    const reply = await client.call("unlock");

    /* The device only *prompts*; the PIN is typed there and never travels, so
     * the reply is `{prompted:1, unlocked:0}` and arrives long before the user
     * has touched the keypad. The status poll is the answer. `{unlocked:1}`
     * comes back only when the device was already unlocked. */
    if (reply["unlocked"] !== 1) {
      log("waiting for the PIN on the device…");
      const deadline = Date.now() + 120000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 750));
        const s = await readStatus();
        if (s.unlocked) break;
        if (Date.now() > deadline) throw new Error("timed out waiting for the PIN");
      }
    }
    log("device unlocked");
    await loadAddresses();
    $("addrpanel").hidden = false;
    $("signpanel").hidden = false;
    lastStatus = await readStatus();
    if (!lastStatus.unlocked) {
      log("device is locked — press Unlock, then enter your PIN on the device");
    }
    $("wallet").textContent =
      `wallet ${lastStatus.activeWallet}/${lastStatus.walletCount}` +
      (lastStatus.passphrase ? " + passphrase" : "");

    /* Two seconds is frequent enough that a lock is noticed before the user
     * acts on a stale address, and rare enough not to keep a BLE link busy. */
    if (!pollTimer) pollTimer = setInterval(() => void poll(), 2000);
  } catch (e) {
    // Name the thing that failed. "undefined" was the previous message when
    // the device answered with an error carrying no text.
    const msg = e instanceof DeviceError ? e.message
      : e instanceof Error && e.message ? e.message
      : String(e);
    log(`unlock failed: ${msg}`);
  } finally {
    busy(false);
    ($("connect") as HTMLButtonElement).disabled = true;
  }
}

async function loadAddresses(): Promise<void> {
  if (!client) return;

  /* Each run claims a generation. If another starts while this one is waiting
   * on the device, this one abandons its results rather than appending them to
   * a list it no longer owns. */
  const generation = ++loadGeneration;

  addresses.length = 0;
  const list = $("addrs");
  list.textContent = "Deriving…";

  const derived: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await client.call("getAddress", { path: `m/44'/60'/0'/0/${i}` });
    if (generation !== loadGeneration) return;   // superseded
    derived.push(String(r["address"]));
  }

  addresses.length = 0;
  addresses.push(...derived);

  list.textContent = "";
  addresses.forEach((addr, i) => {
    const btn = document.createElement("button");
    btn.className = "addr-item";
    btn.setAttribute("aria-selected", String(i === selectedIndex));
    btn.innerHTML =
      `<span class="addr-item__index">${i}</span><span class="addr">${chunk(addr)}</span>`;
    btn.addEventListener("click", () => {
      selectedIndex = i;
      for (const el of Array.from(list.children)) el.setAttribute("aria-selected", "false");
      btn.setAttribute("aria-selected", "true");
      $("sfrom").textContent = `m/44'/60'/0'/0/${i}`;
      log(`selected address ${i}`);
    });
    list.appendChild(btn);
  });

  $("sfrom").textContent = `m/44'/60'/0'/0/${selectedIndex}`;
  log(`derived ${addresses.length} addresses`);
  walletConnect.accountsChanged();
}

/* ------------------------------------------------------------------ chains */

/*
 * Chain selection (T51). The registry in packages/core/src/chains.ts is the
 * only source of chain facts; nothing about a network is written down here.
 *
 * The choice is persisted because it is the single field a user is most likely
 * to get wrong by inattention: the same address exists on every EVM chain, and
 * a signature that was meant for a testnet but was made on mainnet spends real
 * money. Restoring the last choice is not merely convenient, it means the
 * selector reads the same on every launch instead of quietly resetting.
 */
const CHAIN_KEY = "leek.chainId";

/** Sepolia: the default has to be a testnet, since a mis-click here costs money. */
const DEFAULT_CHAIN_ID = 11155111;

function storedChainId(): number {
  const raw = localStorage.getItem(CHAIN_KEY);
  const id = raw === null ? NaN : Number(raw);
  return getChain(id) ? id : DEFAULT_CHAIN_ID;
}

let chainId = storedChainId();

/** Never undefined: storedChainId() only returns IDs the registry knows. */
function activeChain(): ChainInfo {
  return getChain(chainId) ?? (getChain(DEFAULT_CHAIN_ID) as ChainInfo);
}

/**
 * The registry entry as viem wants it. Built per call rather than cached: viem
 * only needs id, currency and a URL, and a stale cache here would mean signing
 * for one chain while broadcasting to another.
 */
function viemChain(info: ChainInfo, endpoint: string): Chain {
  return defineChain({
    id: info.id,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: [endpoint] } },
    ...(info.testnet ? { testnet: true } : {}),
  });
}

/** Rebuild the RPC list for whatever chain is selected, preserving nothing. */
function populateRpcs(info: ChainInfo): void {
  const select = $("rpc") as HTMLSelectElement;
  select.textContent = "";
  for (const url of info.rpcUrls) {
    const opt = document.createElement("option");
    opt.value = url;
    // The host, not the full URL: the user is choosing who to tell, and the
    // path is noise in that decision.
    opt.textContent = new URL(url).host;
    select.appendChild(opt);
  }
}

function applyChain(info: ChainInfo): void {
  populateRpcs(info);
  $("amountlabel").textContent = `Amount (${info.nativeCurrency.symbol})`;
  $("chainnote").dataset["net"] = info.testnet ? "testnet" : "mainnet";
  $("chainnote").textContent = info.testnet
    ? `Chain ${info.id}. Testnet — this money is not worth anything. Check the chain ID on the device.`
    : `Chain ${info.id}. MAINNET — real funds. Check the chain ID on the device before approving.`;
  renderPreview();
}

function initChainSelector(): void {
  const select = $("chain") as HTMLSelectElement;
  select.textContent = "";
  for (const c of CHAINS) {
    const opt = document.createElement("option");
    opt.value = String(c.id);
    opt.textContent = `${c.name} (${c.id})${c.testnet ? " — testnet" : ""}`;
    select.appendChild(opt);
  }
  select.value = String(chainId);
  select.addEventListener("change", () => {
    const picked = getChain(Number(select.value));
    // An unknown value can only come from a tampered DOM; ignore rather than
    // sign against a chain nothing in the app can name.
    if (!picked) return;
    chainId = picked.id;
    localStorage.setItem(CHAIN_KEY, String(chainId));
    applyChain(picked);
    log(`chain: ${picked.name} (${picked.id})`);
    // Sessions are told, or a connected dapp keeps building transactions for
    // the chain this wallet has just left.
    walletConnect.chainChanged(picked.id);
  });
  applyChain(activeChain());
}

/* ---------------------------------------------------------------- preview */

/**
 * Draw the advisory interpretation of whatever is currently in the form.
 *
 * It updates as the user types rather than appearing at the moment they press
 * Sign, so an unlimited approval or a refusal is read while there is still
 * something to do about it. Everything here is host-side and therefore
 * untrustworthy by construction: the notice at the bottom is not decoration,
 * it is the only accurate statement on the card. See PROTOCOL.md 6c.
 */
function renderPreview(fee?: { gas: bigint; maxFeePerGas: bigint }): void {
  const panel = $("preview");
  const toValue = ($("to") as HTMLInputElement).value.trim();
  const amountValue = ($("amount") as HTMLInputElement).value.trim();

  let value: bigint;
  try {
    value = parseEther(amountValue);
  } catch {
    value = 0n;
  }

  // An incomplete form has nothing worth summarising, and a half-summary of a
  // half-typed address invites reading it as if it were complete.
  if (!isAddress(toValue)) {
    panel.hidden = true;
    return;
  }

  const view: TxInterpretation = interpretTransaction(
    {
      chainId,
      to: toValue,
      value,
      ...(fee ? { gas: fee.gas, maxFeePerGas: fee.maxFeePerGas } : {}),
    },
    // Symbol from the chain registry, for descriptor `amount` fields. The
    // descriptor set itself is the bundled one and is never fetched here.
    { nativeSymbol: activeChain().nativeCurrency.symbol },
  );

  renderInterpretation(
    {
      summary: $("psummary"),
      fields: $("pfields"),
      warnings: $("pwarnings"),
      authority: $("pauthority"),
    },
    view,
    activeChain().nativeCurrency.symbol,
  );
  panel.hidden = false;
}

/**
 * Ask the device to sign.
 *
 * There is deliberately no "simulate rejection" button any more. It worked by
 * swapping the live transport for a mock configured to refuse - and never
 * swapped it back, so every later request went to a fake device while the
 * badge still read "hardware". A control that silently replaces your hardware
 * connection is worse than no control; the rejection path is covered by the
 * mock-device tests, where it belongs.
 */
async function sign(): Promise<void> {
  if (!transport || !client) return;

  const toValue = ($("to") as HTMLInputElement).value.trim();
  const amountValue = ($("amount") as HTMLInputElement).value.trim();
  $("txresult").textContent = "";

  if (!isAddress(toValue)) {
    ($("to") as HTMLInputElement).setAttribute("aria-invalid", "true");
    log("that is not a valid address");
    return;
  }
  ($("to") as HTMLInputElement).removeAttribute("aria-invalid");

  let value: bigint;
  try {
    value = parseEther(amountValue);
  } catch {
    ($("amount") as HTMLInputElement).setAttribute("aria-invalid", "true");
    log("that is not a valid amount");
    return;
  }
  ($("amount") as HTMLInputElement).removeAttribute("aria-invalid");

  busy(true);
  try {
    const from = addresses[selectedIndex] as Address | undefined;
    if (!from) throw new Error("no address selected");

    /* Chain state comes from a public RPC, which is untrusted like any other
     * host input. A wrong nonce or fee produces a stuck or replaced
     * transaction, not a stolen one - the device still shows what it signs.
     * Worth knowing that this query tells the RPC operator which addresses
     * you are interested in. */
    /* The endpoint is chosen from a short allowlist that the CSP also permits.
     * An editable field would mean allowing any host, which is precisely what
     * a compromised dependency would want. */
    const endpoint = ($("rpc") as HTMLSelectElement).value;
    /* Snapshot the chain for the whole of this signing run. Re-reading the
     * selector after the device has been asked would let a mid-flight change
     * broadcast to a network other than the one that was signed for. */
    const chain = activeChain();
    const rpc = createPublicClient({ chain: viemChain(chain, endpoint), transport: http(endpoint) });
    log(`fetching nonce and fees via ${new URL(endpoint).host}…`);

    const [nonce, fees] = await Promise.all([
      rpc.getTransactionCount({ address: from }),
      rpc.estimateFeesPerGas(),
    ]);
    const maxFeePerGas = fees.maxFeePerGas ?? 30000000000n;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1000000000n;

    log(`nonce ${nonce}, max fee ${maxFeePerGas} wei`);

    /* Re-draw the preview now that the fee ceiling is known, and repeat any
     * warnings in the log — the panel can be scrolled off, and an unlimited
     * approval is worth saying twice. Nothing here blocks: refusing to send
     * would only teach the user that the app decides what is safe. */
    renderPreview({ gas: 21000n, maxFeePerGas });
    for (const w of interpretTransaction({ chainId: chain.id, to: toValue, value }).warnings) {
      log(`warning: ${w.message}`);
    }

    log("check every page on the device, then approve");

    const SIGN_TIMEOUT_MS = 150000;   // the device gives the user 120 s
    const tx = {
      chainId: chain.id,
      nonce,
      to: toValue as Address,
      value,
      gas: 21000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: "eip1559" as const,
    };

    const reply = await client.call("signTransaction", {
      index: selectedIndex,
      chainId: chain.id,
      nonce,
      to: hexBytes(toValue),
      value: weiBytes(value),
      gas: weiBytes(21000n),
      maxFeePerGas: weiBytes(maxFeePerGas),
      maxPriorityFeePerGas: weiBytes(maxPriorityFeePerGas),
    }, SIGN_TIMEOUT_MS);

    const r = reply["r"];
    const sv = reply["s"];
    if (!(r instanceof Uint8Array) || !(sv instanceof Uint8Array)) {
      throw new Error("device returned no signature");
    }
    /* Reassemble here rather than on the device: the signature covers the
     * digest the device computed from its own parse, so the serialised form
     * either matches or the network rejects it. */
    /* The device sends yParity directly. Deriving it from a legacy v by
     * masking the low bit inverts the value, which produces a signature that
     * recovers to an address with no funds - a failure that reads as "you
     * are broke" rather than "the signature is wrong". */
    const yParity = reply["yParity"];
    if (yParity !== 0 && yParity !== 1) {
      throw new Error(`device returned yParity ${String(yParity)}, expected 0 or 1`);
    }

    const raw = serializeTransaction(tx, { r: toHex(r), s: toHex(sv), yParity });

    log("broadcasting…");
    const hash = await rpc.sendRawTransaction({ serializedTransaction: raw });

    log(`sent: ${hash}`);
    $("txresult").innerHTML =
      `Sent. <a href="${chain.explorerUrl}/tx/${hash}" target="_blank" rel="noreferrer">View on explorer</a>`;
  } catch (e) {
    if (e instanceof DeviceError && e.code === 0x0200) {
      log("rejected on the device");
    } else if (e instanceof DeviceError && e.code === 0x0201) {
      log("timed out waiting for an answer on the device");
    } else if (e instanceof DeviceError) {
      log(`declined: ${e.message}`);
    } else {
      log(String((e as Error).message ?? e));
    }
  } finally {
    busy(false);
  }
}

/* ----------------------------------------------------- walletconnect bridge
 *
 * The only route from a dapp to the hardware. Everything a dapp can cause is
 * one of the three methods below, which is what makes the question "what can a
 * connected dapp do?" answerable by reading one screen of code.
 *
 * Note what is *not* here: no path that hands the device a pre-built hash, no
 * path that bypasses the device confirmation, and no path that lets a dapp pick
 * an RPC endpoint. The endpoint always comes from the registry, so a dapp
 * cannot use this app as a proxy to an arbitrary host.
 */

/** Minimal-length big-endian bytes, as the wire format wants. */
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

/** Index of an address in the derived list, or -1. Case-insensitive. */
function addressIndex(address: string): number {
  const want = address.toLowerCase();
  return addresses.findIndex((a) => a.toLowerCase() === want);
}

/**
 * Reassemble the device's `{r, s, yParity}` into a 65-byte signature.
 *
 * The mock still answers `signMessage` with a flat `{signature}` (divergence 2
 * in PROTOCOL.md 6e is closed for the firmware but not in the mock), so both
 * shapes are accepted rather than letting the app work against one and break
 * against the other.
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

/**
 * Sign a transaction a dapp asked for, and broadcast it if it asked for that.
 *
 * Nonce and fees are filled from the registry's RPC when the dapp left them
 * out. A dapp-supplied nonce or fee is honoured — getting either wrong costs a
 * stuck transaction, not funds, and the device still shows what it signs.
 */
async function signPlannedTransaction(tx: PlannedTx, broadcast: boolean): Promise<string> {
  if (!client) throw new Error("no device connected");
  const index = addressIndex(tx.from);
  if (index < 0) throw new Error("that address is not one this device has derived");

  const info = getChain(tx.chainId);
  if (!info) throw new Error(`this wallet has no RPC for chain ${tx.chainId}`);
  const endpoint = info.rpcUrls[0] as string;
  const rpc = createPublicClient({
    chain: viemChain(info, endpoint),
    transport: http(endpoint),
  });

  const from = addresses[index] as Address;
  const nonce = tx.nonce ?? (await rpc.getTransactionCount({ address: from }));

  let maxFeePerGas = tx.maxFeePerGas;
  let maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
  if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
    const fees = await rpc.estimateFeesPerGas();
    maxFeePerGas = maxFeePerGas ?? fees.maxFeePerGas ?? 30000000000n;
    maxPriorityFeePerGas = maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas ?? 1000000000n;
  }

  /* Estimating is a query to the RPC, which learns what is about to be signed.
   * That is the same disclosure the nonce lookup already makes, and the
   * alternative — guessing a gas limit for arbitrary calldata — produces
   * transactions that revert after spending the gas. */
  const gas = tx.gas ?? (await rpc.estimateGas({
    account: from,
    to: tx.to as Address,
    value: tx.value,
    data: tx.data as Hex,
  }));

  log("check every page on the device, then approve");
  const reply = await client.call("signTransaction", {
    index,
    chainId: tx.chainId,
    nonce,
    to: hexBytes(tx.to),
    value: weiBytes(tx.value),
    data: hexBytes(tx.data),
    gas: weiBytes(gas),
    maxFeePerGas: weiBytes(maxFeePerGas),
    maxPriorityFeePerGas: weiBytes(maxPriorityFeePerGas),
  }, 150000);

  const r = reply["r"];
  const s = reply["s"];
  const yParity = reply["yParity"];
  if (!(r instanceof Uint8Array) || !(s instanceof Uint8Array)) {
    throw new Error("device returned no signature");
  }
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(`device returned yParity ${String(yParity)}, expected 0 or 1`);
  }

  const raw = serializeTransaction(
    {
      chainId: tx.chainId,
      nonce,
      to: tx.to as Address,
      value: tx.value,
      data: tx.data as Hex,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: "eip1559" as const,
    },
    { r: toHex(r), s: toHex(s), yParity },
  );

  if (!broadcast) return raw;
  log(`broadcasting via ${new URL(endpoint).host}…`);
  return await rpc.sendRawTransaction({ serializedTransaction: raw });
}

/** EIP-191 message signing. The device renders the message and signs its own digest. */
async function signPlannedMessage(address: string, message: string): Promise<string> {
  if (!client) throw new Error("no device connected");
  const index = addressIndex(address);
  if (index < 0) throw new Error("that address is not one this device has derived");
  const reply = await client.call("signMessage", { index, message }, 150000);
  return signatureFrom(reply);
}

const walletBridge: WalletBridge = {
  // Locked means no accounts, which is what stops a dapp asking for a
  // signature the device could not produce anyway.
  accounts: () => [...addresses],
  /* The device's setting, not the app's opinion of it. Refusing here a call
   * the owner has explicitly allowed on the device would be the app overruling
   * them, invisibly - they would opt in and see the identical refusal. */
  blindSigning: () => deviceBlindSigning,
  chainId: () => chainId,
  setChainId: (id: number) => {
    const picked = getChain(id);
    if (!picked) return;
    chainId = picked.id;
    localStorage.setItem(CHAIN_KEY, String(chainId));
    ($("chain") as HTMLSelectElement).value = String(chainId);
    applyChain(picked);
    log(`chain: ${picked.name} (${picked.id})`);
  },
  signTransaction: signPlannedTransaction,
  signMessage: signPlannedMessage,
  log,
};

const walletConnect = initWalletConnect(walletBridge);

async function disconnect(): Promise<void> {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  lastStatus = UNKNOWN_STATUS;
  await transport?.close();
  transport = null;
  client = null;
  setConnection("disconnected", "Disconnected");
  setMode(null);
  // Back to whatever the build allows: a single-option selector stays shut.
  ($("transport") as HTMLSelectElement).disabled =
    ($("transport") as HTMLSelectElement).options.length < 2;
  $("addrpanel").hidden = true;
  $("signpanel").hidden = true;
  $("pairing").hidden = true;
  $("wallet").textContent = "";
  ($("connect") as HTMLButtonElement).disabled = false;
  ($("unlock") as HTMLButtonElement).disabled = true;
  ($("disconnect") as HTMLButtonElement).disabled = true;
  log("disconnected; session secrets cleared");
}

/* ------------------------------------------------------------------- wiring */

const LINK_NAMES: Record<LinkKind, string> = {
  usb: "USB cable",
  ble: "Bluetooth",
  mock: "Mock device",
};

/**
 * Say what the badge actually knows, and no more.
 *
 * Before a connection it can only report what this build could do; after one
 * it names the live transport. Naming it matters: a user comparing an address
 * against the device screen is checking that the thing on the desk produced
 * it, and "hardware" alone does not say which wire that answer came down.
 */
function setMode(active: Transport | null): void {
  const badge = $("mode");
  if (active) {
    const hardware = active.kind !== "mock";
    badge.textContent = hardware
      ? `hardware · ${active.kind.toUpperCase()}`
      : "mock";
    badge.dataset["mode"] = hardware ? "hardware" : "mock";
    badge.title = hardware
      ? `Connected to real hardware over ${LINK_NAMES[active.kind]}`
      : "Simulated device — nothing here is signed by hardware";
    return;
  }

  const hasHardware = available.length > 0;
  badge.textContent = hasHardware ? "no link" : "mock";
  badge.dataset["mode"] = hasHardware ? "idle" : "mock";
  badge.title = hasHardware
    ? "Not connected. The badge names the transport once a device answers."
    : "This build has no device transport; the mock is the only option";
}

/* Say plainly what this window can talk to, before anything is connected. The
 * label used to read "Connect mock device" unconditionally, so a native window
 * talking to real hardware still claimed to be a simulation. */
async function initEnvironment(): Promise<void> {
  available = await availableTransports();

  const select = $("transport") as HTMLSelectElement;
  select.textContent = "";
  /* The mock is offered only when there is no real transport. On a desktop
   * build it would be an option sitting one mis-click away from the hardware
   * one, and a fake device the user believes is real is worse than no device
   * at all. */
  const kinds: LinkKind[] = available.length > 0 ? [...available] : ["mock"];
  for (const kind of kinds) {
    const opt = document.createElement("option");
    opt.value = kind;
    opt.textContent = LINK_NAMES[kind];
    select.appendChild(opt);
  }
  /* USB first: it is the link the device ships selected, and the one a user
   * with a cable in hand is most likely to want. */
  select.value = kinds[0] as string;
  select.disabled = kinds.length < 2;

  ($("connect") as HTMLButtonElement).textContent =
    available.length > 0 ? "Connect device" : "Connect mock device";

  $("devicehint").textContent = available.length > 0
    ? "Pick the link the device is set to, then Connect. The device serves only one at a time — if it is set to USB it will not appear over Bluetooth, and the reverse. Confirm the passkey on the device when asked."
    /* Reaches a browser tab and an Android window alike, so it cannot name a
     * cause it does not know. What matters is the same either way: nothing
     * here is signed by a device. */
    : "No device transport available, so this uses the built-in mock. It speaks the same protocol as the firmware and the interface behaves identically — but nothing is signed by real hardware, and no address shown here is one you should send funds to.";

  setMode(null);
  ($("connect") as HTMLButtonElement).disabled = false;
}

/* Held shut until the backend has answered. Clicking through an unpopulated
 * selector would read as "mock" and quietly connect to a simulation on a
 * machine that has a device attached. */
($("connect") as HTMLButtonElement).disabled = true;
void initEnvironment();
initChainSelector();

$("connect").addEventListener("click", () => void connect());
$("unlock").addEventListener("click", () => void unlock());
$("disconnect").addEventListener("click", () => void disconnect());
$("sign").addEventListener("click", () => void sign());
$("usenext").addEventListener("click", () => {
  // Sending to your own next address is the safest possible live test.
  const other = addresses[selectedIndex === 0 ? 1 : 0];
  if (other) ($("to") as HTMLInputElement).value = other;
  renderPreview();
});

for (const id of ["to", "amount"]) {
  $(id).addEventListener("input", () => renderPreview());
}
/* ------------------------------------------------------------------- theme */

/* Three states, not two. "System" has to be reachable, or a user who toggles
 * once can never get back to following their OS. Reading the computed --bg and
 * comparing it to a literal would also break the moment the palette moves. */
type Theme = "system" | "light" | "dark";
const THEME_KEY = "leek.theme";
const THEME_ORDER: Theme[] = ["system", "light", "dark"];
const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset["theme"];
  } else {
    root.dataset["theme"] = theme;
  }
  const btn = $("theme");
  btn.textContent = THEME_ICON[theme];
  btn.setAttribute("aria-label", `Theme: ${theme}. Click to change.`);
  btn.title = `Theme: ${theme}`;
}

function currentTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

applyTheme(currentTheme());

/* ------------------------------------------------------------ diagnostics */

/**
 * Everything a bug report needs, as plain text.
 *
 * Every bug report on this project so far has been the log, hand-copied off a
 * screen. This assembles it with the state that makes it readable — which
 * transport, which chain, which addresses — formatted for a chat box rather
 * than as JSON, because the person reading it is a human and the person
 * sending it is on a phone.
 *
 * ---------------------------------------------------------------------------
 * What it must never contain, and why. This list is a decision, not an
 * oversight, and it is short because the app holds no seed, PIN or key — those
 * never leave the device (PROTOCOL.md 6). What is left is:
 *
 * - **The session passkey.** Excluded. It is the value the user compares
 *   against the device screen to prove the encrypted channel reaches *that*
 *   device and not something in the middle; it is short-lived and it is a
 *   comparison secret. Pasting it into a chat while the session is live hands
 *   it to whoever reads the chat, and its only job is to be compared, never
 *   transmitted. It is also useless in a bug report: what matters is whether
 *   the pairing succeeded, and the log already says that.
 * - **The WalletConnect project ID.** Excluded. It is the user's own relay
 *   credential — attributable and rate-limited against them — and a bug is
 *   never explained by its 32 hex digits. Whether one is configured is worth
 *   knowing, so that is what gets reported.
 * - **The pairing URI / symKey.** Excluded, and already excluded upstream: the
 *   loggable form of a wc: URI never contains the key (see wc-uri.ts and its
 *   test), so the log below cannot carry one.
 * - **Whatever is typed into the form fields.** Excluded. A half-typed
 *   recipient is not state, and the amount someone is about to send is theirs.
 *
 * Included on purpose: **addresses**. They are public by construction — they
 * are what the user hands out to be paid — and "address 3 came back wrong" is
 * precisely the bug this button exists to report. The user agent is included
 * because "which Android" is the first question anyone will ask.
 */
function diagnosticsReport(): string {
  const L: string[] = [];
  const chain = activeChain();
  const rpc = ($("rpc") as HTMLSelectElement).value;

  L.push("LeekWallet companion — diagnostics");
  L.push(new Date().toISOString());
  L.push(`User agent: ${navigator.userAgent}`);
  L.push("");

  L.push("== Connection");
  L.push(`State:      ${$("conn").textContent ?? "?"}`);
  L.push(`Backend:    ${$("mode").textContent ?? "?"}`);
  L.push(`Link:       ${LINK_NAMES[selectedKind()]} (selected)`);
  L.push(`Transports: ${available.length > 0 ? available.join(", ") : "none — mock only"}`);
  L.push(
    `Device:     ${lastStatus.unlocked ? "unlocked" : "locked"}, ` +
      `wallet ${lastStatus.activeWallet}, ` +
      `passphrase ${lastStatus.passphrase ? "on" : "off"}, ` +
      `blind signing ${deviceBlindSigning ? "ON" : "off"}`,
  );
  L.push("");

  L.push("== Chain");
  L.push(`${chain.name} (${chain.id})${chain.testnet ? " — testnet" : ""}, ${chain.source}`);
  L.push(`RPC: ${rpc || "none selected"}`);
  L.push("");

  L.push("== Addresses");
  if (addresses.length === 0) {
    L.push("None derived. (Device locked, or not connected.)");
  } else {
    // Unchunked, so the line pastes straight into an explorer. The chunked
    // form is for comparing against the device screen, which is a different
    // job done by a different surface.
    addresses.forEach((a, i) => L.push(`${i === selectedIndex ? ">" : " "} [${i}] ${a}`));
    L.push(`Derivation: m/44'/60'/0'/0/i`);
  }
  L.push("");

  L.push("== Dapps (WalletConnect)");
  /* Presence, never the value — and read through the module that owns the key
   * so this cannot start reporting on a key nothing writes any more. */
  L.push(`Project ID: ${resolveProjectId().source} (value withheld)`);
  L.push($("wcstatus").textContent || "(no status)");
  /* Read back from the rendered list rather than from the WalletConnect client:
   * what the user is reporting is what they are looking at, and a second source
   * for the same list could disagree with the screen. Dapp-authored names come
   * through as text and stay text. */
  const sessions = Array.from($("wcsessions").querySelectorAll(".wc-session"))
    .map((row) =>
      Array.from(row.children)
        .filter((el) => el.tagName !== "BUTTON")
        .map((el) => el.textContent?.trim() ?? "")
        .filter((s) => s.length > 0)
        .join(" · "),
    );
  L.push(sessions.length > 0 ? sessions.map((s) => `- ${s}`).join("\n") : "No dapp is connected.");
  L.push("");

  L.push("== Device log (newest first)");
  L.push($("log").textContent ?? "");

  return L.join("\n");
}

type CopyRoute = "tauri" | "async-clipboard" | "exec-command" | "manual";

/**
 * Put text on the clipboard, trying every route this app can reach.
 *
 * There are three because none of them works everywhere:
 *
 * 1. **Tauri's clipboard plugin**, if the native build has it. It is the only
 *    route that is unambiguously correct inside an Android webview. NOTE: as
 *    of this commit `src-tauri/capabilities/default.json` grants only
 *    `core:default`, so the plugin is *not* registered and this probe will
 *    miss; it is written first anyway so that adding the plugin on the Rust
 *    side is the only change needed to light it up.
 * 2. **`navigator.clipboard`**, which requires a secure context. A Tauri
 *    Android window is served from `http://tauri.localhost`, which is not one
 *    of the origins browsers treat as secure, so this may well be undefined
 *    there. It is the right answer on desktop and in a dev browser tab.
 * 3. **`document.execCommand("copy")`** over a hidden textarea. Deprecated,
 *    and still the thing that actually works in an Android webview under a
 *    user gesture — which a button click is.
 *
 * If all three fail the text is put on screen, selected, and the caller says
 * so. A copy button that silently does nothing is worse than no button: the
 * user pastes stale clipboard content and nobody finds out for an hour.
 */
async function copyText(text: string): Promise<CopyRoute> {
  const tauri = (window as unknown as {
    __TAURI__?: { clipboardManager?: { writeText?: (t: string) => Promise<void> } };
  }).__TAURI__?.clipboardManager?.writeText;
  if (tauri) {
    try {
      await tauri(text);
      return "tauri";
    } catch { /* fall through: a failed plugin call is not a reason to give up */ }
  }

  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return "async-clipboard";
    } catch { /* permission denied or no gesture; try the old way */ }
  }

  /* The textarea has to be in the document, visible to the layout engine and
   * focused for the selection to be real, so it is placed off-screen rather
   * than hidden — `display: none` cannot be selected. */
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return "exec-command";
  } catch { /* fall through to manual */ }

  const out = $("copyout") as HTMLTextAreaElement;
  out.value = text;
  out.hidden = false;
  out.focus();
  out.select();
  return "manual";
}

$("copydiag").addEventListener("click", () => {
  const text = diagnosticsReport();
  const out = $("copyout") as HTMLTextAreaElement;
  out.hidden = true;
  const status = $("copystatus");
  status.textContent = "Copying…";

  void copyText(text).then(
    (route) => {
      const lines = text.split("\n").length;
      status.textContent =
        route === "manual"
          ? "This build could not reach the clipboard. The text is below and selected — copy it by hand."
          : `Copied ${lines} lines (${route}). No passkey, project ID or form input is included.`;
      log(`diagnostics copied via ${route}`);
    },
    (e: unknown) => {
      status.textContent = `Copy failed: ${(e as Error).message}`;
      log(`diagnostics copy failed: ${(e as Error).message}`);
    },
  );
});

$("theme").addEventListener("click", () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length] ?? "system";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  log(`theme: ${next}`);
});
