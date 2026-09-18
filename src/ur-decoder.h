/**
 * Assembling a message from animated-QR parts.
 *
 * ---------------------------------------------------------------------------
 * What arrives
 *
 *   ur:<type>/<seq_num>-<seq_len>/<bytewords>
 *
 * and the bytewords carry CBOR:
 *
 *   [ seq_num, seq_len, message_len, checksum, fragment_bytes ]
 *
 * Parts 1..seq_len are the plain fragments. Later parts are the XOR of a
 * subset that both ends derive rather than transmit (see ur-fountain.h). The
 * decoder reduces each arrival against what it already holds, promotes anything
 * that collapses to a single fragment, and finishes when every fragment is
 * known and the CRC-32 of the whole message matches the one the sender put in
 * every part.
 *
 * ---------------------------------------------------------------------------
 * Memory
 *
 * The caller owns all of it, because the sizes come off the wire and this runs
 * on a device with 512 KB of SRAM. `fragments` needs seq_len * fragment_len
 * bytes and `mixed` needs UR_DECODER_MIXED * fragment_len. Anything that does
 * not fit is refused at the first part rather than part-way through, so a
 * sender cannot walk the decoder into a corner.
 *
 * ---------------------------------------------------------------------------
 * Hostility
 *
 * Every field here is attacker-chosen. The decoder therefore pins seq_len,
 * message_len, fragment_len and checksum from the first part it accepts and
 * rejects any later part that disagrees, so a second sender cannot steer an
 * in-progress assembly. It also refuses to grow: a part longer than the
 * fragment length already agreed is dropped.
 */

#ifndef LEEK_UR_DECODER_H
#define LEEK_UR_DECODER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ur-fountain.h"
#include "ur.h"

/** Mixed parts held back waiting to be reducible. */
#ifndef UR_DECODER_MIXED
#define UR_DECODER_MIXED 8
#endif

typedef enum {
    UR_PART_ACCEPTED,   /* took it, still waiting for more */
    UR_PART_COMPLETE,   /* message is assembled and its checksum matched */
    UR_PART_REDUNDANT,  /* valid, but carried nothing new */
    UR_PART_REJECTED,   /* malformed, inconsistent, or too big */
} UrPartResult;

typedef struct {
    bool     started;
    char     type[UR_TYPE_MAX + 1];

    uint32_t seq_len;
    uint32_t message_len;
    uint32_t checksum;
    uint32_t fragment_len;

    uint8_t  received[UR_PART_MASK_BYTES];
    uint8_t *fragments;
    size_t   fragments_cap;

    uint32_t mixed_count;
    uint8_t  mixed_mask[UR_DECODER_MIXED][UR_PART_MASK_BYTES];
    uint8_t *mixed;
    size_t   mixed_cap;

    UrFountainScratch scratch;
} UrDecoder;

/** Point a decoder at its working memory and clear it. */
void ur_decoder_init(UrDecoder *d,
                     uint8_t *fragments, size_t fragments_cap,
                     uint8_t *mixed, size_t mixed_cap);

/** Forget everything, keeping the same buffers. Call between messages. */
void ur_decoder_reset(UrDecoder *d);

/**
 * Feed one scanned UR string, single-part or multi-part.
 *
 * On UR_PART_COMPLETE the message is in the first `message_len` bytes of the
 * fragment buffer, and `ur_decoder_message()` returns it.
 */
UrPartResult ur_decoder_receive(UrDecoder *d, const char *ur, size_t ur_len);

/** True once every fragment is known. */
bool ur_decoder_complete(const UrDecoder *d);

/** The assembled message, or NULL until complete. */
const uint8_t *ur_decoder_message(const UrDecoder *d, size_t *len);

/** Fragments still missing, for a progress indicator. */
uint32_t ur_decoder_remaining(const UrDecoder *d);

#endif /* LEEK_UR_DECODER_H */
