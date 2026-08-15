/**
 * The scan path, from pixels to a recipient — decoder and parser together.
 *
 * Every other test in this repo exercises one side of this: qr.test.ts checks
 * the acceptance logic with hand-written strings, payment-uri.test.ts checks
 * parsing with hand-written URIs. Neither would have noticed if the decoder
 * itself stopped working, which is exactly what happened on real hardware:
 * `BarcodeDetector` was absent on WebKitGTK and crashed the app on Android, and
 * the suite stayed green throughout because nothing ever decoded an image.
 *
 * So this runs the bundled decoder over rendered QR codes and feeds what comes
 * out into the real parser. The fixtures in `fixtures/qr-codes.json` are QR
 * matrices generated once by python-qrcode and committed, so the test needs no
 * encoder, no camera and no network — only the decoder that ships.
 */

import { readFileSync } from "node:fs";
import jsQR from "jsqr";
import { parsePaymentUri } from "../packages/core/src/payment-uri.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

interface Fixture { text: string; matrix: number[][] }
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/qr-codes.json", import.meta.url), "utf8"),
) as Record<string, Fixture>;

/**
 * Paint a QR matrix as RGBA pixels, the way a camera frame reaches the decoder.
 *
 * `scale` is a real parameter rather than a constant because module size is the
 * axis a camera actually varies along — a code held further away is the same
 * matrix at fewer pixels, and a decoder that only works at one size would pass
 * this test and fail in a user's hand.
 */
function render(matrix: number[][], scale: number): { data: Uint8ClampedArray; width: number } {
  const n = matrix.length;
  const width = n * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const on = matrix[Math.floor(y / scale)]?.[Math.floor(x / scale)] === 1;
      const v = on ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width };
}

const decode = (f: Fixture, scale = 6): string | undefined => {
  const { data, width } = render(f.matrix, scale);
  return jsQR(data, width, width, { inversionAttempts: "attemptBoth" })?.data;
};

group("the bundled decoder reads every payload the app expects");
for (const [name, f] of Object.entries(fixtures)) {
  check(decode(f) === f.text, `${name}: decoded to ${JSON.stringify(decode(f))}, wanted ${JSON.stringify(f.text)}`);
}

group("decoding survives the module sizes a camera actually produces");
{
  // 3px per module is a code held well back; 12px is one held close.
  for (const scale of [3, 4, 8, 12]) {
    const got = decode(fixtures["eip681"] as Fixture, scale);
    check(got === fixtures["eip681"]?.text, `at ${scale}px per module the code did not decode (got ${JSON.stringify(got)})`);
  }
}

group("a scanned code becomes the right recipient, or is refused");
{
  const eip681 = parsePaymentUri(decode(fixtures["eip681"] as Fixture) as string);
  check(eip681.ok && eip681.payment.recipient === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "an EIP-681 code did not yield its address");
  check(eip681.ok && eip681.payment.kind === "native" && eip681.payment.chainId === 1,
    "the chain id was lost between the camera and the parser");

  const bare = parsePaymentUri(decode(fixtures["bare"] as Fixture) as string);
  check(bare.ok && bare.payment.recipient === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "a bare address code did not yield its address");

  // No checksum information in a single-case address, so it must be accepted
  // and normalised rather than rejected as a bad checksum.
  const lower = parsePaymentUri(decode(fixtures["lowercase"] as Fixture) as string);
  check(lower.ok && lower.payment.recipient === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "an all-lowercase address was not accepted and checksummed");

  /* The orientation that costs money if it is wrong: in the transfer form the
   * recipient is the `address` parameter and the token contract is the path
   * target. Swapped, this pays the token contract instead of the person. */
  const transfer = parsePaymentUri(decode(fixtures["transfer"] as Fixture) as string);
  check(transfer.ok && transfer.payment.kind === "token-transfer", "the transfer form was not recognised");
  /* Narrowed rather than asserted through: `token` and `amount` exist only on
   * the transfer variant, which is the whole point of the discriminant -- a
   * caller cannot read them without first establishing it is looking at a
   * transfer. */
  if (transfer.ok && transfer.payment.kind === "token-transfer") {
    const p = transfer.payment;
    check(p.recipient === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "the transfer form's recipient is not the address parameter");
    check(p.token === "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "the transfer form's token is not the path target");
    // 1e6 is EIP-681's exponent form and must be exact, never a float.
    check(p.amount === 1000000n, "1e6 did not become exactly 1000000");
  }

  /* A pairing link and a random URL are both things that can be on a screen
   * behind the one being scanned. Neither may become a recipient. */
  check(!parsePaymentUri(decode(fixtures["wc"] as Fixture) as string).ok,
    "a WalletConnect pairing link was accepted as a payment");
  check(!parsePaymentUri(decode(fixtures["nonsense"] as Fixture) as string).ok,
    "an unrelated URL was accepted as a payment");
}


if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
