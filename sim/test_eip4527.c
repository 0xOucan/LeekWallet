/**
 * EIP-4527 schema reader, and the differential corpus.
 *
 * The refusals are the point. Two decoders that accept the same frames but
 * disagree about which malformed ones to reject hold two readings of one wire
 * format, and the disagreement surfaces on somebody's device rather than in
 * CI. So --emit-vectors writes every case below with the code this decoder
 * returns, and app/packages/core/test/eip4527.test.ts replays them and requires
 * the same code. Equivalent meaning on the valid ones, identical code on the
 * invalid ones.
 *
 * Run under ASan and UBSan as well as plain: `make -C sim asan`.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "eip4527.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* A byte-level corpus, so a case can be something no encoder would emit:
   duplicate keys, indefinite lengths, a known tag in the wrong field. */
typedef struct {
    const char   *name;
    const uint8_t bytes[128];
    size_t        len;
    E4527Result   expect;
    const char   *field;      /* NULL when the field is not asserted */
    bool          signature;  /* decode as eth-signature rather than a request */
} Case;

/* m/44'/60'/0'/0/0, tagged 304. */
#define KEYPATH \
    0xD9, 0x01, 0x30, 0xA1, 0x01, 0x8A, \
    0x18, 44, 0xF5, 0x18, 60, 0xF5, 0x00, 0xF5, 0x00, 0xF4, 0x00, 0xF4
#define KEYPATH_BODY 0xA1, 0x01, 0x8A, \
    0x18, 44, 0xF5, 0x18, 60, 0xF5, 0x00, 0xF5, 0x00, 0xF4, 0x00, 0xF4
#define UUID16 0xD8, 0x25, 0x50, \
    0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0

static const Case CASES[] = {
    { "valid-minimal",
      { 0xA3, 0x02, 0x44, 0xDE,0xAD,0xBE,0xEF, 0x03, 0x01, 0x05, KEYPATH },
      28, E4527_OK, NULL, false },

    { "valid-typed-data",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0x02, 0x05, KEYPATH },
      25, E4527_OK, NULL, false },

    { "data-type-zero",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0x00, 0x05, KEYPATH },
      25, E4527_ERR_INVALID_DATA_TYPE, "data-type", false },

    { "data-type-five",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0x05, 0x05, KEYPATH },
      25, E4527_ERR_INVALID_DATA_TYPE, "data-type", false },

    { "data-type-negative",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0x20, 0x05, KEYPATH },
      25, E4527_ERR_MALFORMED, "data-type", false },

    { "data-type-tagged-401",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0xD9, 0x01, 0x91, 0x01, 0x05, KEYPATH },
      28, E4527_ERR_MALFORMED, "data-type", false },

    { "duplicate-data-type",
      { 0xA4, 0x02, 0x41, 0x00, 0x03, 0x01, 0x03, 0x02, 0x05, KEYPATH },
      27, E4527_ERR_DUPLICATE_FIELD, NULL, false },

    { "request-id-wrong-tag-304",
      { 0xA4, 0x01, 0xD9, 0x01, 0x30, 0x50, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0x02, 0x41, 0x00, 0x03, 0x01, 0x05, KEYPATH },
      47, E4527_ERR_WRONG_TAG, "request-id", false },

    { "request-id-untagged",
      { 0xA4, 0x01, 0x50, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0x02, 0x41, 0x00, 0x03, 0x01, 0x05, KEYPATH },
      44, E4527_ERR_MALFORMED, "request-id", false },

    { "request-id-15-bytes",
      { 0xA4, 0x01, 0xD8, 0x25, 0x4F, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0x02, 0x41, 0x00, 0x03, 0x01, 0x05, KEYPATH },
      46, E4527_ERR_BAD_LENGTH, "request-id", false },

    { "keypath-tag-303",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0x01, 0x05, 0xD9, 0x01, 0x2F, KEYPATH_BODY },
      25, E4527_ERR_WRONG_TAG, "derivation-path", false },

    { "keypath-untagged",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0x01, 0x05, KEYPATH_BODY },
      22, E4527_ERR_MALFORMED, "derivation-path", false },

    { "keypath-unknown-tag",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0x01, 0x05, 0xD9, 0x27, 0x0F, KEYPATH_BODY },
      25, E4527_ERR_WRONG_TAG, "derivation-path", false },

    { "tagged-top-level",
      { 0xD9, 0x01, 0x30, 0xA3, 0x02, 0x41, 0x00, 0x03, 0x01, 0x05, KEYPATH },
      28, E4527_ERR_WRONG_TAG, NULL, false },

    { "address-19-bytes",
      { 0xA4, 0x02, 0x41, 0x00, 0x03, 0x01, 0x05, KEYPATH,
        0x06, 0x53, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 },
      46, E4527_ERR_BAD_LENGTH, "address", false },

    { "unknown-field",
      { 0xA4, 0x02, 0x41, 0x00, 0x03, 0x01, 0x05, KEYPATH, 0x09, 0x01 },
      27, E4527_ERR_UNKNOWN_FIELD, NULL, false },

    { "trailing-data",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0x01, 0x05, KEYPATH, 0x00 },
      26, E4527_ERR_TRAILING_DATA, NULL, false },

    { "missing-sign-data",
      { 0xA2, 0x03, 0x01, 0x05, KEYPATH },
      22, E4527_ERR_MISSING_FIELD, "sign-data", false },

    { "indefinite-map",
      { 0xBF, 0x03, 0x01, 0xFF }, 4, E4527_ERR_MALFORMED, NULL, false },

    { "indefinite-bytes",
      { 0xA3, 0x02, 0x5F, 0x41, 0x00, 0xFF, 0x03, 0x01, 0x05, KEYPATH },
      27, E4527_ERR_MALFORMED, "sign-data", false },

    { "float",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0xF9, 0x3C, 0x00, 0x05, KEYPATH },
      27, E4527_ERR_MALFORMED, "data-type", false },

    { "null",
      { 0xA3, 0x02, 0x41, 0x00, 0x03, 0xF6, 0x05, KEYPATH },
      25, E4527_ERR_MALFORMED, "data-type", false },

    { "truncated-mid-item",
      { 0xA3, 0x02, 0x58, 0x40, 0x00 }, 5, E4527_ERR_MALFORMED, "sign-data", false },

    { "sign-data-too-large",
      { 0xA3, 0x02, 0x59, 0x08, 0x00 }, 5, E4527_ERR_BAD_LENGTH, "sign-data", false },

    /* eth-signature */
    { "valid-signature",
      { 0xA2, 0x01, UUID16, 0x02, 0x58, 0x41,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0 },
      89, E4527_OK, NULL, true },

    { "signature-64-bytes",
      { 0xA2, 0x01, UUID16, 0x02, 0x58, 0x40,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 },
      88, E4527_ERR_BAD_LENGTH, "signature", true },
};

#define N_CASES (sizeof CASES / sizeof CASES[0])

static void run_cases(void)
{
    printf("== every case returns the code the schema requires\n");

    for (size_t i = 0; i < N_CASES; i++) {
        const Case *c = &CASES[i];
        const char *field = NULL;
        E4527Result rc;

        if (c->signature) {
            E4527Signature sig;
            rc = eip4527_decode_signature(c->bytes, c->len, &sig, &field);
        } else {
            E4527SignRequest req;
            rc = eip4527_decode_sign_request(c->bytes, c->len, &req, &field);
        }

        CHECK(rc == c->expect, "%s: got %s, want %s",
              c->name, e4527_error_name(rc), e4527_error_name(c->expect));
        if (c->field != NULL && rc == c->expect) {
            CHECK(strcmp(field, c->field) == 0,
                  "%s: field \"%s\", want \"%s\"", c->name, field, c->field);
        }
    }
}

static void test_valid_contents(void)
{
    printf("== a valid request decodes to the right values\n");

    const uint8_t bytes[] = {
        0xA3, 0x02, 0x44, 0xDE,0xAD,0xBE,0xEF, 0x03, 0x01, 0x05, KEYPATH
    };
    E4527SignRequest req;
    const char *field = NULL;
    CHECK(eip4527_decode_sign_request(bytes, sizeof bytes, &req, &field)
          == E4527_OK, "valid request refused at %s", field);

    CHECK(req.data_type == E4527_SIGN_TRANSACTION, "data-type %u", req.data_type);
    CHECK(req.chain_id == 1, "chain-id defaulted to %llu, want 1",
          (unsigned long long)req.chain_id);
    CHECK(req.sign_data_len == 4 && req.sign_data[0] == 0xDE,
          "sign-data wrong");
    CHECK(!req.has_request_id, "request-id should be absent");
    CHECK(req.derivation_path.count == 5, "%u path components, want 5",
          req.derivation_path.count);
    CHECK(req.derivation_path.components[0].index == 44 &&
          req.derivation_path.components[0].hardened,
          "first path component wrong");
    CHECK(!req.derivation_path.components[4].hardened,
          "last path component should not be hardened");
}

/* A truncation at every offset must refuse, never read past the buffer. Run
   under ASan this is the check that `pos + len` was never computed. */
static void test_every_truncation_refuses(void)
{
    printf("== truncating a valid frame anywhere is refused, not read past\n");

    const uint8_t full[] = {
        0xA3, 0x02, 0x44, 0xDE,0xAD,0xBE,0xEF, 0x03, 0x01, 0x05, KEYPATH
    };
    int accepted = 0;
    for (size_t n = 0; n < sizeof full; n++) {
        E4527SignRequest req;
        const char *field = NULL;
        if (eip4527_decode_sign_request(full, n, &req, &field) == E4527_OK) {
            accepted++;
        }
    }
    CHECK(accepted == 0, "%d truncations were accepted", accepted);
}

static int emit_vectors(const char *path)
{
    FILE *f = fopen(path, "w");
    if (f == NULL) { perror(path); return 1; }

    fprintf(f, "[\n");
    for (size_t i = 0; i < N_CASES; i++) {
        const Case *c = &CASES[i];
        const char *field = NULL;
        E4527Result rc;
        if (c->signature) {
            E4527Signature sig;
            rc = eip4527_decode_signature(c->bytes, c->len, &sig, &field);
        } else {
            E4527SignRequest req;
            rc = eip4527_decode_sign_request(c->bytes, c->len, &req, &field);
        }

        fprintf(f, "  { \"name\": \"%s\", \"kind\": \"%s\", \"hex\": \"",
                c->name, c->signature ? "signature" : "sign-request");
        for (size_t j = 0; j < c->len; j++) fprintf(f, "%02x", c->bytes[j]);
        fprintf(f, "\", \"expect\": \"%s\", \"field\": \"%s\" }%s\n",
                e4527_error_name(rc), field == NULL ? "" : field,
                i + 1 == N_CASES ? "" : ",");
    }
    fprintf(f, "]\n");

    if (fclose(f) != 0) { perror(path); return 1; }
    printf("wrote %zu EIP-4527 vectors to %s\n", N_CASES, path);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 3 && strcmp(argv[1], "--emit-vectors") == 0) {
        return emit_vectors(argv[2]);
    }

    run_cases();
    test_valid_contents();
    test_every_truncation_refuses();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
