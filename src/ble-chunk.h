/**
 * BLE chunking layer — see docs/PROTOCOL.md section 2.
 *
 * GATT writes and notifications cap at MTU-3 bytes, so a frame is split with a
 * one-byte header: bit 7 means "more follows", bits 0-6 are a sequence number
 * that wraps at 128. This is the ONLY thing BLE adds. Above it the bytes are
 * the same frame the USB endpoint carries — same length prefix, same type byte,
 * same CBOR — because a transport that alters the protocol is a second
 * protocol, and then the two drift.
 *
 * The device side is deliberately a mirror of `chunkForBle` / `ChunkReassembler`
 * in app/packages/core/src/framing.ts. Where the two could differ, this side is
 * the stricter one: it parses bytes an unauthenticated peer chose.
 *
 * No dynamic allocation and no growth. The reassembly buffer is fixed and a
 * frame that claims to be larger is refused on the first two bytes, before any
 * of it is stored. A signing device must never let the peer pick a size.
 */

#ifndef LEEK_BLE_CHUNK_H
#define LEEK_BLE_CHUNK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

/* Defined FROM the protocol's limit rather than alongside it.
 *
 * These were two numbers that were supposed to be equal, with a comment saying
 * so. When PROTOCOL_MAX_FRAME went 512 -> 1024 for EIP-712 this one stayed
 * behind, and the comment kept asserting a match that had stopped being true.
 * The result was a request that signs over the cable and cannot be sent over
 * the radio at all: a Permit2 PermitSingle is 588 bytes on the wire, so BLE
 * users simply could not sign one, with no error that pointed at the cause.
 *
 * Deriving it means the next change to the protocol limit carries this one
 * with it, and there is no second number to forget. */
#define BLE_CHUNK_MAX_FRAME PROTOCOL_MAX_FRAME

#define BLE_CHUNK_MORE     0x80
#define BLE_CHUNK_SEQ_MASK 0x7f

typedef enum {
    BLE_CHUNK_NEED_MORE,   /* accepted, frame incomplete */
    BLE_CHUNK_FRAME_READY, /* buf/len hold a complete frame */
    BLE_CHUNK_ERROR,       /* rejected; state reset, resynchronise */
} BleChunkResult;

typedef struct {
    uint8_t buf[BLE_CHUNK_MAX_FRAME];
    size_t  len;
    uint8_t next_seq;
    bool    complete;      /* buf holds a frame nobody has consumed yet */
} BleReassembler;

/** Drop any partial frame. Called on connect, disconnect and on any error. */
void ble_chunk_reset(BleReassembler *r);

/**
 * Feed one GATT write. On BLE_CHUNK_FRAME_READY, `r->buf` holds `r->len` bytes
 * of complete frame; it stays valid until the next push.
 *
 * Every failure resets: a peer that desynchronises must start a frame over
 * rather than have its next chunk appended to a stranger's prefix.
 */
BleChunkResult ble_chunk_push(BleReassembler *r, const uint8_t *chunk, size_t len);

/** Emit one chunk. Returning false aborts the split (a failed notify). */
typedef bool (*BleChunkEmit)(void *ctx, const uint8_t *chunk, size_t len);

/**
 * Split a frame into MTU-sized chunks and hand each to `emit`.
 * Returns false if the MTU leaves no room for payload or an emit failed.
 */
bool ble_chunk_split(const uint8_t *frame, size_t len, uint16_t mtu,
                     BleChunkEmit emit, void *ctx);

#endif /* LEEK_BLE_CHUNK_H */
