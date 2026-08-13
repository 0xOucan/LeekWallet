/**
 * Change-PIN tests (ROADMAP T4, AUDIT S8e).
 *
 * The PIN is the vault password: every stored mnemonic is encrypted under a key
 * derived from it. So changing it is not a hash swap, it is a re-encryption of
 * everything the device holds, and the failure mode of getting it wrong is not
 * an error message - it is seeds locked under a key nobody can ever derive
 * again.
 *
 * The property under test is therefore not "the PIN changed". It is that at
 * every instant, including the instant the power dies, exactly one PIN opens
 * ALL the wallets. A device that comes back with half its vault under the old
 * key and half under the new is the bug this file exists to catch, and no
 * amount of testing the happy path finds it.
 *
 * Unlike the other suites here, this links the real components/leek-wallet.c.
 * A fake would prove nothing: the ordering being tested is entirely inside the
 * real code.
 */

#include <stdio.h>
#include <string.h>

#include "esp_stubs.h"
#include "fake_nvs.h"
#include "leek-wallet.h"
#include "pin.h"

void pin__reset_static_state_for_test(void);
void wallet__reset_static_state_for_test(void);

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* ------------------------------------------------------------ fixtures */

/* Real BIP39 phrases - the vault validates checksums on the way out, so a
 * decrypt with the wrong key is rejected rather than silently returning
 * garbage. That is load-bearing for these tests. */
static const char *SEEDS[] = {
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
};
#define SEED_COUNT ((int)(sizeof(SEEDS) / sizeof(SEEDS[0])))

#define OLD_PIN "112233"
#define NEW_PIN "445566"

static char expected_address[SEED_COUNT][48];

static const HDPath ETH_PATH = {
    .purpose = 44, .coin_type = 60, .account = 0, .change = 0, .address_index = 0
};

static bool address_of_selected(char *out, size_t out_size)
{
    EthAddress addr;
    if (wallet_get_address_at_path(&ETH_PATH, &addr) != WALLET_OK) {
        return false;
    }
    snprintf(out, out_size, "%s", addr.hex);
    return true;
}

/* Simulate a power cycle: storage survives, every byte of RAM does not. */
static void reboot(void)
{
    fake_nvs_reboot();
    wallet__reset_static_state_for_test();
    pin__reset_static_state_for_test();
    wallet_init();
    pin_init();
}

/* A provisioned device: a PIN, three wallets, and the addresses they derive
 * recorded so a later change can be checked against them rather than merely
 * "something decrypted". */
static void provisioned_device(int wallet_count)
{
    fake_nvs_reset();
    wallet__reset_static_state_for_test();
    pin__reset_static_state_for_test();

    wallet_init();
    wallet_set_password(OLD_PIN, strlen(OLD_PIN));
    for (int i = 0; i < wallet_count; i++) {
        wallet_add_mnemonic(SEEDS[i]);
    }
    pin_init();
    pin_set(OLD_PIN);

    memset(expected_address, 0, sizeof(expected_address));
    for (int i = 0; i < wallet_count; i++) {
        wallet_select_wallet((uint8_t)(i + 1));
        address_of_selected(expected_address[i], sizeof(expected_address[i]));
    }
    wallet_select_wallet(1);
}

/* Does this PIN open every wallet, and do they still derive the addresses they
 * derived before? "It decrypted" is not enough - a vault that opens onto the
 * wrong seeds is worse than one that does not open. */
static bool pin_opens_all(const char *pin, int wallet_count)
{
    if (wallet_unlock(pin, strlen(pin)) != WALLET_OK) {
        return false;
    }
    for (int i = 0; i < wallet_count; i++) {
        if (wallet_select_wallet((uint8_t)(i + 1)) != WALLET_OK) {
            return false;
        }
        char addr[48];
        if (!address_of_selected(addr, sizeof(addr))) {
            return false;
        }
        if (strcmp(addr, expected_address[i]) != 0) {
            return false;
        }
    }
    return true;
}

/* Rewrite the vault into the pre-generation layout: un-suffixed m_N/iv_N keys
 * and a bare pwd_hash, with no record at all. This is what is actually on
 * devices in the field, and it has to keep working. */
static void make_legacy_layout(int wallet_count)
{
    nvs_handle_t nvs;
    if (nvs_open("colibri", NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }

    /* The record holds the verifier; move it back to where a pre-generation
     * device kept it, then drop the record so the vault reads as legacy. */
    uint8_t rec[128];
    size_t rec_len = sizeof(rec);
    if (nvs_get_blob(nvs, "vault_rec", rec, &rec_len) == ESP_OK) {
        nvs_set_blob(nvs, "pwd_hash", rec + 4, 32);
    }
    nvs_erase_key(nvs, "vault_rec");

    for (int i = 1; i <= wallet_count; i++) {
        char src[16], dst[16];
        uint8_t blob[512];
        size_t len = sizeof(blob);

        snprintf(src, sizeof(src), "m0_%d", i);
        snprintf(dst, sizeof(dst), "m_%d", i);
        if (nvs_get_blob(nvs, src, blob, &len) == ESP_OK) {
            nvs_set_blob(nvs, dst, blob, len);
            nvs_erase_key(nvs, src);
        }
    }

    nvs_commit(nvs);
    nvs_close(nvs);
}

/* --------------------------------------------------------------- tests */

static void test_completed_change(void)
{
    printf("== a completed change keeps every wallet and every address\n");

    provisioned_device(SEED_COUNT);
    CHECK(pin_change(OLD_PIN, NEW_PIN), "pin_change refused a valid change");

    reboot();
    CHECK(pin_verify(NEW_PIN), "the new PIN was rejected after reboot");
    CHECK(pin_opens_all(NEW_PIN, SEED_COUNT),
          "the new PIN did not open all wallets at their original addresses");
}

static void test_old_pin_is_dead(void)
{
    printf("== the old PIN stops working, the new one starts\n");

    provisioned_device(SEED_COUNT);
    CHECK(pin_change(OLD_PIN, NEW_PIN), "pin_change refused a valid change");
    reboot();

    CHECK(!pin_verify(OLD_PIN), "the old PIN still unlocks the device");
    pin_reset_attempts();
    CHECK(wallet_unlock(OLD_PIN, strlen(OLD_PIN)) != WALLET_OK,
          "the vault still opens with the old password");
    CHECK(wallet_unlock(NEW_PIN, strlen(NEW_PIN)) == WALLET_OK,
          "the vault does not open with the new password");
}

static void test_wrong_current_pin_changes_nothing(void)
{
    printf("== a wrong current PIN leaves the vault exactly as it was\n");

    provisioned_device(SEED_COUNT);
    int writes_before = fake_nvs_write_count();

    CHECK(!pin_change("999999", NEW_PIN), "a wrong current PIN was accepted");

    /* One write is expected and only one: the spent attempt. Anything more
     * means the vault was touched on a rejected change. */
    CHECK(fake_nvs_write_count() - writes_before <= 1,
          "a rejected change wrote to storage %d times",
          fake_nvs_write_count() - writes_before);

    reboot();
    CHECK(pin_opens_all(OLD_PIN, SEED_COUNT),
          "the original PIN no longer opens the vault after a rejected change");
    CHECK(!pin_opens_all(NEW_PIN, SEED_COUNT),
          "the rejected new PIN opens the vault");
}

/*
 * The core of the suite. Cut power at every single write of the change, one
 * run per write, and demand the same thing each time: after the reboot exactly
 * one PIN opens ALL the wallets.
 *
 * Sweeping every write rather than a few chosen ones is deliberate. The
 * dangerous point is not one a test author picks - it is whichever one they
 * did not think of.
 */
static void test_crash_at_every_write(void)
{
    printf("== a power cut at any point leaves exactly one PIN opening everything\n");

    /* Establish the length of the operation, so the sweep covers it. */
    provisioned_device(SEED_COUNT);
    int before = fake_nvs_write_count();
    pin_change(OLD_PIN, NEW_PIN);
    int total_writes = fake_nvs_write_count() - before;
    CHECK(total_writes > 3, "the change only made %d writes; sweep is meaningless",
          total_writes);

    for (int cut = 0; cut <= total_writes; cut++) {
        provisioned_device(SEED_COUNT);

        fake_nvs_crash_after(cut);
        pin_change(OLD_PIN, NEW_PIN);   /* return value is irrelevant here */

        reboot();

        bool old_works = pin_opens_all(OLD_PIN, SEED_COUNT);
        wallet_lock();
        pin_reset_attempts();
        bool new_works = pin_opens_all(NEW_PIN, SEED_COUNT);
        wallet_lock();
        pin_reset_attempts();

        /* Exactly one. Neither means the vault is bricked; both would mean a
         * key is reachable from two secrets, which is its own problem. */
        CHECK(old_works != new_works,
              "crash after write %d/%d: old=%d new=%d (want exactly one)",
              cut, total_writes, old_works, new_works);

        /* And the PIN gate has to agree with the vault, or the user is locked
         * out of a vault that would have opened. This is the half-state that
         * a separately-stored PIN hash would produce. */
        pin__reset_static_state_for_test();
        pin_init();
        bool pin_old = pin_verify(OLD_PIN);
        pin_reset_attempts();
        bool pin_new = pin_verify(NEW_PIN);
        pin_reset_attempts();

        CHECK(pin_old == old_works && pin_new == new_works,
              "crash after write %d/%d: PIN gate (old=%d new=%d) disagrees with "
              "the vault (old=%d new=%d)",
              cut, total_writes, pin_old, pin_new, old_works, new_works);
    }
}

static void test_legacy_layout_survives(void)
{
    printf("== a pre-generation vault opens, changes, and still opens\n");

    provisioned_device(SEED_COUNT);
    make_legacy_layout(SEED_COUNT);
    reboot();

    CHECK(pin_opens_all(OLD_PIN, SEED_COUNT),
          "the legacy vault did not open with its own PIN");

    CHECK(pin_change(OLD_PIN, NEW_PIN), "pin_change refused a legacy vault");
    reboot();

    CHECK(pin_opens_all(NEW_PIN, SEED_COUNT),
          "the legacy vault's seeds did not survive the PIN change");
    CHECK(!fake_nvs_has("colibri", "m_1"),
          "the legacy ciphertext was left behind under the retired key");
}

static void test_legacy_layout_crash_sweep(void)
{
    printf("== a power cut mid-change on a legacy vault is equally safe\n");

    provisioned_device(SEED_COUNT);
    make_legacy_layout(SEED_COUNT);
    reboot();
    int before = fake_nvs_write_count();
    pin_change(OLD_PIN, NEW_PIN);
    int total_writes = fake_nvs_write_count() - before;

    for (int cut = 0; cut <= total_writes; cut++) {
        provisioned_device(SEED_COUNT);
        make_legacy_layout(SEED_COUNT);
        reboot();

        fake_nvs_crash_after(cut);
        pin_change(OLD_PIN, NEW_PIN);

        reboot();

        bool old_works = pin_opens_all(OLD_PIN, SEED_COUNT);
        wallet_lock();
        pin_reset_attempts();
        bool new_works = pin_opens_all(NEW_PIN, SEED_COUNT);
        wallet_lock();
        pin_reset_attempts();

        CHECK(old_works != new_works,
              "legacy, crash after write %d/%d: old=%d new=%d (want exactly one)",
              cut, total_writes, old_works, new_works);
    }
}

/*
 * The pre-check earns its keep only when a slot is unreadable, so break one.
 * Overwriting a mnemonic blob with rubbish makes it fail its BIP39 checksum on
 * decrypt, which is exactly how a corrupt slot presents itself.
 */
static void test_unreadable_wallet_aborts(void)
{
    printf("== an unreadable wallet aborts the change with the vault untouched\n");

    provisioned_device(SEED_COUNT);

    nvs_handle_t nvs;
    if (nvs_open("colibri", NVS_READWRITE, &nvs) == ESP_OK) {
        uint8_t rubbish[64];
        memset(rubbish, 0xA5, sizeof(rubbish));
        nvs_set_blob(nvs, "m0_2", rubbish, sizeof(rubbish));
        nvs_commit(nvs);
        nvs_close(nvs);
    }

    CHECK(!pin_change(OLD_PIN, NEW_PIN),
          "the change went ahead with an unreadable wallet");

    reboot();
    CHECK(pin_verify(OLD_PIN), "the old PIN stopped working after a refused change");
    pin_reset_attempts();
    CHECK(!pin_verify(NEW_PIN), "the new PIN works after a refused change");

    /* Wallet 1 was fine and must be untouched - the refusal must not have
     * partially converted the vault. */
    CHECK(wallet_unlock(OLD_PIN, strlen(OLD_PIN)) == WALLET_OK,
          "the vault will not open at all after a refused change");
    CHECK(wallet_select_wallet(1) == WALLET_OK, "wallet 1 was lost to the refusal");
}

static void test_short_new_pin_refused(void)
{
    printf("== a malformed new PIN is refused before anything happens\n");

    provisioned_device(1);
    int before = fake_nvs_write_count();

    CHECK(!pin_change(OLD_PIN, "1"), "a 1-digit PIN was accepted");
    CHECK(fake_nvs_write_count() == before,
          "a malformed new PIN still wrote to storage");

    CHECK(pin_opens_all(OLD_PIN, 1), "the original PIN stopped working");
}

int main(void)
{
    test_completed_change();
    test_old_pin_is_dead();
    test_wrong_current_pin_changes_nothing();
    test_short_new_pin_refused();
    test_unreadable_wallet_aborts();
    test_legacy_layout_survives();
    test_crash_at_every_write();
    test_legacy_layout_crash_sweep();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
