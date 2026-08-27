/**
 * BLE chunking and reassembly. See ble-chunk.h for the layout and why this is
 * the only layer BLE adds.
 *
 * Free of ESP-IDF and of NimBLE on purpose: this is the code that reads
 * attacker-chosen bytes, so it has to be runnable under the host suite and a
 * sanitiser (sim/test_ble_chunk.c, `make -C sim asan`).
 */

#include "ble-chunk.h"

#include <string.h>

void ble_chunk_reset(BleReassembler *r)
{
    r->len = 0;
    r->next_seq = 0;
    r->complete = false;
}

/* Total wire size a frame header declares: len:u16 covers type + payload, and
 * the two length bytes themselves are on top. Mirrors encodeFrame(). */
static size_t declared_total(const BleReassembler *r)
{
    return (((size_t)r->buf[0] << 8) | r->buf[1]) + 2;
}

BleChunkResult ble_chunk_push(BleReassembler *r, const uint8_t *chunk, size_t len)
{
    if (r->complete) {
        /* The previous frame has been handed over; this chunk starts a new one. */
        ble_chunk_reset(r);
    }

    if (len < 1) {
        /* A write with no header byte tells us nothing, not even a sequence
         * number, so there is no state to keep. */
        ble_chunk_reset(r);
        return BLE_CHUNK_ERROR;
    }

    uint8_t header = chunk[0];
    uint8_t seq    = header & BLE_CHUNK_SEQ_MASK;
    bool    more   = (header & BLE_CHUNK_MORE) != 0;
    size_t  body   = len - 1;

    if (seq != r->next_seq) {
        /* Out of order, or a replayed chunk. Reassembling around a gap would
         * produce a frame neither side sent. */
        ble_chunk_reset(r);
        return BLE_CHUNK_ERROR;
    }

    if (body == 0) {
        /* chunkForBle never emits a payload-free chunk; something that does is
         * either broken or probing for an infinite stream of headers. */
        ble_chunk_reset(r);
        return BLE_CHUNK_ERROR;
    }

    if (r->len + body > sizeof(r->buf)) {
        ble_chunk_reset(r);
        return BLE_CHUNK_ERROR;
    }

    memcpy(r->buf + r->len, chunk + 1, body);
    r->len += body;

    /* Check the declared length as soon as it is readable, so an absurd frame
     * costs one chunk rather than a buffer's worth of writes. */
    if (r->len >= 2) {
        size_t total = declared_total(r);
        if (total < 4 || total > sizeof(r->buf) || r->len > total) {
            ble_chunk_reset(r);
            return BLE_CHUNK_ERROR;
        }
        if (!more && r->len != total) {
            /* The last chunk has to land exactly on the declared end. Trailing
             * bytes would be a second, unannounced frame. */
            ble_chunk_reset(r);
            return BLE_CHUNK_ERROR;
        }
    }

    r->next_seq = (uint8_t)((r->next_seq + 1) & BLE_CHUNK_SEQ_MASK);

    if (more) {
        return BLE_CHUNK_NEED_MORE;
    }

    if (r->len < 4) {                 /* len:u16 + type + at least one byte */
        ble_chunk_reset(r);
        return BLE_CHUNK_ERROR;
    }

    r->complete = true;
    return BLE_CHUNK_FRAME_READY;
}

bool ble_chunk_split(const uint8_t *frame, size_t len, uint16_t mtu,
                     BleChunkEmit emit, void *ctx)
{
    /* MTU-3 is the ATT payload; one more byte goes to our chunk header. The
     * arithmetic is copied from chunkForBle so the two cannot drift. */
    if (mtu < 5) {
        return false;               /* nothing would fit; caller must not send */
    }
    size_t capacity = (size_t)mtu - 3 - 1;

    /* Static for the same reason as the receive buffer in ble.c: it doubled
     * with the frame limit, and the notify path is driven by one task at a
     * time. The host suites drive this function single-threaded too. */
    static uint8_t out[BLE_CHUNK_MAX_FRAME + 1];
    if (capacity > sizeof(out) - 1) {
        capacity = sizeof(out) - 1;
    }

    uint8_t seq = 0;
    for (size_t offset = 0; offset < len; offset += capacity, seq++) {
        size_t take = len - offset;
        if (take > capacity) {
            take = capacity;
        }
        bool more = (offset + capacity) < len;

        out[0] = (uint8_t)((more ? BLE_CHUNK_MORE : 0) | (seq & BLE_CHUNK_SEQ_MASK));
        memcpy(out + 1, frame + offset, take);

        if (!emit(ctx, out, take + 1)) {
            return false;
        }
    }
    return true;
}
