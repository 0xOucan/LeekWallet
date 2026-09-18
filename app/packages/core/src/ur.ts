/**
 * Uniform Resources (BC-UR): the wire format for the QR air gap.
 *
 * The mirror of `src/ur.c`, in the same relationship `cbor.ts` has to
 * `src/cbor.c` — two implementations of one wire format, held together by
 * vectors the firmware emits. `sim/test_ur.c --emit-vectors` writes
 * `test/ur-vectors.json`, `scripts/check.sh` regenerates it before this
 * package's tests run, and `test/ur.test.ts` replays it. A corpus recorded
 * from an older `ur.c` would let this file agree with an encoder nobody runs,
 * which is the failure docs/MIRROR-GAP.md describes.
 *
 * BC-UR is the encoding: CBOR payload, CRC-32, Bytewords text, and a fountain
 * code for splitting across animated frames. EIP-4527 is a profile on top that
 * names the CBOR structures (`crypto-hdkey`, `eth-sign-request`,
 * `eth-signature`) and says nothing about the encoding. They are kept apart
 * here for the same reason they are in the firmware: 4527 is marked Stagnant
 * while BC-UR is what wallets actually interoperate over.
 *
 * The word list is data from Blockchain Commons' bc-ur, BSD-2-Clause Plus
 * Patent. The implementation is ours.
 */

/**
 * The 256 Bytewords, concatenated, four characters each.
 *
 * Copied verbatim rather than retyped: the first and last letters of each word
 * ARE the encoding, so one transposed letter would produce output other
 * wallets decode to different bytes, and the checksum would not catch it
 * because it would be computed over the same wrong understanding.
 */
const BYTEWORDS =
  "ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabias" +
  "bluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcost" +
  "cruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdull" +
  "dutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfish" +
  "fizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglow" +
  "goodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhope" +
  "hornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowl" +
  "judojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamb" +
  "lavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmany" +
  "mathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnote" +
  "numbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolpose" +
  "puffpumapurrquadquizraceramprealredorichroadrockroofrubyruinruns" +
  "rustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotask" +
  "taxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuser" +
  "vastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebs" +
  "whatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom";

/** first+last letter pair -> byte value */
const MINIMAL_TO_BYTE = new Map<string, number>();
for (let i = 0; i < 256; i++) {
  MINIMAL_TO_BYTE.set(BYTEWORDS[i * 4]! + BYTEWORDS[i * 4 + 3]!, i);
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3: reflected, init and final xor 0xFFFFFFFF). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc = CRC32_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode bytes as Bytewords-minimal, appending the CRC-32. */
export function bytewordsEncode(data: Uint8Array): string {
  const crc = crc32(data);
  const withCrc = new Uint8Array(data.length + 4);
  withCrc.set(data, 0);
  withCrc[data.length] = (crc >>> 24) & 0xff;
  withCrc[data.length + 1] = (crc >>> 16) & 0xff;
  withCrc[data.length + 2] = (crc >>> 8) & 0xff;
  withCrc[data.length + 3] = crc & 0xff;

  let out = "";
  for (const b of withCrc) {
    out += BYTEWORDS[b * 4]! + BYTEWORDS[b * 4 + 3]!;
  }
  return out;
}

/**
 * Decode Bytewords-minimal and verify the CRC-32.
 *
 * Throws rather than returning null on a bad frame. A misread QR is the
 * expected case, not an exceptional one, so callers scanning an animation are
 * meant to catch and keep scanning; what must never happen is a corrupted
 * frame decoding to plausible bytes.
 */
export function bytewordsDecode(text: string): Uint8Array {
  if (text.length % 2 !== 0) {
    throw new Error("bytewords: odd length");
  }
  if (text.length < 8) {
    throw new Error("bytewords: too short to carry a checksum");
  }

  const total = text.length / 2;
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const pair = text.slice(i * 2, i * 2 + 2).toLowerCase();
    const v = MINIMAL_TO_BYTE.get(pair);
    if (v === undefined) {
      throw new Error(`bytewords: no word for "${pair}"`);
    }
    out[i] = v;
  }

  const payload = out.subarray(0, total - 4);
  const tail = out.subarray(total - 4);
  const want =
    ((tail[0]! << 24) | (tail[1]! << 16) | (tail[2]! << 8) | tail[3]!) >>> 0;
  if (crc32(payload) !== want) {
    throw new Error("bytewords: checksum mismatch");
  }
  return payload;
}

/** Longest UR type we accept, e.g. "eth-sign-request". */
export const UR_TYPE_MAX = 32;

function validType(type: string): boolean {
  if (type.length === 0 || type.length > UR_TYPE_MAX) return false;
  if (type.startsWith("-") || type.endsWith("-")) return false;
  return /^[a-z0-9-]+$/.test(type.toLowerCase());
}

/** Encode a single-part UR: `ur:<type>/<bytewords>`. */
export function urEncode(type: string, payload: Uint8Array): string {
  if (!validType(type)) {
    throw new Error(`ur: invalid type "${type}"`);
  }
  return `ur:${type.toLowerCase()}/${bytewordsEncode(payload)}`;
}

export interface UrDecoded {
  type: string;
  payload: Uint8Array;
}

/**
 * Decode a single-part UR.
 *
 * Accepts the scheme in any case: QR readers and some wallets uppercase the
 * whole string to reach the QR alphanumeric mode, which is smaller on screen.
 * Multi-part URs are rejected here rather than mis-parsed; see `isMultipart`.
 */
export function urDecode(ur: string): UrDecoded {
  const parts = ur.split("/");
  if (parts.length !== 2) {
    throw new Error("ur: expected exactly one '/'");
  }
  const head = parts[0]!;
  if (!/^ur:/i.test(head)) {
    throw new Error("ur: missing scheme");
  }
  const type = head.slice(3).toLowerCase();
  if (!validType(type)) {
    throw new Error(`ur: invalid type "${type}"`);
  }
  return { type, payload: bytewordsDecode(parts[1]!) };
}

/** True if this UR carries a sequence component and needs the fountain decoder. */
export function isMultipart(ur: string): boolean {
  return (ur.match(/\//g) ?? []).length > 1;
}
