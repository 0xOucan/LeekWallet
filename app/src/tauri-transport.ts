/**
 * Transport backed by the Tauri Rust backend.
 *
 * The backend does request/response over a serial port; this presents it as the
 * same frame-in, frame-out interface the mock implements, so nothing above
 * `Transport` can tell which one it is talking to. That equivalence is the
 * point: the UI is developed against the mock and then meets real hardware
 * without changing.
 */

import type { Transport } from "../packages/core/src/transport.ts";
import { FrameType } from "../packages/core/src/framing.ts";

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** The transports a build can offer. Mirrors `Transport["kind"]` minus mock. */
export type HardwareKind = "usb" | "ble";

/**
 * Locate Tauri's invoke function.
 *
 * Tauri v2 does **not** expose `window.__TAURI__` unless `withGlobalTauri` is
 * set in `tauri.conf.json`; the documented path is importing from
 * `@tauri-apps/api`. Without that flag the native window looks exactly like a
 * browser to this check, and the app quietly runs against the mock while
 * sitting on top of a working USB backend.
 *
 * Both shapes are accepted because v2 moved invoke under `core` and older
 * builds put it at the top level.
 */
export function invoker(): Invoke | null {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: Invoke }; invoke?: Invoke };
  };
  return w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke ?? null;
}

/**
 * Which transports the backend actually has compiled in.
 *
 * This has to mean "there is a transport", not merely "this is a native
 * window". Claiming "hardware" on a phone connected to nothing is the one lie
 * a wallet UI must never tell, and an `invoke` bridge exists on Android
 * whether or not anything is wired behind it.
 *
 * Since T30 the Android build answers `["ble"]`: serial is still compiled out
 * (no ports to enumerate) but BLE is real there, carrying its Android driver
 * inside `tauri-plugin-blec`. An empty *scan* on that build is a separate
 * thing from an absent transport — permissions, a radio switched off, or a
 * device on USB — and each of those comes back as an error with its own
 * message rather than as a missing capability.
 *
 * Asked of the backend rather than sniffed from the user agent, which is what
 * this did before: the backend is the only thing that knows what was compiled
 * into it, and a UA string cannot answer "was BLE built in".
 *
 * An older backend without the `transports` command still answers usefully:
 * the invoke rejects, and the fallback reports the one transport such a build
 * had.
 */
export async function availableTransports(): Promise<HardwareKind[]> {
  const invoke = invoker();
  if (!invoke) return [];
  try {
    const kinds = await invoke<string[]>("transports");
    return kinds.filter((k): k is HardwareKind => k === "usb" || k === "ble");
  } catch {
    return /Android/i.test(navigator.userAgent) ? [] : ["usb"];
  }
}

export interface SerialPortInfo {
  name: string;
  description: string;
  likely_device: boolean;
}

export async function listPorts(): Promise<SerialPortInfo[]> {
  const invoke = invoker();
  if (!invoke) return [];
  return invoke<SerialPortInfo[]>("ports");
}

export class TauriSerialTransport implements Transport {
  readonly kind = "usb" as const;
  readonly label: string;

  private readonly path: string;
  private opened = false;
  private handler: ((frame: Uint8Array) => void) | null = null;

  constructor(path: string) {
    this.path = path;
    this.label = `USB ${path}`;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    const invoke = invoker();
    if (!invoke) throw new Error("not running under Tauri");
    await invoke("connect", { path: this.path });
    this.opened = true;
  }

  async close(): Promise<void> {
    const invoke = invoker();
    if (invoke) await invoke("disconnect");
    this.opened = false;
  }

  onFrame(handler: (frame: Uint8Array) => void): void {
    this.handler = handler;
  }

  /**
   * Send a frame and deliver the reply through `onFrame`.
   *
   * The backend is request/response while `Transport` is send/receive, so the
   * reply is handed back through the same callback the mock uses. Re-framing it
   * here keeps the seam honest: the client above cannot tell the difference,
   * which is exactly what makes mock-developed UI work against hardware.
   */
  /**
   * How long to wait for the next reply, in milliseconds.
   *
   * Set per request. Anything needing a button press on the device has to
   * outlast a human deciding, and the device gives them two minutes.
   */
  timeoutMs = 5000;

  async send(frame: Uint8Array): Promise<void> {
    const invoke = invoker();
    if (!invoke || !this.opened) throw new Error("transport is not open");

    // Strip our own framing; the backend applies the sync marker and length.
    const type = frame[2] ?? FrameType.Request;
    const payload = Array.from(frame.slice(3));

    const [replyType, replyPayload] = await invoke<[number, number[]]>("request", {
      frameType: type,
      payload,
      timeoutMs: this.timeoutMs,
    });

    const body = new Uint8Array(replyPayload.length + 3);
    const len = replyPayload.length + 1;
    body[0] = (len >> 8) & 0xff;
    body[1] = len & 0xff;
    body[2] = replyType;
    body.set(replyPayload, 3);

    this.handler?.(body);
  }
}
