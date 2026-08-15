/**
 * The parts of scanning that are just logic.
 *
 * Split from qr.ts so they can be tested under plain Node. qr.ts imports the
 * decoder's WebAssembly through Vite's `?url`, which only a bundler can
 * resolve -- importing it from a test drags in the whole browser world and
 * fails before a single assertion runs. The control flow here is exactly the
 * part that has been wrong before, so it is the part that must stay reachable
 * from a test.
 */

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
 * One pass of the scan loop: what should happen next.
 *
 * Extracted because the control flow here has already been wrong once, in a way
 * nothing could see. The loop used to run on setInterval, where returning early
 * from a frame that did not decode simply skipped that tick. When it became
 * self-pacing -- each pass scheduling the next -- those same early returns
 * stopped rescheduling, so the scan died on the first frame without a code,
 * which is essentially every first frame. The camera opened, one frame was
 * examined, and nothing ever happened again.
 *
 * So the decision lives in one function with one caller, and "no code in this
 * frame" is a first-class outcome rather than a return statement in the middle
 * of a try block.
 */
export async function scanStep<T>(
  attempt: () => Promise<T | undefined> | (T | undefined),
  onResult: (value: T) => void,
  onError: (message: string) => void,
): Promise<"continue" | "done"> {
  let hit: T | undefined;
  try {
    hit = await attempt();
  } catch (e) {
    onError((e as Error).message ?? String(e));
    return "done";
  }
  if (hit === undefined) return "continue";
  onResult(hit);
  return "done";
}

