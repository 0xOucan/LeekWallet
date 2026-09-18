/* Animated-QR part production. See ur-encoder.h. */

#include "ur-encoder.h"

#include <stdio.h>
#include <string.h>

#include "cbor.h"

/* Same shape of check ur.c makes; repeated rather than exported because the
   encoder has to refuse a type before borrowing anything. */
static bool type_ok(const char *type)
{
    const size_t n = strlen(type);
    if (n == 0 || n > UR_TYPE_MAX) {
        return false;
    }
    for (size_t i = 0; i < n; i++) {
        const char c = type[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) {
            return false;
        }
    }
    return true;
}

bool ur_encoder_init(UrEncoder *e, const char *type,
                     const uint8_t *message, size_t message_len,
                     size_t max_fragment_len)
{
    if (e == NULL || type == NULL || message == NULL || message_len == 0 ||
        message_len > 0xFFFFFFFFu || !type_ok(type)) {
        return false;
    }
    if (max_fragment_len < UR_MIN_FRAGMENT_LEN) {
        max_fragment_len = UR_MIN_FRAGMENT_LEN;
    }
    if (max_fragment_len > UR_MAX_FRAGMENT_LEN) {
        max_fragment_len = UR_MAX_FRAGMENT_LEN;
    }

    /* bc-ur's findNominalFragmentLength: the fewest fragments that respect
       the maximum, then share the message evenly between them. Matching it is
       what makes these parts byte-identical to the reference's. */
    const size_t count = (message_len + max_fragment_len - 1) / max_fragment_len;
    if (count > UR_MAX_PARTS) {
        return false;
    }
    const size_t frag = (message_len + count - 1) / count;

    memset(e, 0, sizeof *e);
    memcpy(e->type, type, strlen(type) + 1);
    e->message = message;
    e->message_len = (uint32_t)message_len;
    e->checksum = ur_crc32(message, message_len);
    e->fragment_len = (uint32_t)frag;
    e->seq_len = (uint32_t)count;
    e->seq_num = 0;
    return true;
}

bool ur_encoder_is_single_part(const UrEncoder *e)
{
    return e->seq_len == 1;
}

size_t ur_encoder_part_max(const UrEncoder *e)
{
    if (ur_encoder_is_single_part(e)) {
        return 4 + strlen(e->type) + UR_BYTEWORDS_LEN(e->message_len) + 1;
    }
    /* CBOR envelope: array head, four uints of at most five bytes, and a
       byte-string head of at most three. */
    const size_t cbor = 1 + 4 * 5 + 3 + e->fragment_len;
    /* "ur:" type "/" "<10 digits>-<10 digits>" "/" body NUL */
    return 3 + strlen(e->type) + 1 + 21 + 1 + UR_BYTEWORDS_LEN(cbor) + 1;
}

/* Byte `i` of fragment `index`, reading past the message as zero - the
   padding bc-ur applies to the last fragment. */
static uint8_t frag_byte(const UrEncoder *e, uint32_t index, uint32_t i)
{
    const size_t at = (size_t)index * e->fragment_len + i;
    return at < e->message_len ? e->message[at] : 0;
}

size_t ur_encoder_part(UrEncoder *e, uint32_t seq_num, char *out, size_t out_size)
{
    if (e == NULL || out == NULL || out_size == 0) {
        return 0;
    }
    if (ur_encoder_is_single_part(e)) {
        return ur_encode(e->type, e->message, e->message_len, out, out_size);
    }
    if (seq_num == 0) {
        return 0;
    }

    uint8_t mask[UR_PART_MASK_BYTES];
    if (!ur_fountain_fragments(seq_num, e->seq_len, e->checksum, mask,
                               &e->scratch)) {
        return 0;
    }

    uint8_t fragment[UR_MAX_FRAGMENT_LEN];
    memset(fragment, 0, e->fragment_len);
    for (uint32_t f = 0; f < e->seq_len; f++) {
        if (mask[f / 8] & (1u << (f % 8))) {
            for (uint32_t i = 0; i < e->fragment_len; i++) {
                fragment[i] ^= frag_byte(e, f, i);
            }
        }
    }

    uint8_t cbor[1 + 4 * 5 + 3 + UR_MAX_FRAGMENT_LEN];
    CborWriter w;
    cbor_writer_init(&w, cbor, sizeof cbor);
    cbor_write_array(&w, 5);
    cbor_write_uint(&w, seq_num);
    cbor_write_uint(&w, e->seq_len);
    cbor_write_uint(&w, e->message_len);
    cbor_write_uint(&w, e->checksum);
    cbor_write_bytes(&w, fragment, e->fragment_len);
    if (!cbor_writer_ok(&w)) {
        return 0;
    }

    const int head = snprintf(out, out_size, "ur:%s/%u-%u/", e->type,
                              (unsigned)seq_num, (unsigned)e->seq_len);
    if (head < 0 || (size_t)head >= out_size) {
        return 0;
    }
    const size_t body = ur_bytewords_encode(cbor, w.length, out + head,
                                            out_size - (size_t)head);
    if (body == 0) {
        return 0;
    }
    return (size_t)head + body;
}

size_t ur_encoder_next_part(UrEncoder *e, char *out, size_t out_size)
{
    if (e == NULL) {
        return 0;
    }
    const size_t n = ur_encoder_part(e, e->seq_num + 1, out, out_size);
    if (n != 0) {
        e->seq_num++;
    }
    return n;
}

void ur_to_upper(char *ur)
{
    for (; ur != NULL && *ur; ur++) {
        if (*ur >= 'a' && *ur <= 'z') {
            *ur = (char)(*ur - 'a' + 'A');
        }
    }
}
