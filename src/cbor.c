/**
 * Minimal CBOR for the LeekWallet protocol - see cbor.h
 */

#include "cbor.h"

#include <string.h>

#define MAJOR_UINT   0
#define MAJOR_NEGINT 1
#define MAJOR_BYTES  2
#define MAJOR_TEXT   3
#define MAJOR_ARRAY  4
#define MAJOR_MAP    5

/* Bounded so a hostile payload cannot recurse the stack away. Matches the
 * TypeScript side. */
#define MAX_DEPTH 8

/* ---------------------------------------------------------------- writer */

void cbor_writer_init(CborWriter *w, uint8_t *buf, size_t capacity)
{
    w->buf = buf;
    w->capacity = capacity;
    w->length = 0;
    w->overflow = false;
}

bool cbor_writer_ok(const CborWriter *w)
{
    return !w->overflow;
}

static void put(CborWriter *w, uint8_t b)
{
    if (w->length >= w->capacity) {
        w->overflow = true;
        return;
    }
    w->buf[w->length++] = b;
}

/* Type byte plus argument, shortest form. Canonical encoding depends on this:
 * two encoders that disagree here produce different bytes for the same value. */
static void head(CborWriter *w, uint8_t major, uint32_t value)
{
    uint8_t m = (uint8_t)(major << 5);

    if (value < 24) {
        put(w, (uint8_t)(m | value));
    } else if (value < 0x100) {
        put(w, (uint8_t)(m | 24));
        put(w, (uint8_t)value);
    } else if (value < 0x10000) {
        put(w, (uint8_t)(m | 25));
        put(w, (uint8_t)(value >> 8));
        put(w, (uint8_t)value);
    } else {
        put(w, (uint8_t)(m | 26));
        put(w, (uint8_t)(value >> 24));
        put(w, (uint8_t)(value >> 16));
        put(w, (uint8_t)(value >> 8));
        put(w, (uint8_t)value);
    }
}

void cbor_write_uint(CborWriter *w, uint32_t value)
{
    head(w, MAJOR_UINT, value);
}

void cbor_write_int(CborWriter *w, int32_t value)
{
    if (value >= 0) {
        head(w, MAJOR_UINT, (uint32_t)value);
    } else {
        head(w, MAJOR_NEGINT, (uint32_t)(-(value + 1)));
    }
}

void cbor_write_bytes(CborWriter *w, const uint8_t *data, size_t len)
{
    head(w, MAJOR_BYTES, (uint32_t)len);
    for (size_t i = 0; i < len; i++) {
        put(w, data[i]);
    }
}

void cbor_write_text(CborWriter *w, const char *text)
{
    size_t len = strlen(text);
    head(w, MAJOR_TEXT, (uint32_t)len);
    for (size_t i = 0; i < len; i++) {
        put(w, (uint8_t)text[i]);
    }
}

void cbor_write_array(CborWriter *w, size_t count)
{
    head(w, MAJOR_ARRAY, (uint32_t)count);
}

void cbor_write_map(CborWriter *w, size_t pairs)
{
    head(w, MAJOR_MAP, (uint32_t)pairs);
}

/* ---------------------------------------------------------------- reader */

void cbor_reader_init(CborReader *r, const uint8_t *buf, size_t len)
{
    r->buf = buf;
    r->length = len;
    r->pos = 0;
    r->depth = 0;
}

bool cbor_reader_done(const CborReader *r)
{
    return r->pos == r->length;
}

static bool take_byte(CborReader *r, uint8_t *out)
{
    if (r->pos >= r->length) {
        return false;
    }
    *out = r->buf[r->pos++];
    return true;
}

/* Read the argument following a type byte. Rejects 64-bit values, indefinite
 * lengths and reserved encodings rather than interpreting them. */
static bool read_argument(CborReader *r, uint8_t info, uint32_t *out)
{
    uint8_t b;

    if (info < 24) {
        *out = info;
        return true;
    }
    if (info == 24) {
        if (!take_byte(r, &b)) return false;
        *out = b;
        return true;
    }
    if (info == 25) {
        uint8_t hi, lo;
        if (!take_byte(r, &hi) || !take_byte(r, &lo)) return false;
        *out = ((uint32_t)hi << 8) | lo;
        return true;
    }
    if (info == 26) {
        uint8_t v[4];
        for (int i = 0; i < 4; i++) {
            if (!take_byte(r, &v[i])) return false;
        }
        *out = ((uint32_t)v[0] << 24) | ((uint32_t)v[1] << 16) |
               ((uint32_t)v[2] << 8) | v[3];
        return true;
    }

    /* 27 is a 64-bit argument, 31 is indefinite length, 28-30 are reserved. */
    return false;
}

bool cbor_read(CborReader *r, CborItem *out)
{
    uint8_t initial;
    if (!take_byte(r, &initial)) {
        return false;
    }

    uint8_t major = (uint8_t)(initial >> 5);
    uint8_t info = initial & 0x1f;

    uint32_t arg;
    if (!read_argument(r, info, &arg)) {
        return false;
    }

    out->value = arg;
    out->data = NULL;

    switch (major) {
        case MAJOR_UINT:   out->type = CBOR_UINT;   return true;
        case MAJOR_NEGINT: out->type = CBOR_NEGINT; return true;

        case MAJOR_BYTES:
        case MAJOR_TEXT: {
            if (arg > r->length - r->pos) {
                return false;   /* claims more than remains */
            }
            out->type = (major == MAJOR_BYTES) ? CBOR_BYTES : CBOR_TEXT;
            out->data = r->buf + r->pos;
            r->pos += arg;
            return true;
        }

        case MAJOR_ARRAY:  out->type = CBOR_ARRAY; return true;
        case MAJOR_MAP:    out->type = CBOR_MAP;   return true;

        /* Major 6 is tags, major 7 is simple values and floats. Neither is in
         * the subset, and guessing at them is how parsers grow holes. */
        default:
            return false;
    }
}

/* Skip one complete item, including its children. */
static bool skip_item(CborReader *r, int depth)
{
    if (depth > MAX_DEPTH) {
        return false;
    }

    CborItem item;
    if (!cbor_read(r, &item)) {
        return false;
    }

    if (item.type == CBOR_ARRAY) {
        for (uint32_t i = 0; i < item.value; i++) {
            if (!skip_item(r, depth + 1)) return false;
        }
    } else if (item.type == CBOR_MAP) {
        for (uint32_t i = 0; i < item.value; i++) {
            if (!skip_item(r, depth + 1)) return false;   /* key */
            if (!skip_item(r, depth + 1)) return false;   /* value */
        }
    }

    return true;
}

bool cbor_skip(CborReader *r)
{
    /* Depth counts from here, not from wherever the caller is in the document.
     * The bound exists to cap this function's own recursion; a caller that has
     * already descended keeps its own count, and eip712.c does. */
    return skip_item(r, 0);
}

bool cbor_map_find(const uint8_t *buf, size_t len, const char *key, CborItem *out)
{
    CborReader r;
    cbor_reader_init(&r, buf, len);

    CborItem head_item;
    if (!cbor_read(&r, &head_item) || head_item.type != CBOR_MAP) {
        return false;
    }

    size_t key_len = strlen(key);

    for (uint32_t i = 0; i < head_item.value; i++) {
        CborItem k;
        if (!cbor_read(&r, &k) || k.type != CBOR_TEXT) {
            return false;   /* non-text keys are outside the subset */
        }

        bool match = (k.value == key_len) &&
                     (memcmp(k.data, key, key_len) == 0);

        if (match) {
            return cbor_read(&r, out);
        }
        if (!skip_item(&r, 1)) {
            return false;
        }
    }

    return false;
}

bool cbor_text_copy(const CborItem *item, char *out, size_t out_size)
{
    if (item->type != CBOR_TEXT || out_size == 0) {
        return false;
    }
    if (item->value + 1 > out_size) {
        return false;
    }
    memcpy(out, item->data, item->value);
    out[item->value] = '\0';
    return true;
}
