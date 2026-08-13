/**
 * BLE transport backed by the Tauri Rust backend.
 *
 * A deliberate twin of `TauriSerialTransport`: same interface, same
 * request/response-behind-a-callback shape, different four command names. The
 * client above cannot tell them apart, which is the entire point — the session
 * handshake, the framing and the commands are identical over both, and if they
 * were not, "it works over USB" would tell you nothing about BLE.
 *
 * Chunking is absent here on purpose. It lives in the Rust crate next to the
 * MTU it depends on, so the frontend hands over whole frames exactly as it
 * does for serial.
 */

import type { Transport } from "../packages/core/src/transport.ts";
import { FrameType } from "../packages/core/src/framing.ts";
import { invoker } from "./tauri-transport.ts";

export interface BleDeviceInfo {
  id: string;
  /** Advertised name if the device broadcast one. Decoration, never identity. */
  name: string | null;
}

/**
 * What to tell a user who scanned and found nothing.
 *
 * Almost always the device is simply in USB mode: it serves exactly one
 * transport at a time (PROTOCOL.md 3b) and does not advertise at all on the
 * other. Saying "no device found" alone would send someone looking for a fault
 * that is not there — same reasoning, and roughly the same words, as the
 * failure message in `leek-ble-probe`.
 */
export const BLE_NOT_FOUND =
  "No LeekWallet is advertising over Bluetooth. The device serves one transport " +
  "at a time, so if its Link setting is USB it will not advertise at all — check " +
  "Settings → Link on the device, and that it is powered on and in range.";

/**
 * Scan for advertising devices.
 *
 * Returns empty only when there is no Tauri bridge at all. A backend failure
 * *rejects*, and the rejection is the useful half: on Android a denied
 * "Nearby devices" permission produces an empty result set at the OS level and
 * is indistinguishable from a device that is switched off, so the backend
 * turns it into an error with instructions instead. Swallowing that here would
 * put the user back where they started, staring at an empty list.
 */
export async function scanBle(): Promise<BleDeviceInfo[]> {
  const invoke = invoker();
  if (!invoke) return [];
  return invoke<BleDeviceInfo[]>("ble_scan");
}

export class BleTransport implements Transport {
  readonly kind = "ble" as const;
  readonly label: string;

  private readonly id: string;
  private opened = false;
  private handler: ((frame: Uint8Array) => void) | null = null;

  constructor(device: BleDeviceInfo) {
    this.id = device.id;
    // The name is shown because it helps a human pick between two devices, but
    // the id is what was connected to and so it is what the label falls back
    // to. Never the name alone: it is device-supplied and can say anything.
    this.label = device.name ? `BLE ${device.name}` : `BLE ${device.id}`;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    const invoke = invoker();
    if (!invoke) throw new Error("not running under Tauri");
    await invoke("ble_connect", { id: this.id });
    this.opened = true;
  }

  async close(): Promise<void> {
    const invoke = invoker();
    // Disconnect explicitly rather than letting the link lapse: the device
    // serves one peer at a time, so a lingering link locks out the next
    // connection until the stack times it out.
    if (invoke) await invoke("ble_disconnect");
    this.opened = false;
  }

  onFrame(handler: (frame: Uint8Array) => void): void {
    this.handler = handler;
  }

  /**
   * How long to wait for the next reply, in milliseconds. Set per request by
   * the client; anything needing a button press has to outlast a human.
   */
  timeoutMs = 5000;

  async send(frame: Uint8Array): Promise<void> {
    const invoke = invoker();
    if (!invoke || !this.opened) throw new Error("transport is not open");

    // Strip our own framing; the backend re-applies length and type, and
    // chunks to the MTU.
    const type = frame[2] ?? FrameType.Request;
    const payload = Array.from(frame.slice(3));

    const [replyType, replyPayload] = await invoke<[number, number[]]>("ble_request", {
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
