/**
 * Host tests for src/vault-kdf.c (ROADMAP T9b, AUDIT.md S1).
 *
 * The properties that matter are separation (verifier tells you nothing about
 * the encryption key), salting (two devices with the same PIN get different
 * keys), and that the legacy path still reproduces old vaults exactly so
 * migration can read them.
 */

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "vault-kdf.h"
#include "sha2.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static const uint8_t SALT_A[VAULT_SALT_SIZE] = {
    0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,
    0x99,0xAA,0xBB,0xCC,0xDD,0xEE,0xFF,0x00,
};
static const uint8_t SALT_B[VAULT_SALT_SIZE] = {
    0xFE,0xED,0xFA,0xCE,0xDE,0xAD,0xBE,0xEF,
    0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,
};

static void test_key_and_verifier_are_independent(void)
{
    printf("== encryption key and verifier are independent\n");

    uint8_t key[VAULT_KEY_SIZE], ver[VAULT_HASH_SIZE];
    vault_derive_key(VAULT_KDF_V2, "123456", 6, SALT_A, key);
    vault_derive_verifier(VAULT_KDF_V2, "123456", 6, SALT_A, ver);

    CHECK(memcmp(key, ver, 32) != 0, "key and verifier are identical");

    /* The v1 flaw: the verifier was a pure function of the key's own input, so
     * one SHA256 turned a cracked verifier into the storage key. Confirm no
     * such trivial relation survives under v2. */
    uint8_t chained[32];
    sha256_Raw(key, 32, chained);
    CHECK(memcmp(chained, ver, 32) != 0, "verifier is SHA256(key)");
    sha256_Raw(ver, 32, chained);
    CHECK(memcmp(chained, key, 32) != 0, "key is SHA256(verifier)");
}

static void test_salt_separates_devices(void)
{
    printf("== the same PIN on two devices yields different keys\n");

    uint8_t key_a[32], key_b[32], ver_a[32], ver_b[32];
    vault_derive_key(VAULT_KDF_V2, "1234", 4, SALT_A, key_a);
    vault_derive_key(VAULT_KDF_V2, "1234", 4, SALT_B, key_b);
    vault_derive_verifier(VAULT_KDF_V2, "1234", 4, SALT_A, ver_a);
    vault_derive_verifier(VAULT_KDF_V2, "1234", 4, SALT_B, ver_b);

    CHECK(memcmp(key_a, key_b, 32) != 0, "salt did not affect the key");
    CHECK(memcmp(ver_a, ver_b, 32) != 0, "salt did not affect the verifier");
}

static void test_determinism_and_pin_sensitivity(void)
{
    printf("== derivation is deterministic and PIN-sensitive\n");

    uint8_t first[32], second[32], other[32];
    vault_derive_key(VAULT_KDF_V2, "987654", 6, SALT_A, first);
    vault_derive_key(VAULT_KDF_V2, "987654", 6, SALT_A, second);
    vault_derive_key(VAULT_KDF_V2, "987655", 6, SALT_A, other);

    CHECK(memcmp(first, second, 32) == 0, "same inputs gave different keys");
    CHECK(memcmp(first, other, 32) != 0, "one digit did not change the key");
}

static void test_legacy_path_is_bit_exact(void)
{
    printf("== the legacy path still reproduces v1 vaults\n");

    /* Recompute the original scheme independently and require a match, so
     * migration can still open vaults written by the old firmware. */
    const char *pin = "1234";
    uint8_t expect_key[32], expect_ver[32], tmp[32];

    sha256_Raw((const uint8_t *)pin, 4, tmp);
    sha256_Raw(tmp, 32, expect_key);

    sha256_Raw((const uint8_t *)pin, 4, tmp);
    sha256_Raw(tmp, 32, tmp);
    sha256_Raw(tmp, 32, expect_ver);

    uint8_t got_key[32], got_ver[32];
    vault_derive_key(VAULT_KDF_V1_LEGACY, pin, 4, SALT_A, got_key);
    vault_derive_verifier(VAULT_KDF_V1_LEGACY, pin, 4, SALT_A, got_ver);

    CHECK(memcmp(got_key, expect_key, 32) == 0, "legacy key derivation changed");
    CHECK(memcmp(got_ver, expect_ver, 32) == 0, "legacy verifier derivation changed");

    /* And v2 must not collide with v1 for the same PIN. */
    uint8_t v2_key[32];
    vault_derive_key(VAULT_KDF_V2, pin, 4, SALT_A, v2_key);
    CHECK(memcmp(v2_key, expect_key, 32) != 0, "v2 collides with v1");
}

static void test_constant_time_compare(void)
{
    printf("== hash comparison\n");

    uint8_t a[32], b[32];
    memset(a, 0xA5, sizeof(a));
    memcpy(b, a, sizeof(b));
    CHECK(vault_hash_equals(a, b), "identical hashes reported unequal");

    b[31] ^= 0x01;
    CHECK(!vault_hash_equals(a, b), "last-byte difference missed");
    b[31] ^= 0x01;
    b[0] ^= 0x80;
    CHECK(!vault_hash_equals(a, b), "first-byte difference missed");
}

/* Not a pass/fail assertion - the target depends on the hardware. Reported so
 * the iteration count can be tuned against a real board. */
static void report_cost(void)
{
    printf("== derivation cost\n");

    uint8_t key[32];
    clock_t start = clock();
    const int reps = 5;
    for (int i = 0; i < reps; i++) {
        vault_derive_key(VAULT_KDF_V2, "123456", 6, SALT_A, key);
    }
    double ms = 1000.0 * (double)(clock() - start) / CLOCKS_PER_SEC / reps;

    printf("  %d iterations: %.1f ms/derivation on this host\n",
           VAULT_KDF_V2_ITERATIONS, ms);
    printf("  target is ~500 ms on an ESP32-S3 at 160 MHz - measure on\n");
    printf("  hardware or QEMU before trusting this number\n");
}

int main(void)
{
    test_key_and_verifier_are_independent();
    test_salt_separates_devices();
    test_determinism_and_pin_sensitivity();
    test_legacy_path_is_bit_exact();
    test_constant_time_compare();
    report_cost();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
