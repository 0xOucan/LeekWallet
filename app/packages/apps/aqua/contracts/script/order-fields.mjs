/**
 * Split a `strategy` blob into the three `Order` fields `quote`/`swap` take.
 *
 * Step 7 of the runbook used to say "read them out of the strategy blob (spec
 * §4: word 2 is traits, data begins at word 5)". That is correct and it is a
 * hand-count of 32-byte words in a 600-character hex string, performed once,
 * under a deadline, with money on the other side of it. This does the count.
 *
 * It is a decoder, not a builder: it re-encodes what it parsed and refuses if
 * the result is not the input it was given. A field this prints is a field
 * that round-trips, so a misparse cannot reach `cast` looking plausible.
 */
const hex = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^0x[0-9a-f]*$/.test(hex) || (hex.length - 2) % 64 !== 0) {
  console.error("usage: order-fields.mjs 0x<strategy>   (whole 32-byte words)");
  process.exit(1);
}
const body = hex.slice(2);
const word = (i) => body.slice(i * 64, (i + 1) * 64);
const num = (i) => BigInt("0x" + word(i));

if (num(0) !== 32n) { console.error(`word0 is ${num(0)}, expected 32 (tuple offset)`); process.exit(1); }
const maker = "0x" + word(1).slice(24);
const traits = "0x" + word(2);
if (num(3) !== 96n) { console.error(`word3 is ${num(3)}, expected 96 (offset to data)`); process.exit(1); }
const len = Number(num(4));
const data = "0x" + body.slice(5 * 64, 5 * 64 + len * 2);
if (data.length - 2 !== len * 2) { console.error("data is shorter than its own length prefix"); process.exit(1); }

// Round-trip: rebuild and compare, so a misparse cannot print quietly.
const pad = (s) => s.padEnd(Math.ceil(s.length / 64) * 64, "0");
const rebuilt = "0x" + word(0) + word(1) + word(2) + word(3) + word(4) + pad(data.slice(2));
if (rebuilt !== hex) {
  console.error("REFUSED: re-encoding the parsed fields did not reproduce the input.");
  console.error(`  in  ${hex.length - 2} chars\n  out ${rebuilt.length - 2} chars`);
  process.exit(1);
}

console.log(`maker    ${maker}`);
console.log(`traits   ${traits}`);
console.log(`data     ${data}`);
console.log(`\nORDER tuple for cast, copy verbatim:\n(${maker},${traits},${data})`);
