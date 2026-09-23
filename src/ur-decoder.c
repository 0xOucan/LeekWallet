/* Fountain assembly of animated-QR parts. See ur-decoder.h. */

#include "ur-decoder.h"

#include <string.h>

#include "cbor.h"

/* Largest single part we will decode from bytewords before looking at it.
   A QR frame cannot hold more than this, and it bounds the stack. */
#define UR_PART_MAX 1024

static bool mask_get(const uint8_t *m, uint32_t i)
{
    return (m[i / 8] & (1u << (i % 8))) != 0;
}

static void mask_clear(uint8_t *m, uint32_t i)
{
    m[i / 8] &= (uint8_t)~(1u << (i % 8));
}

static void mask_set(uint8_t *m, uint32_t i)
{
    m[i / 8] |= (uint8_t)(1u << (i % 8));
}

void ur_decoder_init(UrDecoder *d,
                     uint8_t *fragments, size_t fragments_cap,
                     uint8_t *mixed, size_t mixed_cap)
{
    memset(d, 0, sizeof *d);
    d->fragments = fragments;
    d->fragments_cap = fragments_cap;
    d->mixed = mixed;
    d->mixed_cap = mixed_cap;
}

void ur_decoder_reset(UrDecoder *d)
{
    uint8_t *f = d->fragments;
    size_t fc = d->fragments_cap;
    uint8_t *m = d->mixed;
    size_t mc = d->mixed_cap;
    ur_decoder_init(d, f, fc, m, mc);
}

bool ur_decoder_complete(const UrDecoder *d)
{
    if (!d->started) {
        return false;
    }
    return ur_mask_count(d->received, d->seq_len) == d->seq_len;
}

uint32_t ur_decoder_remaining(const UrDecoder *d)
{
    if (!d->started) {
        return 0;
    }
    return d->seq_len - ur_mask_count(d->received, d->seq_len);
}

const uint8_t *ur_decoder_message(const UrDecoder *d, size_t *len)
{
    if (!ur_decoder_complete(d)) {
        return NULL;
    }
    if (len != NULL) {
        *len = d->message_len;
    }
    return d->fragments;
}

/* "<seq_num>-<seq_len>" with no leading zeros, no sign, nothing else. */
static bool parse_seq(const char *s, size_t len,
                      uint32_t *seq_num, uint32_t *seq_len)
{
    uint32_t v = 0;
    size_t i = 0;
    bool any = false;

    for (; i < len && s[i] != '-'; i++) {
        if (s[i] < '0' || s[i] > '9' || v > 100000) {
            return false;
        }
        v = v * 10 + (uint32_t)(s[i] - '0');
        any = true;
    }
    if (!any || i == len) {
        return false;
    }
    *seq_num = v;

    v = 0;
    any = false;
    for (i++; i < len; i++) {
        if (s[i] < '0' || s[i] > '9' || v > 100000) {
            return false;
        }
        v = v * 10 + (uint32_t)(s[i] - '0');
        any = true;
    }
    if (!any) {
        return false;
    }
    *seq_len = v;
    return true;
}

/* [seq_num, seq_len, message_len, checksum, bytes] */
static bool parse_part(const uint8_t *cbor, size_t len,
                       uint32_t *seq_num, uint32_t *seq_len,
                       uint32_t *message_len, uint32_t *checksum,
                       const uint8_t **data, uint32_t *data_len)
{
    CborReader r;
    CborItem it;

    cbor_reader_init(&r, cbor, len);
    if (!cbor_read(&r, &it) || it.type != CBOR_ARRAY || it.value != 5) {
        return false;
    }

    uint32_t *fields[4] = { seq_num, seq_len, message_len, checksum };
    for (int i = 0; i < 4; i++) {
        if (!cbor_read(&r, &it) || it.type != CBOR_UINT) {
            return false;
        }
        *fields[i] = it.value;
    }

    if (!cbor_read(&r, &it) || it.type != CBOR_BYTES) {
        return false;
    }
    *data = it.data;
    *data_len = it.value;

    /* Trailing bytes mean this is not the part it claims to be. */
    return cbor_reader_done(&r);
}

/* XOR `src` into `dst`. */
static void xor_into(uint8_t *dst, const uint8_t *src, uint32_t len)
{
    for (uint32_t i = 0; i < len; i++) {
        dst[i] ^= src[i];
    }
}

/* Reduce a part by every simple fragment it names and we already hold. */
static void reduce(const UrDecoder *d, uint8_t *mask, uint8_t *data)
{
    for (uint32_t i = 0; i < d->seq_len; i++) {
        if (mask_get(mask, i) && mask_get(d->received, i)) {
            xor_into(data, d->fragments + (size_t)i * d->fragment_len,
                     d->fragment_len);
            mask_clear(mask, i);
        }
    }
}

/* Store a known fragment, then see whether anything queued now collapses.
   Loops because promoting one fragment can free another, and that one a
   third. */
static void absorb(UrDecoder *d, uint32_t index, const uint8_t *data)
{
    memcpy(d->fragments + (size_t)index * d->fragment_len, data,
           d->fragment_len);
    mask_set(d->received, index);

    bool progressed = true;
    while (progressed) {
        progressed = false;

        for (uint32_t m = 0; m < d->mixed_count; m++) {
            uint8_t *mm = d->mixed_mask[m];
            uint8_t *md = d->mixed + (size_t)m * d->fragment_len;

            reduce(d, mm, md);
            const uint32_t degree = ur_mask_count(mm, d->seq_len);

            if (degree == 1) {
                uint32_t idx = 0;
                while (!mask_get(mm, idx)) {
                    idx++;
                }
                memcpy(d->fragments + (size_t)idx * d->fragment_len, md,
                       d->fragment_len);
                mask_set(d->received, idx);
                progressed = true;
            }
            if (degree <= 1) {
                /* Consumed or empty: drop it by moving the last one down. */
                d->mixed_count--;
                if (m != d->mixed_count) {
                    memcpy(d->mixed_mask[m], d->mixed_mask[d->mixed_count],
                           UR_PART_MASK_BYTES);
                    memcpy(d->mixed + (size_t)m * d->fragment_len,
                           d->mixed + (size_t)d->mixed_count * d->fragment_len,
                           d->fragment_len);
                }
                m--;
            }
        }
    }
}

UrPartResult ur_decoder_receive(UrDecoder *d, const char *ur, size_t ur_len)
{
    if (d == NULL || ur == NULL || d->fragments == NULL) {
        return UR_PART_REJECTED;
    }
    if (ur_decoder_complete(d)) {
        return UR_PART_REDUNDANT;
    }

    /* Locate the two '/' of a multi-part UR, or the one of a single-part. */
    size_t first = 0, second = 0, slashes = 0;
    for (size_t i = 0; i < ur_len; i++) {
        if (ur[i] == '/') {
            if (slashes == 0) {
                first = i;
            } else if (slashes == 1) {
                second = i;
            } else {
                return UR_PART_REJECTED;
            }
            slashes++;
        }
    }
    if (slashes == 0 || ur_len < 4) {
        return UR_PART_REJECTED;
    }
    if (ur[0] != 'u' && ur[0] != 'U') {
        return UR_PART_REJECTED;
    }

    uint8_t raw[UR_PART_MAX];
    size_t raw_len = 0;
    uint32_t seq_num, seq_len, message_len, checksum, data_len;
    const uint8_t *data;
    char type[UR_TYPE_MAX + 1];

    if (slashes == 1) {
        /* Single part: the whole message, no CBOR envelope. */
        if (!ur_decode(ur, ur_len, type, sizeof type, raw, sizeof raw,
                       &raw_len)) {
            return UR_PART_REJECTED;
        }
        seq_num = 1;
        seq_len = 1;
        message_len = (uint32_t)raw_len;
        checksum = ur_crc32(raw, raw_len);
        data = raw;
        data_len = (uint32_t)raw_len;
    } else {
        const size_t type_len = first - 3;
        if (type_len == 0 || type_len > UR_TYPE_MAX) {
            return UR_PART_REJECTED;
        }
        for (size_t i = 0; i < type_len; i++) {
            const char c = ur[3 + i];
            type[i] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
        }
        type[type_len] = '\0';

        uint32_t hdr_num, hdr_len;
        if (!parse_seq(ur + first + 1, second - first - 1, &hdr_num,
                       &hdr_len)) {
            return UR_PART_REJECTED;
        }
        if (!ur_bytewords_decode(ur + second + 1, ur_len - second - 1,
                                 raw, sizeof raw, &raw_len)) {
            return UR_PART_REJECTED;
        }
        if (!parse_part(raw, raw_len, &seq_num, &seq_len, &message_len,
                        &checksum, &data, &data_len)) {
            return UR_PART_REJECTED;
        }
        /* The header outside the CBOR and the values inside it must agree;
           if they do not, one of them is lying and we cannot tell which. */
        if (hdr_num != seq_num || hdr_len != seq_len) {
            return UR_PART_REJECTED;
        }
    }

    if (seq_num == 0 || seq_len == 0 || seq_len > UR_MAX_PARTS ||
        data_len == 0 || message_len == 0) {
        return UR_PART_REJECTED;
    }
    /* The fragment length is implied, and the sender does not get to make the
       last fragment a different size from the rest. */
    if ((uint64_t)seq_len * data_len < message_len ||
        (uint64_t)(seq_len - 1) * data_len >= message_len) {
        return UR_PART_REJECTED;
    }

    if (!d->started) {
        if ((size_t)seq_len * data_len > d->fragments_cap) {
            return UR_PART_REJECTED;
        }
        if ((size_t)UR_DECODER_MIXED * data_len > d->mixed_cap) {
            return UR_PART_REJECTED;
        }
        d->started = true;
        d->seq_len = seq_len;
        d->message_len = message_len;
        d->checksum = checksum;
        d->fragment_len = data_len;
        memcpy(d->type, type, sizeof type);
    } else {
        /* Pinned at the first part, so a second sender cannot take over one
           that is already in progress. */
        if (seq_len != d->seq_len || message_len != d->message_len ||
            checksum != d->checksum || data_len != d->fragment_len ||
            strcmp(type, d->type) != 0) {
            return UR_PART_REJECTED;
        }
    }

    uint8_t mask[UR_PART_MASK_BYTES];
    if (!ur_fountain_fragments(seq_num, d->seq_len, d->checksum, mask,
                               &d->scratch)) {
        return UR_PART_REJECTED;
    }

    uint8_t work[UR_PART_MAX];
    memcpy(work, data, d->fragment_len);
    reduce(d, mask, work);

    const uint32_t degree = ur_mask_count(mask, d->seq_len);
    if (degree == 0) {
        return UR_PART_REDUNDANT;
    }

    if (degree == 1) {
        uint32_t idx = 0;
        while (!mask_get(mask, idx)) {
            idx++;
        }
        if (mask_get(d->received, idx)) {
            return UR_PART_REDUNDANT;
        }
        absorb(d, idx, work);
    } else {
        if (d->mixed_count >= UR_DECODER_MIXED) {
            /* Full. Dropping is safe: the sender keeps emitting parts and a
               later one will reduce further. Better than evicting a part that
               might have been the useful one. */
            return UR_PART_REDUNDANT;
        }
        memcpy(d->mixed_mask[d->mixed_count], mask, UR_PART_MASK_BYTES);
        memcpy(d->mixed + (size_t)d->mixed_count * d->fragment_len, work,
               d->fragment_len);
        d->mixed_count++;
    }

    if (!ur_decoder_complete(d)) {
        return UR_PART_ACCEPTED;
    }

    /* Everything the sender said must now be true of what we assembled. The
       checksum is over the message, not the padded fragments. */
    if (ur_crc32(d->fragments, d->message_len) != d->checksum) {
        ur_decoder_reset(d);
        return UR_PART_REJECTED;
    }
    return UR_PART_COMPLETE;
}
