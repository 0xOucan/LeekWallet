/**
 * Showing an address someone is going to pay.
 *
 * ---------------------------------------------------------------------------
 * The one risk this screen has, and the one thing that answers it
 *
 * A hardware wallet's guarantee is that nothing is signed except what the
 * DEVICE drew. Receiving has no signature in it, so that guarantee does not
 * reach here: this extension reads ten addresses over the session and renders
 * one. Everything between the device and the pixels — the offscreen document,
 * this popup, the renderer — is software on a computer, and software on a
 * computer is what a hardware wallet assumes may be lying.
 *
 * The consequence is specific and worth naming rather than implying. A
 * compromised host cannot spend from these addresses and cannot extract a key.
 * What it CAN do is show you somebody else's address, so that money you were
 * about to be paid is paid to them instead. No amount of care in this file
 * detects that, because a lie told convincingly here looks exactly like the
 * truth.
 *
 * What answers it is the device's own screen. `Show on device` asks the board
 * to draw the address itself, from its own key, on a display the browser
 * cannot reach. Compare the two and the question is settled. That is why the
 * button is beside every address rather than buried in a menu, and why the
 * text says what it is for: an address worth receiving real money at is worth
 * four seconds of comparison.
 *
 * Building your own extension removes the risk of a tampered BUILD, which is
 * real and worth doing. It does not remove this one — a browser has other ways
 * to be compromised than the extension's own source — so the advice stands
 * whoever compiled it.
 */

import qrcodegen from "qrcode-generator";

/**
 * An address as a scannable QR, as an SVG element.
 *
 * Error correction M and a 4-module quiet zone: a phone camera pointed at a
 * laptop screen has good light and a short distance, and a smaller matrix
 * reads faster than a denser one at this size.
 *
 * The payload is the bare address, not an EIP-681 URI. A URI carries a chain
 * and often an amount, and a QR that silently names a chain is one a payer can
 * follow onto the wrong network. The chain is on the screen in words instead,
 * where the person reads it.
 */
export function addressQr(address: string, doc: Document = document): SVGSVGElement {
  const qr = qrcodegen(0, "M");
  qr.addData(address);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;

  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", "160");
  svg.setAttribute("height", "160");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `QR code for ${address}`);

  /* White plate first: a transparent QR on a dark popup is unreadable, and a
   * QR nobody can scan is worse than no QR because it looks like one. */
  const bg = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  bg.setAttribute("fill", "#ffffff");
  svg.append(bg);

  /* One path for every dark module rather than one rect each: a 40-module code
   * is 1600 elements, and the popup redraws on every state change. */
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.append(path);
  return svg;
}
