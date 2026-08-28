/**
 * Atomic wipe tests (ROADMAP T5, AUDIT S7).
 *
 * The property is not "wipe erases things" — that was never in doubt. It is
 * that a wipe interrupted at *any* point completes on the next boot, and that
 * the device never comes back half-wiped and usable. So every test here cuts
 * power somewhere different and then reboots.
 *
 * `wallet_wipe()` is stubbed. The real one lives in a component that pulls in
 * BIP32 and the vault, none of which this is testing: what matters is that it
 * was called, in the right order relative to the PIN, and again on resume.
 */

#include <stdio.h>
#include <string.h>

#include "esp_stubs.h"
#include "fake_nvs.h"
#include "pin.h"
#include "device-wipe.h"
#include "leek-wallet.h"

void pin__reset_static_state_for_test(void);

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* ------------------------------------------------------- wallet stub */

/* Stands in for the encrypted mnemonics: a key in the wallet's own namespace,
 * so the fake NVS can show whether the erase actually reached it. */
#define WALLET_NS  "colibri"
#define WALLET_KEY "m_1"

static int wallet_wipe_calls = 0;

WalletError wallet_wipe(void)
{
    wallet_wipe_calls++;

    nvs_handle_t nvs;
    if (nvs_open(WALLET_NS, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_erase_all(nvs);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
    return WALLET_OK;
}

static void store_fake_wallet(void)
{
    nvs_handle_t nvs;
    if (nvs_open(WALLET_NS, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_u8(nvs, WALLET_KEY, 0x42);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
}

static bool wallet_present(void) { return fake_nvs_has(WALLET_NS, WALLET_KEY); }

/* ------------------------------------------------------------ harness */

static void provisioned_device(void)
{
    fake_nvs_reset();
    pin__reset_static_state_for_test();
    pin_init();
    pin_set("123456");
    store_fake_wallet();
    wallet_wipe_calls = 0;
}

static void reboot(void)
{
    fake_nvs_reboot();
    pin__reset_static_state_for_test();
    pin_init();
}

/* ------------------------------------------------------------- tests */

static void test_clean_wipe(void)
{
    printf("== a wipe that completes leaves nothing and no marker\n");
    provisioned_device();

    device_wipe();

    CHECK(wallet_wipe_calls == 1, "wallet_wipe called %d times", wallet_wipe_calls);
    CHECK(!wallet_present(), "wallet data survived");
    CHECK(pin_is_set() == false, "PIN survived");
    CHECK(device_wipe_pending() == false, "marker left behind");

    reboot();
    CHECK(pin_is_set() == false, "PIN reappeared after reboot");
    CHECK(!wallet_present(), "wallet reappeared after reboot");
    CHECK(device_wipe_pending() == false, "marker reappeared after reboot");
}

static void test_idempotent(void)
{
    printf("== wiping an already-wiped device is harmless\n");
    provisioned_device();

    device_wipe();
    device_wipe();

    CHECK(pin_is_set() == false, "PIN came back");
    CHECK(device_wipe_pending() == false, "marker left behind");
    CHECK(device_wipe_resume() == false, "resume claimed work on a clean device");
}

static void test_wallet_dies_first(void)
{
    printf("== the seed is erased before the PIN\n");
    provisioned_device();

    /* Cut power in the window between the two erases and look at what flash
     * kept. If only one can survive, it must not be the seed's - so the wallet
     * namespace has to go first, and this asserts the order the way the device
     * would actually experience it. */
    fake_nvs_crash_after(2);
    device_wipe();

    CHECK(!wallet_present(), "the seed outlived a crash mid-wipe");
    /* The attempt counter, not a PIN hash: the PIN's only verifier now lives
     * in the vault's own namespace, so the wallet erase takes it along - which
     * is the right way round, and leaves this counter as the thing that proves
     * pin_wipe() had not run yet. */
    CHECK(fake_nvs_has("leek_pin", "attempts"),
          "setup: expected the PIN state to still be there at this crash point");
}

static void test_crash_between_the_two_erases(void)
{
    printf("== power cut between the two erases finishes on the next boot (S7)\n");
    provisioned_device();

    /* Let the marker commit and the wallet erase land, then cut power. This is
     * the exact window S7 describes: ciphertext gone, PIN still standing. */
    fake_nvs_crash_after(2);
    device_wipe();

    CHECK(fake_nvs_crashed(), "the injected crash never fired - test is not testing anything");

    reboot();

    /* The marker committed before the crash, so the pending wipe is visible. */
    CHECK(device_wipe_pending() == true, "the interrupted wipe left no marker");

    int before = wallet_wipe_calls;
    CHECK(device_wipe_resume() == true, "resume did not report finishing a wipe");
    CHECK(wallet_wipe_calls == before + 1, "resume did not re-erase the wallet");
    CHECK(pin_is_set() == false, "the PIN survived the resumed wipe");
    CHECK(device_wipe_pending() == false, "marker survived a completed resume");
}

static void test_crash_before_anything_is_erased(void)
{
    printf("== power cut right after the marker still completes\n");
    provisioned_device();

    /* Crash immediately after the marker's commit: nothing has been erased. */
    fake_nvs_crash_after(1);
    device_wipe();

    reboot();
    CHECK(device_wipe_pending() == true, "no marker after a crash past the marker write");
    CHECK(device_wipe_resume() == true, "resume found nothing to do");
    CHECK(pin_is_set() == false, "PIN survived");
    CHECK(!wallet_present(), "wallet survived");
}

static void test_crash_before_the_marker(void)
{
    printf("== power cut before the marker leaves the device untouched\n");
    provisioned_device();

    /* Nothing commits at all. The device is exactly as it was, which is the
     * correct outcome: no wipe was ever durably requested. */
    fake_nvs_crash_now();
    device_wipe();

    reboot();
    CHECK(pin_is_set() == true, "the PIN was erased despite no durable wipe request");
    CHECK(wallet_present(), "the wallet was erased despite no durable wipe request");
    CHECK(device_wipe_pending() == false, "a marker appeared from a dropped write");
}

static void test_resume_is_a_noop_on_a_healthy_device(void)
{
    printf("== resume does nothing to a device that never started a wipe\n");
    provisioned_device();

    CHECK(device_wipe_pending() == false, "fresh device reports a pending wipe");
    CHECK(device_wipe_resume() == false, "resume claimed to wipe a healthy device");
    CHECK(wallet_wipe_calls == 0, "resume erased a healthy device's wallet");
    CHECK(pin_is_set() == true, "resume erased a healthy device's PIN");
}

int main(void)
{
    test_clean_wipe();
    test_idempotent();
    test_wallet_dies_first();
    test_crash_between_the_two_erases();
    test_crash_before_anything_is_erased();
    test_crash_before_the_marker();
    test_resume_is_a_noop_on_a_healthy_device();


    /* -------------------------------------------------------------------
     * A wipe takes the partition, not just the entries.
     *
     * `nvs_erase_all()` marks entries deleted and leaves the bytes in place
     * until NVS garbage-collects the page, which on a six-page partition with
     * a few wallets may be never. An audit read this device's flash and found
     * four intact copies of a retired PIN verifier that way.
     *
     * The host model has no pages, so what it can check is that settings no
     * part of the wipe path touches are gone afterwards -- `leek_ui` is erased
     * by nothing else, and a wiped device used to be handed on with the
     * previous owner's blind-signing preference still enabled. Proving the
     * *bytes* are gone needs `esptool read_flash` on a board, before and
     * after; this test cannot and does not claim it.
     */
    printf("== a wipe erases settings nothing else touches\n");
    {
        provisioned_device();

        nvs_handle_t nvs;
        CHECK(nvs_open("leek_ui", NVS_READWRITE, &nvs) == ESP_OK, "could not open settings");
        CHECK(nvs_set_u8(nvs, "blind", 1) == ESP_OK, "could not set blind signing");
        CHECK(nvs_commit(nvs) == ESP_OK, "could not commit the setting");
        nvs_close(nvs);
        CHECK(fake_nvs_has("leek_ui", "blind"), "setup: the setting was not stored");

        device_wipe();
        reboot();

        CHECK(!fake_nvs_has("leek_ui", "blind"),
              "a setting outside the wipe path survived the wipe");
    }

    if (failures) {
        printf("FAILED (%d failure(s))\n", failures);
        return 1;
    }
    printf("PASSED (0 failures)\n");
    return 0;
}
