/**
 * QR scanning for `wc:` pairing links (T32).
 *
 * Built on the platform's own `BarcodeDetector` rather than a bundled decoder.
 * That is a real trade-off, so here is the reasoning: a JS QR decoder is
 * ~40 KB of image-processing code running on camera frames, and it would be a
 * new dependency inside the process that talks to a signing device, for a
 * convenience feature. The platform API is already there on Android and on
 * Chromium desktop, and where it is missing the honest answer — "your webview
 * cannot do this, paste the link instead" — costs the user one paste.
 *
 * The camera stream never leaves this function: no frame is stored, uploaded or
 * put through anything but the detector.
 */

/** The subset of the BarcodeDetector API used here. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const detectorCtor = (): BarcodeDetectorCtor | undefined =>
  (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;

/** Whether this webview can scan at all, before any camera permission prompt. */
export function qrScanningAvailable(): boolean {
  return detectorCtor() !== undefined && typeof navigator?.mediaDevices?.getUserMedia === "function";
}

/** Said in the UI when it is not. Names the workaround, which always works. */
export const QR_UNAVAILABLE =
  "This window's webview has no barcode scanner (it is available on Android and on " +
  "Chromium-based desktop builds). Copy the wc: link from the dapp and paste it above instead.";

export interface QrScan {
  /** Stops the camera and releases the device. Safe to call twice. */
  stop(): void;
}

/**
 * Scan until a `wc:` code is seen, then stop.
 *
 * Only `wc:` values resolve — a QR code in shot that happens to be a URL is
 * ignored rather than handed to the pairing code, which keeps a poster on the
 * wall behind the laptop from interrupting the scan.
 *
 * The caller supplies the `<video>` element so the UI decides where it appears
 * and this module does not touch layout.
 */
export async function scanQr(
  video: HTMLVideoElement,
  onResult: (uri: string) => void,
  onError: (message: string) => void,
): Promise<QrScan> {
  const Ctor = detectorCtor();
  if (!Ctor) throw new Error(QR_UNAVAILABLE);

  const stream = await navigator.mediaDevices.getUserMedia({
    // The rear camera on a phone; ignored on a laptop with one camera.
    video: { facingMode: "environment" },
    audio: false,
  });

  const detector = new Ctor({ formats: ["qr_code"] });
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  await video.play().catch(() => undefined);

  /* Ten frames a second. Faster burns battery on a phone for no gain: a person
   * holding a phone at a screen takes well over a tenth of a second to line the
   * code up. */
  timer = setInterval(() => {
    if (stopped) return;
    void detector
      .detect(video)
      .then((codes) => {
        const hit = codes.find((c) => c.rawValue.trim().toLowerCase().startsWith("wc:"));
        if (!hit || stopped) return;
        stop();
        onResult(hit.rawValue.trim());
      })
      .catch((e: unknown) => {
        stop();
        onError((e as Error).message ?? String(e));
      });
  }, 100);

  return { stop };
}
