/* EIP-4527 schema reader. See eip4527.h for why this is not cbor.c. */

#include "eip4527.h"

#include <string.h>

const char *e4527_error_name(E4527Result r)
{
    switch (r) {
        case E4527_OK:                    return "E4527_OK";
        case E4527_ERR_WRONG_TAG:         return "E4527_ERR_WRONG_TAG";
        case E4527_ERR_BAD_LENGTH:        return "E4527_ERR_BAD_LENGTH";
        case E4527_ERR_DUPLICATE_FIELD:   return "E4527_ERR_DUPLICATE_FIELD";
        case E4527_ERR_UNKNOWN_FIELD:     return "E4527_ERR_UNKNOWN_FIELD";
        case E4527_ERR_MISSING_FIELD:     return "E4527_ERR_MISSING_FIELD";
        case E4527_ERR_INVALID_DATA_TYPE: return "E4527_ERR_INVALID_DATA_TYPE";
        case E4527_ERR_TRAILING_DATA:     return "E4527_ERR_TRAILING_DATA";
        case E4527_ERR_MALFORMED:         return "E4527_ERR_MALFORMED";
    }
    return "E4527_ERR_MALFORMED";
}

/* ------------------------------------------------------------------ reader */

typedef struct {
    const uint8_t *buf;
    size_t         len;
    size_t         pos;
    const char    *field;
} Reader;

/* Every failure goes through here so the field is recorded once. */
static E4527Result fail(Reader *r, E4527Result code)
{
    (void)r;
    return code;
}

#define TRY(expr) do { const E4527Result _e = (expr); if (_e != E4527_OK) return _e; } while (0)

static bool have(const Reader *r, size_t n)
{
    /* Never `r->pos + n`: that can wrap and turn a bounds check into a
       permission slip. Subtraction cannot, because pos <= len is an
       invariant of every path that advances it. */
    return n <= r->len - r->pos;
}

static E4527Result read_byte(Reader *r, uint8_t *out)
{
    if (!have(r, 1)) {
        return fail(r, E4527_ERR_MALFORMED);
    }
    *out = r->buf[r->pos++];
    return E4527_OK;
}

/*
 * Major type and argument, definite lengths only.
 *
 * Refused here rather than anywhere else: indefinite lengths, the reserved
 * additional information values, major type 7 as a whole (floats, null and
 * every other simple value), and 64-bit arguments. Nothing in these schemas is
 * larger than 32 bits, and truncating an argument we cannot represent would be
 * worse than refusing it.
 */
static E4527Result read_head(Reader *r, uint8_t *mt, uint64_t *arg)
{
    uint8_t ib;
    TRY(read_byte(r, &ib));

    const uint8_t major = (uint8_t)(ib >> 5);
    const uint8_t ai = (uint8_t)(ib & 0x1F);

    if (major == 7) {
        return fail(r, E4527_ERR_MALFORMED);
    }
    if (ai >= 28) {   /* 28-30 reserved, 31 indefinite */
        return fail(r, E4527_ERR_MALFORMED);
    }

    uint64_t value = ai;
    if (ai >= 24) {
        const uint8_t n = (uint8_t)(1u << (ai - 24));
        if (n > 4) {
            return fail(r, E4527_ERR_MALFORMED);
        }
        value = 0;
        for (uint8_t i = 0; i < n; i++) {
            uint8_t b;
            TRY(read_byte(r, &b));
            value = (value << 8) | b;
        }
    }

    *mt = major;
    *arg = value;
    return E4527_OK;
}

static E4527Result expect_major(Reader *r, uint8_t want, uint64_t *arg)
{
    uint8_t mt;
    TRY(read_head(r, &mt, arg));
    if (mt != want) {
        return fail(r, E4527_ERR_MALFORMED);
    }
    return E4527_OK;
}

/** Require exactly this tag. There is no variant that accepts any tag. */
static E4527Result expect_tag(Reader *r, uint64_t want)
{
    uint64_t got;
    uint8_t mt;
    TRY(read_head(r, &mt, &got));
    if (mt != 6) {
        return fail(r, E4527_ERR_MALFORMED);
    }
    if (got != want) {
        return fail(r, E4527_ERR_WRONG_TAG);
    }
    return E4527_OK;
}

/** Refuse if the next item carries a tag at all. */
static E4527Result expect_untagged(Reader *r)
{
    if (have(r, 1) && (r->buf[r->pos] >> 5) == 6) {
        return fail(r, E4527_ERR_WRONG_TAG);
    }
    return E4527_OK;
}

static E4527Result expect_uint(Reader *r, uint64_t *out)
{
    return expect_major(r, 0, out);
}

/**
 * A byte string into a fixed buffer.
 *
 * `cap` is the buffer's size, from the schema. `exact` is a required length or
 * zero for "any, up to cap". The declared length is compared against both
 * before a single byte is copied, so nothing is ever sized from the wire.
 */
static E4527Result expect_bytes(Reader *r, uint8_t *dst, size_t cap,
                                size_t exact, size_t *out_len)
{
    uint64_t len;
    TRY(expect_major(r, 2, &len));

    if (exact != 0 && len != exact) {
        return fail(r, E4527_ERR_BAD_LENGTH);
    }
    if (len > cap) {
        return fail(r, E4527_ERR_BAD_LENGTH);
    }
    if (!have(r, (size_t)len)) {
        return fail(r, E4527_ERR_MALFORMED);
    }

    memcpy(dst, r->buf + r->pos, (size_t)len);
    r->pos += (size_t)len;
    if (out_len != NULL) {
        *out_len = (size_t)len;
    }
    return E4527_OK;
}

static E4527Result expect_text(Reader *r, char *dst, size_t cap)
{
    uint64_t len;
    TRY(expect_major(r, 3, &len));

    if (len > cap) {
        return fail(r, E4527_ERR_BAD_LENGTH);
    }
    if (!have(r, (size_t)len)) {
        return fail(r, E4527_ERR_MALFORMED);
    }
    memcpy(dst, r->buf + r->pos, (size_t)len);
    dst[len] = '\0';
    r->pos += (size_t)len;
    return E4527_OK;
}

/*
 * Exactly `false` or `true`.
 *
 * Booleans live in major type 7, which read_head() refuses outright — that is
 * where floats and null are. crypto-keypath needs booleans for the hardened
 * flag, so the two encodings are named here rather than the major type being
 * opened up. 0xF4 and 0xF5, and nothing else.
 */
static E4527Result expect_bool(Reader *r, bool *out)
{
    uint8_t b;
    TRY(read_byte(r, &b));
    if (b == 0xF4) { *out = false; return E4527_OK; }
    if (b == 0xF5) { *out = true;  return E4527_OK; }
    return fail(r, E4527_ERR_MALFORMED);
}

static bool peek_is_empty_array(const Reader *r)
{
    return have(r, 1) && r->buf[r->pos] == 0x80;
}

/* -------------------------------------------------------------- keypath */

/* Depth is the call graph: this is the innermost level and calls nothing. */
static E4527Result read_path_components(Reader *r, E4527Keypath *kp,
                                        const char **field)
{
    *field = "derivation-path.components";

    uint64_t n;
    TRY(expect_major(r, 4, &n));
    if ((n % 2) != 0) {
        return fail(r, E4527_ERR_MALFORMED);
    }
    if (n / 2 > E4527_MAX_PATH_COMPONENTS) {
        return fail(r, E4527_ERR_BAD_LENGTH);
    }

    kp->count = 0;
    for (uint64_t i = 0; i < n; i += 2) {
        E4527PathComponent c = {0};
        if (peek_is_empty_array(r)) {
            uint64_t zero;
            TRY(expect_major(r, 4, &zero));
            c.wildcard = true;
        } else {
            uint64_t idx;
            TRY(expect_uint(r, &idx));
            if (idx > 0xFFFFFFFFu) {
                return fail(r, E4527_ERR_BAD_LENGTH);
            }
            c.index = (uint32_t)idx;
        }
        TRY(expect_bool(r, &c.hardened));
        kp->components[kp->count++] = c;
    }
    return E4527_OK;
}

/* Positioned past the 304 tag. Calls read_path_components and nothing else. */
static E4527Result read_keypath_body(Reader *r, E4527Keypath *kp,
                                     const char **field)
{
    uint64_t pairs;
    TRY(expect_major(r, 5, &pairs));

    bool seen[4] = {false, false, false, false};

    for (uint64_t i = 0; i < pairs; i++) {
        uint64_t key;
        TRY(expect_uint(r, &key));
        if (key < 1 || key > 3) {
            *field = "derivation-path";
            return fail(r, E4527_ERR_UNKNOWN_FIELD);
        }
        if (seen[key]) {
            *field = "derivation-path";
            return fail(r, E4527_ERR_DUPLICATE_FIELD);
        }
        seen[key] = true;

        switch (key) {
            case 1:
                TRY(read_path_components(r, kp, field));
                break;
            case 2: {
                *field = "derivation-path.source-fingerprint";
                uint64_t v;
                TRY(expect_uint(r, &v));
                kp->source_fingerprint = (uint32_t)v;
                kp->has_source_fingerprint = true;
                break;
            }
            case 3: {
                *field = "derivation-path.depth";
                uint64_t v;
                TRY(expect_uint(r, &v));
                kp->depth = (uint32_t)v;
                kp->has_depth = true;
                break;
            }
            default:
                return fail(r, E4527_ERR_UNKNOWN_FIELD);
        }
    }
    return E4527_OK;
}

/* --------------------------------------------------------- sign request */

E4527Result eip4527_decode_sign_request(const uint8_t *cbor, size_t len,
                                        E4527SignRequest *out,
                                        const char **field_out)
{
    const char *field = "eth-sign-request";
    E4527SignRequest tmp;
    memset(&tmp, 0, sizeof tmp);

    Reader r = { cbor, len, 0, field };

    E4527Result rc = expect_untagged(&r);
    if (rc != E4527_OK) { goto done; }

    uint64_t pairs;
    rc = expect_major(&r, 5, &pairs);
    if (rc != E4527_OK) { goto done; }

    bool seen[8];
    memset(seen, 0, sizeof seen);

    for (uint64_t i = 0; i < pairs; i++) {
        uint64_t key;
        /* The key is read at the schema's level, not inside a field, so the
           field name is reset first. It used to be left at whatever the
           previous pair set, which made a duplicate or unknown key report the
           name of the field before it - found by the differential corpus,
           because TypeScript reported the schema and C reported a neighbour. */
        field = "eth-sign-request";
        rc = expect_uint(&r, &key);
        if (rc != E4527_OK) { goto done; }

        if (key < 1 || key > 7) {
            rc = E4527_ERR_UNKNOWN_FIELD;
            goto done;
        }
        if (seen[key]) {
            rc = E4527_ERR_DUPLICATE_FIELD;
            goto done;
        }
        seen[key] = true;

        switch (key) {
            case 1:
                field = "request-id";
                rc = expect_tag(&r, E4527_TAG_UUID);
                if (rc != E4527_OK) { goto done; }
                rc = expect_bytes(&r, tmp.request_id, sizeof tmp.request_id,
                                  16, NULL);
                tmp.has_request_id = true;
                break;
            case 2: {
                field = "sign-data";
                size_t n = 0;
                rc = expect_bytes(&r, tmp.sign_data, sizeof tmp.sign_data,
                                  0, &n);
                tmp.sign_data_len = (uint16_t)n;
                break;
            }
            case 3: {
                field = "data-type";
                uint64_t v;
                rc = expect_uint(&r, &v);
                if (rc != E4527_OK) { goto done; }
                if (v < 1 || v > 4) {
                    rc = E4527_ERR_INVALID_DATA_TYPE;
                    goto done;
                }
                tmp.data_type = (uint8_t)v;
                break;
            }
            case 4:
                field = "chain-id";
                rc = expect_uint(&r, &tmp.chain_id);
                break;
            case 5:
                field = "derivation-path";
                rc = expect_tag(&r, E4527_TAG_CRYPTO_KEYPATH);
                if (rc != E4527_OK) { goto done; }
                rc = read_keypath_body(&r, &tmp.derivation_path, &field);
                break;
            case 6:
                field = "address";
                rc = expect_bytes(&r, tmp.address, sizeof tmp.address, 20, NULL);
                tmp.has_address = true;
                break;
            case 7:
                field = "origin";
                rc = expect_text(&r, tmp.origin, E4527_MAX_ORIGIN);
                tmp.has_origin = true;
                break;
            default:
                rc = E4527_ERR_UNKNOWN_FIELD;
                break;
        }
        if (rc != E4527_OK) { goto done; }
    }

    if (r.pos != r.len) {
        field = "eth-sign-request";
        rc = E4527_ERR_TRAILING_DATA;
        goto done;
    }

    if (!seen[2]) { field = "sign-data";       rc = E4527_ERR_MISSING_FIELD; goto done; }
    if (!seen[3]) { field = "data-type";       rc = E4527_ERR_MISSING_FIELD; goto done; }
    if (!seen[5]) { field = "derivation-path"; rc = E4527_ERR_MISSING_FIELD; goto done; }

    /* The ERC defaults chain-id to 1 when absent. Written rather than implied,
       because defaulting a chain has consequences. */
    if (!seen[4]) {
        tmp.chain_id = 1;
    }

    *out = tmp;
    rc = E4527_OK;

done:
    if (field_out != NULL) {
        *field_out = field;
    }
    return rc;
}

/* ----------------------------------------------------------- signature */

E4527Result eip4527_decode_signature(const uint8_t *cbor, size_t len,
                                     E4527Signature *out,
                                     const char **field_out)
{
    const char *field = "eth-signature";
    E4527Signature tmp;
    memset(&tmp, 0, sizeof tmp);

    Reader r = { cbor, len, 0, field };

    E4527Result rc = expect_untagged(&r);
    if (rc != E4527_OK) { goto done; }

    uint64_t pairs;
    rc = expect_major(&r, 5, &pairs);
    if (rc != E4527_OK) { goto done; }

    bool seen[4];
    memset(seen, 0, sizeof seen);

    for (uint64_t i = 0; i < pairs; i++) {
        uint64_t key;
        field = "eth-signature";
        rc = expect_uint(&r, &key);
        if (rc != E4527_OK) { goto done; }

        if (key < 1 || key > 3) { rc = E4527_ERR_UNKNOWN_FIELD; goto done; }
        if (seen[key])          { rc = E4527_ERR_DUPLICATE_FIELD; goto done; }
        seen[key] = true;

        switch (key) {
            case 1:
                field = "request-id";
                rc = expect_tag(&r, E4527_TAG_UUID);
                if (rc != E4527_OK) { goto done; }
                rc = expect_bytes(&r, tmp.request_id, sizeof tmp.request_id,
                                  16, NULL);
                break;
            case 2:
                /* 65 bytes, fixed by the ERC, so the reader is inflexible
                   rather than merely checking that it is a byte string. */
                field = "signature";
                rc = expect_bytes(&r, tmp.signature, sizeof tmp.signature,
                                  65, NULL);
                break;
            case 3:
                field = "origin";
                rc = expect_text(&r, tmp.origin, E4527_MAX_ORIGIN);
                tmp.has_origin = true;
                break;
            default:
                rc = E4527_ERR_UNKNOWN_FIELD;
                break;
        }
        if (rc != E4527_OK) { goto done; }
    }

    if (r.pos != r.len) {
        field = "eth-signature";
        rc = E4527_ERR_TRAILING_DATA;
        goto done;
    }
    if (!seen[1]) { field = "request-id"; rc = E4527_ERR_MISSING_FIELD; goto done; }
    if (!seen[2]) { field = "signature";  rc = E4527_ERR_MISSING_FIELD; goto done; }

    *out = tmp;
    rc = E4527_OK;

done:
    if (field_out != NULL) {
        *field_out = field;
    }
    return rc;
}
