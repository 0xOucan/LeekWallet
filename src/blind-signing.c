/**
 * Blind signing setting - see blind-signing.h
 */

#include "blind-signing.h"

#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "blind";

/* Shares the UI's settings namespace: this is a preference, not a secret, and
 * it must be erased by exactly the same wipe that erases the wallet. Its own
 * namespace would be one more thing to remember to clear. */
#define BLIND_NAMESPACE "leek_ui"
#define BLIND_KEY       "blindsig"

/* Cached rather than read per transaction, because the read happens on the
 * protocol task in the middle of a signing decision and a flash error there
 * must not be able to flip the answer. `loaded` is what makes the default
 * survive a device that has never stored the key. */
static bool loaded  = false;
static bool enabled = false;

static void load_once(void)
{
    if (loaded) {
        return;
    }
    loaded = true;
    enabled = false;      /* the default, and the answer if NVS says nothing */

    nvs_handle_t nvs;
    if (nvs_open(BLIND_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }
    uint8_t stored = 0;
    if (nvs_get_u8(nvs, BLIND_KEY, &stored) == ESP_OK) {
        /* Only an exact 1 turns it on. Any other byte is a setting this
         * firmware did not write, and the safe reading of a corrupt
         * protection flag is "protected". */
        enabled = (stored == 1);
    }
    nvs_close(nvs);
}

bool blind_signing_enabled(void)
{
    load_once();
    return enabled;
}

bool blind_signing_set(bool value)
{
    nvs_handle_t nvs;
    if (nvs_open(BLIND_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        ESP_LOGW(TAG, "Could not open settings to store blind signing");
        return false;
    }

    esp_err_t err = nvs_set_u8(nvs, BLIND_KEY, value ? 1 : 0);
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Could not persist blind signing");
        return false;
    }

    loaded  = true;
    enabled = value;
    ESP_LOGW(TAG, "Blind signing %s", value ? "ENABLED" : "disabled");
    return true;
}

void blind_signing_forget(void)
{
    loaded  = false;
    enabled = false;
}
