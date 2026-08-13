/**
 * Authenticated storage encryption tests (ROADMAP T14, AUDIT.md S8h).
 *
 * The property the old CBC scheme lacked: a modified ciphertext must fail,
 * loudly, rather than decrypt to something that looks like a mnemonic.
 */

#include <stdio.h>
#include <string.h>

#include "vault-crypt.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static const uint8_t KEY_A[32] = {
    0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0x0c,0x0d,0x0e,0x0f,
    0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1a,0x1b,0x1c,0x1d,0x1e,0x1f,
};
static const uint8_t KEY_B[32] = {
    0xff,0xfe,0xfd,0xfc,0xfb,0xfa,0xf9,0xf8,0xf7,0xf6,0xf5,0xf4,0xf3,0xf2,0xf1,0xf0,
    0xef,0xee,0xed,0xec,0xeb,0xea,0xe9,0xe8,0xe7,0xe6,0xe5,0xe4,0xe3,0xe2,0xe1,0xe0,
};

static const char MNEMONIC[] =
    "abandon abandon abandon abandon abandon abandon "
    "abandon abandon abandon abandon abandon about";

static void test_round_trip(void)
{
    printf("== round trip\n");

    uint8_t blob[512], back[512];
    size_t len = strlen(MNEMONIC) + 1;   /* include the terminator */

    size_t n = vault_encrypt((const uint8_t *)MNEMONIC, len, KEY_A, blob, sizeof(blob));
    CHECK(n == len + VAULT_CRYPT_OVERHEAD, "encrypt returned %zu", n);
    CHECK(memcmp(blob + VAULT_NONCE_SIZE, MNEMONIC, 8) != 0, "ciphertext matches plaintext");

    size_t m = vault_decrypt(blob, n, KEY_A, back, sizeof(back));
    CHECK(m == len, "decrypt returned %zu, expected %zu", m, len);
    CHECK(strcmp((char *)back, MNEMONIC) == 0, "plaintext did not survive");
}

static void test_wrong_key_fails(void)
{
    printf("== the wrong key fails rather than producing garbage\n");

    uint8_t blob[512], back[512];
    size_t len = strlen(MNEMONIC) + 1;
    size_t n = vault_encrypt((const uint8_t *)MNEMONIC, len, KEY_A, blob, sizeof(blob));

    memset(back, 0xAA, sizeof(back));
    size_t m = vault_decrypt(blob, n, KEY_B, back, sizeof(back));
    CHECK(m == 0, "the wrong key was accepted");

    /* Nothing partially decrypted should survive for a caller to misread. */
    bool clean = true;
    for (size_t i = 0; i < 64; i++) if (back[i] != 0) clean = false;
    CHECK(clean, "a failed decrypt left data in the output buffer");
}

/* This is the whole point of the change. Under CBC every one of these produced
 * a different plaintext and no error at all. */
static void test_tampering_is_detected(void)
{
    printf("== every kind of tampering is detected\n");

    uint8_t blob[512], back[512];
    size_t len = strlen(MNEMONIC) + 1;
    size_t n = vault_encrypt((const uint8_t *)MNEMONIC, len, KEY_A, blob, sizeof(blob));

    struct { const char *what; size_t offset; } spots[] = {
        { "nonce",              0 },
        { "first ciphertext byte", VAULT_NONCE_SIZE },
        { "middle of ciphertext",  VAULT_NONCE_SIZE + 20 },
        { "last ciphertext byte",  VAULT_NONCE_SIZE + len - 1 },
        { "tag",                n - 1 },
    };

    for (size_t i = 0; i < sizeof(spots) / sizeof(spots[0]); i++) {
        uint8_t copy[512];
        memcpy(copy, blob, n);
        copy[spots[i].offset] ^= 0x01;     /* one bit */

        size_t m = vault_decrypt(copy, n, KEY_A, back, sizeof(back));
        CHECK(m == 0, "a flipped bit in the %s was accepted", spots[i].what);
    }

    /* Truncation must fail too, not decrypt a prefix. */
    CHECK(vault_decrypt(blob, n - 1, KEY_A, back, sizeof(back)) == 0,
          "a truncated blob was accepted");
    CHECK(vault_decrypt(blob, VAULT_CRYPT_OVERHEAD - 1, KEY_A, back, sizeof(back)) == 0,
          "an impossibly short blob was accepted");
}

static void test_nonce_is_fresh(void)
{
    printf("== each encryption uses a fresh nonce\n");

    /* A repeated nonce under one key does not degrade GCM, it breaks it: two
     * messages leak the keystream and the authentication key. */
    uint8_t a[512], b[512];
    size_t len = strlen(MNEMONIC) + 1;

    size_t n1 = vault_encrypt((const uint8_t *)MNEMONIC, len, KEY_A, a, sizeof(a));
    size_t n2 = vault_encrypt((const uint8_t *)MNEMONIC, len, KEY_A, b, sizeof(b));

    CHECK(n1 == n2, "sizes differ");
    CHECK(memcmp(a, b, VAULT_NONCE_SIZE) != 0, "the same nonce was used twice");
    CHECK(memcmp(a, b, n1) != 0, "identical plaintext produced identical ciphertext");
}

static void test_buffer_bounds(void)
{
    printf("== undersized buffers are refused\n");

    uint8_t small[8], back[512], blob[512];
    size_t len = strlen(MNEMONIC) + 1;

    CHECK(vault_encrypt((const uint8_t *)MNEMONIC, len, KEY_A, small, sizeof(small)) == 0,
          "encrypt wrote into a buffer too small to hold the result");

    size_t n = vault_encrypt((const uint8_t *)MNEMONIC, len, KEY_A, blob, sizeof(blob));
    CHECK(vault_decrypt(blob, n, KEY_A, small, sizeof(small)) == 0,
          "decrypt wrote into a buffer too small to hold the plaintext");
}

static void test_empty_and_small(void)
{
    printf("== short plaintexts\n");

    uint8_t blob[64], back[64];
    const uint8_t one[1] = { 0x42 };

    size_t n = vault_encrypt(one, 1, KEY_A, blob, sizeof(blob));
    CHECK(n == 1 + VAULT_CRYPT_OVERHEAD, "one byte encrypted to %zu", n);
    CHECK(vault_decrypt(blob, n, KEY_A, back, sizeof(back)) == 1, "one byte did not round trip");
    CHECK(back[0] == 0x42, "the byte changed");

    /* A plaintext ending in zero is exactly what CBC zero-padding could not
     * represent. */
    const uint8_t zero_tail[4] = { 1, 2, 3, 0 };
    n = vault_encrypt(zero_tail, 4, KEY_A, blob, sizeof(blob));
    CHECK(vault_decrypt(blob, n, KEY_A, back, sizeof(back)) == 4,
          "a plaintext ending in a zero byte did not round trip");
    CHECK(memcmp(back, zero_tail, 4) == 0, "trailing zero was lost");
}

int main(void)
{
    test_round_trip();
    test_wrong_key_fails();
    test_tampering_is_detected();
    test_nonce_is_fresh();
    test_buffer_bounds();
    test_empty_and_small();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
