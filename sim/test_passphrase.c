/**
 * BIP39 passphrase interop vectors (ROADMAP T41).
 *
 * Proves LeekWallet's seed derivation is byte-identical to the BIP39 standard,
 * so a seed + passphrase produces the same wallet here as on Trezor, Ledger,
 * Coldcard or Sparrow. These are known-answer tests from the BIP39 spec — if
 * one ever fails, the derivation path changed and every existing wallet just
 * became unrecoverable. Treat a failure here as a release blocker.
 */

#include <stdio.h>
#include <string.h>

#include "bip39.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static void to_hex(const uint8_t *in, size_t len, char *out)
{
    static const char *d = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[i * 2]     = d[in[i] >> 4];
        out[i * 2 + 1] = d[in[i] & 0x0F];
    }
    out[len * 2] = '\0';
}

static void check_vector(const char *label, const char *mnemonic,
                         const char *passphrase, const char *expect_hex)
{
    uint8_t seed[64];
    char got[129];

    mnemonic_to_seed(mnemonic, passphrase, seed, NULL);
    to_hex(seed, sizeof(seed), got);

    CHECK(strcmp(got, expect_hex) == 0,
          "%s\n         expected %s\n         got      %s", label, expect_hex, got);
}

/* Vectors from the BIP39 specification's English test set. */
static void test_known_vectors(void)
{
    printf("== BIP39 known-answer vectors\n");

    const char *abandon12 =
        "abandon abandon abandon abandon abandon abandon "
        "abandon abandon abandon abandon abandon about";

    check_vector("abandon x11 + about, no passphrase", abandon12, "",
        "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1"
        "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4");

    check_vector("abandon x11 + about, passphrase \"TREZOR\"", abandon12, "TREZOR",
        "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553"
        "1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04");
}

/* The properties users depend on, independent of any particular vector. */
static void test_passphrase_semantics(void)
{
    printf("== passphrase semantics\n");

    const char *m =
        "abandon abandon abandon abandon abandon abandon "
        "abandon abandon abandon abandon abandon about";

    uint8_t none[64], empty[64], a[64], b[64], case_a[64], space[64];

    mnemonic_to_seed(m, "",         none,   NULL);
    mnemonic_to_seed(m, "",         empty,  NULL);
    mnemonic_to_seed(m, "leek",     a,      NULL);
    mnemonic_to_seed(m, "leek2",    b,      NULL);
    mnemonic_to_seed(m, "Leek",     case_a, NULL);
    mnemonic_to_seed(m, "leek ",    space,  NULL);

    CHECK(memcmp(none, empty, 64) == 0, "empty passphrase is not deterministic");
    CHECK(memcmp(none, a, 64) != 0, "a passphrase did not change the seed");
    CHECK(memcmp(a, b, 64) != 0, "different passphrases produced the same seed");

    /* Both of these are why a mistyped passphrase silently opens an empty
     * wallet instead of erroring - the UI must surface a fingerprint. */
    CHECK(memcmp(a, case_a, 64) != 0, "passphrase is not case-sensitive");
    CHECK(memcmp(a, space, 64) != 0, "trailing whitespace is being ignored");
}

/* The device caps passphrases at 128 bytes (MAX_PASSPHRASE_LENGTH); trezor-crypto
 * itself reads up to 256. Anything we accept must derive stably. */
static void test_long_passphrase(void)
{
    printf("== long passphrase stability\n");

    const char *m =
        "abandon abandon abandon abandon abandon abandon "
        "abandon abandon abandon abandon abandon about";

    char longpass[128];
    memset(longpass, 'x', sizeof(longpass) - 1);
    longpass[sizeof(longpass) - 1] = '\0';

    uint8_t first[64], second[64];
    mnemonic_to_seed(m, longpass, first, NULL);
    mnemonic_to_seed(m, longpass, second, NULL);

    CHECK(memcmp(first, second, 64) == 0, "127-char passphrase is not deterministic");

    /* One character shorter must be a different wallet. */
    longpass[sizeof(longpass) - 2] = '\0';
    uint8_t shorter[64];
    mnemonic_to_seed(m, longpass, shorter, NULL);
    CHECK(memcmp(first, shorter, 64) != 0, "passphrase is being truncated");
}

int main(void)
{
    test_known_vectors();
    test_passphrase_semantics();
    test_long_passphrase();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
