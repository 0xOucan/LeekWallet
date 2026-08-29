/**
 * Host-native tests for the temporary seed (T69), against the real vault.
 *
 * The mode makes exactly one promise: a seed used this way is never written
 * down, so a device that is not powered holds nothing about it. A promise
 * about storage is a statement about stored bytes or it is nothing, which is
 * why this suite links components/leek-wallet.c rather than a stand-in, and
 * asserts against the simulated flash itself - the same tool
 * docs/AUDIT-SECRETS.md's F1 fix is proved with (fake_nvs_contains_bytes).
 *
 * The screen half of the feature - that the device says it is in the mode, and
 * what that costs - is in test_ui.c, which can see the framebuffer.
 */

#include <stdio.h>
#include <string.h>

#include "esp_stubs.h"
#include "fake_nvs.h"
#include "leek-wallet.h"
#include "memzero.h"
#include "sha2.h"

void wallet__reset_static_state_for_test(void);

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Two distinct BIP39 vectors: one the device stores, one it must never store. */
static const char *STORED =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";
static const char *TEMPORARY =
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";

#define PIN "482913"

/* m/44'/60'/0'/0/0. Addresses are asked for by path here, as the screens do:
 * wallet_get_eth_address() reads whatever node a previous wallet_select_path()
 * left behind, which is not a question about this feature. */
static const HDPath ETH0 = HDPATH_ETH_DEFAULT;

static void fresh_device(void)
{
    fake_nvs_reset();
    wallet__reset_static_state_for_test();
    wallet_init();
    CHECK(wallet_set_password(PIN, strlen(PIN)) == WALLET_OK, "setup: no password");
    CHECK(wallet_unlock(PIN, strlen(PIN)) == WALLET_OK, "setup: no unlock");
}

/* A device with one stored wallet, unlocked. */
static void device_with_a_stored_wallet(void)
{
    fresh_device();
    CHECK(wallet_add_mnemonic(STORED) == 1, "setup: could not store a seed");
    CHECK(wallet_select_wallet(1) == WALLET_OK, "setup: could not select it");
}

static void reboot(void)
{
    fake_nvs_reboot();
    wallet__reset_static_state_for_test();
    wallet_init();
}

/* ------------------------------------------------------------------ storage
 *
 * Not "is the phrase in flash" alone. A check value would confirm a guess just
 * as completely as the phrase itself, so everything the mode could plausibly
 * have leaked is looked for: the words, each word on its own, the seed's own
 * fingerprint, and the address it derives - any one of which would let an
 * attacker holding the flash confirm which seed was used here.
 */
static bool anything_about_it_is_in_flash(const char *phrase)
{
    if (fake_nvs_contains_bytes(phrase, strlen(phrase))) {
        return true;
    }

    /* SHA-256 of the phrase: the cheapest check value anyone would reach for,
     * and the shape of thing F1 was. Looked for so that a future "just cache a
     * hash so we can tell the seed changed" cannot pass this suite quietly. */
    uint8_t digest[32];
    sha256_Raw((const uint8_t *)phrase, strlen(phrase), digest);
    if (fake_nvs_contains_bytes(digest, sizeof(digest))) {
        return true;
    }

    /* Words on their own. A phrase reassembled with different spacing, or a
     * partial write, would miss the whole-string scan. */
    const char *p = phrase;
    while (*p) {
        char word[16];
        size_t k = 0;
        while (*p && *p != ' ' && k < sizeof(word) - 1) {
            word[k++] = *p++;
        }
        word[k] = '\0';
        while (*p == ' ') {
            p++;
        }
        /* Four characters is enough to identify a BIP39 word and short enough
         * to still be specific; whole short words like "cage" are used as-is. */
        if (k >= 4 && fake_nvs_contains_bytes(word, k)) {
            return true;
        }
    }

    return false;
}

static bool derived_material_is_in_flash(void)
{
    EthAddress addr;
    uint32_t fp = 0;
    bool found = false;

    if (wallet_get_address_at_path(&ETH0, &addr) == WALLET_OK) {
        found = found || fake_nvs_contains_bytes(addr.hex, strlen(addr.hex));
    }
    if (wallet_get_master_fingerprint(&fp) == WALLET_OK) {
        found = found || fake_nvs_contains_bytes(&fp, sizeof(fp));
    }
    return found;
}

static void test_nothing_reaches_storage(void)
{
    printf("== a temporary seed writes nothing, anywhere in flash (T69)\n");
    device_with_a_stored_wallet();

    const int writes_before = fake_nvs_write_count();

    CHECK(wallet_use_temporary_mnemonic(TEMPORARY) == WALLET_OK,
          "the temporary seed was refused");
    CHECK(wallet_has_temporary_mnemonic(), "the mode did not take effect");

    /* The strongest form of the claim: not a single NVS write happened. No
     * ciphertext, no IV, no wallet count, no active index, no backup bit, no
     * flag recording that the mode was ever used. */
    CHECK(fake_nvs_write_count() == writes_before,
          "%d write(s) reached flash on the temporary-seed path",
          fake_nvs_write_count() - writes_before);

    CHECK(!anything_about_it_is_in_flash(TEMPORARY),
          "something that identifies the temporary seed is in flash");
    CHECK(!derived_material_is_in_flash(),
          "an address or fingerprint derived from the temporary seed is in "
          "flash - either would confirm a guess at the seed");

    /* Deriving and signing must not write either: the interesting leak is the
     * one that happens on use, not on entry. */
    const int writes_after_entry = fake_nvs_write_count();
    EthAddress addr;
    CHECK(wallet_get_address_at_path(&ETH0, &addr) == WALLET_OK,
          "no address off the temporary seed");
    uint8_t digest[32];
    memset(digest, 0xAB, sizeof(digest));
    EthSignature sig;
    CHECK(wallet_sign_hash_at_path(&ETH0, digest, &sig) == WALLET_OK,
          "could not sign with the temporary seed");
    CHECK(fake_nvs_write_count() == writes_after_entry,
          "using the temporary seed wrote %d entries to flash",
          fake_nvs_write_count() - writes_after_entry);
    CHECK(!anything_about_it_is_in_flash(TEMPORARY),
          "using the temporary seed put something identifying it in flash");

    /* The stored wallet underneath is untouched and still opens. */
    CHECK(wallet_get_count() == 1, "the wallet count moved to %u",
          (unsigned)wallet_get_count());
    CHECK(wallet_select_wallet(1) == WALLET_OK, "the stored wallet stopped opening");
}

static void test_a_reboot_loses_it(void)
{
    printf("== a reboot loses the temporary seed and leaves no trace of it\n");
    device_with_a_stored_wallet();
    CHECK(wallet_use_temporary_mnemonic(TEMPORARY) == WALLET_OK, "not adopted");

    reboot();
    CHECK(!wallet_has_temporary_mnemonic(), "the mode survived a power cycle");
    CHECK(!anything_about_it_is_in_flash(TEMPORARY),
          "the temporary seed is recoverable from flash after a reboot");

    /* And the device comes back as it was: same PIN, same stored wallet, and
     * the user's own selection restored rather than the temporary mode's 0. */
    CHECK(wallet_unlock(PIN, strlen(PIN)) == WALLET_OK, "the PIN stopped working");
    CHECK(wallet_get_count() == 1, "the stored wallet did not come back");
    CHECK(wallet_get_active_index() == 1,
          "the active wallet came back as %u, not the user's selection",
          (unsigned)wallet_get_active_index());
}

/* ------------------------------------------------------- the clearing paths */

static void check_cleared(const char *path)
{
    CHECK(!wallet_has_temporary_mnemonic(), "%s: the temporary seed survived", path);

    char leaked[256];
    memset(leaked, 0, sizeof(leaked));
    if (wallet_get_mnemonic(leaked, sizeof(leaked)) == WALLET_OK) {
        CHECK(strcmp(leaked, TEMPORARY) != 0,
              "%s: the vault still hands out the temporary phrase", path);
    }
    memzero(leaked, sizeof(leaked));
}

static void test_every_clearing_path(void)
{
    printf("== lock, wallet switch and wipe each destroy the temporary seed\n");

    /* Lock - the same call auto-lock and the host lock both reach. */
    device_with_a_stored_wallet();
    CHECK(wallet_use_temporary_mnemonic(TEMPORARY) == WALLET_OK, "not adopted");
    wallet_lock();
    check_cleared("lock");
    EthAddress addr;
    CHECK(wallet_get_address_at_path(&ETH0, &addr) != WALLET_OK,
          "lock: the locked device still derives addresses");

    /* Wallet switch, with the vault still open: the state this feature refuses
     * to have is two seeds live at once. */
    device_with_a_stored_wallet();
    CHECK(wallet_use_temporary_mnemonic(TEMPORARY) == WALLET_OK, "not adopted");
    CHECK(wallet_select_wallet(1) == WALLET_OK, "could not switch to the stored wallet");
    check_cleared("wallet switch");
    CHECK(wallet_get_active_index() == 1, "the switch did not take effect");

    /* Wipe. */
    device_with_a_stored_wallet();
    CHECK(wallet_use_temporary_mnemonic(TEMPORARY) == WALLET_OK, "not adopted");
    CHECK(wallet_wipe() == WALLET_OK, "the wipe failed");
    check_cleared("wipe");
    CHECK(!anything_about_it_is_in_flash(TEMPORARY),
          "the wipe left something identifying the temporary seed");

    /* Adopting a second temporary seed replaces the first, rather than leaving
     * the old one anywhere. */
    device_with_a_stored_wallet();
    CHECK(wallet_use_temporary_mnemonic(TEMPORARY) == WALLET_OK, "not adopted");
    CHECK(wallet_use_temporary_mnemonic(STORED) == WALLET_OK, "the second was refused");
    CHECK(wallet_has_temporary_mnemonic(), "the replacement is not temporary");
    {
        char live[256];
        CHECK(wallet_get_mnemonic(live, sizeof(live)) == WALLET_OK, "no seed after replacing");
        CHECK(strcmp(live, TEMPORARY) != 0,
              "the first temporary seed is still what the device derives from");
        memzero(live, sizeof(live));
    }
    CHECK(!anything_about_it_is_in_flash(TEMPORARY),
          "replacing a temporary seed left the first one in flash");
}

static void test_it_is_a_different_wallet(void)
{
    printf("== the device really derives from the typed seed, not the stored one\n");
    device_with_a_stored_wallet();

    EthAddress stored_addr;
    CHECK(wallet_get_address_at_path(&ETH0, &stored_addr) == WALLET_OK, "no stored address");

    CHECK(wallet_use_temporary_mnemonic(TEMPORARY) == WALLET_OK, "not adopted");
    EthAddress temp_addr;
    CHECK(wallet_get_address_at_path(&ETH0, &temp_addr) == WALLET_OK, "no temporary address");

    CHECK(strcmp(stored_addr.hex, temp_addr.hex) != 0,
          "the temporary seed derives the stored wallet's address (%s) - the "
          "typed phrase is not the one being used", temp_addr.hex);

    /* The passphrase applies on top of it exactly as it does to a stored seed,
     * so the two secrets keep behaving as one lifetime rather than two. */
    CHECK(wallet_set_passphrase("hidden", 6) == WALLET_OK, "no passphrase");
    EthAddress hidden;
    CHECK(wallet_get_address_at_path(&ETH0, &hidden) == WALLET_OK,
          "no address with a passphrase");
    CHECK(strcmp(hidden.hex, temp_addr.hex) != 0,
          "the passphrase did not change the temporary wallet");
    CHECK(!anything_about_it_is_in_flash(TEMPORARY),
          "a passphrase over a temporary seed put something in flash");
}

static void test_it_refuses_what_it_should(void)
{
    printf("== a temporary seed still needs an unlocked device and a valid phrase\n");

    /* Locked: the mode is not a way past the PIN gate. */
    device_with_a_stored_wallet();
    wallet_lock();
    CHECK(wallet_use_temporary_mnemonic(TEMPORARY) == WALLET_ERROR_LOCKED,
          "a locked device accepted a temporary seed");
    CHECK(!wallet_has_temporary_mnemonic(), "the mode started on a locked device");

    /* A mistyped phrase is a typo, and is rejected before anything derives. */
    device_with_a_stored_wallet();
    const char *bad =
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage abandon";
    CHECK(wallet_use_temporary_mnemonic(bad) == WALLET_ERROR_INVALID_MNEMONIC,
          "a phrase that fails its checksum was accepted");
    CHECK(!wallet_has_temporary_mnemonic(), "a bad phrase started the mode");
    CHECK(!anything_about_it_is_in_flash(bad), "a rejected phrase reached flash");

    /* And the rejection left the stored wallet exactly as it was, rather than
     * half-replacing it. */
    CHECK(wallet_get_active_index() == 1, "a rejected phrase deselected the wallet");
    char m[256];
    CHECK(wallet_get_mnemonic(m, sizeof(m)) == WALLET_OK, "the stored seed is gone");
    CHECK(strcmp(m, STORED) == 0, "the stored seed changed under a rejected phrase");
    memzero(m, sizeof(m));

    CHECK(wallet_use_temporary_mnemonic(NULL) == WALLET_ERROR_INVALID_MNEMONIC,
          "NULL was accepted");
    CHECK(wallet_use_temporary_mnemonic("") == WALLET_ERROR_INVALID_MNEMONIC,
          "an empty phrase was accepted");
}

/* The detector has to be able to fail, or the storage assertions above prove
 * nothing. Plant the phrase in flash by the ordinary route - store it as a
 * wallet, whose ciphertext is not the plaintext - and then plant it raw. */
static void test_the_flash_scan_can_fail(void)
{
    printf("== the flash scan detects a seed that IS stored\n");
    fresh_device();

    CHECK(!anything_about_it_is_in_flash(TEMPORARY), "found on an empty device");

    nvs_handle_t nvs;
    CHECK(nvs_open("colibri", NVS_READWRITE, &nvs) == ESP_OK, "could not open NVS");
    nvs_set_blob(nvs, "planted", TEMPORARY, strlen(TEMPORARY));
    nvs_commit(nvs);
    nvs_close(nvs);

    CHECK(anything_about_it_is_in_flash(TEMPORARY),
          "the scan missed a phrase written to flash in plain sight - every "
          "other assertion in this file is worthless if this one fails");
}

int main(void)
{
    test_the_flash_scan_can_fail();
    test_nothing_reaches_storage();
    test_a_reboot_loses_it();
    test_every_clearing_path();
    test_it_is_a_different_wallet();
    test_it_refuses_what_it_should();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
