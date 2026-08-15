/**
 * The mock leg of the conformance suite (ROADMAP T26).
 *
 * Every host test in this repository stands on MockDevice, so every one of
 * them is worth exactly as much as the mock's agreement with the firmware.
 * Twice the mock has been more permissive than protocol.c, passed a green
 * suite, and certified code the device refuses. Prose in PROTOCOL.md did not
 * stop that happening and could not: two implementations agree only where
 * something compares them.
 *
 * So nothing here is written by hand. `sim/test_protocol.c --emit-vectors`
 * replays a fixed corpus through the real protocol.c compiled on this machine
 * and records, byte for byte, the request it received and the plaintext reply
 * it produced. This file feeds the SAME bytes to the mock and compares the
 * answers — frame type, map shape, field names, values, error codes. Adding a
 * case on the C side adds it here with no edit to this file, which is the only
 * version of this that stays true.
 *
 * What is deliberately NOT compared, and why. The mock is a protocol mock, not
 * a wallet: it has no BIP32 and no secp256k1, so an address, an `r`, an `s` and
 * a `yParity` cannot match and pretending otherwise would mean weakening the
 * comparison everywhere to accommodate four fields. Those are checked for shape
 * — a real 20-byte address, 32-byte scalars, a parity bit that is 0 or 1 —
 * while their presence, their names and every other field beside them are
 * compared exactly. Error `message` strings are human text on both sides and
 * are checked only for being present and non-empty; the `code` beside them is
 * what a client branches on and is compared exactly.
 *
 * Regenerate with `make -C sim conformance`. A failure here means the mock and
 * the firmware have diverged; read the case name, then decide which of the two
 * is wrong before touching either.
 */

import { readFileSync } from "node:fs";

import { decodeCbor, type CborValue } from "../src/cbor.ts";
import { encodeFrame, FrameDecoder, type FrameType } from "../src/framing.ts";
import { MockDevice } from "../src/mock-device.ts";

interface Vector {
  name: string;
  setup: {
    wallet: boolean;
    unlocked: boolean;
    session: boolean;
    blindSigning: boolean;
    approve: boolean;
  };
  frameType: number;
  request: string;
  replyType: number;
  reply: string;
}

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL("./conformance-vectors.json", import.meta.url), "utf8"),
);

let failures = 0;
const fail = (m: string) => { console.log(`  FAIL: ${m}`); failures++; };

const bytes = (hex: string) =>
  new Uint8Array((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));

/* ------------------------------------------------------------- comparison */

/**
 * Fields the mock cannot reproduce, and what it must still get right.
 *
 * Each returns an explanation of the mismatch, or null when the pair is
 * acceptable. Nothing is exempt from EXISTING — a field listed here that the
 * mock omits still fails, because the exemption is about the value only.
 */
type Excuse = (firmware: CborValue, mock: CborValue) => string | null;

const isBytes32 = (v: CborValue) => v instanceof Uint8Array && v.length === 32;
const isAddress = (v: CborValue) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

const UNCOMPARABLE: Record<string, Excuse> = {
  /* No BIP32 in the mock. The address must still be a real one in shape: host
   * code slices and checksums these, and a placeholder of the wrong length
   * would pass every mock test and break on the first device. */
  address: (f, m) =>
    isAddress(f) && isAddress(m) ? null : `not both 20-byte hex addresses (${f} / ${m})`,
  /* No secp256k1 either. Length is the part that matters: a client reassembles
   * r‖s‖v by offset, so a short scalar is a corrupt signature, not a small one. */
  r: (f, m) => (isBytes32(f) && isBytes32(m) ? null : "r is not 32 bytes on both sides"),
  s: (f, m) => (isBytes32(f) && isBytes32(m) ? null : "s is not 32 bytes on both sides"),
  /* Follows from the signature, so it cannot match — but it must be the
   * EIP-1559 parity bit and never the legacy 27/28, which is the divergence
   * that makes a signature recover to an address nobody owns. */
  yParity: (f, m) =>
    (f === 0 || f === 1) && (m === 0 || m === 1)
      ? null
      : `yParity is not a 0/1 parity bit (${f} / ${m})`,
  /* Build identity. A mock claiming to be LeekWallet-S3 0.1.0 would be worse
   * than one that says it is a mock. */
  model: (f, m) =>
    typeof f === "string" && f.length > 0 && typeof m === "string" && m.length > 0
      ? null
      : "model is not a non-empty string on both sides",
  firmware: (f, m) =>
    typeof f === "string" && f.length > 0 && typeof m === "string" && m.length > 0
      ? null
      : "firmware is not a non-empty string on both sides",
  /* Human text for a log or a toast. The code beside it is the contract. */
  message: (f, m) =>
    typeof f === "string" && f.length > 0 && typeof m === "string" && m.length > 0
      ? null
      : "error message is not a non-empty string on both sides",
};

const isMap = (v: CborValue): v is Record<string, CborValue> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

const show = (v: CborValue): string =>
  v instanceof Uint8Array ? `bytes(${v.length})` : JSON.stringify(v) ?? String(v);

/** Every way the two replies differ, at every depth. */
function differences(firmware: CborValue, mock: CborValue, at = ""): string[] {
  const here = at || "reply";

  if (isMap(firmware) && isMap(mock)) {
    const out: string[] = [];
    const fw = Object.keys(firmware).sort();
    const mk = Object.keys(mock).sort();
    /* The keys are the shape of the reply and are compared before anything
     * else: an invented field is how the mock taught app code to read
     * `initialized` and `fingerprint`, neither of which the device sends. */
    for (const k of fw) if (!mk.includes(k)) out.push(`${here}: the mock omits "${k}"`);
    for (const k of mk) if (!fw.includes(k)) out.push(`${here}: the mock invents "${k}"`);
    for (const k of fw) {
      if (!mk.includes(k)) continue;
      const excuse = UNCOMPARABLE[k];
      if (excuse) {
        const why = excuse(firmware[k]!, mock[k]!);
        if (why) out.push(`${here}.${k}: ${why}`);
        continue;
      }
      out.push(...differences(firmware[k]!, mock[k]!, `${here}.${k}`));
    }
    return out;
  }

  if (firmware instanceof Uint8Array || mock instanceof Uint8Array) {
    const same =
      firmware instanceof Uint8Array && mock instanceof Uint8Array &&
      firmware.length === mock.length &&
      firmware.every((b, i) => b === mock[i]);
    return same ? [] : [`${here}: ${show(firmware)} vs ${show(mock)}`];
  }

  if (Array.isArray(firmware) && Array.isArray(mock)) {
    if (firmware.length !== mock.length) {
      return [`${here}: ${firmware.length} items vs ${mock.length}`];
    }
    return firmware.flatMap((v, i) => differences(v, mock[i]!, `${here}[${i}]`));
  }

  return firmware === mock ? [] : [`${here}: ${show(firmware)} vs ${show(mock)}`];
}

/* ------------------------------------------------------------- the replay */

/** One frame in, one frame out. Rejects rather than hanging if none comes. */
function exchange(dev: MockDevice, frame: Uint8Array): Promise<{ type: number; body: CborValue }> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    let answered = false;
    dev.onFrame((out) => {
      const f = decoder.push(out)[0];
      if (!f || answered) return;
      answered = true;
      resolve({ type: f.type, body: decodeCbor(f.payload) });
    });
    dev.send(frame).then(() => {
      /* Silence is the failure mode BLE was caught in and it has to be loud
       * here too: an unanswered request desynchronises a session forever. */
      if (!answered) reject(new Error("the mock did not answer at all"));
    }, reject);
  });
}

/** A mock configured the way the firmware was for this vector. */
async function deviceFor(v: Vector): Promise<MockDevice> {
  const dev = new MockDevice({
    latencyMs: 0,
    startUnlocked: v.setup.unlocked,
    autoApprove: v.setup.approve,
    autoConfirmSession: true,
    blindSigning: v.setup.blindSigning,
    /* The C fixture preloads exactly one seed. walletCount is compared
     * exactly in getStatus, so this is a real assertion, not scaffolding. */
    walletCount: 1,
    /* The device types its own PIN in the C fixture before the request goes
     * out; nothing here should unlock behind the test's back mid-case. */
    autoPin: false,
  });
  await dev.open();
  if (v.setup.session) {
    await exchange(dev, encodeFrame(0x01 as FrameType, encodeHello()));
  }
  return dev;
}

/* `hello` is the one exchange that cannot be replayed from the corpus: the
 * firmware answers with an X25519 public key and the mock has no key agreement
 * at all, so their replies differ by design and comparing them would say
 * nothing. What the corpus needs from it is only its side effect — a session
 * the following request can travel inside. */
const encodeHello = (): Uint8Array =>
  // { "method": "hello" }, hand-encoded to keep this file's only CBOR writer
  // out of the comparison path.
  new Uint8Array([0xa1, 0x66, 0x6d, 0x65, 0x74, 0x68, 0x6f, 0x64, 0x65,
                  0x68, 0x65, 0x6c, 0x6c, 0x6f]);

const FRAME_NAMES: Record<number, string> = {
  0x01: "REQUEST", 0x02: "RESPONSE", 0x11: "ENC_REQUEST",
  0x12: "ENC_RESPONSE", 0x7e: "ENC_ERROR", 0x7f: "ERROR",
};
const frameName = (t: number) => FRAME_NAMES[t] ?? `0x${t.toString(16)}`;

async function main(): Promise<void> {
  console.log(`== ${vectors.length} conformance vectors, firmware vs mock`);

  for (const v of vectors) {
    const dev = await deviceFor(v);

    let reply: { type: number; body: CborValue };
    try {
      reply = await exchange(dev, encodeFrame(v.frameType as FrameType, bytes(v.request)));
    } catch (e) {
      fail(`${v.name}: ${(e as Error).message}`);
      continue;
    }

    /* The frame TYPE first. An error carried in a plaintext frame inside a
     * session is not a cosmetic difference: the device advances its receive
     * counter on decrypt, so a client that swallows a plaintext error there
     * runs one behind for the rest of the connection. */
    if (reply.type !== v.replyType) {
      fail(`${v.name}: firmware answered ${frameName(v.replyType)}, ` +
           `mock answered ${frameName(reply.type)}`);
      continue;
    }

    const firmware = decodeCbor(bytes(v.reply));
    for (const d of differences(firmware, reply.body)) fail(`${v.name}: ${d}`);
  }

  console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
  if (failures) process.exit(1);
}

await main();
