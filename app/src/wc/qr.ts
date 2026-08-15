/**
 * Camera QR scanning (T32).
 *
 * Decoding is done in-process by the bundled `jsqr` (Apache-2.0, pure JS, no
 * WASM, no network). This module used to call the platform's own
 * `BarcodeDetector` instead, on the reasoning that ~40 KB of image-processing
 * code was not worth adding to the process that talks to a signing device for a
 * convenience feature. That reasoning rested on a premise that measurement
 * killed:
 *
 *   - Linux desktop (WebKitGTK 2.52, which is what Tauri uses there) has no
 *     `BarcodeDetector` at all — `window.BarcodeDetector` is undefined, so the
 *     feature was permanently unavailable on the maintainer's own machine.
 *   - Android has it, but Chromium implements it on top of Google Play
 *     Services, and binding the provider without the corresponding manifest
 *     meta-data throws `GooglePlayServicesMissingManifestValueException` on a
 *     Java thread. That is not a JS error this module can catch — it killed the
 *     whole app the moment a user pressed "Scan QR". Wiring it up correctly
 *     would have meant linking Google Play Services into a hardware wallet.
 *
 * So the platform API cost us a crash on one platform, an unavailable feature
 * on another, and a Google dependency to fix the first. A bundled decoder is
 * one code path, on every platform, with no third party in it. That is the
 * better trade for this app, and it is worth recording that the original
 * decision was reasonable and simply wrong about what was there.
 *
 * The camera stream never leaves this function: frames go to an offscreen
 * canvas and into the decoder, and nothing is stored, uploaded, or kept after
 * `stop()`.
 *
 * This module is deliberately agnostic about what a scanned code *means*. It
 * started life only able to yield `wc:` pairing links because the prefix test
 * was baked into the polling loop; a second caller (scanning a recipient
 * address) would have had to fork it. The caller supplies `accept`, so the
 * knowledge of what a valid code looks like lives with whoever asked to scan.
 */

import jsQR from "jsqr";

/**
 * Whether this webview can scan at all, before any camera permission prompt.
 *
 * Only the camera is in question now. The decoder ships with the app, so unlike
 * the `BarcodeDetector` era there is no platform on which scanning is simply
 * missing — if there is a camera and permission for it, this works.
 */
export function qrScanningAvailable(): boolean {
  return typeof navigator?.mediaDevices?.getUserMedia === "function";
}

/**
 * Said in the UI when it is not.
 *
 * Kept free of any one caller's vocabulary: this is shown both where the
 * fallback is "paste the wc: link" and where it is "type the address", and a
 * message that names only one of those is a lie in the other place. Callers
 * that know which form they are in should use `qrUnavailable()` and name the
 * workaround exactly.
 */
export const QR_UNAVAILABLE =
  "This window cannot reach a camera. Enter the value by hand instead.";

/**
 * The same explanation with the caller's own fallback spelled out.
 *
 * Naming the workaround is the whole value of the message — "scanning is
 * unavailable" on its own leaves the user stuck, so `fallback` is required
 * rather than optional.
 */
export function qrUnavailable(fallback: string): string {
  return `This window cannot reach a camera. ${fallback}`;
}

export interface QrScan {
  /** Stops the camera and releases the device. Safe to call twice. */
  stop(): void;
}

/**
 * The first decoded value the caller accepts, or `undefined` if not this frame.
 *
 * Split out from the polling loop so the "ignore a QR code that happens to be
 * in shot" behaviour can be tested without a camera. jsQR returns at most one
 * code per frame, so this takes a list to keep the shape the tests already
 * pin down and to stay correct if that ever changes.
 */
export function firstAccepted<T>(
  codes: Array<{ rawValue: string }>,
  accept: (raw: string) => T | undefined,
): T | undefined {
  for (const code of codes) {
    const value = accept(code.rawValue.trim());
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Longest edge the decoder is given, in pixels.
 *
 * A tablet hands over 1080p or better, and jsQR's cost is proportional to the
 * pixel count — decoding full frames ten times a second is enough work to make
 * the UI stutter and the battery drain, for no gain: a QR code that fills a
 * useful part of the frame is still comfortably readable at this size.
 */
const DECODE_MAX_EDGE = 640;

/**
 * Scan until `accept` recognises a code, then stop.
 *
 * Only values `accept` returns something for resolve the scan — a QR code in
 * shot that happens to be an unrelated URL is ignored rather than handed on,
 * which keeps a poster on the wall behind the laptop from interrupting the
 * scan. That filter lives with the caller, not here: a caller whose `accept`
 * returns a value for everything gets exactly the interruption this guards
 * against, so `accept` should be as strict as the caller's parser.
 *
 * The caller supplies the `<video>` element so the UI decides where it appears
 * and this module does not touch layout.
 *
 * `signal` closes the window between "the user dismissed the scanner" and "the
 * camera permission prompt was answered". Without it a caller can only stop the
 * scan through the returned handle, which does not exist until `getUserMedia`
 * has resolved — dismissing the UI during the prompt would leave the camera
 * running with nothing holding a reference to it.
 */
export async function scanQr<T>(
  video: HTMLVideoElement,
  accept: (raw: string) => T | undefined,
  onResult: (value: T) => void,
  onError: (message: string) => void,
  signal?: AbortSignal,
): Promise<QrScan> {
  if (!qrScanningAvailable()) throw new Error(QR_UNAVAILABLE);
  if (signal?.aborted) throw new Error("Scan cancelled before the camera started.");

  const stream = await navigator.mediaDevices.getUserMedia({
    // The rear camera on a phone; ignored on a laptop with one camera.
    video: { facingMode: "environment" },
    audio: false,
  });

  /* From here the camera is live, so every exit path must release it. Anything
   * that throws before the handle is returned would otherwise leave the device
   * held open with no reference left to close it — a wallet app silently
   * holding the camera is worse than a failed scan. */
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop();
  };

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    release();
    video.srcObject = null;
    signal?.removeEventListener("abort", stop);
  };

  // The dismissal may already have happened while the prompt was up.
  if (signal?.aborted) {
    release();
    throw new Error("Scan cancelled before the camera started.");
  }
  signal?.addEventListener("abort", stop);

  const canvas = document.createElement("canvas");
  /* `willReadFrequently` because every frame is read straight back out; without
   * it browsers keep the canvas on the GPU and each getImageData is a stall. */
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  try {
    if (!ctx) throw new Error("This window cannot open a 2D canvas to decode frames.");
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    await video.play().catch(() => undefined);
  } catch (e) {
    stop();
    throw e;
  }

  // `stop()` during the awaited play() leaves nothing to poll.
  if (stopped) return { stop };

  /* Ten frames a second. Faster burns battery on a phone for no gain: a person
   * holding a phone at a screen takes well over a tenth of a second to line the
   * code up. */
  timer = setInterval(() => {
    if (stopped) return;
    try {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) return;    // first frames arrive before the size does

      const scale = Math.min(1, DECODE_MAX_EDGE / Math.max(w, h));
      const dw = Math.max(1, Math.round(w * scale));
      const dh = Math.max(1, Math.round(h * scale));
      if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width = dw;
        canvas.height = dh;
      }
      ctx.drawImage(video, 0, 0, dw, dh);
      const frame = ctx.getImageData(0, 0, dw, dh);

      /* Both inversion attempts: a QR printed light-on-dark is still a QR, and
       * this is the difference between "it just works" and a user holding a
       * phone at a screen wondering why. */
      const code = jsQR(frame.data, dw, dh, { inversionAttempts: "attemptBoth" });
      if (!code || stopped) return;

      const hit = firstAccepted([{ rawValue: code.data }], accept);
      if (hit === undefined) return;
      stop();
      onResult(hit);
    } catch (e) {
      if (stopped) return;
      stop();
      onError((e as Error).message ?? String(e));
    }
  }, 100);

  return { stop };
}
