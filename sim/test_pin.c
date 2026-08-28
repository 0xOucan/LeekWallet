/**
 * Host-native tests for src/pin.c
 *
 * The interesting cases are the power-cut ones (AUDIT.md S4). The fake NVS can
 * stop accepting writes partway through an operation, so "what does the device
 * do if you yank the cable right here" becomes an assertion instead of an
 * argument.
 *
 * This suite links the real vault. It has to: pin.c stores no verifier of its
 * own any more — the PIN is the vault password, and the vault's salted PBKDF2
 * hash is the only thing in flash that can recognise it. A stubbed vault would
 * make every assertion here a statement about the stub, and the one property
 * this file exists to defend (§ no fast verifier survives anywhere in flash)
 * is a statement about real stored bytes or it is nothing.
 */

#include <stdio.h>
#include <string.h>

#include "esp_stubs.h"
#include "fake_nvs.h"
#include "leek-wallet.h"
#include "pin.h"
#include "sha2.h"

void pin__reset_static_state_for_test(void);
void wallet__reset_static_state_for_test(void);

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Fresh device: empty storage, no PIN, no vault, cleared RAM. */
static void fresh_device(void)
{
    fake_nvs_reset();
    wallet__reset_static_state_for_test();
    pin__reset_static_state_for_test();
    wallet_init();
    pin_init();
}

/* Power-cycle: storage survives, RAM does not. */
static void reboot(void)
{
    fake_nvs_reboot();
    wallet__reset_static_state_for_test();
    pin__reset_static_state_for_test();
    wallet_init();
    pin_init();
}

/* ------------------------------------------------- the retired verifier
 *
 * SHA-256 applied 101 times, unsalted: what src/pin.c used to store in
 * leek_pin/pin_hash and inside the vault record. Reproduced here so the tests
 * can plant it on a simulated field device and then prove it is gone — the
 * migration is only demonstrable against the exact bytes it has to remove.
 */
#define RETIRED_HASH_SIZE 32
#define KEY_RETIRED       "pin_hash"

static void retired_hash(const char *pin, uint8_t out[RETIRED_HASH_SIZE])
{
    uint8_t temp[32];
    sha256_Raw((const uint8_t *)pin, strlen(pin), temp);
    for (int i = 0; i < 100; i++) {
        sha256_Raw(temp, 32, temp);
    }
    memcpy(out, temp, RETIRED_HASH_SIZE);
}

/* Byte offsets inside the persisted VaultRecord: version, generation and two
 * reserved bytes, then the password verifier, then the retired companion and
 * its presence flag. Hard-coded rather than shared, deliberately — a test that
 * included the struct would follow it silently if the layout ever moved, and
 * the layout not moving is exactly what keeps field records readable. */
#define REC_COMPANION_OFF      (4 + 32)
#define REC_HAS_COMPANION_OFF  (4 + 32 + 32)

/* Turn a device provisioned by this firmware back into one provisioned by the
 * firmware before it: the retired verifier in leek_pin, and a copy inside the
 * vault record where wallet_change_password used to park it. */
static void make_legacy_verifier(const char *pin)
{
    uint8_t hash[RETIRED_HASH_SIZE];
    retired_hash(pin, hash);

    nvs_handle_t nvs;
    if (nvs_open("leek_pin", NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_blob(nvs, KEY_RETIRED, hash, sizeof(hash));
        nvs_commit(nvs);
        nvs_close(nvs);
    }

    if (nvs_open("colibri", NVS_READWRITE, &nvs) == ESP_OK) {
        uint8_t rec[128];
        size_t len = sizeof(rec);
        if (nvs_get_blob(nvs, "vault_rec", rec, &len) == ESP_OK &&
            len > REC_HAS_COMPANION_OFF) {
            memcpy(rec + REC_COMPANION_OFF, hash, sizeof(hash));
            rec[REC_HAS_COMPANION_OFF] = 1;
            nvs_set_blob(nvs, "vault_rec", rec, len);
            nvs_commit(nvs);
        }
        nvs_close(nvs);
    }
}

/* The property, asked of storage rather than of the code: nowhere in flash is
 * there a value that recognises this PIN more cheaply than the vault does.
 *
 * Searching only for the retired SHA-256x101 chain would prove that one
 * construction is gone, which is a fact about the blob that was removed rather
 * than about the property. So this sweeps the family a cheap verifier would
 * plausibly be built from - every chained SHA-256 depth this codebase has ever
 * used, plus the salted one-shot forms - and asks whether any of them appears
 * anywhere in simulated flash:
 *
 *   SHA-256^1   the obvious mistake
 *   SHA-256^2   the legacy v1 ENCRYPTION key (vault-kdf.c, VAULT_KDF_V1_LEGACY)
 *   SHA-256^3   the legacy v1 VERIFIER
 *   SHA-256^101 the retired src/pin.c verifier
 *   SHA-256(salt || pin), SHA-256(pin || salt)
 *
 * The salted forms use the device's own kdf_salt, read back out of the fake
 * NVS: a salted-but-unstretched verifier is still one hash per guess, and it
 * is exactly the shortcut somebody adds while "keeping the salt".
 *
 * Anything caught here is worth a hard look even if it is not the retired
 * blob. Nothing this firmware writes should hash the PIN cheaply at all.
 */
static bool chained_sha_in_flash(const char *pin, int depth)
{
    uint8_t h[32];
    sha256_Raw((const uint8_t *)pin, strlen(pin), h);
    for (int i = 1; i < depth; i++) {
        sha256_Raw(h, 32, h);
    }
    return fake_nvs_contains_bytes(h, sizeof(h));
}

static bool salted_sha_in_flash(const char *pin)
{
    uint8_t salt[16];
    size_t  len = sizeof(salt);
    nvs_handle_t nvs;
    if (nvs_open("colibri", NVS_READONLY, &nvs) != ESP_OK) {
        return false;
    }
    esp_err_t err = nvs_get_blob(nvs, "kdf_salt", salt, &len);
    nvs_close(nvs);
    if (err != ESP_OK || len != sizeof(salt)) {
        return false;   /* no salt yet: nothing salted can have been written */
    }

    uint8_t buf[16 + 8];
    uint8_t h[32];
    size_t  plen = strlen(pin);
    if (plen > 8) {
        plen = 8;
    }

    memcpy(buf, salt, sizeof(salt));
    memcpy(buf + sizeof(salt), pin, plen);
    sha256_Raw(buf, sizeof(salt) + plen, h);
    if (fake_nvs_contains_bytes(h, sizeof(h))) {
        return true;
    }

    memcpy(buf, pin, plen);
    memcpy(buf + plen, salt, sizeof(salt));
    sha256_Raw(buf, plen + sizeof(salt), h);
    return fake_nvs_contains_bytes(h, sizeof(h));
}

static bool fast_verifier_in_flash(const char *pin)
{
    if (fake_nvs_has("leek_pin", KEY_RETIRED)) {
        return true;
    }
    static const int depths[] = { 1, 2, 3, 101 };
    for (size_t i = 0; i < sizeof(depths) / sizeof(depths[0]); i++) {
        if (chained_sha_in_flash(pin, depths[i])) {
            return true;
        }
    }
    return salted_sha_in_flash(pin);
}

static void test_set_and_verify(void)
{
    printf("== set and verify\n");
    fresh_device();

    CHECK(pin_is_set() == false, "fresh device reports a PIN is set");
    CHECK(pin_set("123456") == true, "pin_set failed");
    CHECK(pin_is_set() == true, "PIN not persisted");
    CHECK(pin_verify("123456") == true, "correct PIN rejected");
    CHECK(pin_get_remaining_attempts() == PIN_MAX_ATTEMPTS,
          "success did not restore attempts (%d)", pin_get_remaining_attempts());
}

static void test_lengths(void)
{
    printf("== PIN lengths 4 through 8 (S2)\n");

    static const char *pins[] = {"1234", "12345", "123456", "1234567", "12345678"};
    for (size_t i = 0; i < sizeof(pins) / sizeof(pins[0]); i++) {
        fresh_device();
        CHECK(pin_set(pins[i]) == true, "could not set %zu-digit PIN", strlen(pins[i]));
        CHECK(pin_verify(pins[i]) == true, "could not verify %zu-digit PIN", strlen(pins[i]));
    }

    fresh_device();
    CHECK(pin_set("123") == false, "accepted a 3-digit PIN");
    CHECK(pin_set("123456789") == false, "accepted a 9-digit PIN");
    CHECK(pin_set("12a4") == false, "accepted a non-digit PIN");
    CHECK(pin_set("") == false, "accepted an empty PIN");
}

static void test_attempts_decrement(void)
{
    printf("== failed attempts count down to a wipe\n");
    fresh_device();
    pin_set("1234");

    CHECK(pin_verify("9999") == false, "wrong PIN accepted");
    CHECK(pin_get_remaining_attempts() == 2, "expected 2, got %d", pin_get_remaining_attempts());
    CHECK(pin_should_wipe() == false, "wiping too early");

    pin_verify("9999");
    CHECK(pin_get_remaining_attempts() == 1, "expected 1, got %d", pin_get_remaining_attempts());

    pin_verify("9999");
    CHECK(pin_get_remaining_attempts() == 0, "expected 0, got %d", pin_get_remaining_attempts());
    CHECK(pin_should_wipe() == true, "should be requesting a wipe");
}

static void test_correct_pin_restores_attempts(void)
{
    printf("== a correct PIN refunds spent attempts\n");
    fresh_device();
    pin_set("1234");

    pin_verify("9999");
    CHECK(pin_get_remaining_attempts() == 2, "setup: expected 2");

    CHECK(pin_verify("1234") == true, "correct PIN rejected");
    CHECK(pin_get_remaining_attempts() == PIN_MAX_ATTEMPTS,
          "attempts not restored (%d)", pin_get_remaining_attempts());

    reboot();
    CHECK(pin_get_remaining_attempts() == PIN_MAX_ATTEMPTS,
          "restored count did not survive reboot (%d)", pin_get_remaining_attempts());
}

/* S4, part one: the attempt must be charged before the comparison, so cutting
 * power mid-verify cannot buy a free guess. */
static void test_powercut_during_verify(void)
{
    printf("== power cut mid-verify still spends the attempt (S4)\n");
    fresh_device();
    pin_set("1234");

    /* The attempt must be durable before the verifier is even read.
     * Compare-then-decrement would report 0 writes here, and every power cut
     * during the comparison would be a free guess.
     *
     * The vault caches its record in RAM, so the probe only sees a read if the
     * cache is cold - drop it first, without re-initialising, so the read this
     * counts is the one pin_verify() itself provokes. */
    wallet__reset_static_state_for_test();
    fake_nvs_mark_io_start();
    pin_verify("9999");
    CHECK(fake_nvs_writes_before_first_read() >= 1,
          "attempt was not persisted before the hash was read (%d writes)",
          fake_nvs_writes_before_first_read());

    /* And the charge survives losing power immediately afterwards. */
    fake_nvs_crash_after(1);
    reboot();
    CHECK(pin_get_remaining_attempts() == 2,
          "power cut refunded the attempt: %d remaining (expected 2)",
          pin_get_remaining_attempts());
}

/* S4, part two: exhausting attempts and cutting power before the wipe finishes
 * must NOT hand back a fresh set of attempts on the next boot. */
static void test_powercut_during_wipe(void)
{
    printf("== power cut mid-wipe does not reset the counter (S4)\n");
    fresh_device();
    pin_set("1234");

    pin_verify("9999");
    pin_verify("9999");
    pin_verify("9999");
    CHECK(pin_get_remaining_attempts() == 0, "setup: attempts should be exhausted");
    CHECK(pin_should_wipe() == true, "setup: should be requesting a wipe");

    /* Power dies before the UI ever gets to run pin_wipe(). */
    reboot();

    CHECK(pin_get_remaining_attempts() == 0,
          "reboot handed back %d attempts with the wallet intact",
          pin_get_remaining_attempts());
    CHECK(pin_should_wipe() == true, "reboot cleared the pending wipe");
}

static void test_wipe_clears_pin(void)
{
    printf("== wipe clears the stored PIN\n");
    fresh_device();
    pin_set("1234");
    CHECK(pin_is_set() == true, "setup failed");

    /* Both halves, in the order device_wipe() uses them. Since the PIN's only
     * verifier is now the vault's, erasing the vault is what erases the PIN;
     * pin_wipe() alone takes the attempt counter and the cached PIN. */
    wallet_wipe();
    pin_wipe();
    CHECK(pin_is_set() == false, "PIN survived the wipe");
    CHECK(pin_is_unlocked() == false, "still unlocked after wipe");

    reboot();
    CHECK(pin_is_set() == false, "PIN reappeared after reboot");
    CHECK(pin_get_remaining_attempts() == PIN_MAX_ATTEMPTS,
          "a completed wipe should restore attempts");
}

static void test_lock_and_current_pin(void)
{
    printf("== lock clears the cached PIN\n");
    fresh_device();
    pin_set("123456");

    char buf[PIN_MAX_LENGTH + 1];
    CHECK(pin_get_current(buf, sizeof(buf)) == true, "cached PIN unavailable after set");
    CHECK(strcmp(buf, "123456") == 0, "cached PIN is \"%s\"", buf);

    /* S8c: a zero-length buffer must be rejected, not written to. */
    CHECK(pin_get_current(buf, 0) == false, "accepted max_len == 0");
    CHECK(pin_get_current(NULL, sizeof(buf)) == false, "accepted a NULL buffer");

    pin_lock();
    CHECK(pin_is_unlocked() == false, "still unlocked after pin_lock()");
    CHECK(pin_get_current(buf, sizeof(buf)) == false, "PIN still cached after lock");
}

static void test_change_pin(void)
{
    printf("== change PIN\n");
    fresh_device();
    pin_set("1234");

    CHECK(pin_change("9999", "5678") == false, "changed PIN with the wrong current PIN");
    CHECK(pin_verify("1234") == true, "original PIN stopped working after a failed change");

    CHECK(pin_change("1234", "567890") == true, "valid change rejected");
    CHECK(pin_verify("567890") == true, "new PIN does not verify");
    CHECK(pin_verify("1234") == false, "old PIN still works");
}


/* ------------------------------------------- the retired verifier (F1) */

static void test_legacy_device_migrates_on_unlock(void)
{
    printf("== a field device drops its retired verifier and still unlocks\n");
    fresh_device();
    pin_set("482913");
    make_legacy_verifier("482913");
    CHECK(fast_verifier_in_flash("482913"), "setup: the legacy fixture planted nothing");

    reboot();
    CHECK(pin_verify("482913") == true, "the upgraded firmware rejected the owner's PIN");
    CHECK(fast_verifier_in_flash("482913") == false,
          "the retired verifier is still somewhere in flash after unlocking");

    reboot();
    CHECK(pin_verify("482913") == true, "the PIN stopped working after the migration");
}

static void test_legacy_device_with_no_vault_migrates(void)
{
    printf("== a PIN set but never used to make a wallet still opens, once\n");

    /* The awkward case: firmware before this change wrote leek_pin/pin_hash at
     * PIN setup but only created the vault password at the first unlock, so a
     * device can carry the retired verifier and nothing else. It is the one
     * device whose PIN cannot be checked against the vault, so it is honoured
     * once and migrated on the spot. */
    fresh_device();
    uint8_t hash[RETIRED_HASH_SIZE];
    retired_hash("7788", hash);
    nvs_handle_t nvs;
    CHECK(nvs_open("leek_pin", NVS_READWRITE, &nvs) == ESP_OK, "setup: NVS");
    nvs_set_blob(nvs, KEY_RETIRED, hash, sizeof(hash));
    nvs_commit(nvs);
    nvs_close(nvs);

    reboot();
    CHECK(pin_is_set() == true, "an upgraded device forgot it had a PIN");
    CHECK(pin_verify("9999") == false, "a wrong PIN was accepted");
    pin_reset_attempts();
    CHECK(pin_verify("7788") == true, "the owner's PIN was rejected");
    CHECK(fast_verifier_in_flash("7788") == false,
          "the retired verifier survived the migration");

    reboot();
    CHECK(pin_verify("7788") == true, "the PIN did not survive the migration");
    CHECK(pin_verify("9999") == false, "a wrong PIN works after the migration");
}

static void test_no_fast_verifier_in_nvs(void)
{
    printf("== nothing this firmware writes recognises a PIN cheaply\n");

    /* Not "the code no longer calls hash_pin" — that is a fact about a diff.
     * This asks storage: after a normal life (set, unlock, change, unlock),
     * does the unsalted chained hash of any PIN this device has ever held
     * appear anywhere in flash? */
    fresh_device();
    pin_set("135790");
    CHECK(fast_verifier_in_flash("135790") == false, "pin_set wrote a fast verifier");

    reboot();
    pin_verify("135790");
    CHECK(fast_verifier_in_flash("135790") == false, "pin_verify wrote a fast verifier");

    CHECK(pin_change("135790", "246801") == true, "setup: the change was refused");
    CHECK(fast_verifier_in_flash("246801") == false, "pin_change wrote a fast verifier");
    CHECK(fast_verifier_in_flash("135790") == false,
          "the old PIN's fast verifier was left behind by the change");

    reboot();
    CHECK(fast_verifier_in_flash("246801") == false,
          "a fast verifier appeared across a reboot");

    /* A detector that cannot fail proves nothing. Plant one - under a key name
     * nothing looks for, at a non-zero offset inside a larger blob, so what is
     * being demonstrated is the byte scan and not a lookup - and require the
     * check to catch it. Then take it away again. */
    {
        uint8_t planted[64] = {0};
        uint8_t h[32];
        sha256_Raw((const uint8_t *)"246801", 6, h);
        sha256_Raw(h, 32, h);                 /* the legacy v1 encryption key */
        memcpy(planted + 17, h, sizeof(h));

        nvs_handle_t nvs;
        CHECK(nvs_open("colibri", NVS_READWRITE, &nvs) == ESP_OK, "setup: NVS");
        nvs_set_blob(nvs, "innocuous", planted, sizeof(planted));
        nvs_commit(nvs);
        CHECK(fast_verifier_in_flash("246801") == true,
              "the check cannot see a fast verifier that is definitely there");
        nvs_erase_key(nvs, "innocuous");
        nvs_commit(nvs);
        nvs_close(nvs);

        CHECK(fast_verifier_in_flash("246801") == false,
              "the planted verifier outlived its own removal");
    }
}

/*
 * The migration is two writes at most, and the demand at every cut is the same
 * one test_pin_change.c makes of a PIN change: exactly one PIN opens the
 * device afterwards, never zero. Sweeping every write rather than picking one
 * is the point — the dangerous cut is the one nobody thought of.
 */
static void test_crash_at_every_migration_write(void)
{
    printf("== a power cut during the migration never leaves zero working PINs\n");

    fresh_device();
    pin_set("482913");
    make_legacy_verifier("482913");
    reboot();
    int before = fake_nvs_write_count();
    pin_verify("482913");
    int total = fake_nvs_write_count() - before;
    printf("   sweeping %d writes (vault present)\n", total);
    CHECK(total >= 1, "the migration made %d writes; the sweep is meaningless", total);

    for (int cut = 0; cut <= total; cut++) {
        fresh_device();
        pin_set("482913");
        make_legacy_verifier("482913");
        reboot();

        fake_nvs_crash_after(cut);
        pin_verify("482913");       /* return value is irrelevant here */

        reboot();
        CHECK(pin_verify("482913") == true,
              "crash after migration write %d/%d locked the owner out", cut, total);
        pin_reset_attempts();
        CHECK(pin_verify("999999") == false,
              "crash after migration write %d/%d let a wrong PIN in", cut, total);
        pin_reset_attempts();
    }

    /* And the same sweep for the harder case: no vault password to fall back
     * on, so the migration has to write one before it erases anything. This
     * one writes more than the case above - a salt, a version marker, the
     * record and the erase - so the bound is measured rather than assumed. A
     * hard-coded bound that fell short would silently stop sweeping exactly
     * the late writes this test exists to cover. */
    int vaultless_writes;
    {
        fresh_device();
        uint8_t hash[RETIRED_HASH_SIZE];
        retired_hash("7788", hash);
        nvs_handle_t nvs;
        if (nvs_open("leek_pin", NVS_READWRITE, &nvs) == ESP_OK) {
            nvs_set_blob(nvs, KEY_RETIRED, hash, sizeof(hash));
            nvs_commit(nvs);
            nvs_close(nvs);
        }
        reboot();
        int before = fake_nvs_write_count();
        pin_verify("7788");
        vaultless_writes = fake_nvs_write_count() - before;
        printf("   sweeping %d writes (no vault)\n", vaultless_writes);
    CHECK(vaultless_writes >= 1,
              "the vault-less migration made %d writes; the sweep is meaningless",
              vaultless_writes);
    }

    for (int cut = 0; cut <= vaultless_writes; cut++) {
        fresh_device();
        uint8_t hash[RETIRED_HASH_SIZE];
        retired_hash("7788", hash);
        nvs_handle_t nvs;
        if (nvs_open("leek_pin", NVS_READWRITE, &nvs) == ESP_OK) {
            nvs_set_blob(nvs, KEY_RETIRED, hash, sizeof(hash));
            nvs_commit(nvs);
            nvs_close(nvs);
        }
        reboot();

        fake_nvs_crash_after(cut);
        pin_verify("7788");

        reboot();
        CHECK(pin_verify("7788") == true,
              "vault-less migration, crash after write %d/%d: the PIN stopped working",
              cut, vaultless_writes);
        pin_reset_attempts();
        CHECK(pin_verify("9999") == false,
              "vault-less migration, crash after write %d/%d: a wrong PIN works",
              cut, vaultless_writes);
        pin_reset_attempts();
    }
}

static void test_attempts_survive_the_migration(void)
{
    printf("== the attempt counter is not reset by the migration\n");
    fresh_device();
    pin_set("482913");
    make_legacy_verifier("482913");
    reboot();

    CHECK(pin_verify("111111") == false, "setup: a wrong PIN was accepted");
    CHECK(pin_get_remaining_attempts() == 2, "expected 2, got %d",
          pin_get_remaining_attempts());

    reboot();
    CHECK(pin_get_remaining_attempts() == 2,
          "the migration handed back attempts: %d", pin_get_remaining_attempts());

    CHECK(pin_verify("222222") == false, "a wrong PIN was accepted");
    CHECK(pin_verify("333333") == false, "a wrong PIN was accepted");
    CHECK(pin_should_wipe() == true, "three wrong PINs did not reach the wipe");

    /* And the wipe still takes everything with it, retired verifier included. */
    wallet_wipe();
    pin_wipe();
    CHECK(pin_is_set() == false, "the wipe left a PIN behind");
    CHECK(fast_verifier_in_flash("482913") == false,
          "the wipe left the retired verifier in flash");
}

int main(void)
{
    test_set_and_verify();
    test_lengths();
    test_attempts_decrement();
    test_correct_pin_restores_attempts();
    test_powercut_during_verify();
    test_powercut_during_wipe();
    test_wipe_clears_pin();
    test_lock_and_current_pin();
    test_change_pin();
    test_legacy_device_migrates_on_unlock();
    test_legacy_device_with_no_vault_migrates();
    test_no_fast_verifier_in_nvs();
    test_attempts_survive_the_migration();
    test_crash_at_every_migration_write();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
