/**
 * EIP-4527 writer: `crypto-hdkey` for the handshake, `eth-signature` for the
 * answer.
 *
 * The hdkey bytes below are written out by hand from BCR-2020-007's field
 * table, not captured from this encoder, so a test that passes proves the
 * encoder agrees with the table rather than with itself. --emit-vectors then
 * records what the encoder produces for app/packages/core/test, where the
 * TypeScript side can check the same bytes against Keystone's ur-registry.
 *
 * The signature writer is checked the stronger way: everything it emits must
 * come back through the strict reader in eip4527.c unchanged, because that
 * reader is the grammar the companions have agreed to.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "eip4527.h"
#include "eip4527-encode.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static void fill(uint8_t *p, size_t n, uint8_t seed)
{
    for (size_t i = 0; i < n; i++) {
        p[i] = (uint8_t)(seed + i * 7);
    }
}

static E4527AccountKey sample_key(uint32_t account)
{
    E4527AccountKey k;
    memset(&k, 0, sizeof k);
    fill(k.key_data, 33, 0x10);
    k.key_data[0] = 0x02;
    fill(k.chain_code, 32, 0x80);
    k.account = account;
    k.master_fingerprint = 0x12345678u;
    k.parent_fingerprint = 0x9ABCDEF0u;
    return k;
}

static void test_hdkey_matches_the_table(void)
{
    printf("== crypto-hdkey, byte for byte against BCR-2020-007\n");

    const E4527AccountKey k = sample_key(0);

    uint8_t want[E4527_HDKEY_MAX];
    size_t n = 0;
    want[n++] = 0xA5;                              /* map(5) */
    want[n++] = 0x03; want[n++] = 0x58; want[n++] = 33;
    memcpy(want + n, k.key_data, 33); n += 33;
    want[n++] = 0x04; want[n++] = 0x58; want[n++] = 32;
    memcpy(want + n, k.chain_code, 32); n += 32;
    want[n++] = 0x05;                              /* use-info */
    want[n++] = 0xD9; want[n++] = 0x01; want[n++] = 0x31;   /* #6.305 */
    want[n++] = 0xA1; want[n++] = 0x01; want[n++] = 0x18; want[n++] = 60;
    want[n++] = 0x06;                              /* origin */
    want[n++] = 0xD9; want[n++] = 0x01; want[n++] = 0x30;   /* #6.304 */
    want[n++] = 0xA2;
    want[n++] = 0x01; want[n++] = 0x86;
    want[n++] = 0x18; want[n++] = 44; want[n++] = 0xF5;
    want[n++] = 0x18; want[n++] = 60; want[n++] = 0xF5;
    want[n++] = 0x00; want[n++] = 0xF5;
    want[n++] = 0x02; want[n++] = 0x1A;
    want[n++] = 0x12; want[n++] = 0x34; want[n++] = 0x56; want[n++] = 0x78;
    want[n++] = 0x08; want[n++] = 0x1A;
    want[n++] = 0x9A; want[n++] = 0xBC; want[n++] = 0xDE; want[n++] = 0xF0;

    uint8_t got[E4527_HDKEY_MAX];
    const size_t len = eip4527_encode_account_hdkey(&k, got, sizeof got);
    CHECK(len == n, "length %zu, table says %zu", len, n);
    CHECK(len == n && memcmp(got, want, n) == 0,
          "the encoding disagrees with the field table");

    /* An account above 23 changes the component's width, which is where a
       hand-rolled head() goes wrong first. */
    const E4527AccountKey k9 = sample_key(300);
    const size_t len9 = eip4527_encode_account_hdkey(&k9, got, sizeof got);
    CHECK(len9 == n + 2, "account 300 should cost two more bytes, got %zu", len9);
}

static void test_hdkey_refusals(void)
{
    printf("== crypto-hdkey refuses what no companion could read\n");

    uint8_t out[E4527_HDKEY_MAX];
    E4527AccountKey k = sample_key(0);

    k.key_data[0] = 0x04;
    CHECK(eip4527_encode_account_hdkey(&k, out, sizeof out) == 0,
          "an uncompressed key prefix was encoded");

    k = sample_key(0x80000000u);
    CHECK(eip4527_encode_account_hdkey(&k, out, sizeof out) == 0,
          "an account that is already hardened was encoded");

    /* Every short buffer is a refusal, never a truncated encoding a camera
       would read as something smaller. */
    k = sample_key(5);
    const size_t full = eip4527_encode_account_hdkey(&k, out, sizeof out);
    for (size_t cap = 0; cap < full; cap++) {
        CHECK(eip4527_encode_account_hdkey(&k, out, cap) == 0,
              "a %zu-byte buffer produced a partial hdkey", cap);
    }
}

static void test_signature_round_trips(void)
{
    printf("== eth-signature comes back through the strict reader\n");

    uint8_t id[16], sig[65];
    fill(id, 16, 0xA0);
    fill(sig, 65, 0x33);
    sig[64] = 1;

    uint8_t out[E4527_SIGNATURE_MAX];
    size_t len = eip4527_encode_signature(id, sig, NULL, out, sizeof out);
    CHECK(len > 0, "no signature was encoded");

    E4527Signature back;
    const char *field = NULL;
    E4527Result rc = eip4527_decode_signature(out, len, &back, &field);
    CHECK(rc == E4527_OK, "the reader refused it: %s in %s",
          e4527_error_name(rc), field ? field : "?");
    CHECK(rc == E4527_OK && memcmp(back.request_id, id, 16) == 0,
          "the request id changed on the way through");
    CHECK(rc == E4527_OK && memcmp(back.signature, sig, 65) == 0,
          "the signature changed on the way through");
    CHECK(rc == E4527_OK && !back.has_origin, "an origin appeared from nowhere");

    len = eip4527_encode_signature(id, sig, "LeekWallet", out, sizeof out);
    rc = eip4527_decode_signature(out, len, &back, &field);
    CHECK(rc == E4527_OK && back.has_origin &&
          strcmp(back.origin, "LeekWallet") == 0, "the origin did not survive");

    char long_origin[E4527_MAX_ORIGIN + 2];
    memset(long_origin, 'x', sizeof long_origin - 1);
    long_origin[sizeof long_origin - 1] = '\0';
    CHECK(eip4527_encode_signature(id, sig, long_origin, out, sizeof out) == 0,
          "an origin the reader would refuse was written");

    CHECK(eip4527_encode_signature(NULL, sig, NULL, out, sizeof out) == 0,
          "a signature without a request id was written");

    const size_t full = eip4527_encode_signature(id, sig, NULL, out, sizeof out);
    for (size_t cap = 0; cap < full; cap++) {
        CHECK(eip4527_encode_signature(id, sig, NULL, out, cap) == 0,
              "a %zu-byte buffer produced a partial signature", cap);
    }
}

static void hex(FILE *f, const uint8_t *p, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        fprintf(f, "%02x", p[i]);
    }
}

/*
 * The mock leg for the handshake, same reasoning as every other vector file
 * `ur-conformance` writes: what this encoder produces today, with the inputs
 * next to it so the TypeScript side can build the same key with ur-registry
 * and require identical bytes.
 */
static int emit_vectors(const char *path)
{
    FILE *f = fopen(path, "w");
    if (f == NULL) {
        perror(path);
        return 1;
    }

    static const uint32_t ACCOUNTS[] = { 0, 1, 9, 23, 24, 255, 256, 65535, 65536, 0x7FFFFFFFu };
    const size_t count = sizeof ACCOUNTS / sizeof ACCOUNTS[0];

    fprintf(f, "[\n");
    for (size_t i = 0; i < count; i++) {
        E4527AccountKey k;
        fill(k.key_data, 33, (uint8_t)(0x21 * (i + 1)));
        k.key_data[0] = (i & 1) ? 0x03 : 0x02;
        fill(k.chain_code, 32, (uint8_t)(0x5B * (i + 3)));
        k.account = ACCOUNTS[i];
        k.master_fingerprint = 0x01020304u * (uint32_t)(i + 1);
        k.parent_fingerprint = 0xF0E0D0C0u ^ (uint32_t)(i * 0x01010101u);

        uint8_t out[E4527_HDKEY_MAX];
        const size_t len = eip4527_encode_account_hdkey(&k, out, sizeof out);
        if (len == 0) {
            fclose(f);
            return 1;
        }

        fprintf(f, "  {\n    \"path\": \"m/44'/60'/%u'\",\n", k.account);
        fprintf(f, "    \"account\": %u,\n", k.account);
        fprintf(f, "    \"pubkeyHex\": \"");
        hex(f, k.key_data, 33);
        fprintf(f, "\",\n    \"chainCodeHex\": \"");
        hex(f, k.chain_code, 32);
        fprintf(f, "\",\n    \"masterFingerprint\": %u,\n", k.master_fingerprint);
        fprintf(f, "    \"parentFingerprint\": %u,\n", k.parent_fingerprint);
        fprintf(f, "    \"cborHex\": \"");
        hex(f, out, len);
        fprintf(f, "\"\n  }%s\n", i + 1 == count ? "" : ",");
    }
    fprintf(f, "]\n");

    if (fclose(f) != 0) {
        perror(path);
        return 1;
    }
    printf("wrote %zu crypto-hdkey vectors to %s\n", count, path);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 3 && strcmp(argv[1], "--emit-vectors") == 0) {
        return emit_vectors(argv[2]);
    }

    test_hdkey_matches_the_table();
    test_hdkey_refusals();
    test_signature_round_trips();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
