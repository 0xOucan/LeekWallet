/**
 * Multi-part assembly, against parts the FIRMWARE read.
 *
 * The part strings did not come from our encoder: Blockchain Commons' own
 * UREncoder produced them, the C suite embeds them, and `--emit-vectors`
 * records what src/ur-decoder.c makes of them. So this checks two things at
 * once — that the TypeScript decoder reads what other wallets send, and that
 * it reaches the same answer the firmware does.
 */

import { readFileSync } from "node:fs";
import { UrDecoder } from "../src/ur-decoder.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

interface Vectors {
  messageHex: string;
  parts: string[];
  single: string;
  singleHex: string;
}

const v: Vectors = JSON.parse(
  readFileSync(new URL("./ur-assembly-vectors.json", import.meta.url), "utf8"),
);

const dec = new UrDecoder();

function feedAll(parts: string[], passes = 1): boolean {
  for (let p = 0; p < passes; p++) {
    for (const part of parts) {
      const r = dec.receive(part);
      check(r !== "rejected", `a firmware-recorded part was rejected: ${part.slice(0, 40)}…`);
      if (r === "complete") return true;
    }
  }
  return false;
}

group(`parts in order (${v.parts.length} available)`);
{
  dec.reset();
  check(feedAll(v.parts), "never completed");
  check(hex(dec.message ?? new Uint8Array()) === v.messageHex,
    "assembled bytes differ from the firmware's");
}

/* The real case: a user points a camera at a loop already running, so the
 * first plain fragments are never seen as themselves and have to come out of
 * the mixed parts. */
group("joining the animation late, and looping");
{
  dec.reset();
  check(feedAll(v.parts.slice(3), 3), "never completed");
  check(hex(dec.message ?? new Uint8Array()) === v.messageHex, "assembled the wrong bytes");
}

group("every third frame dropped");
{
  dec.reset();
  check(feedAll(v.parts.filter((_, i) => i % 3 !== 2), 3), "never completed");
  check(hex(dec.message ?? new Uint8Array()) === v.messageHex, "assembled the wrong bytes");
}

/* Only the mixed parts, and none of the plain fragments.
 *
 * This is the shape that forces the held-back queue to work. Every other
 * ordering lets a mixed part be reduced the moment it arrives, against
 * fragments already known, so the queue fills but is never needed. Here
 * nothing is known when the first parts arrive, so they can only be stored,
 * and the message can only be recovered by promoting them as later arrivals
 * unlock them — which is what a fountain code is for.
 *
 * Two earlier attempts at this test were wrong, and both are worth recording.
 * The first fed parts in order and the second joined late; disabling the
 * promotion loop outright left both green, because repeated passes let each
 * mixed part be re-reduced on its next arrival. The third asserted that mixed
 * parts alone "cannot" complete, which is backwards — recovering a message
 * from nothing but mixed parts is precisely the property being bought. */
group("mixed parts alone, so the queue has to be used");
{
  dec.reset();
  let completed = false;
  for (const part of v.parts.slice(5)) {
    const r = dec.receive(part);
    check(r !== "rejected", "a firmware-recorded mixed part was rejected");
    if (r === "complete") { completed = true; break; }
  }
  check(completed, "the fountain never converged from mixed parts alone");
  check(hex(dec.message ?? new Uint8Array()) === v.messageHex,
    "assembled the wrong bytes");
}

group("a single-part UR needs no assembly");
{
  dec.reset();
  check(dec.receive(v.single) === "complete", "single-part UR did not complete");
  check(hex(dec.message ?? new Uint8Array()) === v.singleHex, "single-part payload is wrong");
}

/* Two senders, one decoder. Whatever arrives second must not be able to steer
 * an assembly already under way. */
group("a part from a different message is refused");
{
  dec.reset();
  check(dec.receive(v.parts[0]!) === "accepted", "first part not accepted");
  check(dec.receive(v.single) === "rejected",
    "a part from another message was accepted mid-assembly");
  check(feedAll(v.parts.slice(1), 3), "did not recover after the bad part");
  check(hex(dec.message ?? new Uint8Array()) === v.messageHex, "assembled the wrong bytes");
}

group("malformed parts are refused");
{
  const rejected = (label: string, s: string) => {
    dec.reset();
    check(dec.receive(s) === "rejected", `${label} was accepted`);
  };
  rejected("part zero", "ur:bytes/0-5/lpadahcszscyvadpiyhnhdey");
  rejected("a zero fragment count", "ur:bytes/1-0/lpadahcszscyvadpiyhnhdey");
  rejected("an empty body", "ur:bytes/1-5/");
  rejected("a non-numeric sequence", "ur:bytes/a-5/lpadahcszscyvadpiyhnhdey");
  rejected("a UR with no scheme", "bytes/1-5/lpadahcszscyvadpiyhnhdey");

  /* A single flipped character in a real part must fail its CRC. */
  const p = v.parts[0]!;
  const broken = p.slice(0, -1) + (p.endsWith("a") ? "z" : "a");
  rejected("a corrupted part", broken);
}

/* The header outside the CBOR and the values inside it are both attacker
 * controlled; disagreeing means one is lying and there is no way to tell
 * which. */
group("a header that disagrees with its payload is refused");
{
  dec.reset();
  const p = v.parts[0]!;
  const lied = p.replace(/\/(\d+)-(\d+)\//, (_m, _a, b) => `/2-${b}/`);
  check(lied !== p, "test did not actually alter the header");
  check(dec.receive(lied) === "rejected", "a lying sequence header was accepted");
}

console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
process.exit(failures ? 1 : 0);
