/**
 * EIP-4527 schema reader: `eth-sign-request` and `eth-signature`.
 *
 * ---------------------------------------------------------------------------
 * Why this is not src/cbor.c
 *
 * `cbor.c` says in its own header that tags, floats, indefinite lengths and
 * bignums are rejected rather than tolerated, because a signing device's
 * parser is attack surface. EIP-4527 needs tags. Rather than make that
 * sentence untrue, this is a second grammar, also small enough to audit in one
 * sitting, in which the accepted semantic tags are properties of *specific
 * fields* rather than capabilities of CBOR.
 *
 * There is deliberately no "read whatever tag is here". Each schema asks for
 * the tag it expects where it expects it, so tag 303 where a keypath belongs is
 * refused exactly as hard as tag 9999.
 *
 * ---------------------------------------------------------------------------
 * Three things this file does that the TypeScript mirror cannot check
 *
 * 1. **Nothing is allocated from a length on the wire.** Every destination is a
 *    fixed buffer sized by the schema; a declared length is compared against
 *    that maximum and refused before a byte is copied.
 * 2. **No arithmetic before a bounds check.** `pos + len` can wrap, so the test
 *    is always `len > input_len - pos`.
 * 3. **Depth is structural.** The schema says where nesting occurs, so the call
 *    graph is the bound — sign_request calls keypath calls components — and
 *    there is no generic recursion to give a MAX_DEPTH to.
 *
 * ---------------------------------------------------------------------------
 * Refusal codes are part of the wire contract
 *
 * `e4527_error_name()` returns the same strings the TypeScript side uses. Two
 * decoders that accept the same frames but disagree about which malformed ones
 * to reject hold two readings of one format, and the disagreement surfaces on
 * somebody's device rather than in CI. The shared corpus asserts the codes
 * match; the human-readable detail is allowed to differ.
 */

#ifndef LEEK_EIP4527_H
#define LEEK_EIP4527_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    E4527_OK = 0,
    E4527_ERR_WRONG_TAG,
    E4527_ERR_BAD_LENGTH,
    E4527_ERR_DUPLICATE_FIELD,
    E4527_ERR_UNKNOWN_FIELD,
    E4527_ERR_MISSING_FIELD,
    E4527_ERR_INVALID_DATA_TYPE,
    E4527_ERR_TRAILING_DATA,
    E4527_ERR_MALFORMED,
} E4527Result;

/** The stable name, identical to the TypeScript enum's value. */
const char *e4527_error_name(E4527Result r);

/* Semantic tags this grammar knows. Anything else is refused, and a known tag
   in the wrong field is refused just as hard. */
#define E4527_TAG_UUID              37
#define E4527_TAG_CRYPTO_HDKEY      303
#define E4527_TAG_CRYPTO_KEYPATH    304
#define E4527_TAG_CRYPTO_COIN_INFO  305
/* A Keystone extension rather than part of EIP-4527's signing protocol. */
#define E4527_TAG_CRYPTO_MULTI_ACCOUNTS 1103

/** The four values the ERC defines for `data-type`. */
typedef enum {
    E4527_SIGN_TRANSACTION       = 1,
    E4527_SIGN_TYPED_DATA        = 2,
    E4527_SIGN_PERSONAL_MESSAGE  = 3,
    E4527_SIGN_TYPED_TRANSACTION = 4,
} E4527SignDataType;

/* Schema maxima. Every one of these is a buffer size, and a declared length
   above it is a refusal rather than a reallocation. */
#define E4527_MAX_PATH_COMPONENTS 12
#define E4527_MAX_SIGN_DATA       1024
#define E4527_MAX_ORIGIN          64

typedef struct {
    uint32_t index;
    bool     hardened;
    bool     wildcard;   /* an empty array in place of an index */
} E4527PathComponent;

typedef struct {
    E4527PathComponent components[E4527_MAX_PATH_COMPONENTS];
    uint8_t  count;
    uint32_t source_fingerprint;
    bool     has_source_fingerprint;
    uint32_t depth;
    bool     has_depth;
} E4527Keypath;

typedef struct {
    bool     has_request_id;
    uint8_t  request_id[16];

    uint8_t  sign_data[E4527_MAX_SIGN_DATA];
    uint16_t sign_data_len;

    uint8_t  data_type;
    uint64_t chain_id;

    E4527Keypath derivation_path;

    bool     has_address;
    uint8_t  address[20];

    bool     has_origin;
    char     origin[E4527_MAX_ORIGIN + 1];
} E4527SignRequest;

typedef struct {
    uint8_t request_id[16];
    uint8_t signature[65];   /* r || s || v, fixed by the ERC */
    bool    has_origin;
    char    origin[E4527_MAX_ORIGIN + 1];
} E4527Signature;

/**
 * Decode the body of a `ur:eth-sign-request`.
 *
 * `field_out`, when not NULL, is set to a static string naming the schema field
 * a refusal happened in, so a diagnostic can say *which* field disagreed rather
 * than only that something did. `out` is untouched on failure.
 */
E4527Result eip4527_decode_sign_request(const uint8_t *cbor, size_t len,
                                        E4527SignRequest *out,
                                        const char **field_out);

/** Decode the body of a `ur:eth-signature`. */
E4527Result eip4527_decode_signature(const uint8_t *cbor, size_t len,
                                     E4527Signature *out,
                                     const char **field_out);

#endif /* LEEK_EIP4527_H */
