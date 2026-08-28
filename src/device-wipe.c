/**
 * Atomic device wipe - see device-wipe.h
 */

#include "device-wipe.h"

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "pin.h"
#include "leek-wallet.h"

static const char *TAG = "wipe";

/* A namespace of its own, because the marker has to outlive the erasure of
 * both namespaces it is guarding. Putting it in either one would erase the
 * evidence that the wipe was ever started. */
#define WIPE_NAMESPACE "leek_wipe"
#define WIPE_KEY       "pending"

static bool marker_write(uint8_t value)
{
    nvs_handle_t nvs;
    if (nvs_open(WIPE_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return false;
    }

    esp_err_t err = nvs_set_u8(nvs, WIPE_KEY, value);
    if (err == ESP_OK) {
        /* Commit before returning. An uncommitted marker is no marker at all,
         * and this is the one write in the sequence that must be durable
         * before the destructive part starts. */
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);
    return err == ESP_OK;
}

static bool marker_clear(void)
{
    nvs_handle_t nvs;
    if (nvs_open(WIPE_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return false;
    }

    esp_err_t err = nvs_erase_all(nvs);
    if (err == ESP_OK || err == ESP_ERR_NVS_NOT_FOUND) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);
    return err == ESP_OK;
}

bool device_wipe_pending(void)
{
    nvs_handle_t nvs;
    if (nvs_open(WIPE_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return false;   /* namespace absent: nothing was ever started */
    }

    uint8_t value = 0;
    esp_err_t err = nvs_get_u8(nvs, WIPE_KEY, &value);
    nvs_close(nvs);

    return err == ESP_OK && value != 0;
}

/**
 * Erase the NVS partition itself, not merely its entries.
 *
 * `nvs_erase_all()` is a bookkeeping operation: it marks entries deleted in
 * the page state bitmap and leaves the bytes where they are until NVS decides
 * to garbage-collect that page. An audit read this device's flash with
 * `esptool read_flash` and found four intact copies of a retired PIN verifier,
 * plus superseded mnemonics, IVs and salts, on a page whose sequence number
 * showed it had never been collected in the device's life. The partition is
 * six pages; a device with a few wallets never comes round to reusing them.
 *
 * So a "wiped" device still held its secrets, which is the one thing this
 * function's name promises it does not. The erase below is the flash-level
 * one, and it takes the whole partition -- including `leek_ui`, which nothing
 * else here touches and which is why a wiped device used to be handed on with
 * the previous owner's blind-signing setting still enabled.
 *
 * A power cut in the middle leaves NVS unmountable, and `app_main()` already
 * answers that by erasing and re-initialising it. The end state of an
 * interrupted wipe is therefore a blank device, which is the end state the
 * wipe was asking for.
 */
static void scrub_nvs_partition(void)
{
    esp_err_t err = nvs_flash_deinit();
    if (err != ESP_OK) {
        /* Something still holds a handle. The entry-level erase above has
         * already happened, so this degrades to the old behaviour rather than
         * to no wipe -- said out loud, because the difference is exactly what
         * an owner selling the device would want to know. */
        ESP_LOGE(TAG, "NVS still in use; secrets remain readable in flash");
        return;
    }

    err = nvs_flash_erase();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Flash-level erase failed (%s)", esp_err_to_name(err));
    }

    err = nvs_flash_init();
    if (err != ESP_OK) {
        /* Leaving NVS down would brick the device until the next boot, and
         * the next boot repairs it: app_main() erases and re-initialises when
         * the partition will not mount. */
        ESP_LOGE(TAG, "NVS did not come back up (%s); the next boot repairs it",
                 esp_err_to_name(err));
    }
}

/* The destructive half, without the marker bookkeeping. */
static void erase_everything(void)
{
    /* Wallets first: the seed is the secret that must not survive. A crash
     * after this point leaves a PIN guarding nothing, which the resume path
     * cleans up and which is harmless in the meantime. The reverse order
     * would leave the ciphertext behind with its attempt counter gone. */
    wallet_wipe();
    pin_wipe();

    /* Then take the pages themselves. Entry-level erasure first is not
     * redundant: it is what keeps the device consistent if the flash-level
     * erase cannot run because a handle is still open. */
    scrub_nvs_partition();
}

void device_wipe(void)
{
    ESP_LOGW(TAG, "Wiping device");

    /* If the marker cannot be written, wipe anyway.
     *
     * Refusing would mean a device that will not erase itself because its
     * bookkeeping failed - and the user asking for this may be under duress or
     * about to sell the thing. Losing atomicity is a far better outcome than
     * losing the wipe. */
    if (!marker_write(1)) {
        ESP_LOGE(TAG, "Could not record wipe intent; wiping unguarded");
    }

    erase_everything();

    if (!marker_clear()) {
        /* The next boot will redo a wipe that already finished. Idempotent, so
         * the cost is one wasted erase. */
        ESP_LOGE(TAG, "Could not clear wipe marker");
    }

    ESP_LOGW(TAG, "Wipe complete");
}

bool device_wipe_resume(void)
{
    if (!device_wipe_pending()) {
        return false;
    }

    ESP_LOGW(TAG, "Interrupted wipe found; finishing it");
    erase_everything();
    marker_clear();
    return true;
}
