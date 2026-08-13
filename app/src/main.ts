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

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onFrame((frame) => {
      for (const f of this.decoder.push(frame)) {
        const body = decodeCbor(f.payload) as Record<string, CborValue>;
        const resolve = this.pending;
        this.pending = null;
        if (!resolve) continue;
        if (f.type === FrameType.Error) {
          resolve({ err: new DeviceError(Number(body["code"]), String(body["message"])) });
        } else {
          resolve({ ok: body["result"] as Record<string, CborValue> });
        }
      }
    });
  }

  async call(method: string, params: Record<string, CborValue> = {}): Promise<Record<string, CborValue>> {
    if (this.pending) throw new Error("a request is already in flight");
    const reply = new Promise<{ ok?: Record<string, CborValue>; err?: DeviceError }>((r) => {
      this.pending = r;
    });
    await this.transport.send(encodeFrame(FrameType.Request, encodeCbor({ method, params })));
    const { ok, err } = await reply;
    if (err) throw err;
    return ok ?? {};
  }
}

/* ------------------------------------------------------------------- state */

let transport: MockDevice | null = null;
let client: Client | null = null;
let selectedIndex = 0;
const addresses: string[] = [];

/* Last known device state, and a poll to notice changes the app did not cause
 * - an auto-lock on the device's own timer, or a wallet switched by hand. */
let lastStatus: DeviceStatus = UNKNOWN_STATUS;
let pollTimer: ReturnType<typeof setInterval> | null = null;

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
  addresses.length = 0;
  $("addrs").textContent = "";
  $("addrpanel").hidden = true;
  $("signpanel").hidden = true;
  $("sfrom").textContent = "—";
  log(`derived addresses cleared: ${reason}`);
}

async function poll(): Promise<void> {
  if (!client) return;
  try {
    const now = await readStatus();
    if (derivationsInvalidated(lastStatus, now)) {
      invalidateDerived(
        !now.unlocked ? "device locked"
          : now.activeWallet !== lastStatus.activeWallet ? "wallet changed on device"
          : "passphrase changed on device",
      );
      if (now.unlocked) {
        await loadAddresses();
        $("addrpanel").hidden = false;
        $("signpanel").hidden = false;
      }
    }
    lastStatus = now;
    $("wallet").textContent = now.unlocked
      ? `wallet ${now.activeWallet}/${now.walletCount}${now.passphrase ? " + passphrase" : ""}`
      : "locked";
  } catch {
    /* A poll failing is not itself news; the connection state covers it. */
  }
}

const setConnection = (state: string, label: string): void => {
  $("dot").dataset["state"] = state;
  $("conn").textContent = label;
};

const busy = (on: boolean): void => {
  for (const id of ["connect", "unlock", "disconnect", "sign", "signreject"]) {
    ($(id) as HTMLButtonElement).disabled = on;
  }
};

/* ----------------------------------------------------------------- actions */

async function connect(): Promise<void> {
  // Latency is deliberate: a mock that answers instantly hides every place the
  // UI forgot to show that it is waiting.
  transport = new MockDevice({ latencyMs: 250, walletCount: 1 });
  client = new Client(transport);

  setConnection("connecting", "Connecting…");
  busy(true);
  await transport.open();

  const hello = await client.call("hello");
  $("passkey").textContent = String(hello["passkey"] ?? "");
  $("pairing").hidden = false;
  log(`session established with ${transport.label}`);

  setConnection("connected", transport.label);
  $("devicehint").textContent =
    "Connected to the mock. Behaviour matches the protocol, but keys and signatures are not real.";
  busy(false);
  ($("connect") as HTMLButtonElement).disabled = true;
  ($("unlock") as HTMLButtonElement).disabled = false;
  ($("disconnect") as HTMLButtonElement).disabled = false;
}

async function unlock(): Promise<void> {
  if (!client) return;
  busy(true);
  log("waiting for PIN entry on the device…");
  try {
    await client.call("unlock");
    log("device unlocked");
    await loadAddresses();
    $("addrpanel").hidden = false;
    $("signpanel").hidden = false;
    lastStatus = await readStatus();
    $("wallet").textContent =
      `wallet ${lastStatus.activeWallet}/${lastStatus.walletCount}` +
      (lastStatus.passphrase ? " + passphrase" : "");

    /* Two seconds is frequent enough that a lock is noticed before the user
     * acts on a stale address, and rare enough not to keep a BLE link busy. */
    if (!pollTimer) pollTimer = setInterval(() => void poll(), 2000);
  } catch (e) {
    log(`unlock failed: ${(e as Error).message}`);
  } finally {
    busy(false);
    ($("connect") as HTMLButtonElement).disabled = true;
  }
}

async function loadAddresses(): Promise<void> {
  if (!client) return;
  addresses.length = 0;
  const list = $("addrs");
  list.textContent = "Deriving…";

  for (let i = 0; i < 10; i++) {
    const r = await client.call("getAddress", { path: `m/44'/60'/0'/0/${i}` });
    addresses.push(String(r["address"]));
  }

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

async function sign(reject: boolean): Promise<void> {
  if (!transport || !client) return;
  // Rebuild the client against a mock configured to refuse, so the rejection
  // path is exercised rather than described.
  if (reject) {
    transport = new MockDevice({ latencyMs: 250, autoApprove: false, startUnlocked: true });
    client = new Client(transport);
    await transport.open();
    await client.call("hello");
  }

  busy(true);
  log("confirm on the device…");
  try {
    const r = await client.call("signTransaction", {
      path: `m/44'/60'/0'/0/${selectedIndex}`,
      to: new Uint8Array(20).fill(0x71),
      chainId: 1,
    });
    const sig = r["signature"];
    log(`signed: ${sig instanceof Uint8Array ? sig.length : 0} bytes`);
  } catch (e) {
    log(e instanceof DeviceError ? `rejected on device (${e.message})` : String(e));
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

$("connect").addEventListener("click", () => void connect());
$("unlock").addEventListener("click", () => void unlock());
$("disconnect").addEventListener("click", () => void disconnect());
$("sign").addEventListener("click", () => void sign(false));
$("signreject").addEventListener("click", () => void sign(true));
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
