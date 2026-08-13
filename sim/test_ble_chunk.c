/**
 * BLE chunking and reassembly (ROADMAP T25).
 *
 * This layer parses bytes an unpaired stranger chose, before any session key
 * exists, so it is where a hostile peer meets the firmware first. The tests are
 * written at the byte level and against the *published* constants rather than
 * the ones ble-chunk.c uses, for the same reason test_protocol.c is: a test
 * that imports the header bit it is checking cannot notice it changing.
 *
 * The reference for the chunk format is app/packages/core/src/framing.ts. Where
 * a case is under-specified there, the device is the stricter side.
 */

#include <stdio.h>
#include <string.h>

#include "ble-chunk.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Spelled out rather than included: see the file comment. */
#define MORE 0x80

/* ------------------------------------------------------------- helpers */

static BleReassembler r;

/* Build a frame: len:u16 (covering type + payload) ‖ type ‖ payload. */
static size_t make_frame(uint8_t *out, uint8_t type, size_t payload_len)
{
    size_t body = payload_len + 1;
    out[0] = (uint8_t)(body >> 8);
    out[1] = (uint8_t)body;
    out[2] = type;
    for (size_t i = 0; i < payload_len; i++) {
        out[3 + i] = (uint8_t)(i & 0xff);
    }
    return body + 2;
}

/* Collector for ble_chunk_split. */
#define MAX_CHUNKS 64
static struct {
    uint8_t data[MAX_CHUNKS][BLE_CHUNK_MAX_FRAME + 1];
    size_t  len[MAX_CHUNKS];
    int     count;
    int     fail_at;      /* emit returns false at this index; -1 never */
} sink;

static void sink_reset(void)
{
    memset(&sink, 0, sizeof(sink));
    sink.fail_at = -1;
}

static bool sink_emit(void *ctx, const uint8_t *chunk, size_t len)
{
    (void)ctx;
    if (sink.count == sink.fail_at) {
        return false;
    }
    if (sink.count >= MAX_CHUNKS) {
        return false;
    }
    memcpy(sink.data[sink.count], chunk, len);
    sink.len[sink.count] = len;
    sink.count++;
    return true;
}

/* ------------------------------------------------------------- the tests */

/* The exact expectation of chunkForBle at the two MTUs the host suite pins:
 * capacity = mtu - 3 - 1, so 19 bytes at MTU 23 and 240 at MTU 244. A device
 * that chunks larger than the negotiated MTU produces notifications the stack
 * truncates silently, which reaches the host as a corrupt frame rather than a
 * short one. */
static void test_split_matches_chunk_for_ble(void)
{
    printf("== split matches chunkForBle at MTU 23 and 244\n");

    uint8_t frame[512];
    size_t  len = make_frame(frame, 0x01, 100);   /* 103 bytes on the wire */

    sink_reset();
    CHECK(ble_chunk_split(frame, len, 23, sink_emit, NULL), "split at MTU 23 failed");
    CHECK(sink.count == 6, "expected ceil(103/19)=6 chunks, got %d", sink.count);
    for (int i = 0; i < sink.count; i++) {
        bool last = (i == sink.count - 1);
        CHECK((sink.data[i][0] & 0x7f) == i, "chunk %d has sequence %d", i,
              sink.data[i][0] & 0x7f);
        CHECK(((sink.data[i][0] & MORE) != 0) == !last,
              "chunk %d has the wrong more-follows bit", i);
        size_t body = sink.len[i] - 1;
        CHECK(body == (last ? (size_t)(103 - 5 * 19) : 19u),
              "chunk %d carries %zu payload bytes", i, body);
    }

    /* Reassembling exactly what we produced must return the original bytes —
     * the property the whole layer exists for. */
    ble_chunk_reset(&r);
    BleChunkResult res = BLE_CHUNK_NEED_MORE;
    for (int i = 0; i < sink.count; i++) {
        res = ble_chunk_push(&r, sink.data[i], sink.len[i]);
    }
    CHECK(res == BLE_CHUNK_FRAME_READY, "round trip did not complete a frame");
    CHECK(r.len == len && memcmp(r.buf, frame, len) == 0,
          "round trip changed the frame");

    sink_reset();
    CHECK(ble_chunk_split(frame, len, 244, sink_emit, NULL), "split at MTU 244 failed");
    CHECK(sink.count == 1, "103 bytes fit one 240-byte chunk, got %d", sink.count);
    CHECK((sink.data[0][0] & MORE) == 0, "a single chunk claimed more follows");
}

/* An MTU that leaves no room for payload must be refused rather than looping
 * forever emitting header-only chunks. */
static void test_split_refuses_useless_mtu(void)
{
    printf("== split refuses an MTU with no payload room\n");

    uint8_t frame[16];
    size_t  len = make_frame(frame, 0x01, 4);

    sink_reset();
    CHECK(!ble_chunk_split(frame, len, 4, sink_emit, NULL), "MTU 4 was accepted");
    CHECK(sink.count == 0, "chunks were emitted for an unusable MTU");
}

/* A notify that fails stops the split. Continuing would leave the peer with a
 * frame missing its middle and a reassembler pointed at the wrong sequence. */
static void test_split_stops_on_emit_failure(void)
{
    printf("== split aborts when a notification fails\n");

    uint8_t frame[512];
    size_t  len = make_frame(frame, 0x01, 100);

    sink_reset();
    sink.fail_at = 2;
    CHECK(!ble_chunk_split(frame, len, 23, sink_emit, NULL),
          "a failed emit was reported as success");
    CHECK(sink.count == 2, "kept emitting after a failure (%d chunks)", sink.count);
}

/* The case that matters most on real hardware: a peer that dribbles. Every
 * chunk carrying one payload byte is legal, just slow. */
static void test_frame_one_byte_at_a_time(void)
{
    printf("== a frame arriving one byte per chunk\n");

    uint8_t frame[64];
    size_t  len = make_frame(frame, 0x02, 20);   /* 23 bytes */

    ble_chunk_reset(&r);
    BleChunkResult res = BLE_CHUNK_NEED_MORE;
    for (size_t i = 0; i < len; i++) {
        uint8_t chunk[2] = {
            (uint8_t)(((i + 1 < len) ? MORE : 0) | (i & 0x7f)),
            frame[i],
        };
        res = ble_chunk_push(&r, chunk, 2);
        if (i + 1 < len) {
            CHECK(res == BLE_CHUNK_NEED_MORE, "byte %zu did not want more", i);
        }
    }
    CHECK(res == BLE_CHUNK_FRAME_READY, "dribbled frame never completed");
    CHECK(r.len == len && memcmp(r.buf, frame, len) == 0,
          "dribbled frame reassembled wrong");
}

/* Sequence numbers wrap at 128, so a frame longer than 128 chunks is only
 * reassemblable if both sides wrap the same way. At one byte per chunk a
 * 200-byte frame crosses the wrap twice. */
static void test_sequence_wraps_at_128(void)
{
    printf("== sequence numbers wrap at 128\n");

    uint8_t frame[256];
    size_t  len = make_frame(frame, 0x11, 200);

    ble_chunk_reset(&r);
    BleChunkResult res = BLE_CHUNK_NEED_MORE;
    for (size_t i = 0; i < len; i++) {
        uint8_t chunk[2] = {
            (uint8_t)(((i + 1 < len) ? MORE : 0) | (i & 0x7f)),
            frame[i],
        };
        res = ble_chunk_push(&r, chunk, 2);
    }
    CHECK(res == BLE_CHUNK_FRAME_READY, "a frame spanning a wrap never completed");
    CHECK(r.len == len && memcmp(r.buf, frame, len) == 0, "wrap corrupted the frame");
}

static void test_out_of_order_is_refused(void)
{
    printf("== out-of-order and replayed chunks are refused\n");

    uint8_t frame[512];
    size_t  len = make_frame(frame, 0x01, 60);
    sink_reset();
    ble_chunk_split(frame, len, 23, sink_emit, NULL);
    CHECK(sink.count >= 3, "need at least three chunks for this test");

    /* Skipping one. Appending around a gap would build a frame neither side
     * sent, and it would still parse. */
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, sink.data[0], sink.len[0]) == BLE_CHUNK_NEED_MORE,
          "first chunk rejected");
    CHECK(ble_chunk_push(&r, sink.data[2], sink.len[2]) == BLE_CHUNK_ERROR,
          "a skipped sequence was accepted");

    /* And the error must have reset: the next chunk 0 starts cleanly. */
    CHECK(ble_chunk_push(&r, sink.data[0], sink.len[0]) == BLE_CHUNK_NEED_MORE,
          "the reassembler did not resynchronise after an error");

    /* Replaying the chunk just accepted is equally wrong. */
    ble_chunk_reset(&r);
    ble_chunk_push(&r, sink.data[0], sink.len[0]);
    CHECK(ble_chunk_push(&r, sink.data[0], sink.len[0]) == BLE_CHUNK_ERROR,
          "a replayed chunk 0 was accepted");
}

static void test_oversized_length_is_refused(void)
{
    printf("== an oversized declared length is refused before buffering\n");

    /* 0xFFFF bytes claimed in the first chunk. Nothing may be reserved for it:
     * a signing device does not let the peer pick an allocation. */
    uint8_t chunk[8] = { MORE, 0xff, 0xff, 0x01, 0x02 };
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, chunk, 5) == BLE_CHUNK_ERROR,
          "a 65535-byte frame was accepted");
    CHECK(r.len == 0, "an oversized frame left %zu bytes buffered", r.len);

    /* Just past the buffer is refused too, not only absurd values. */
    size_t too_big = BLE_CHUNK_MAX_FRAME - 1;   /* +2 length bytes = over */
    uint8_t chunk2[8] = { MORE, (uint8_t)(too_big >> 8), (uint8_t)too_big, 0x01, 0x02 };
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, chunk2, 5) == BLE_CHUNK_ERROR,
          "a frame one byte over the buffer was accepted");

    /* A single write larger than the whole reassembly buffer, before the
     * declared length has ever been sane. This is the one that reaches the
     * memcpy first, so it needs its own bound rather than relying on the
     * length check to have run. */
    static uint8_t flood[BLE_CHUNK_MAX_FRAME + 64];
    memset(flood, 0xa5, sizeof(flood));
    flood[0] = MORE;
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, flood, sizeof(flood)) == BLE_CHUNK_ERROR,
          "a write larger than the reassembly buffer was accepted");
    CHECK(r.len == 0, "an over-long write left %zu bytes buffered", r.len);

    /* The largest frame that does fit is still accepted — the bound must be a
     * bound, not an off-by-one that costs a legal frame. */
    uint8_t big[BLE_CHUNK_MAX_FRAME];
    size_t big_len = make_frame(big, 0x01, BLE_CHUNK_MAX_FRAME - 3);
    CHECK(big_len == BLE_CHUNK_MAX_FRAME, "test built the wrong size");
    sink_reset();
    CHECK(ble_chunk_split(big, big_len, 244, sink_emit, NULL), "split of a full frame failed");
    ble_chunk_reset(&r);
    BleChunkResult res = BLE_CHUNK_NEED_MORE;
    for (int i = 0; i < sink.count; i++) {
        res = ble_chunk_push(&r, sink.data[i], sink.len[i]);
    }
    CHECK(res == BLE_CHUNK_FRAME_READY, "the largest legal frame was refused");
}

static void test_trailing_and_short_bodies(void)
{
    printf("== trailing bytes and truncated frames are refused\n");

    /* A final chunk that overshoots the declared length is a second frame
     * nobody announced. */
    uint8_t chunk[16] = { 0x00, 0x00, 0x04, 0x01, 0xaa, 0xbb, 0xcc, 0xdd };
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, chunk, 8) == BLE_CHUNK_ERROR,
          "trailing bytes past the declared length were accepted");

    /* A last chunk that stops short of it is a truncated frame, not a short
     * one to be parsed anyway. */
    uint8_t chunk2[8] = { 0x00, 0x00, 0x08, 0x01, 0xaa };
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, chunk2, 5) == BLE_CHUNK_ERROR,
          "a truncated final chunk was accepted");

    /* A frame too short to hold len+type+one byte. */
    uint8_t chunk3[8] = { 0x00, 0x00, 0x01, 0x01 };
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, chunk3, 4) == BLE_CHUNK_ERROR,
          "a body-less frame was accepted");

    /* Zero declared length. */
    uint8_t chunk4[8] = { 0x00, 0x00, 0x00, 0x00, 0x00 };
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, chunk4, 5) == BLE_CHUNK_ERROR,
          "a zero-length frame was accepted");
}

static void test_degenerate_writes(void)
{
    printf("== empty and header-only writes are refused\n");

    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, (const uint8_t *)"", 0) == BLE_CHUNK_ERROR,
          "a zero-length write was accepted");

    /* Header with no payload: legal-looking, and an endless stream of them
     * would advance sequence numbers forever while carrying nothing. */
    uint8_t header_only[1] = { MORE };
    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, header_only, 1) == BLE_CHUNK_ERROR,
          "a payload-free chunk was accepted");

    /* And that refusal must not leave a partial frame behind for the next
     * peer's chunk 0 to be appended to. */
    CHECK(r.len == 0, "a rejected chunk left state behind");
}

/* A completed frame stays readable until the next push, and the next push
 * starts a new frame rather than appending to the one just handed over. */
static void test_completion_starts_a_new_frame(void)
{
    printf("== a new chunk 0 after a completed frame starts over\n");

    uint8_t frame[32];
    size_t  len = make_frame(frame, 0x01, 8);
    uint8_t chunk[64];
    chunk[0] = 0x00;
    memcpy(chunk + 1, frame, len);

    ble_chunk_reset(&r);
    CHECK(ble_chunk_push(&r, chunk, len + 1) == BLE_CHUNK_FRAME_READY, "frame 1 failed");
    CHECK(r.len == len, "frame 1 wrong length");
    CHECK(ble_chunk_push(&r, chunk, len + 1) == BLE_CHUNK_FRAME_READY, "frame 2 failed");
    CHECK(r.len == len, "frame 2 appended to frame 1 (%zu bytes)", r.len);
}

int main(void)
{
    printf("BLE chunk layer tests\n\n");

    test_split_matches_chunk_for_ble();
    test_split_refuses_useless_mtu();
    test_split_stops_on_emit_failure();
    test_frame_one_byte_at_a_time();
    test_sequence_wraps_at_128();
    test_out_of_order_is_refused();
    test_oversized_length_is_refused();
    test_trailing_and_short_bodies();
    test_degenerate_writes();
    test_completion_starts_a_new_frame();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
