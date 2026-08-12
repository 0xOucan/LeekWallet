/**
 * CBOR codec tests.
 *
 * Two things are being checked: that the subset round-trips, and that
 * everything outside the subset is rejected rather than guessed at. The second
 * matters more — this parser handles bytes from a device, and on the firmware
 * side it handles bytes from a host that may be hostile.
 */

import { encodeCbor, decodeCbor, type CborValue } from "../src/cbor.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/* Order-insensitive comparison. The encoder sorts map keys deliberately (see
 * the canonical-encoding group), so a decoded map will not match the insertion
 * order of the literal it came from. Comparing raw JSON.stringify output would
 * flag that as a round-trip failure when the data is identical. */
function canonical(v: CborValue): string {
  if (v instanceof Uint8Array) return `b:${hex(v)}`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${k}:${canonical(v[k] as CborValue)}`).join(",")}}`;
  }
  return typeof v === "string" ? `s:${v}` : `n:${v}`;
}

function roundTrip(label: string, value: CborValue): void {
  const encoded = encodeCbor(value);
  const decoded = decodeCbor(encoded);
  check(
    canonical(decoded) === canonical(value),
    `${label}: round trip differed\n         in:  ${canonical(value)}\n         out: ${canonical(decoded)}`,
  );
}

group("RFC 8949 appendix A vectors");
{
  // Known-answer vectors from the specification: if these drift, the firmware
  // and the client have silently stopped speaking the same language.
  const vectors: Array<[CborValue, string]> = [
    [0, "00"],
    [1, "01"],
    [10, "0a"],
    [23, "17"],
    [24, "1818"],
    [25, "1819"],
    [100, "1864"],
    [1000, "1903e8"],
    [1000000, "1a000f4240"],
    [-1, "20"],
    [-10, "29"],
    [-100, "3863"],
    [-1000, "3903e7"],
    ["", "60"],
    ["a", "6161"],
    ["IETF", "6449455446"],
    [[], "80"],
    [[1, 2, 3], "83010203"],
  ];

  for (const [value, expected] of vectors) {
    const got = hex(encodeCbor(value));
    check(got === expected, `encode ${JSON.stringify(value)}: want ${expected}, got ${got}`);
  }
}

group("round trips");
{
  roundTrip("small int", 42);
  roundTrip("large int", 4294967295);
  roundTrip("negative", -12345);
  roundTrip("text", "signTransaction");
  roundTrip("utf-8 text", "café ☕");
  roundTrip("array", [1, "two", 3]);
  roundTrip("map", { chainId: 1, nonce: 42 });
  roundTrip("nested", { path: [44, 60, 0, 0, 0], meta: { v: 1 } });

  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const decoded = decodeCbor(encodeCbor(bytes));
  check(decoded instanceof Uint8Array && hex(decoded) === "deadbeef", "byte string round trip");

  // A realistic signing request.
  roundTrip("transaction", {
    path: "m/44'/60'/0'/0/0",
    chainId: 1,
    nonce: 42,
    to: new Uint8Array(20).fill(0x71),
    value: new Uint8Array([0x0d, 0xe0, 0xb6, 0xb3, 0xa7, 0x64, 0x00, 0x00]),
    data: new Uint8Array(0),
  });
}

group("canonical encoding");
{
  // Key order must not depend on how the object was built, or two clients
  // produce different bytes for the same request.
  const a = encodeCbor({ zebra: 1, alpha: 2, middle: 3 });
  const b = encodeCbor({ alpha: 2, middle: 3, zebra: 1 });
  check(hex(a) === hex(b), `key order leaked into the encoding: ${hex(a)} vs ${hex(b)}`);

  // Shortest-form integers.
  check(hex(encodeCbor(23)) === "17", "23 should be one byte");
  check(hex(encodeCbor(24)) === "1818", "24 should be two bytes");
  check(hex(encodeCbor(255)) === "18ff", "255 should be two bytes");
  check(hex(encodeCbor(256)) === "190100", "256 should be three bytes");
}

group("everything outside the subset is rejected");
{
  const rejects: Array<[string, () => unknown]> = [
    ["float", () => encodeCbor(1.5 as CborValue)],
    ["truncated head", () => decodeCbor(new Uint8Array([0x18]))],
    ["truncated text", () => decodeCbor(new Uint8Array([0x64, 0x61]))],
    ["indefinite-length array", () => decodeCbor(new Uint8Array([0x9f, 0x01, 0xff]))],
    ["64-bit argument", () => decodeCbor(new Uint8Array([0x1b, 0, 0, 0, 0, 0, 0, 0, 1]))],
    ["tag (major 6)", () => decodeCbor(new Uint8Array([0xc0, 0x01]))],
    ["simple/float (major 7)", () => decodeCbor(new Uint8Array([0xf5]))],
    ["non-text map key", () => decodeCbor(new Uint8Array([0xa1, 0x01, 0x02]))],
    ["trailing bytes", () => decodeCbor(new Uint8Array([0x01, 0x02]))],
    ["invalid utf-8", () => decodeCbor(new Uint8Array([0x62, 0xff, 0xfe]))],
  ];

  for (const [label, fn] of rejects) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(threw, `${label} was accepted`);
  }

  // Deep nesting must be bounded, not stack-overflow.
  let deep: CborValue = 1;
  for (let i = 0; i < 20; i++) deep = [deep];
  let threw = false;
  try { decodeCbor(encodeCbor(deep)); } catch { threw = true; }
  check(threw, "20-deep nesting was accepted");
}

console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
process.exit(failures ? 1 : 0);
