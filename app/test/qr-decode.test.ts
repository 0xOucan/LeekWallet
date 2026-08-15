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
import { readBarcodes } from "zxing-wasm/reader";
import qrcodegen from "qrcode-generator";
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

/* The decoder that ships. Async, so every caller awaits -- worth the churn:
 * a test that exercises a different decoder than the app proves nothing about
 * the app, which is how a scanner that could not read a pairing code passed a
 * green suite. */
const decode = async (f: Fixture, scale = 6): Promise<string | undefined> => {
  const { data, width } = render(f.matrix, scale);
  const found = await readBarcodes(
    { data, width, height: width, colorSpace: "srgb" } as ImageData,
    { formats: ["QRCode"], tryHarder: true },
  );
  return found[0]?.text;
};

async function main(): Promise<void> {
group("the bundled decoder reads every payload the app expects");
for (const [name, f] of Object.entries(fixtures)) {
  check(await decode(f) === f.text, `${name}: decoded to ${JSON.stringify(await decode(f))}, wanted ${JSON.stringify(f.text)}`);
}

group("decoding survives the module sizes a camera actually produces");
{
  // 3px per module is a code held well back; 12px is one held close.
  for (const scale of [3, 4, 8, 12]) {
    const got = await decode(fixtures["eip681"] as Fixture, scale);
    check(got === fixtures["eip681"]?.text, `at ${scale}px per module the code did not decode (got ${JSON.stringify(got)})`);
  }
}

group("a scanned code becomes the right recipient, or is refused");
{
  const eip681 = parsePaymentUri(await decode(fixtures["eip681"] as Fixture) as string);
  check(eip681.ok && eip681.payment.recipient === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "an EIP-681 code did not yield its address");
  check(eip681.ok && eip681.payment.kind === "native" && eip681.payment.chainId === 1,
    "the chain id was lost between the camera and the parser");

  const bare = parsePaymentUri(await decode(fixtures["bare"] as Fixture) as string);
  check(bare.ok && bare.payment.recipient === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "a bare address code did not yield its address");

  // No checksum information in a single-case address, so it must be accepted
  // and normalised rather than rejected as a bad checksum.
  const lower = parsePaymentUri(await decode(fixtures["lowercase"] as Fixture) as string);
  check(lower.ok && lower.payment.recipient === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "an all-lowercase address was not accepted and checksummed");

  /* The orientation that costs money if it is wrong: in the transfer form the
   * recipient is the `address` parameter and the token contract is the path
   * target. Swapped, this pays the token contract instead of the person. */
  const transfer = parsePaymentUri(await decode(fixtures["transfer"] as Fixture) as string);
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
  check(!parsePaymentUri(await decode(fixtures["wc"] as Fixture) as string).ok,
    "a WalletConnect pairing link was accepted as a payment");
  check(!parsePaymentUri(await decode(fixtures["nonsense"] as Fixture) as string).ok,
    "an unrelated URL was accepted as a payment");
}


group("an address this app draws scans back as the same address");
{
  /* The receive side, end to end, with no camera: encode exactly as the
   * address panel does, rasterise, and read it back with the decoder that runs
   * on scanned frames. A QR the app draws but nothing can read is a support
   * ticket; one that reads back as a DIFFERENT string is somebody's funds.
   *
   * Checksummed input on purpose -- mixed case carries EIP-55, so a corrupted
   * read is caught by the parser rather than becoming a valid-looking address.
   */
  const addresses = [
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "0xbDEB381a7c77040bf2a99E2990C116774CCb339f",
    "0xc095c7cA2B56b0F0DC572d5d4A9Eb1B37f4306a0",
  ];

  for (const address of addresses) {
    const qr = qrcodegen(0, "M");
    qr.addData(address);
    qr.make();

    const n = qr.getModuleCount();
    const quiet = 4;
    const scale = 6;
    const width = (n + quiet * 2) * scale;
    const data = new Uint8ClampedArray(width * width * 4);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const mx = Math.floor(x / scale) - quiet;
        const my = Math.floor(y / scale) - quiet;
        const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx);
        const v = dark ? 0 : 255;
        const i = (y * width + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }

    const found = await readBarcodes(
      { data, width, height: width, colorSpace: "srgb" } as ImageData,
      { formats: ["QRCode"], tryHarder: true },
    );
    const read = found[0]?.text;
    check(read === address, `${address} scanned back as ${JSON.stringify(read)}`);

    // And the scanner's own parser must accept it as a recipient.
    const parsed = parsePaymentUri(read ?? "");
    check(parsed.ok && parsed.payment.recipient === address,
      `${address} did not survive the parser after a round trip`);
  }
}


group("a real pairing link decodes, not just a short one");
{
  /* The gap that let a bug ship. The `wc` fixture above is 56 characters and
   * 41 modules; a real WalletConnect v2 URI carries a 64-hex topic and a 64-hex
   * symmetric key, which is 187 characters and 65 modules. Addresses are 37.
   *
   * Decoding is a function of PIXELS PER MODULE, so a code with two thirds
   * again as many modules needs two thirds more resolution to read at the same
   * framing. The scanner captured at whatever the webview offered -- 640x480 on
   * Android -- and then threw it down to 640 anyway, which left a pairing link
   * near the floor while an address had margin to spare. Addresses scanned,
   * pairing links did not, and nothing here noticed because the only wc:
   * fixture was a short one.
   *
   * So this asserts the density that actually ships, at the pixels per module
   * the capture settings now provide. */
  const wc = fixtures["wcRealistic"] as Fixture;
  const modules = wc.matrix.length;
  check(modules >= 60, `the realistic pairing fixture is only ${modules} modules; it is not exercising density`);

  // 4 px/module is about where real optics stop being reliable. The capture is
  // 1080-capable and the decoder is given up to 1080, so a code filling a
  // quarter of the frame clears this comfortably.
  for (const scale of [4, 6, 10]) {
    check(await decode(wc, scale) === wc.text,
      `a 65-module pairing link did not decode at ${scale}px per module`);
  }

  // And it must still be refused as a payment recipient.
  check(!parsePaymentUri(await decode(wc) as string).ok,
    "a pairing link was accepted as a payment address");
}


group("a code that is not dead centre is still read");
{
  /* The bug this exists for: the decoder was handed a centre square crop of a
   * portrait frame, which keeps only the middle 56% of the height. A code that
   * filled the frame and sat slightly high lost its top edge -- both upper
   * finder patterns -- and fifty sharp frames in a row decoded nothing while
   * the preview looked perfect.
   *
   * So: render a code into a portrait frame, offset from centre the way a hand
   * -held camera actually frames one, and require it to decode. */
  const wc = fixtures["wcRealistic"] as Fixture;
  const FW = 540, FH = 960;              // a portrait frame, scaled down for speed
  const n = wc.matrix.length;

  const place = async (topFrac: number): Promise<string | undefined> => {
    const side = Math.floor(FW * 0.85);
    const scale = side / n;
    const ox = Math.floor((FW - side) / 2);
    const oy = Math.floor(FH * topFrac);
    const data = new Uint8ClampedArray(FW * FH * 4).fill(255);
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        const mx = Math.floor((x - ox) / scale);
        const my = Math.floor((y - oy) / scale);
        const dark = mx >= 0 && my >= 0 && mx < n && my < n && wc.matrix[my]?.[mx] === 1;
        const i = (y * FW + x) * 4;
        const v = dark ? 0 : 255;
        data[i] = v; data[i+1] = v; data[i+2] = v; data[i+3] = 255;
      }
    }
    const found = await readBarcodes(
      { data, width: FW, height: FH, colorSpace: "srgb" } as ImageData,
      { formats: ["QRCode"], tryHarder: true },
    );
    return found[0]?.text;
  };

  // 0.14 is where the real one sat when this broke; 0.5 is the bottom half.
  for (const top of [0.05, 0.14, 0.3, 0.5]) {
    check(await place(top) === wc.text,
      `a code starting ${Math.round(top*100)}% down the frame did not decode`);
  }
}
}

await main();

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
