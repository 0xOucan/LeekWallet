/**
 * Transport abstraction.
 *
 * Everything above this is transport-blind: the same commands, framing and
 * session run over USB CDC on desktop and BLE on Android. Only chunking differs
 * and that lives in framing.ts.
 *
 * Implementations live outside this package — Rust behind a Tauri command for
 * real hardware, and MockTransport here for development.
 */

export interface Transport {
  readonly kind: "usb" | "ble" | "mock";
  /** Human-readable, for the connection status bar. */
  readonly label: string;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Write one complete frame. Chunking, if any, is the transport's problem. */
  send(frame: Uint8Array): Promise<void>;
  /** Called with each complete frame received. */
  onFrame(handler: (frame: Uint8Array) => void): void;
  readonly isOpen: boolean;
}

/** Thrown when the device rejects a request; carries the protocol error code. */
export class DeviceError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`device error 0x${code.toString(16).padStart(4, "0")}: ${message}`);
    this.name = "DeviceError";
    this.code = code;
  }
}

export const ErrorCode = {
  MalformedFrame: 0x0001,
  UnsupportedVersion: 0x0002,
  NotUnlocked: 0x0100,
  WrongPermission: 0x0101,
  UserRejected: 0x0200,
  UserTimeout: 0x0201,
  /* Outside the decodable set — the device will not ask for approval of a
   * call it cannot describe. See eth-decode.ts. */
  Undecodable: 0x0202,
  NoWallet: 0x0300,
  SessionRequired: 0x0400,
} as const;
