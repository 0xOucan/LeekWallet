/**
 * What this browser can and cannot do, said out loud.
 *
 * Web Serial is not a web standard everybody implements. It is a Chromium
 * feature. Mozilla's position on it is "harmful" and WebKit's is "opposed"
 * (both recorded on the WHATWG/W3C standards-positions repositories), and
 * neither has shipped it. Chrome on Android supports no extensions at all, and
 * Chrome on iOS is Safari's engine wearing a Chrome badge. So the set of
 * places this extension can reach a device is: desktop Chromium — Chrome,
 * Edge, Brave, Opera, Vivaldi, Arc — on Windows, macOS, Linux and ChromeOS.
 *
 * The alternative to saying so is a Connect button that opens nothing, and a
 * user who concludes their device is broken. A wallet gets exactly one chance
 * to be believed about what it cannot do; spending it on a dead button is a
 * poor trade. So this file exists to produce a sentence, not a boolean, and
 * every surface that would have rendered a disabled control renders the
 * sentence instead.
 */

export interface SerialSupport {
  supported: boolean;
  /** A complete sentence, safe to render verbatim. Empty when supported. */
  reason: string;
}

/**
 * Whether `navigator.serial` is usable from this context.
 *
 * Feature-detected rather than sniffed from the user agent. UA strings lie by
 * design — every Chromium fork claims to be Chrome and Edge claims to be both
 * — and the question here has an exact answer available for free.
 */
export function serialSupport(scope: {
  navigator?: { serial?: unknown };
} = globalThis as { navigator?: { serial?: unknown } }): SerialSupport {
  if (scope.navigator?.serial) return { supported: true, reason: "" };
  return {
    supported: false,
    reason:
      "This browser has no Web Serial API, so it cannot reach the device. " +
      "Web Serial is a Chromium feature: Firefox and Safari have both " +
      "declined to implement it, and Chrome for Android ships no extensions. " +
      "Use desktop Chrome, Edge, Brave or another desktop Chromium browser — " +
      "or the LeekWallet desktop app, which talks to the device over the " +
      "same protocol without needing a browser API at all.",
  };
}

/**
 * The device's USB CDC identity, used to pre-filter the port chooser.
 *
 * A filter is a courtesy, not a security control: the user still picks the
 * port, Chrome still draws the chooser, and a filter that matched nothing
 * would leave them staring at an empty dialog. So it narrows the list and the
 * handshake — not this constant — decides whether the thing on the other end
 * is really a LeekWallet.
 *
 * 0x303a is Espressif's vendor ID; 0x1001 is the USB-serial-JTAG device class
 * the ESP32-S3 exposes. Both are shared with every other ESP32-S3 board in
 * existence, which is precisely why nothing downstream trusts them.
 */
/*
 * Which USB vendors may be a LeekWallet.
 *
 * Espressif alone was the obvious answer and it was wrong on real hardware: an
 * ESP32-S3 board plugged in and the chooser was empty, because only the boards
 * with *native* USB enumerate as Espressif. The reference board routes its
 * serial through a QinHeng CH343 and appears as 1a86:55d3, so a 0x303a filter
 * hides the very device this extension was written for.
 *
 * The four here cover essentially every ESP32 board in circulation. They are a
 * convenience, not a security boundary — a filter decides what a human is shown
 * in a picker, and the device on the other end proves what it is through the
 * handshake, which is where that question actually gets answered.
 */
export const DEVICE_FILTERS = [
  { usbVendorId: 0x303a },  /* Espressif native USB-Serial-JTAG (Firefly Pixie) */
  { usbVendorId: 0x1a86 },  /* QinHeng CH340/CH343 (the ESP32-S3 reference board) */
  { usbVendorId: 0x10c4 },  /* Silicon Labs CP210x */
  { usbVendorId: 0x0403 },  /* FTDI */
];
