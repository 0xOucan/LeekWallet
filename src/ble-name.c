/**
 * The advertised BLE device name — see ble-name.h for why the bound matters.
 */

#include "ble-name.h"

#include <string.h>

#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "ble-name";

/* The UI's settings namespace, like every other user preference: this is not a
 * secret, and it must be erased by exactly the same wipe that erases the
 * wallet rather than surviving it under a namespace of its own. A name is
 * chosen by the owner and can identify them, so leaving it behind on a wiped
 * device would be a small privacy leak with no upside. */
#define BLE_NAME_NAMESPACE "leek_ui"
#define BLE_NAME_KEY       "ble_name"

/* Cached, like the blind-signing flag: this is read when advertising starts
 * and a flash error at that moment must not be able to change the name that
 * goes on air. `loaded` is what lets the default survive a device that has
 * never been renamed. */
static bool loaded = false;
static char name[BLE_NAME_MAX_LEN + 1];

bool ble_name_is_valid(const char *n)
{
    if (!n) {
        return false;
    }

    size_t len = strnlen(n, BLE_NAME_MAX_LEN + 1);
    /* Empty is not a name: a nameless scan entry is worse than the default,
     * and NimBLE would advertise a zero-length AD structure. */
    if (len == 0 || len > BLE_NAME_MAX_LEN) {
        return false;
    }

    for (size_t i = 0; i < len; i++) {
        /* Printable ASCII only, and the same range the device's own keyboard
         * produces (text-entry.c). Two reasons beyond the keyboard: a scanner
         * renders these bytes into someone else's UI, and a multi-byte UTF-8
         * name would be bounded here in characters and on air in bytes — two
         * different limits, which is how a "short enough" name stops the
         * radio. */
        unsigned char c = (unsigned char)n[i];
        if (c < 0x20 || c > 0x7E) {
            return false;
        }
    }
    return true;
}

static void load_once(void)
{
    if (loaded) {
        return;
    }
    loaded = true;
    memcpy(name, BLE_NAME_DEFAULT, sizeof(BLE_NAME_DEFAULT));

    nvs_handle_t nvs;
    if (nvs_open(BLE_NAME_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }

    /* One byte of headroom, so a stored value that is too long fails the read
     * outright instead of arriving truncated. Storage is not a trusted input:
     * it could have been written by another firmware version, and the point of
     * the whole file is that an over-long name never reaches the radio. */
    char stored[BLE_NAME_MAX_LEN + 2];
    size_t len = sizeof(stored);
    esp_err_t err = nvs_get_blob(nvs, BLE_NAME_KEY, stored, &len);
    nvs_close(nvs);

    if (err != ESP_OK || len == 0 || len > sizeof(stored) - 1) {
        return;
    }
    stored[len] = '\0';        /* whatever was stored, terminated by us */

    if (ble_name_is_valid(stored)) {
        memcpy(name, stored, strlen(stored) + 1);
    } else {
        ESP_LOGW(TAG, "Stored device name rejected; using the default");
    }
}

const char *ble_name_get(void)
{
    load_once();
    return name;
}

bool ble_name_set(const char *n)
{
    /* Validated before anything is written, so a refused name leaves neither
     * flash nor the cache touched and the device keeps advertising under the
     * name it already had. */
    if (!ble_name_is_valid(n)) {
        ESP_LOGW(TAG, "Refusing a device name that would not fit the scan response");
        return false;
    }

    size_t len = strlen(n);

    nvs_handle_t nvs;
    if (nvs_open(BLE_NAME_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        ESP_LOGW(TAG, "Could not open settings to store the device name");
        return false;
    }
    esp_err_t err = nvs_set_blob(nvs, BLE_NAME_KEY, n, len);
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Could not persist the device name");
        return false;
    }

    loaded = true;
    memcpy(name, n, len + 1);
    return true;
}

void ble_name_reset(void)
{
    ble_name_set(BLE_NAME_DEFAULT);
}

void ble_name_forget(void)
{
    loaded = false;
    name[0] = '\0';
}
