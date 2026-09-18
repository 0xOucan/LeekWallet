/**
 * The scan-side filter both QR UIs share: only the expected UR type is
 * assembled, and progress is only reported for parts that moved it forward.
 */

import { UrScanAssembler, urType } from "../src/ur-scan.ts";
import { UrEncoder, urFrames } from "../src/ur-encoder.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const message = new Uint8Array(300).map((_, i) => (i * 7 + 3) & 0xff);

group("urType reads the type case-insensitively and refuses non-URs");
check(urType("UR:CRYPTO-HDKEY/abc") === "crypto-hdkey", "uppercase UR not recognised");
check(urType("ur:eth-signature/1-2/abc") === "eth-signature", "multipart type not read");
check(urType("https://example.invalid/x") === null, "a URL was read as a UR");
check(urType("ur:noslash") === null, "a UR with no body was accepted");

group("a multipart message assembles, uppercased, with progress");
{
  const enc = new UrEncoder("crypto-hdkey", message, 60);
  const scan = new UrScanAssembler("crypto-hdkey");
  const progress: string[] = [];
  let out: Uint8Array | undefined;
  for (let i = 0; i < enc.seqLen * 3 && out === undefined; i++) {
    out = scan.accept(enc.nextPart().toUpperCase(), (t) => progress.push(t));
  }
  check(out !== undefined && out.length === message.length && out.every((b, i) => b === message[i]),
    "the message did not come back intact");
  check(progress.length > 0, "no progress was reported for a multipart scan");
}

group("a UR of another type never reaches the decoder");
{
  const other = new UrEncoder("eth-signature", message, 60);
  const scan = new UrScanAssembler("crypto-hdkey");
  const progress: string[] = [];
  for (let i = 0; i < other.seqLen * 3; i++) {
    check(scan.accept(other.nextPart(), (t) => progress.push(t)) === undefined,
      "a wrong-type part completed the scan");
  }
  check(progress.length === 0, "a wrong-type part drove the progress line");
  /* And it did not pin the decoder: the right type still assembles. */
  const frames = urFrames("crypto-hdkey", message.subarray(0, 40), 200);
  check("single" in frames, "fixture should be single-part");
  if ("single" in frames) {
    check(scan.accept(frames.single) !== undefined, "the right UR was blocked by the wrong one");
  }
}

console.log(failures === 0 ? "\nall ur-scan tests passed" : `\n${failures} ur-scan test(s) FAILED`);
if (failures > 0) process.exit(1);
