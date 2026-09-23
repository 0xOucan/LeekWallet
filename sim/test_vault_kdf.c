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

/* ========== Stored KDF parameters ==========
 *
 * The bug these cover: the work factor was a compile-time #define and nothing
 * else. Nothing recorded what a given vault had been derived with, so editing
 * the constant - which is exactly what adding Argon2id or retuning PBKDF2
 * means - would have orphaned every vault already in the field, silently, with
 * a real seed inside it.
 */

static void test_absent_params_still_open_old_vaults(void)
{
    printf("== a vault with no recorded parameters keeps its old derivation\n");

    /* Every device shipped before parameters were stored has no blob. That
     * case must not be an error, and must not change a single derived byte -
     * this is the backward-compatibility requirement, stated as a test. */
    VaultKdfParams p;
    memset(&p, 0xAA, sizeof(p));
    CHECK(vault_params_parse(NULL, 0, VAULT_KDF_V3, &p),
          "absent parameter blob reported as an error");
    CHECK(p.family == VAULT_KDF_FAMILY_PBKDF2_SHA512,
          "absent blob did not default to PBKDF2-HMAC-SHA512");
    CHECK(p.iterations == VAULT_KDF_V2_ITERATIONS,
          "absent blob defaulted to %u iterations, not %d",
          (unsigned)p.iterations, VAULT_KDF_V2_ITERATIONS);

    uint8_t legacy_key[32], params_key[32];
    vault_derive_key(VAULT_KDF_V3, "123456", 6, SALT_A, legacy_key);
    vault_derive_key_with(&p, "123456", 6, SALT_A, params_key);
    CHECK(memcmp(legacy_key, params_key, 32) == 0,
          "an unrecorded-parameter vault derives a different key than before");

    uint8_t legacy_ver[32], params_ver[32];
    vault_derive_verifier(VAULT_KDF_V3, "123456", 6, SALT_A, legacy_ver);
    vault_derive_verifier_with(&p, "123456", 6, SALT_A, params_ver);
    CHECK(memcmp(legacy_ver, params_ver, 32) == 0,
          "an unrecorded-parameter vault derives a different verifier than before");
}

static void test_work_factor_actually_travels(void)
{
    printf("== the recorded work factor is the one used\n");

    /* The point of storing parameters is that the stored value, not the
     * build's constant, decides the derivation. If this passes with both
     * counts producing the same key, the parameters are decoration and the
     * next change to the work factor orphans every vault. */
    VaultKdfParams base, raised;
    vault_params_default(VAULT_KDF_CURRENT, &base);
    raised = base;
    raised.iterations = VAULT_KDF_V2_ITERATIONS * 2;

    uint8_t key_base[32], key_raised[32];
    vault_derive_key_with(&base,   "123456", 6, SALT_A, key_base);
    vault_derive_key_with(&raised, "123456", 6, SALT_A, key_raised);
    CHECK(memcmp(key_base, key_raised, 32) != 0,
          "a doubled iteration count produced the same key - the stored work "
          "factor is being ignored");

    uint8_t ver_base[32], ver_raised[32];
    vault_derive_verifier_with(&base,   "123456", 6, SALT_A, ver_base);
    vault_derive_verifier_with(&raised, "123456", 6, SALT_A, ver_raised);
    CHECK(memcmp(ver_base, ver_raised, 32) != 0,
          "a doubled iteration count produced the same verifier");

    /* And a second vault recorded at the raised count must reproduce its own
     * key exactly - a changed work factor has to be stable, not just
     * different. */
    uint8_t again[32];
    vault_derive_key_with(&raised, "123456", 6, SALT_A, again);
    CHECK(memcmp(key_raised, again, 32) == 0,
          "derivation at a raised work factor is not deterministic");
}

static void test_params_round_trip_including_argon2_fields(void)
{
    printf("== parameters survive a round trip through storage\n");

    /* Argon2id is not implemented, but its three knobs have to survive the
     * format or adding it becomes a second format change on a device holding
     * someone's seed. Nothing reads these today; the test is that they are
     * carried. */
    VaultKdfParams in;
    vault_params_default(VAULT_KDF_CURRENT, &in);
    in.iterations  = 0x01020304u;
    in.mem_kib     = 65536u;
    in.time_cost   = 3u;
    in.parallelism = 4u;

    uint8_t blob[VAULT_PARAMS_BLOB_SIZE];
    CHECK(vault_params_serialize(&in, blob, sizeof(blob)) == VAULT_PARAMS_BLOB_SIZE,
          "serialize did not write a full blob");

    VaultKdfParams out;
    CHECK(vault_params_parse(blob, sizeof(blob), VAULT_KDF_CURRENT, &out),
          "a blob this build wrote did not parse");
    CHECK(out.blob_version == VAULT_PARAMS_BLOB_V1, "blob version lost");
    CHECK(out.family == in.family, "family lost");
    CHECK(out.iterations == in.iterations, "iteration count lost (%u)",
          (unsigned)out.iterations);
    CHECK(out.mem_kib == in.mem_kib, "argon2 memory cost lost");
    CHECK(out.time_cost == in.time_cost, "argon2 time cost lost");
    CHECK(out.parallelism == in.parallelism, "argon2 parallelism lost");

    /* Explicitly little-endian, because this blob outlives the build that
     * wrote it and may not depend on host byte order or struct padding. */
    CHECK(blob[2] == 0x04 && blob[3] == 0x03 && blob[4] == 0x02 && blob[5] == 0x01,
          "iteration count is not stored little-endian");

    /* A short buffer is refused rather than half-written. */
    uint8_t tiny[VAULT_PARAMS_BLOB_SIZE - 1];
    CHECK(vault_params_serialize(&in, tiny, sizeof(tiny)) == 0,
          "serialize wrote into a buffer too small for the blob");
}

static void test_malformed_params_fall_back_safely(void)
{
    printf("== a damaged parameter blob falls back instead of deriving garbage\n");

    VaultKdfParams good;
    vault_params_default(VAULT_KDF_CURRENT, &good);
    uint8_t blob[VAULT_PARAMS_BLOB_SIZE];
    vault_params_serialize(&good, blob, sizeof(blob));

    /* Truncated. */
    VaultKdfParams out;
    memset(&out, 0, sizeof(out));
    CHECK(!vault_params_parse(blob, 3, VAULT_KDF_CURRENT, &out),
          "a truncated blob was accepted");
    CHECK(out.iterations == VAULT_KDF_V2_ITERATIONS,
          "a truncated blob left a zero work factor behind");

    /* A blob version from the future. */
    uint8_t future[VAULT_PARAMS_BLOB_SIZE];
    memcpy(future, blob, sizeof(future));
    future[0] = VAULT_PARAMS_BLOB_V1 + 7;
    memset(&out, 0, sizeof(out));
    CHECK(!vault_params_parse(future, sizeof(future), VAULT_KDF_CURRENT, &out),
          "an unknown blob version was accepted");
    CHECK(out.iterations == VAULT_KDF_V2_ITERATIONS,
          "an unknown blob version left a zero work factor behind");

    /* A KDF family this build cannot compute - what a downgrade from an
     * Argon2id vault looks like. Guessing would write ciphertext nobody can
     * read back. */
    uint8_t alien[VAULT_PARAMS_BLOB_SIZE];
    memcpy(alien, blob, sizeof(alien));
    alien[1] = 0x7F;
    memset(&out, 0, sizeof(out));
    CHECK(!vault_params_parse(alien, sizeof(alien), VAULT_KDF_CURRENT, &out),
          "an unknown KDF family was accepted");
    CHECK(out.family == VAULT_KDF_FAMILY_PBKDF2_SHA512,
          "an unknown family was left in place rather than replaced");

    /* Whatever happens, the fallback derives the same key an existing device
     * would - a damaged blob must not lock anyone out. */
    uint8_t fallback_key[32], reference[32];
    vault_derive_key_with(&out, "123456", 6, SALT_A, fallback_key);
    vault_derive_key(VAULT_KDF_V3, "123456", 6, SALT_A, reference);
    CHECK(memcmp(fallback_key, reference, 32) == 0,
          "the fallback derivation does not match an existing vault's");
}

static void test_current_version_params_are_self_consistent(void)
{
    printf("== the version-keyed entry points agree with their defaults\n");

    /* vault_derive_key(v, ...) must be exactly vault_derive_key_with() on
     * vault_params_default(v). Callers picking one or the other - the boot
     * benchmark, the migration - must not be choosing between two answers. */
    for (int v = VAULT_KDF_V1_LEGACY; v <= VAULT_KDF_CURRENT; v++) {
        VaultKdfParams p;
        vault_params_default((VaultKdfVersion)v, &p);

        uint8_t a[32], b[32];
        vault_derive_key((VaultKdfVersion)v, "4321", 4, SALT_B, a);
        vault_derive_key_with(&p, "4321", 4, SALT_B, b);
        CHECK(memcmp(a, b, 32) == 0, "v%d key: entry points disagree", v);

        vault_derive_verifier((VaultKdfVersion)v, "4321", 4, SALT_B, a);
        vault_derive_verifier_with(&p, "4321", 4, SALT_B, b);
        CHECK(memcmp(a, b, 32) == 0, "v%d verifier: entry points disagree", v);
    }
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
    test_absent_params_still_open_old_vaults();
    test_work_factor_actually_travels();
    test_params_round_trip_including_argon2_fields();
    test_malformed_params_fall_back_safely();
    test_current_version_params_are_self_consistent();
    report_cost();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
