/**
 * The USB wire format, checked against the bytes the FIRMWARE actually sends.
 *
 * Not against a second copy of this file's arithmetic: the layout under test is
 * the one written down in `src/protocol.c:16` and implemented in
 * `app/transport-serial/src/wire.rs`, and the only property worth having is
 * that this agrees with those two.
 */

import { encodeUsbFrame, UsbFrameDecoder, MAX_USB_FRAME } from "../src/usb-framing.ts";

let failures = 0;
const check = (ok: boolean, why: string): void => {
  if (!ok) { failures++; console.log(`  FAIL: ${why}`); }
};
const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

{
  console.log("== the frame on the wire is the one protocol.c documents");

  const f = encodeUsbFrame(0x01, bytes(0xaa, 0xbb, 0xcc));
  check(f[0] === 0x4c && f[1] === 0x4b, `no 'L' 'K' marker: got ${f[0]},${f[1]}`);
  /* len covers the type byte plus the payload, and neither the marker nor
   * itself. Three payload bytes plus one type byte is four. */
  check(f[2] === 0x00 && f[3] === 0x04, `len should be 4, got ${(f[2]! << 8) | f[3]!}`);
  check(f[4] === 0x01, "the type byte is not where wire.rs puts it");
  /* marker 2 + len 2 + type 1 + payload 3. `body + 4` in wire.rs. */
  check(f.length === 8, `total should be 8, got ${f.length}`);
}

{
  console.log("== a frame the device sends decodes back");

  const d = new UsbFrameDecoder();
  const got = d.push(encodeUsbFrame(0x02, bytes(1, 2, 3, 4)));
  check(got.length === 1, `expected one frame, got ${got.length}`);
  check(got[0]?.type === 0x02, "wrong type");
  check(same(got[0]?.payload ?? bytes(), bytes(1, 2, 3, 4)), "payload did not survive");
}

{
  /* THE REGRESSION. The extension used the BLE framing on USB, so it read the
   * first two bytes of whatever arrived as a big-endian length. With the IDF
   * console on the same stream those bytes were "I " from `I (1234) tag:` —
   * 0x4920, 18720 — and the user saw "invalid frame length 18720". */
  console.log("== console text before a frame is skipped, not parsed as a length");

  const noise = new TextEncoder().encode("I (1234) leekwallet: booted\r\n");
  check(noise[0] === 0x49 && noise[1] === 0x20,
    "the log line under test does not start with the bytes that caused the bug");
  check(((noise[0]! << 8) | noise[1]!) === 18720, "these are not the reported 18720");

  const d = new UsbFrameDecoder();
  const wire = join(noise, encodeUsbFrame(0x03, bytes(9, 9, 9)));

  const got = d.push(wire);
  check(got.length === 1, `expected one frame past the log line, got ${got.length}`);
  check(got[0]?.type === 0x03, "the frame after the noise decoded wrong");
  check(same(got[0]?.payload ?? bytes(), bytes(9, 9, 9)), "payload past the noise is wrong");
}

{
  console.log("== a frame split across reads is reassembled");

  const whole = encodeUsbFrame(0x04, bytes(7, 7, 7, 7, 7));
  const d = new UsbFrameDecoder();
  /* Split inside the header, which is where a naive decoder breaks: one byte
   * of the marker in one read and the rest in the next. */
  check(d.push(whole.slice(0, 1)).length === 0, "a lone 'L' should not yield a frame");
  check(d.push(whole.slice(1, 3)).length === 0, "half a header should not yield a frame");
  const got = d.push(whole.slice(3));
  check(got.length === 1, `the reassembled frame never arrived (${got.length})`);
  check(same(got[0]?.payload ?? bytes(), bytes(7, 7, 7, 7, 7)), "reassembled payload is wrong");
}

{
  console.log("== a false marker inside noise does not wedge the stream");

  /* 'L' 'K' can occur in text. Followed by an impossible length it must be
   * dropped and the scan resumed, not waited on for ever. */
  const d = new UsbFrameDecoder();
  const trap = bytes(0x4c, 0x4b, 0xff, 0xff);  // len 65535, over the cap
  const wire = join(trap, encodeUsbFrame(0x05, bytes(5, 5, 5)));

  const got = d.push(wire);
  check(got.length === 1, `the real frame after a false marker was lost (${got.length})`);
  check(got[0]?.type === 0x05, "wrong frame recovered after the false marker");
}

{
  console.log("== two frames in one read both come out, in order");

  const d = new UsbFrameDecoder();
  const wire = join(encodeUsbFrame(0x06, bytes(1)), encodeUsbFrame(0x07, bytes(2)));

  const got = d.push(wire);
  check(got.length === 2, `expected two frames, got ${got.length}`);
  check(got[0]?.type === 0x06 && got[1]?.type === 0x07, "frames came out in the wrong order");
}

{
  console.log("== an oversized frame is refused rather than sent");

  let threw = false;
  try {
    encodeUsbFrame(0x01, new Uint8Array(MAX_USB_FRAME));
  } catch { threw = true; }
  check(threw, "a payload over the cap was encoded instead of refused");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
