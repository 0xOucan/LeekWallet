/**
 * Master fingerprint (XFP) against reference vectors (ROADMAP T39b).
 *
 * The roadmap's acceptance is "matches a reference implementation", so these
 * are values published elsewhere rather than whatever this code happens to
 * produce. A fingerprint that only agrees with itself identifies nothing: the
 * point of showing it is that a user can compare it against what another
 * wallet says about the same seed.
 *
 * This exercises the BIP39 -> seed -> BIP32 master -> hash160 chain directly
 * rather than through leek-wallet.c, which needs an unlocked vault. The wallet
 * function is a thin wrapper over exactly these calls; test_pin_change.c is
 * where the vault-level plumbing is covered.
 */

#include <stdio.h>
#include <string.h>

#include "bip32.h"
#include "bip39.h"
#include "curves.h"
#include "memzero.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static uint32_t xfp_of(const char *mnemonic, const char *passphrase)
{
    uint8_t seed[64];
    mnemonic_to_seed(mnemonic, passphrase ? passphrase : "", seed, NULL);

    HDNode node;
    if (hdnode_from_seed(seed, sizeof(seed), SECP256K1_NAME, &node) != 1) {
        memzero(seed, sizeof(seed));
        return 0;
    }
    hdnode_fill_public_key(&node);
    uint32_t fp = hdnode_fingerprint(&node);

    memzero(seed, sizeof(seed));
    memzero(&node, sizeof(node));
    return fp;
}

/* The industry test seed - all-zero entropy. Its XFP is published by several
 * independent implementations, which is what makes it a reference rather than
 * a self-consistency check. */
static const char *ABANDON =
    "abandon abandon abandon abandon abandon abandon "
    "abandon abandon abandon abandon abandon about";

static void test_reference_vector(void)
{
    printf("== the standard test seed matches published implementations\n");
    uint32_t fp = xfp_of(ABANDON, "");
    CHECK(fp == 0x73c5da0au, "got %08x, expected 73c5da0a", (unsigned)fp);
}

static void test_bip32_vector_one(void)
{
    printf("== BIP32 test vector 1 master fingerprint\n");

    /* Straight from BIP32: seed 000102...0f, master fingerprint 0x3442193e.
     * Entering the seed directly checks the BIP32 half on its own, so a
     * failure says which of the two stages broke. */
    uint8_t seed[16];
    for (int i = 0; i < 16; i++) {
        seed[i] = (uint8_t)i;
    }

    HDNode node;
    CHECK(hdnode_from_seed(seed, sizeof(seed), SECP256K1_NAME, &node) == 1,
          "hdnode_from_seed failed");
    hdnode_fill_public_key(&node);
    CHECK(hdnode_fingerprint(&node) == 0x3442193eu,
          "got %08x, expected 3442193e", (unsigned)hdnode_fingerprint(&node));
    memzero(&node, sizeof(node));
}

static void test_passphrase_changes_it(void)
{
    printf("== a passphrase is a different seed, and says so\n");

    /* The reason to show this on screen at all: it is the cheapest check that
     * the passphrase you typed is the passphrase you meant. A wrong one is a
     * valid wallet, just not yours, and this is what makes that visible. */
    uint32_t plain = xfp_of(ABANDON, "");
    uint32_t with  = xfp_of(ABANDON, "TREZOR");

    CHECK(plain != with, "passphrase did not change the fingerprint (%08x)",
          (unsigned)plain);
    CHECK(with != 0, "derivation with a passphrase failed");

    /* And it is deterministic - the same passphrase must reproduce it, or it
     * could not be used to recognise a wallet at all. */
    CHECK(xfp_of(ABANDON, "TREZOR") == with, "not reproducible");
}

static void test_distinct_seeds(void)
{
    printf("== different seeds have different fingerprints\n");
    const char *other =
        "legal winner thank year wave sausage worth useful legal winner thank yellow";
    CHECK(xfp_of(ABANDON, "") != xfp_of(other, ""), "two seeds collided");
}

int main(void)
{
    test_reference_vector();
    test_bip32_vector_one();
    test_passphrase_changes_it();
    test_distinct_seeds();

    if (failures) {
        printf("\nFAILED (%d failure%s)\n", failures, failures == 1 ? "" : "s");
        return 1;
    }
    printf("\nPASSED (0 failures)\n");
    return 0;
}
