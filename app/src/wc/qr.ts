/**
 * Camera QR scanning (T32).
 *
 * Decoding is done in-process by the bundled `zxing-wasm` (MIT, ~1.1 MB of
 * WebAssembly, no network -- the binary ships with the app).
 *
 * It was `jsqr` before, chosen for being 40 KB of readable JavaScript, which is
 * a real virtue here. It was replaced for one reason: it could not read a
 * WalletConnect pairing code. Not in theory -- the actual code, captured from
 * the device's own camera at full resolution and in focus, was handed to both
 * decoders. jsQR found nothing; ZXing read it. A decoder that cannot decode is
 * not smaller, it is absent.
 *
 * The costs are real and worth stating: a megabyte of opaque binary instead of
 * auditable source, and `wasm-unsafe-eval` added to a CSP this project
 * otherwise keeps tight. Both were accepted deliberately, with the failing
 * image in hand.
 *
 * Before either, this called the platform's own `BarcodeDetector`, on the
 * reasoning that a bundled decoder was not worth it for a convenience feature.
 * That reasoning rested on a premise that measurement killed:
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

import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { firstAccepted, QR_UNAVAILABLE, qrScanningAvailable, scanStep } from "./qr-loop.ts";

export { firstAccepted, QR_UNAVAILABLE, qrScanningAvailable, qrUnavailable, scanStep } from "./qr-loop.ts";
/* Bundled, not fetched. zxing-wasm downloads its .wasm from a CDN by default,
 * which in this app would be a remote code fetch into the process that talks to
 * a signing device -- and would fail the CSP anyway. Vite turns this import
 * into a local asset URL, so the binary ships inside the app and is served from
 * 'self' like everything else. */
import zxingWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

prepareZXingModule({ overrides: { locateFile: () => zxingWasmUrl } });

export interface QrScan {
  /** Stops the camera and releases the device. Safe to call twice. */
  stop(): void;
  /**
   * What the camera actually gave, which is not always what was asked for.
   *
   * Reported because the difference is the whole ball game for a dense code: a
   * 640x480 capture and a 1920x1080 one look identical on screen and decode
   * very differently. When a scan fails, this is the first number worth
   * knowing, and guessing at it cost a debugging round already.
   *
   * `focusMode` is here for the same reason: a camera parked at its macro
   * limit produces a preview that looks fine to a person and is unreadable to
   * a decoder, and that cost another round. Empty when the platform does not
   * report one.
   */
  resolution: { width: number; height: number; focusMode: string };
}

/**
 * Longest edge the decoder is given, in pixels.
 *
 * jsQR's cost is proportional to pixel count, so this is a trade between CPU
 * and how small a code may appear in frame. It was 640, which threw away most
 * of a 1080p capture and left a 65-module pairing link at roughly half the
 * pixels per module it needed once real blur was involved.
 *
 * At 1080 the same framing gives about 8 px/module for a WalletConnect code
 * instead of about 5, at roughly twice the decode cost per frame. The loop
 * below paces itself rather than running on a fixed timer, so a slower device
 * scans less often instead of falling behind.
 */
const DECODE_MAX_EDGE = 1920;

/** Shortest gap between decode attempts. See the loop below for why. */
const SCAN_INTERVAL_MS = 100;

/** Consecutive decoder exceptions tolerated before the scan gives up. */
const MAX_DECODE_FAILURES = 20;

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
  /**
   * Occasional progress, so a scan that is working and a scan that is stuck
   * are distinguishable from outside.
   *
   * Every failure in this module so far has looked identical from the UI --
   * camera on, nothing happening -- whether the loop had died, the decoder was
   * throwing, or the image was unreadable. A heartbeat costs one log line and
   * turns "nothing happened" into a number.
   */
  onStatus?: (message: string) => void,
): Promise<QrScan> {
  if (!qrScanningAvailable()) throw new Error(QR_UNAVAILABLE);
  if (signal?.aborted) throw new Error("Scan cancelled before the camera started.");

  /* Resolution is asked for, not left to the default.
   *
   * A WalletConnect pairing URI is ~190 characters and its QR is 65 modules a
   * side; an Ethereum address is 37. At the default capture size -- 640x480 on
   * many Android webviews -- a 65-module code held at a comfortable distance
   * lands near two pixels per module, which real optics and a little motion
   * blur push under the floor. The address code, being far coarser, decoded
   * fine at the same framing, which is exactly the symptom: addresses scanned,
   * pairing links did not.
   *
   * `ideal` rather than `exact`: a camera that cannot do 1080p gets to offer
   * whatever it has instead of the request failing outright. */
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      // The rear camera on a phone; ignored on a laptop with one camera.
      facingMode: "environment",
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
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
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    release();
    video.srcObject = null;
    signal?.removeEventListener("abort", stop);
  };

  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  const resolution = {
    width: Number(settings.width ?? 0),
    height: Number(settings.height ?? 0),
    focusMode: "",
  };

  /* Ask for continuous autofocus, explicitly.
   *
   * Measured on a Galaxy Tab A7: the lens sits at its 8 cm macro limit
   * (minimumFocusDistance 12.5 diopters, focusDistance 12.5) and reports
   * PASSIVE_FOCUSED -- it believes it is done. A screen held at arm's length is
   * then badly out of focus, and the preview looks it. A coarse code like an
   * address survives that blur; a 61-module pairing link does not, which is
   * exactly the difference between the two that worked and did not.
   *
   * `focusMode` is not in the base MediaTrackConstraints type and is not
   * supported everywhere, so it goes through `advanced` -- which browsers
   * ignore rather than reject when unsupported -- and any failure is swallowed.
   * Scanning at a bad focus is worse than scanning; it is not worth failing the
   * whole scan over. */
  try {
    await track?.applyConstraints?.({
      advanced: [{ focusMode: "continuous" } as unknown as MediaTrackConstraintSet],
    });
  } catch {
    /* Nothing to do: the camera keeps whatever focus it had. */
  }
  // Read back rather than assume: applyConstraints can succeed and change
  // nothing, which looks identical from here unless the value is checked.
  resolution.focusMode = String(
    (track?.getSettings?.() as { focusMode?: string } | undefined)?.focusMode ?? "",
  );

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
  if (stopped) return { stop, resolution };

  /* Self-pacing rather than a fixed interval.
   *
   * A decode is synchronous and now costs more than it did, so a timer that
   * fires every 100 ms regardless would queue attempts behind each other on a
   * slow device and lock the UI. Scheduling the next attempt only after the
   * previous one returns means a slower phone simply scans less often. The
   * floor stays at 100 ms: a person lining a code up takes far longer than
   * that, so faster buys nothing and costs battery. */
  /** Grab a frame and decode it. `undefined` means "nothing usable yet". */
  const attempt = async (): Promise<T | undefined> => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    // Frames arrive before the intrinsic size does; not an error, just not yet.
    if (w === 0 || h === 0) return undefined;

    /* The WHOLE frame, at native resolution. Not a crop, not a downscale.
     *
     * Both previous attempts were wrong in opposite directions. Scaling the
     * longest edge to a cap threw away 44% of the width on a portrait frame,
     * which is the dimension a centred code needs. Cropping to a centre square
     * fixed that and introduced something worse: it keeps only the middle 56%
     * of the height, so a code that filled the frame and sat slightly high had
     * its top sliced off -- including both upper finder patterns, which is
     * exactly what a decoder locates a code by. Measured on the device: the
     * code spanned y 0.145-0.658 of the frame, the crop kept 0.219-0.781, and
     * fifty sharp frames in a row decoded nothing.
     *
     * A 1080x1920 frame is about 2 megapixels and costs roughly 25 ms to
     * decode, which the self-pacing loop absorbs by scanning a little less
     * often. The cap only engages on cameras larger than this. */
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
    /* `tryHarder` is the point of this decoder: it is what reads a pairing code
     * off a screen, with a logo in the middle of it, through a camera. */
    const found = await readBarcodes(frame, { formats: ["QRCode"], tryHarder: true });
    decodeFailures = 0;                 // this frame got through the decoder
    if (found.length === 0) return undefined;
    return firstAccepted(found.map((f) => ({ rawValue: f.text })), accept);
  };

  /* Self-pacing rather than a fixed interval: a decode is synchronous and not
   * cheap at this resolution, so a timer firing regardless would queue passes
   * behind each other on a slow device and stall the UI. Exactly one place
   * reschedules, and it is reached unless the scan is over. */
  /* jsQR can throw on a frame it cannot make sense of -- it was seen crashing
   * inside its own locator on a real camera image. One bad frame is not a
   * reason to end a scan, so they are counted and tolerated; a decoder failing
   * every single frame is a real fault and still gets reported. */
  let decodeFailures = 0;
  let framesTried = 0;
  let decoderReady = false;

  const tick = (): void => {
    if (stopped) return;
    void scanStep(
      attempt,
      onResult,
      (m) => {
        decodeFailures += 1;
        if (decodeFailures < MAX_DECODE_FAILURES) return;   // tolerate this frame
        stop();
        onError(`${m} (the decoder failed on ${decodeFailures} frames in a row)`);
      },
    ).then((outcome) => {
      if (stopped) return;
      framesTried += 1;
      /* The first completed pass proves the WebAssembly module loaded at all.
       * If it never arrives, the module is stuck fetching and the scan is
       * silently stalled -- which is indistinguishable from a bad image
       * without this line. */
      if (!decoderReady) {
        decoderReady = true;
        onStatus?.("decoder ready");
      } else if (framesTried % 25 === 0) {
        onStatus?.(`scanning: ${framesTried} frames, no code yet`);
      }
      /* A tolerated decoder failure came back as "done" without stopping, so
       * carry on: only a real hit or a real give-up ends the scan. */
      const tolerated = outcome === "done" && decodeFailures > 0 && decodeFailures < MAX_DECODE_FAILURES;
      if (outcome === "done" && !tolerated) {
        // The camera is released before the caller's handler runs.
        stop();
        return;
      }
      timer = setTimeout(tick, SCAN_INTERVAL_MS);
    });
  };

  timer = setTimeout(tick, SCAN_INTERVAL_MS);

  return { stop, resolution };
}
