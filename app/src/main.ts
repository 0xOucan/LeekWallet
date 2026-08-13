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
import { DeviceError, type Transport } from "../packages/core/src/transport.ts";
import {
  derivationsInvalidated, UNKNOWN_STATUS, type DeviceStatus,
} from "../packages/core/src/device-state.ts";
import { isTauri, listPorts, TauriSerialTransport } from "./tauri-transport.ts";
import {
  deriveSession, generateKeypair, Session,
} from "../packages/core/src/session.ts";

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

        if (encrypted && this.session) {
          try {
            payload = this.session.decrypt(payload);
          } catch {
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
          resolve({ err: new DeviceError(Number(body["code"]), String(body["message"])) });
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

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.call("getStatus");
        return;
      } catch (e) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for confirmation on the device");
        }
        await new Promise((r) => setTimeout(r, 750));
      }
    }
  }

  get encrypted(): boolean {
    return this.session?.isActive ?? false;
  }
}

/* ------------------------------------------------------------------- state */

let transport: Transport | null = null;
let client: Client | null = null;
let selectedIndex = 0;
const addresses: string[] = [];

/* Last known device state, and a poll to notice changes the app did not cause
 * - an auto-lock on the device's own timer, or a wallet switched by hand. */
let lastStatus: DeviceStatus = UNKNOWN_STATUS;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Bumped whenever a derivation is superseded or discarded. */
let loadGeneration = 0;

async function readStatus(): Promise<DeviceStatus> {
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

async function connect(): Promise<void> {
  /* Real hardware when the Tauri backend is present, the mock otherwise. The
   * two are interchangeable by construction - if they were not, everything
   * built against the mock would need revisiting the first time a device was
   * plugged in. */
  if (isTauri()) {
    const ports = await listPorts();
    const port = ports.find((p) => p.likely_device) ?? ports[0];
    if (!port) {
      setConnection("error", "No device found");
      log("no USB serial ports; check the cable and the dialout group");
      return;
    }
    transport = new TauriSerialTransport(port.name);
    log(`found ${port.name} — ${port.description}`);
  } else {
    // Latency is deliberate: a mock that answers instantly hides every place
    // the UI forgot to show that it is waiting.
    transport = new MockDevice({ latencyMs: 250, walletCount: 1 });
  }
  client = new Client(transport);

  setConnection("connecting", "Connecting…");
  busy(true);
  await transport.open();

  if (isTauri()) {
    /* Real firmware: derive the passkey from the exchange and wait for the
     * user to compare it against the OLED. */
    const passkey = await client.handshake();
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
  $("devicehint").textContent = isTauri()
    ? `Connected over ${transport.label}. The device confirms everything it signs on its own screen.`
    : "Connected to the mock. Behaviour matches the protocol, but keys and signatures are not real.";
  busy(false);
  ($("connect") as HTMLButtonElement).disabled = true;
  ($("unlock") as HTMLButtonElement).disabled = false;
  ($("disconnect") as HTMLButtonElement).disabled = false;
}

async function unlock(): Promise<void> {
  if (!client) return;
  busy(true);
  log("enter your PIN on the device…");
  try {
    const reply = await client.call("unlock");

    /* The device only *prompts*; the PIN is typed there and never travels.
     * So the app waits for the status to change rather than treating the
     * reply as the answer. */
    if (reply["unlocked"] !== 1) {
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

  busy(true);
  log("confirm on the device…");
  try {
    log("check the transaction on the device — every page — then approve");

    /* Quantities go as big-endian byte strings, not numbers: values run to
     * 2^256 and CBOR integers here stop at 32 bits. */
    const wei = (v: bigint): Uint8Array => {
      let hex = v.toString(16);
      if (hex.length % 2) hex = "0" + hex;
      return new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
    };

    const SIGN_TIMEOUT_MS = 150000;   // the device gives the user 120 s
    /* Sepolia, not mainnet. A demo transaction the user can actually fund and
     * broadcast is worth more than one they cannot, and a mainnet chain ID on
     * a test build is an invitation to a costly accident. */
    const r = await client.call("signTransaction", {
      index: selectedIndex,
      chainId: 11155111,
      nonce: 0,
      to: new Uint8Array(20).fill(0x71),
      value: wei(500000000000000000n),          // 0.5 ETH
      gas: wei(21000n),
      maxFeePerGas: wei(20000000000n),
      maxPriorityFeePerGas: wei(1000000000n),
    }, SIGN_TIMEOUT_MS);

    const rr = r["r"];
    const ss = r["s"];
    if (rr instanceof Uint8Array && ss instanceof Uint8Array) {
      const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      log(`signed by the device: r=${hex(rr).slice(0, 16)}… v=${String(r["v"])}`);
    } else {
      log("device returned no signature");
    }
  } catch (e) {
    if (e instanceof DeviceError && e.code === 0x0200) {
      log("rejected on the device");
    } else if (e instanceof DeviceError && e.code === 0x0201) {
      log("timed out waiting for an answer on the device");
    } else if (e instanceof DeviceError) {
      log(`declined: ${e.message}`);
    } else {
      log(String(e));
    }
  } finally {
    busy(false);
  }
}

async function disconnect(): Promise<void> {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  lastStatus = UNKNOWN_STATUS;
  await transport?.close();
  transport = null;
  client = null;
  setConnection("disconnected", "Disconnected");
  $("addrpanel").hidden = true;
  $("signpanel").hidden = true;
  $("pairing").hidden = true;
  $("wallet").textContent = "";
  ($("connect") as HTMLButtonElement).disabled = false;
  ($("unlock") as HTMLButtonElement).disabled = true;
  ($("disconnect") as HTMLButtonElement).disabled = true;
  log("disconnected; session secrets cleared");
}

/** Group into fours so a human can actually compare two addresses. */
const chunk = (addr: string): string => {
  const body = addr.replace(/^0x/, "").match(/.{1,4}/g) ?? [];
  return `0x ${body.join(" ")}`;
};

/* ------------------------------------------------------------------- wiring */

/* Say plainly which backend this window uses, before anything is connected.
 * The label used to read "Connect mock device" unconditionally, so a native
 * window talking to real hardware still claimed to be a simulation. */
function describeEnvironment(): void {
  const tauri = isTauri();
  const badge = $("mode");
  badge.textContent = tauri ? "hardware" : "mock";
  badge.dataset["mode"] = tauri ? "hardware" : "mock";

  ($("connect") as HTMLButtonElement).textContent =
    tauri ? "Connect device" : "Connect mock device";

  $("devicehint").textContent = tauri
    ? "Native shell: this will talk to a LeekWallet over USB. Confirm the passkey on the device when asked."
    : "Browser: no USB access here, so this uses the built-in mock. It speaks the same protocol as the firmware, so the interface behaves identically — but nothing is signed by real hardware.";
}

describeEnvironment();

$("connect").addEventListener("click", () => void connect());
$("unlock").addEventListener("click", () => void unlock());
$("disconnect").addEventListener("click", () => void disconnect());
$("sign").addEventListener("click", () => void sign());
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

$("theme").addEventListener("click", () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length] ?? "system";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  log(`theme: ${next}`);
});
