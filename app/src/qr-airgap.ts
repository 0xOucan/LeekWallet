/**
 * The QR air gap, companion side: scan a UR off the device's screen, and show
 * a UR for the device's camera.
 *
 * This is a second entrance, not a third transport (docs/ARCHITECTURE.md).
 * There is no `Client`, no session and no passkey here, because there is no
 * live channel to protect: each QR carries a self-contained message and the
 * user is looking at both screens. Keeping it out of `connectOnce` is what
 * keeps a cancelled scan from being reported as a broken session — nothing
 * here has a session to break.
 */

import { UrScanAssembler } from "../packages/core/src/ur-scan.ts";
import { urFrames } from "../packages/core/src/ur-encoder.ts";
import { scanQr } from "./wc/qr.ts";

/** The user closed the scanner or the request. Not a failure, and not logged as one. */
export class QrCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "QrCancelled";
  }
}

/**
 * Scan until a complete UR of `type` has been assembled, and return its body.
 *
 * Only parts of the expected type reach the decoder; see UrScanAssembler
 * in core, which the extension's scan window shares.
 */
export function scanUr(
  video: HTMLVideoElement,
  type: string,
  onProgress: (text: string) => void,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<Uint8Array> {
  const assembler = new UrScanAssembler(type);
  return new Promise<Uint8Array>((resolve, reject) => {
    let handle: { stop(): void } | null = null;
    const cancel = (): void => { handle?.stop(); reject(new QrCancelled()); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });

    const accept = (raw: string): Uint8Array | undefined => assembler.accept(raw, onProgress);

    video.hidden = false;
    scanQr<Uint8Array>(
      video,
      accept,
      (message) => {
        signal.removeEventListener("abort", cancel);
        video.hidden = true;
        resolve(message);
      },
      (message) => {
        signal.removeEventListener("abort", cancel);
        video.hidden = true;
        reject(new Error(message));
      },
      signal,
      (status) => log(`scan: ${status}`),
    ).then((h) => { handle = h; }, (e: unknown) => {
      video.hidden = true;
      /* scanQr throws on an abort that landed during the permission prompt;
         that is still the user cancelling, not the camera failing. */
      reject(signal.aborted ? new QrCancelled() : e);
    });
  }).finally(() => { video.hidden = true; });
}

/**
 * Default fragment size, in bytes of payload per frame.
 *
 * Small by default after the bench: a request sent whole came out around 78
 * modules across, version 17, and the device's camera never located it at all.
 * Fewer bytes per frame means fewer modules, and module size is what a camera
 * can or cannot resolve.
 */
export const DEFAULT_FRAGMENT = 40;

/**
 * Default frame period.
 *
 * The device captures one or two frames a second at VGA, so 300 ms meant it
 * missed most frames outright and caught others mid-change. A frame it cannot
 * finish reading is worth nothing, however many of them go past.
 */
export const DEFAULT_FRAME_MS = 700;

/**
 * Show `cbor` as a UR in `holder` until `signal` fires: one static code if it
 * fits, otherwise an endless fountain animation.
 *
 * Uppercase so the QR can use alphanumeric mode, which is about a third
 * smaller than byte mode for the same string; every UR decoder, ours and the
 * firmware's, reads the scheme and the bytewords case-insensitively.
 */
export function showUr(
  holder: HTMLElement,
  type: string,
  cbor: Uint8Array,
  fragmentLen: number,
  render: (text: string) => SVGSVGElement,
  signal: AbortSignal,
  frameMs: number = DEFAULT_FRAME_MS,
): { frames: number } {
  const frames = urFrames(type, cbor, fragmentLen);
  const draw = (text: string): void => {
    holder.textContent = "";
    holder.appendChild(render(text.toUpperCase()));
  };
  if ("single" in frames) {
    draw(frames.single);
    return { frames: 1 };
  }
  const encoder = frames.encoder;
  draw(encoder.nextPart());
  const timer = setInterval(() => draw(encoder.nextPart()), frameMs);
  signal.addEventListener("abort", () => { clearInterval(timer); holder.textContent = ""; }, { once: true });
  return { frames: encoder.seqLen };
}
