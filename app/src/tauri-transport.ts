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

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

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
function invoker(): Invoke | null {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: Invoke }; invoke?: Invoke };
  };
  return w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke ?? null;
}

export function isTauri(): boolean {
  return invoker() !== null;
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
  async send(frame: Uint8Array): Promise<void> {
    const invoke = invoker();
    if (!invoke || !this.opened) throw new Error("transport is not open");

    // Strip our own framing; the backend applies the sync marker and length.
    const type = frame[2] ?? FrameType.Request;
    const payload = Array.from(frame.slice(3));

    const [replyType, replyPayload] = await invoke<[number, number[]]>("request", {
      frameType: type,
      payload,
      timeoutMs: 5000,
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
