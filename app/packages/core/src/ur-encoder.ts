/**
 * Splitting a message into animated-QR parts: the sender side of
 * `ur-decoder.ts`.
 *
 *   ur:<type>/<seqNum>-<seqLen>/<bytewords of [seqNum, seqLen, messageLen, checksum, fragment]>
 *
 * Parts 1..seqLen carry one fragment each; every part after that is a
 * fountain part, the XOR of the subset `chooseFragments` names. A receiver
 * that joins the loop late, or misses frames, still completes from the mixed
 * parts, which is the whole reason to animate a fountain instead of cycling
 * the plain fragments.
 *
 * Built as Blockchain Commons' UREncoder builds it — the same nominal fragment
 * length, the same zero padding of the last fragment, the same subset choice —
 * so the parts are byte-identical to theirs for the same message and length.
 * The test holds it to that against the reference parts the firmware suite
 * embeds, not only to a round trip through our own decoder, since two halves
 * written by one hand can agree on a mistake.
 */

import { encodeCbor } from "./cbor.ts";
import { bytewordsEncode, crc32, urEncode } from "./ur.ts";
import { chooseFragments, UR_MAX_PARTS } from "./ur-fountain.ts";

/**
 * The fragment length for a message, as bc-ur's findNominalFragmentLength
 * picks it: the fewest fragments whose equal share fits `maxFragmentLen`.
 *
 * Equal shares rather than full fragments plus a short tail, because the
 * decoder pins one fragment length for the whole assembly and refuses a part
 * whose length disagrees.
 */
export function nominalFragmentLength(messageLen: number, maxFragmentLen: number): number {
  if (messageLen < 1) throw new Error("ur-encoder: empty message");
  if (maxFragmentLen < 1) throw new Error("ur-encoder: fragment length must be positive");
  const count = Math.ceil(messageLen / maxFragmentLen);
  return Math.ceil(messageLen / count);
}

export class UrEncoder {
  readonly type: string;
  readonly seqLen: number;
  readonly fragmentLen: number;
  private readonly messageLen: number;
  private readonly checksum: number;
  private readonly fragments: Uint8Array[];
  private seqNum = 0;

  constructor(type: string, message: Uint8Array, maxFragmentLen: number) {
    // Validates the type the same way a single-part UR does.
    urEncode(type, new Uint8Array(1));
    this.type = type.toLowerCase();
    this.messageLen = message.length;
    this.checksum = crc32(message);
    this.fragmentLen = nominalFragmentLength(message.length, maxFragmentLen);
    this.seqLen = Math.ceil(message.length / this.fragmentLen);
    if (this.seqLen > UR_MAX_PARTS) {
      /* The decoder on the other end (ours and the firmware's) refuses more
         than this, so emitting it would be an animation nobody can finish. */
      throw new Error(`ur-encoder: ${this.seqLen} fragments exceeds ${UR_MAX_PARTS}`);
    }

    /* Zero-padded to a whole number of fragments; messageLen tells the
       receiver where the real bytes end. */
    const padded = new Uint8Array(this.seqLen * this.fragmentLen);
    padded.set(message);
    this.fragments = [];
    for (let i = 0; i < this.seqLen; i++) {
      this.fragments.push(padded.subarray(i * this.fragmentLen, (i + 1) * this.fragmentLen));
    }
  }

  /** One frame holds it all; show `ur:<type>/<bytewords>` and do not animate. */
  get isSinglePart(): boolean {
    return this.seqLen === 1;
  }

  /** Part `seqNum` (1-based). Any number is valid; the stream never ends. */
  part(seqNum: number): string {
    const data = new Uint8Array(this.fragmentLen);
    for (const i of chooseFragments(seqNum, this.seqLen, this.checksum)) {
      const f = this.fragments[i]!;
      for (let k = 0; k < data.length; k++) data[k]! ^= f[k]!;
    }
    const body = encodeCbor([seqNum, this.seqLen, this.messageLen, this.checksum, data]);
    return `ur:${this.type}/${seqNum}-${this.seqLen}/${bytewordsEncode(body)}`;
  }

  /** The next part in sequence: the plain fragments first, then fountain parts. */
  nextPart(): string {
    this.seqNum += 1;
    return this.part(this.seqNum);
  }
}

/**
 * Everything to display for a message: one static UR if it fits a frame,
 * otherwise an encoder to animate.
 */
export function urFrames(
  type: string,
  message: Uint8Array,
  maxFragmentLen: number,
): { single: string } | { encoder: UrEncoder } {
  const encoder = new UrEncoder(type, message, maxFragmentLen);
  return encoder.isSinglePart ? { single: urEncode(type, message) } : { encoder };
}
