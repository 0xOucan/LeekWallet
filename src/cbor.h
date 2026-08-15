/**
 * Minimal CBOR (RFC 8949) for the LeekWallet protocol — device side.
 *
 * Mirrors app/packages/core/src/cbor.ts exactly: same subset, same canonical
 * form, same refusals. The two are verified against the same known-answer
 * vectors, because a protocol implemented twice is a protocol that will drift
 * unless something checks.
 *
 * Subset: unsigned and negative integers, byte strings, text strings, arrays,
 * maps with text keys. Tags, floats, indefinite lengths and 64-bit arguments
 * are rejected. A signing device's parser is attack surface; this grammar is
 * small enough to read in one sitting.
 *
 * No allocation. The writer fills a caller-supplied buffer and the reader
 * borrows from the input, so a hostile length cannot make the device allocate.
 */

#ifndef LEEK_CBOR_H
#define LEEK_CBOR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ---------------------------------------------------------------- writer */

typedef struct {
    uint8_t *buf;
    size_t   capacity;
    size_t   length;
    bool     overflow;   /* sticky: set once, checked at the end */
} CborWriter;

void cbor_writer_init(CborWriter *w, uint8_t *buf, size_t capacity);

/** True if everything written so far fit. Check once, before transmitting. */
bool cbor_writer_ok(const CborWriter *w);

void cbor_write_uint(CborWriter *w, uint32_t value);
void cbor_write_int(CborWriter *w, int32_t value);
void cbor_write_bytes(CborWriter *w, const uint8_t *data, size_t len);
void cbor_write_text(CborWriter *w, const char *text);
void cbor_write_array(CborWriter *w, size_t count);   /* then `count` items */
void cbor_write_map(CborWriter *w, size_t pairs);     /* then key,value pairs */

/* ---------------------------------------------------------------- reader */

typedef enum {
    CBOR_UINT,
    CBOR_NEGINT,
    CBOR_BYTES,
    CBOR_TEXT,
    CBOR_ARRAY,
    CBOR_MAP,
} CborType;

typedef struct {
    CborType type;
    uint32_t value;         /* UINT: the value. BYTES/TEXT: length.
                             * ARRAY/MAP: element or pair count.
                             * NEGINT: n, where the value is -1 - n. */
    const uint8_t *data;    /* BYTES/TEXT only; borrowed from the input */
} CborItem;

typedef struct {
    const uint8_t *buf;
    size_t         length;
    size_t         pos;
    int            depth;
} CborReader;

void cbor_reader_init(CborReader *r, const uint8_t *buf, size_t len);

/** Read the next item. False on malformed input or anything outside the subset. */
bool cbor_read(CborReader *r, CborItem *out);

/** True once every byte has been consumed. Trailing bytes are a protocol error. */
bool cbor_reader_done(const CborReader *r);

/**
 * Walk a top-level map looking for `key`, leaving the reader positioned on its
 * value. Returns false if absent or if the input is not a map.
 *
 * Linear, which is fine: our maps have a handful of keys and a hash table would
 * be more code to audit for no gain.
 */
bool cbor_map_find(const uint8_t *buf, size_t len, const char *key, CborItem *out);

/**
 * Skip one complete item at the reader's position, children included.
 *
 * Exposed for parsers that have to walk a nested document rather than pluck a
 * key out of a flat one — EIP-712 typed data is the whole reason it exists, and
 * it arrives as a map of maps of arrays of maps. Bounded by the same depth
 * limit as every other traversal here, so a document nested past MAX_DEPTH is
 * refused rather than recursed.
 */
bool cbor_skip(CborReader *r);

/** Copy a TEXT item into a NUL-terminated buffer. False if it does not fit. */
bool cbor_text_copy(const CborItem *item, char *out, size_t out_size);

#endif /* LEEK_CBOR_H */
