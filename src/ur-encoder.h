/**
 * Producing animated-QR parts: the sending half of ur-decoder.h.
 *
 * ---------------------------------------------------------------------------
 * What goes out
 *
 *   ur:<type>/<seq_num>-<seq_len>/<bytewords>
 *
 * with the bytewords carrying CBOR `[seq_num, seq_len, message_len, checksum,
 * fragment]`. Parts 1..seq_len are the plain fragments in order; after that
 * every part is the XOR of the subset ur-fountain.c derives from its sequence
 * number and the checksum, so a receiver that missed a frame does not have to
 * wait a whole cycle for it to come round again. The checksum is the CRC-32 of
 * the whole message and the last fragment is zero-padded, as bc-ur does, so
 * the parts are byte-identical to the reference encoder's.
 *
 * A message that fits one fragment is emitted as a plain single-part UR, which
 * is what bc-ur's `UREncoder` does and what every reader expects to see for a
 * static QR.
 *
 * ---------------------------------------------------------------------------
 * Memory
 *
 * The encoder borrows the message rather than copying it; the caller keeps it
 * alive and unchanged for as long as parts are being produced. The only
 * working space is the fountain scratch, about 2 KB, which is why the struct
 * belongs in static storage rather than on a task stack.
 */

#ifndef LEEK_UR_ENCODER_H
#define LEEK_UR_ENCODER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ur-fountain.h"
#include "ur.h"

/** bc-ur's floor, so the fragment count is never driven up by tiny frames. */
#define UR_MIN_FRAGMENT_LEN 10

/** Largest fragment this encoder builds a part around. Matches the decoder's
 *  own per-part ceiling, so anything emitted here can also be read here. */
#define UR_MAX_FRAGMENT_LEN 512

typedef struct {
    char            type[UR_TYPE_MAX + 1];
    const uint8_t  *message;
    uint32_t        message_len;
    uint32_t        checksum;
    uint32_t        fragment_len;
    uint32_t        seq_len;
    uint32_t        seq_num;        /* last part produced; 0 before the first */
    UrFountainScratch scratch;
} UrEncoder;

/**
 * Prepare to send `message` as parts of at most `max_fragment_len` bytes.
 *
 * The fragment length is bc-ur's "nominal" one: the fewest fragments that fit
 * the maximum, then the smallest equal length that covers the message in that
 * many. Returns false for an invalid type, an empty message, or a message that
 * would need more than UR_MAX_PARTS fragments.
 */
bool ur_encoder_init(UrEncoder *e, const char *type,
                     const uint8_t *message, size_t message_len,
                     size_t max_fragment_len);

/** True when the whole message fits one part and so goes out as `ur:t/body`. */
bool ur_encoder_is_single_part(const UrEncoder *e);

/**
 * Write the part with sequence number `seq_num` (1-based) into `out`.
 *
 * Returns characters written excluding the NUL, or 0 if `out` is too small or
 * `seq_num` is 0. A single-part message ignores `seq_num`.
 */
size_t ur_encoder_part(UrEncoder *e, uint32_t seq_num, char *out, size_t out_size);

/** The part after the last one produced. Never runs out: fountain parts go on. */
size_t ur_encoder_next_part(UrEncoder *e, char *out, size_t out_size);

/**
 * Uppercase a UR in place for a QR code's alphanumeric mode.
 *
 * Every character in a UR - letters, digits, ':', '/', '-' - is in the QR
 * alphanumeric set once uppercased, which costs 5.5 bits a character instead
 * of 8. Readers accept either case (ur.c and ur-decoder.c both do).
 */
void ur_to_upper(char *ur);

/**
 * Worst-case characters for one part of a message of this size, including
 * the NUL. For sizing a buffer before a single part has been built.
 */
size_t ur_encoder_part_max(const UrEncoder *e);

#endif /* LEEK_UR_ENCODER_H */
