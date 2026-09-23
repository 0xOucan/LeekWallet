/**
 * Assembling a message from animated-QR parts.
 *
 * Mirror of `src/ur-decoder.c`, held to it by `test/ur-assembly-vectors.json`.
 *
 * What arrives:
 *
 *   ur:<type>/<seqNum>-<seqLen>/<bytewords>
 *
 * and the bytewords carry CBOR:
 *
 *   [ seqNum, seqLen, messageLen, checksum, fragmentBytes ]
 *
 * Parts 1..seqLen are the plain fragments; later parts are the XOR of a subset
 * both ends derive (see ur-fountain.ts). Each arrival is reduced against what
 * is already held, anything that collapses to one fragment is promoted, and
 * that promotion can free another, so it loops until it stops making progress.
 *
 * ---------------------------------------------------------------------------
 * Every field here is attacker-chosen
 *
 * The companion reads these from a camera pointed at whatever is in front of
 * it. So the fragment count, message length, fragment length, checksum and
 * type are pinned by the first accepted part, and any later part that
 * disagrees is refused — otherwise a second code in the frame could steer an
 * assembly already under way. The same reasoning and the same limits as the
 * firmware, because the two have to refuse the same things.
 */

import { crc32, bytewordsDecode } from "./ur.ts";
import { chooseFragments, UR_MAX_PARTS } from "./ur-fountain.ts";
import { decodeCbor } from "./cbor.ts";

/** Mixed parts held back waiting to become reducible. Matches the firmware. */
export const UR_DECODER_MIXED = 8;

export type UrPartResult =
  /** took it, still waiting for more */
  | "accepted"
  /** assembled, and the checksum matched */
  | "complete"
  /** valid, but carried nothing new */
  | "redundant"
  /** malformed, inconsistent, or too big */
  | "rejected";

interface Pinned {
  type: string;
  seqLen: number;
  messageLen: number;
  checksum: number;
  fragmentLen: number;
}

export class UrDecoder {
  private pinned: Pinned | null = null;
  private fragments: (Uint8Array | null)[] = [];
  private mixed: { indices: Set<number>; data: Uint8Array }[] = [];

  /** Forget everything. Call between messages. */
  reset(): void {
    this.pinned = null;
    this.fragments = [];
    this.mixed = [];
  }

  get complete(): boolean {
    return this.pinned !== null && this.fragments.every((f) => f !== null);
  }

  /** Fragments still missing, for a progress indicator. */
  get remaining(): number {
    if (this.pinned === null) return 0;
    return this.fragments.filter((f) => f === null).length;
  }

  /** The UR type of the assembly in progress, or null. */
  get type(): string | null {
    return this.pinned?.type ?? null;
  }

  /** The assembled message, or null until complete. */
  get message(): Uint8Array | null {
    if (!this.complete || this.pinned === null) return null;
    const out = new Uint8Array(this.pinned.seqLen * this.pinned.fragmentLen);
    this.fragments.forEach((f, i) => out.set(f!, i * this.pinned!.fragmentLen));
    return out.subarray(0, this.pinned.messageLen);
  }

  /** Feed one scanned UR string, single-part or multi-part. */
  receive(ur: string): UrPartResult {
    if (this.complete) return "redundant";

    const slashes = (ur.match(/\//g) ?? []).length;
    if (slashes === 0 || !/^ur:/i.test(ur)) return "rejected";

    let type: string;
    let seqNum: number, seqLen: number, messageLen: number, checksum: number;
    let data: Uint8Array;

    try {
      if (slashes === 1) {
        /* A single part is the whole message, with no CBOR envelope. */
        const head = ur.slice(0, ur.indexOf("/"));
        type = head.slice(3).toLowerCase();
        const payload = bytewordsDecode(ur.slice(ur.indexOf("/") + 1));
        seqNum = 1;
        seqLen = 1;
        messageLen = payload.length;
        checksum = crc32(payload);
        data = payload;
      } else if (slashes === 2) {
        const first = ur.indexOf("/");
        const second = ur.indexOf("/", first + 1);
        type = ur.slice(3, first).toLowerCase();

        const seq = ur.slice(first + 1, second);
        const m = /^(\d+)-(\d+)$/.exec(seq);
        if (m === null) return "rejected";
        const headerNum = Number(m[1]);
        const headerLen = Number(m[2]);

        const part = decodeCbor(bytewordsDecode(ur.slice(second + 1)));
        if (!Array.isArray(part) || part.length !== 5) return "rejected";
        const [a, b, c, d, e] = part;
        if (
          typeof a !== "number" || typeof b !== "number" ||
          typeof c !== "number" || typeof d !== "number" ||
          !(e instanceof Uint8Array)
        ) {
          return "rejected";
        }
        seqNum = a; seqLen = b; messageLen = c; checksum = d; data = e;

        /* The header outside the CBOR and the values inside it must agree; if
           they do not, one of them is lying and we cannot tell which. */
        if (headerNum !== seqNum || headerLen !== seqLen) return "rejected";
      } else {
        return "rejected";
      }
    } catch {
      /* A misread frame is the expected case when a camera is involved. */
      return "rejected";
    }

    if (
      seqNum < 1 || seqLen < 1 || seqLen > UR_MAX_PARTS ||
      data.length === 0 || messageLen === 0
    ) {
      return "rejected";
    }
    /* The fragment length is implied, and the sender does not get to make the
       last fragment a different size from the rest. */
    if (
      seqLen * data.length < messageLen ||
      (seqLen - 1) * data.length >= messageLen
    ) {
      return "rejected";
    }

    if (this.pinned === null) {
      this.pinned = {
        type, seqLen, messageLen, checksum, fragmentLen: data.length,
      };
      this.fragments = new Array(seqLen).fill(null);
    } else {
      const p = this.pinned;
      if (
        p.type !== type || p.seqLen !== seqLen || p.messageLen !== messageLen ||
        p.checksum !== checksum || p.fragmentLen !== data.length
      ) {
        return "rejected";
      }
    }

    let indices: Set<number>;
    try {
      indices = new Set(chooseFragments(seqNum, seqLen, checksum));
    } catch {
      return "rejected";
    }

    let work = new Uint8Array(data);
    this.reduceInPlace(indices, work);

    if (indices.size === 0) return "redundant";

    if (indices.size === 1) {
      const idx = [...indices][0]!;
      if (this.fragments[idx] !== null) return "redundant";
      this.absorb(idx, work);
    } else {
      if (this.mixed.length >= UR_DECODER_MIXED) {
        /* Full. Dropping is safe: the sender keeps emitting and a later part
           will reduce further. Better than evicting one that might have been
           the useful one. */
        return "redundant";
      }
      this.mixed.push({ indices, data: work });
    }

    if (!this.complete) return "accepted";

    /* Everything the sender claimed must now be true of what we assembled. */
    const msg = this.message!;
    if (crc32(msg) !== this.pinned.checksum) {
      this.reset();
      return "rejected";
    }
    return "complete";
  }

  private reduceInPlace(indices: Set<number>, data: Uint8Array): void {
    for (const i of [...indices]) {
      const have = this.fragments[i];
      if (have != null) {
        for (let k = 0; k < data.length; k++) data[k]! ^= have[k]!;
        indices.delete(i);
      }
    }
  }

  /* Storing a fragment can free a queued part, and that one a third, so this
     loops until nothing more moves. */
  private absorb(index: number, data: Uint8Array): void {
    this.fragments[index] = data;

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let m = 0; m < this.mixed.length; m++) {
        const entry = this.mixed[m]!;
        this.reduceInPlace(entry.indices, entry.data);

        if (entry.indices.size === 1) {
          const idx = [...entry.indices][0]!;
          if (this.fragments[idx] === null) {
            this.fragments[idx] = entry.data;
            progressed = true;
          }
        }
        if (entry.indices.size <= 1) {
          this.mixed.splice(m, 1);
          m--;
        }
      }
    }
  }
}
