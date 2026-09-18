/**
 * BC-UR encoding tests.
 *
 * The vectors below were produced by Blockchain Commons' own bc-ur C++
 * implementation, not by this one. src/ur.c was checked against 400 generated
 * cases from that reference before these were written down; this file pins the
 * ones worth keeping so a future change has to agree with the reference rather
 * than merely with itself.
 *
 * Shared with app/packages/core/test/ur.test.ts, for the same reason the CBOR
 * vectors are: two implementations of one wire format drift unless something
 * forces them to agree.
 */

#include <stdio.h>
#include <string.h>

#include "ur.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Every vector here was PRINTED BY the reference implementation, never typed
   from memory. The first draft of this file had a hand-written vector that was
   simply wrong, and it failed against correct code - which is the argument for
   generating them. */
static const struct { const char *hex; const char *minimal; } VECTORS[] = {
    { "",                 "aeaeaeae" },
    { "0001028081ff",     "aeadaolalyzmspaacane" },
    { "e2",               "vonsamjzta" },
    { "e51d",             "vwcaadtbkkmy" },
};

static size_t unhex(const char *hex, uint8_t *out)
{
    size_t n = strlen(hex) / 2;
    for (size_t i = 0; i < n; i++) {
        unsigned v;
        sscanf(hex + i * 2, "%2x", &v);
        out[i] = (uint8_t)v;
    }
    return n;
}

static void test_reference_vectors(void)
{
    printf("== Bytewords minimal, against the reference implementation\n");

    for (size_t i = 0; i < sizeof VECTORS / sizeof VECTORS[0]; i++) {
        uint8_t data[64];
        const size_t len = unhex(VECTORS[i].hex, data);

        char out[256];
        const size_t n = ur_bytewords_encode(data, len, out, sizeof out);

        CHECK(n == strlen(VECTORS[i].minimal) &&
              strcmp(out, VECTORS[i].minimal) == 0,
              "encode(%s): want %s, got %s",
              VECTORS[i].hex, VECTORS[i].minimal, out);

        uint8_t back[64];
        size_t back_len = 0;
        CHECK(ur_bytewords_decode(VECTORS[i].minimal,
                                  strlen(VECTORS[i].minimal),
                                  back, sizeof back, &back_len),
              "decode(%s) rejected a valid string", VECTORS[i].minimal);
        CHECK(back_len == len && memcmp(back, data, len) == 0,
              "decode(%s) did not round-trip", VECTORS[i].minimal);
    }
}

static void test_crc32(void)
{
    printf("== CRC-32\n");
    CHECK(ur_crc32((const uint8_t *)"", 0) == 0x00000000u, "crc of empty");
    CHECK(ur_crc32((const uint8_t *)"123456789", 9) == 0xCBF43926u,
          "crc of the standard check string");
}

/* A misread frame must be refused, not decoded into something plausible. That
   is the entire reason the checksum is on the wire. */
static void test_corruption_is_refused(void)
{
    printf("== a corrupted frame is refused\n");

    const uint8_t payload[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22 };
    char good[128];
    const size_t n = ur_bytewords_encode(payload, sizeof payload,
                                         good, sizeof good);
    CHECK(n > 0, "encode failed");

    /* Flip every character in turn to a different valid one and confirm the
       result never decodes. This catches a checksum that is present but not
       actually being checked. */
    int accepted = 0;
    for (size_t i = 0; i < n; i++) {
        char broken[128];
        memcpy(broken, good, n + 1);
        broken[i] = (broken[i] == 'a') ? 'z' : 'a';

        uint8_t out[64];
        size_t out_len = 0;
        if (ur_bytewords_decode(broken, n, out, sizeof out, &out_len)) {
            accepted++;
        }
    }
    CHECK(accepted == 0, "%d single-character corruptions were accepted",
          accepted);
}

static void test_malformed_input(void)
{
    printf("== malformed input\n");

    uint8_t out[64];
    size_t out_len = 0;

    CHECK(!ur_bytewords_decode("aeadao", 6, out, sizeof out, &out_len),
          "a string too short to hold a checksum was accepted");
    CHECK(!ur_bytewords_decode("aeadaolalyzmspaacane", 19, out, sizeof out,
                               &out_len),
          "an odd-length string was accepted");
    CHECK(!ur_bytewords_decode("qqqqqqqq", 8, out, sizeof out, &out_len),
          "a string with no matching byteword was accepted");

    /* A payload larger than the caller's buffer must be refused, not truncated. */
    uint8_t tiny[2];
    CHECK(!ur_bytewords_decode("aeadaolalyzmspaacane", 20, tiny, sizeof tiny,
                               &out_len),
          "a payload larger than the output buffer was accepted");
}

static void test_ur_envelope(void)
{
    printf("== ur:<type>/<body>\n");

    const uint8_t payload[] = { 0x00, 0x01, 0x02, 0x80, 0x81, 0xFF };
    char ur[256];
    const size_t n = ur_encode("eth-signature", payload, sizeof payload,
                               ur, sizeof ur);
    CHECK(n > 0, "encode failed");
    CHECK(strcmp(ur, "ur:eth-signature/aeadaolalyzmspaacane") == 0,
          "got %s", ur);

    char type[UR_TYPE_MAX + 1];
    uint8_t out[64];
    size_t out_len = 0;
    CHECK(ur_decode(ur, n, type, sizeof type, out, sizeof out, &out_len),
          "decode rejected its own output");
    CHECK(strcmp(type, "eth-signature") == 0, "type was %s", type);
    CHECK(out_len == sizeof payload &&
          memcmp(out, payload, sizeof payload) == 0, "payload changed");

    /* Readers uppercase the whole string to reach the QR alphanumeric mode,
       so an uppercase UR has to decode to the same thing. */
    char upper[256];
    for (size_t i = 0; i <= n; i++) {
        upper[i] = (ur[i] >= 'a' && ur[i] <= 'z')
                     ? (char)(ur[i] - 'a' + 'A') : ur[i];
    }
    out_len = 0;
    CHECK(ur_decode(upper, n, type, sizeof type, out, sizeof out, &out_len),
          "an uppercase UR was rejected");
    CHECK(strcmp(type, "eth-signature") == 0,
          "uppercase type came back as %s", type);

    CHECK(!ur_decode("eth-signature/aeadaolalyzmspaacane", 35, type,
                     sizeof type, out, sizeof out, &out_len),
          "a UR with no scheme was accepted");
    CHECK(!ur_decode("ur:eth signature/aeadaolalyzmspaacane", 37, type,
                     sizeof type, out, sizeof out, &out_len),
          "a type containing a space was accepted");
    CHECK(ur_encode("-bad", payload, sizeof payload, ur, sizeof ur) == 0,
          "a type starting with a hyphen was accepted");
}

/* Multi-part URs need the fountain decoder, which is a later phase. What
   matters now is that they are recognised rather than silently mis-parsed. */
static void test_multipart_is_detected(void)
{
    printf("== multi-part is detected, not mis-parsed\n");

    const char *mp = "ur:eth-sign-request/1-3/aeadaolalyzmspaacane";
    const size_t len = strlen(mp);

    CHECK(ur_is_multipart(mp, len), "multi-part was not detected");
    CHECK(!ur_is_multipart("ur:eth-signature/aeadaolalyzmspaacane", 37),
          "single-part was reported as multi-part");

    char type[UR_TYPE_MAX + 1];
    uint8_t out[64];
    size_t out_len = 0;
    CHECK(!ur_decode(mp, len, type, sizeof type, out, sizeof out, &out_len),
          "the single-part decoder accepted a multi-part UR");
}

int main(void)
{
    test_reference_vectors();
    test_crc32();
    test_corruption_is_refused();
    test_malformed_input();
    test_ur_envelope();
    test_multipart_is_detected();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
