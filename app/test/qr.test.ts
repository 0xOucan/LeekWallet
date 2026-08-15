/**
 * QR scanner tests (T32).
 *
 * The camera parts need a camera, so what is pinned down here is the part that
 * decides *which* code wins: a QR poster on the wall behind the laptop must not
 * end a scan the user started for something else. That filter used to be a
 * hard-coded `wc:` prefix test inside the polling loop; now that the caller
 * supplies it, it is worth a test that it is still applied at all.
 *
 * Also checked: the unavailable message names a workaround without claiming the
 * user is in a screen they are not.
 */

import { firstAccepted, QR_UNAVAILABLE, qrUnavailable, qrScanningAvailable } from "../src/wc/qr.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const codes = (...values: string[]) => values.map((rawValue) => ({ rawValue }));
const wc = (raw: string): string | undefined =>
  raw.toLowerCase().startsWith("wc:") ? raw : undefined;

group("a code the caller does not accept is ignored, not returned");
{
  check(firstAccepted(codes("https://a-poster-on-the-wall.example"), wc) === undefined,
    "an unrelated URL ended the scan");
  check(firstAccepted(codes(), wc) === undefined, "an empty frame produced a result");
}

group("the first accepted code wins, even with distractors in shot");
{
  const r = firstAccepted(codes("https://poster.example", "wc:abc@2", "wc:def@2"), wc);
  check(r === "wc:abc@2", `wrong winner: ${String(r)}`);
}

group("values are trimmed before the caller sees them");
{
  // Cameras and encoders both add stray whitespace; the caller's parser should
  // not have to know that.
  check(firstAccepted(codes("  wc:abc@2\n"), wc) === "wc:abc@2", "raw value not trimmed");
}

group("acceptance is the caller's, not this module's");
{
  // The point of the generalisation: a non-wc caller gets its own codes through.
  const addr = (raw: string) => (/^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : undefined);
  const a = `0x${"a".repeat(40)}`;
  check(firstAccepted(codes("wc:abc@2", a), addr) === a, "a non-wc caller could not accept a code");
  check(firstAccepted(codes(a), wc) === undefined, "the wc caller accepted an address");
}

group("a falsy-but-defined result still counts as a hit");
{
  // `undefined` is the only sentinel; a parser returning "" or 0 must not be
  // mistaken for "no match" and left scanning forever.
  check(firstAccepted(codes("x"), () => "") === "", "an empty-string result was treated as no match");
  check(firstAccepted(codes("x"), () => 0) === 0, "a zero result was treated as no match");
}

group("the unavailable message names a workaround and no particular screen");
{
  check(QR_UNAVAILABLE.length > 40, "the message is too terse to act on");
  // It is shown both where the fallback is pasting a wc: link and where it is
  // typing an address, so it must not claim either one.
  check(!QR_UNAVAILABLE.includes("wc:"), "the generic message still names wc:");
  check(!/address/i.test(QR_UNAVAILABLE), "the generic message still names an address");
  check(/hand|instead/i.test(QR_UNAVAILABLE), "the generic message names no workaround");

  const specific = qrUnavailable("Paste the wc: link above instead.");
  check(specific.includes("Paste the wc: link above instead."), "the caller's fallback was dropped");
  /* The message must still say WHY, not just what to do instead. It used to
   * say "no barcode scanner", which was the truth when decoding depended on the
   * platform; the decoder is bundled now, so the only thing that can be missing
   * is the camera. Same property, current cause. */
  check(/camera/i.test(specific), "the explanation was dropped");
}

group("availability is false where there is no camera to reach");
{
  /* Node has no mediaDevices, which is the "cannot scan" case the UI must
   * detect before offering the button. Since the decoder is bundled this is the
   * ONLY remaining reason scanning can be unavailable -- there is no longer a
   * platform where the decoder itself is missing. */
  check(!qrScanningAvailable(), "claimed scanning works with no camera API");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
