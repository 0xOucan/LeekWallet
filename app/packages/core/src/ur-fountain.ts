/**
 * The BC-UR fountain code: which fragments a given part carries.
 *
 * Mirror of `src/ur-fountain.c`. Held to it by `test/ur-fountain-vectors.json`,
 * which the firmware emits.
 *
 * ---------------------------------------------------------------------------
 * Why this one is the risky mirror
 *
 * The subset a mixed part carries is never transmitted. Both ends derive it
 * from the part number, the fragment count and the message checksum, so an
 * implementation that derives it differently does not fail loudly — it
 * silently XORs the wrong fragments together and the assembled message fails
 * its checksum, which looks exactly like a camera misread.
 *
 * Worse, the derivation runs through IEEE-754 doubles. Two implementations
 * agreeing here is also a claim that C and JavaScript agree bit for bit about
 * double arithmetic, which is true but is not something to assume. That is why
 * the vector file is large and weighted to the mixed path rather than being a
 * handful of spot checks.
 *
 * ---------------------------------------------------------------------------
 * 64-bit arithmetic
 *
 * Xoshiro256** is defined over uint64. JavaScript numbers cannot represent it,
 * so this uses BigInt throughout and converts to a double only where the
 * reference does. Slower than it would be with two 32-bit halves, and not on
 * any hot path: a part is chosen once per scanned frame.
 */

import { sha256 } from "@noble/hashes/sha256";

/** Largest fragment count we will handle; matches UR_MAX_PARTS in the firmware. */
export const UR_MAX_PARTS = 128;

const MASK64 = (1n << 64n) - 1n;
const TWO_POW_64 = 18446744073709551616; // 2^64 as a double, exactly

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (64n - k))) & MASK64;
}

export class Xoshiro256 {
  private s: [bigint, bigint, bigint, bigint];

  /** Seed from a 32-byte digest, big-endian per 64-bit word. */
  constructor(digest: Uint8Array) {
    if (digest.length !== 32) {
      throw new Error("xoshiro256: seed must be 32 bytes");
    }
    const w = (o: number): bigint => {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[o + i]!);
      return v;
    };
    this.s = [w(0), w(8), w(16), w(24)];
  }

  next(): bigint {
    const s = this.s;
    const result = (rotl((s[1] * 5n) & MASK64, 7n) * 9n) & MASK64;
    const t = (s[1] << 17n) & MASK64;

    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 45n);

    return result;
  }

  nextDouble(): number {
    return Number(this.next()) / TWO_POW_64;
  }

  nextInt(low: number, high: number): number {
    return Math.floor(this.nextDouble() * (high - low + 1)) + low;
  }
}

/**
 * Walker's alias method over the degree distribution 1/1, 1/2 ... 1/seqLen.
 *
 * Built exactly as bc-ur builds it, including the reversed index order it flags
 * as a variance from Schwarz. That ordering is part of the wire behaviour: a
 * different but equally valid alias table picks different fragments, and the
 * two ends stop agreeing without either of them being wrong on its own terms.
 */
function chooseDegree(seqLen: number, rng: Xoshiro256): number {
  const n = seqLen;

  let sum = 0;
  for (let i = 1; i <= n; i++) sum += 1 / i;

  const P = new Float64Array(n);
  for (let i = 0; i < n; i++) P[i] = ((1 / (i + 1)) * n) / sum;

  const small: number[] = [];
  const large: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    (P[i]! < 1 ? small : large).push(i);
  }

  const probs = new Float64Array(n);
  const aliases = new Int32Array(n);

  while (small.length > 0 && large.length > 0) {
    const a = small.pop()!;
    const g = large.pop()!;
    probs[a] = P[a]!;
    aliases[a] = g;
    P[g] = P[g]! + P[a]! - 1;
    (P[g]! < 1 ? small : large).push(g);
  }
  while (large.length > 0) probs[large.pop()!] = 1;
  /* Reachable only through numeric instability, per the reference. */
  while (small.length > 0) probs[small.pop()!] = 1;

  const r1 = rng.nextDouble();
  const r2 = rng.nextDouble();
  const i = Math.floor(n * r1);
  return (r2 < probs[i]! ? i : aliases[i]!) + 1;
}

/**
 * The fragments part `seqNum` carries. `seqNum` is 1-based, as on the wire.
 *
 * Parts 1..seqLen select exactly one fragment each, so a sender that emits only
 * those has sent a complete message and a receiver never has to XOR anything.
 */
export function chooseFragments(
  seqNum: number,
  seqLen: number,
  checksum: number,
): number[] {
  if (seqNum < 1 || seqLen < 1 || seqLen > UR_MAX_PARTS) {
    throw new Error(`fountain: seqNum ${seqNum} of seqLen ${seqLen} is out of range`);
  }
  if (seqNum <= seqLen) {
    return [seqNum - 1];
  }

  const seed = new Uint8Array(8);
  const dv = new DataView(seed.buffer);
  dv.setUint32(0, seqNum >>> 0, false);
  dv.setUint32(4, checksum >>> 0, false);

  const rng = new Xoshiro256(sha256(seed));
  const degree = chooseDegree(seqLen, rng);

  /* Fisher-Yates by removal, exactly as the reference shuffles: draw an index
     from what is left, take it, close the gap. Only the first `degree` draws
     are used, but the draws themselves have to match. */
  const remaining: number[] = [];
  for (let i = 0; i < seqLen; i++) remaining.push(i);

  const chosen: number[] = [];
  for (let taken = 0; taken < degree && remaining.length > 0; taken++) {
    const index = rng.nextInt(0, remaining.length - 1);
    chosen.push(remaining[index]!);
    remaining.splice(index, 1);
  }
  return chosen.sort((a, b) => a - b);
}
