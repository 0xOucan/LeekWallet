/**
 * Tests for the wire framing. Run: npm test
 *
 * The cases that matter are the ones a real transport produces: split frames,
 * coalesced frames, and hostile length fields.
 */

import {
  encodeFrame, FrameDecoder, FrameType, MAX_FRAME_BYTES,
  chunkForBle, ChunkReassembler,
} from "../src/framing.ts";

let failures = 0;

function check(cond: boolean, msg: string): void {
  if (!cond) {
    console.log(`  FAIL: ${msg}`);
    failures++;
  }
}

function group(name: string): void {
  console.log(`== ${name}`);
}

function bytes(...v: number[]): Uint8Array {
  return new Uint8Array(v);
}

group("round-trip");
{
  const payload = bytes(1, 2, 3, 4, 5);
  const frame = encodeFrame(FrameType.Request, payload);

  check(frame.length === payload.length + 3, `frame length ${frame.length}`);
  check((((frame[0] ?? 0) << 8) | (frame[1] ?? 0)) === payload.length + 1,
        "length field wrong");
  check(frame[2] === FrameType.Request, "type byte wrong");

  const decoded = new FrameDecoder().push(frame);
  check(decoded.length === 1, `expected 1 frame, got ${decoded.length}`);
  const first = decoded[0];
  check(first?.type === FrameType.Request, "decoded type wrong");
  check(
    first !== undefined && [...first.payload].join() === [...payload].join(),
    "payload did not survive the round trip",
  );
}

group("a frame split across reads");
{
  const frame = encodeFrame(FrameType.EncryptedRequest, new Uint8Array(64).fill(0xab));
  const decoder = new FrameDecoder();

  // Deliver one byte at a time: the worst case a serial port can produce.
  let emitted = 0;
  for (const b of frame) {
    emitted += decoder.push(bytes(b)).length;
  }
  check(emitted === 1, `expected 1 frame from byte-wise delivery, got ${emitted}`);
  check(decoder.pending === 0, `decoder retained ${decoder.pending} bytes`);
}

group("two frames in one read");
{
  const a = encodeFrame(FrameType.Request, bytes(0xaa));
  const b = encodeFrame(FrameType.Response, bytes(0xbb, 0xcc));
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);

  const frames = new FrameDecoder().push(joined);
  check(frames.length === 2, `expected 2 frames, got ${frames.length}`);
  check(frames[0]?.payload[0] === 0xaa, "first frame payload wrong");
  check(frames[1]?.payload[1] === 0xcc, "second frame payload wrong");
}

group("hostile length fields are rejected before allocating");
{
  const decoder = new FrameDecoder();
  let threw = false;
  try {
    decoder.push(bytes(0xff, 0xff, 0x01)); // claims 65535 bytes
  } catch {
    threw = true;
  }
  check(threw, "oversized length was accepted");

  threw = false;
  try {
    new FrameDecoder().push(bytes(0x00, 0x00, 0x01)); // length 0
  } catch {
    threw = true;
  }
  check(threw, "zero length was accepted");

  threw = false;
  try {
    encodeFrame(FrameType.Request, new Uint8Array(MAX_FRAME_BYTES));
  } catch {
    threw = true;
  }
  check(threw, "encoder allowed an oversized frame");
}

group("BLE chunking round-trip");
{
  const frame = encodeFrame(FrameType.EncryptedRequest, new Uint8Array(500).fill(0x5a));
  const mtu = 23; // the pessimistic default before negotiation
  const chunks = chunkForBle(frame, mtu);

  check(chunks.length > 1, "a 500-byte frame should need multiple chunks at MTU 23");
  for (const c of chunks) {
    check(c.length <= mtu - 3, `chunk of ${c.length} exceeds MTU-3`);
  }

  const reassembler = new ChunkReassembler();
  let result: Uint8Array | null = null;
  for (const c of chunks) result = reassembler.push(c);

  check(result !== null, "reassembly never completed");
  check(
    result !== null && [...result].join() === [...frame].join(),
    "reassembled frame differs from the original",
  );
}

group("out-of-order chunks are rejected");
{
  const frame = encodeFrame(FrameType.Request, new Uint8Array(200).fill(7));
  const chunks = chunkForBle(frame, 64);
  const reassembler = new ChunkReassembler();

  const [firstChunk, , thirdChunk] = chunks;
  check(
    firstChunk !== undefined && thirdChunk !== undefined,
    "test needs at least three chunks",
  );

  let threw = false;
  if (firstChunk && thirdChunk) {
    reassembler.push(firstChunk);
    try {
      reassembler.push(thirdChunk); // skip one
    } catch {
      threw = true;
    }
  }
  check(threw, "a dropped chunk went unnoticed");
}

group("a large frame at a negotiated MTU");
{
  const frame = encodeFrame(FrameType.EncryptedResponse, new Uint8Array(2048).fill(0x11));
  const chunks = chunkForBle(frame, 244);
  const reassembler = new ChunkReassembler();
  let result: Uint8Array | null = null;
  for (const c of chunks) result = reassembler.push(c);
  check(
    result !== null && result.length === frame.length,
    "2 KB frame did not survive chunking at MTU 244",
  );
}

console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
process.exit(failures ? 1 : 0);
