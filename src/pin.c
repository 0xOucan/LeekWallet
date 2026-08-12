/**
 * LeekWallet PIN Management
 * Secure PIN storage and verification using NVS
 */

#include "pin.h"
#include <string.h>
#include <ctype.h>
#include "nvs_flash.h"
#include "nvs.h"
#include "sha2.h"
#include "memzero.h"
#include "esp_log.h"

static const char *TAG = "pin";

/* NVS keys */
#define NVS_NAMESPACE       "leek_pin"
#define KEY_PIN_HASH        "pin_hash"
#define KEY_PIN_ATTEMPTS    "attempts"

/* PIN hash size (SHA256) */
#define PIN_HASH_SIZE       32

/* State */
static bool pin_initialized = false;
static uint8_t remaining_attempts = PIN_MAX_ATTEMPTS;
static char current_pin[PIN_MAX_LENGTH + 1] = {0};
static bool pin_verified = false;

/**
 * Hash PIN for storage using SHA256 with key stretching
 */
static void hash_pin(const char *pin, uint8_t *hash)
{
    uint8_t temp[32];
    size_t pin_len = strlen(pin);

    /* First hash */
    sha256_Raw((const uint8_t *)pin, pin_len, temp);

    /* Additional rounds for key stretching */
    for (int i = 0; i < 100; i++) {
        sha256_Raw(temp, 32, temp);
    }

    memcpy(hash, temp, PIN_HASH_SIZE);
    memzero(temp, sizeof(temp));
}

#ifdef LEEK_HOST_TEST
/* Host tests only: drop all in-RAM state so pin_init() re-reads storage,
 * simulating a reboot. Compiled out of firmware builds entirely. */
void pin__reset_static_state_for_test(void)
{
    pin_initialized    = false;
    pin_verified       = false;
    remaining_attempts = PIN_MAX_ATTEMPTS;
    memzero(current_pin, sizeof(current_pin));
}
#endif

/**
 * Persist the attempt counter immediately.
 * Callers rely on this having hit flash before they act on the new value.
 */
static void persist_attempts(uint8_t attempts)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }
    nvs_set_u8(nvs, KEY_PIN_ATTEMPTS, attempts);
    nvs_commit(nvs);
    nvs_close(nvs);
}

bool pin_init(void)
{
    if (pin_initialized) {
        return true;
    }

    /* Load remaining attempts from storage.
     *
     * A stored 0 means "attempts were exhausted and the wipe did not finish" -
     * it must NOT be confused with "no counter stored yet", or power-cycling
     * mid-wipe would hand the attacker a fresh set of guesses. Only a genuinely
     * absent key resets to the maximum. */
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err == ESP_OK) {
        uint8_t attempts = 0;
        err = nvs_get_u8(nvs, KEY_PIN_ATTEMPTS, &attempts);
        if (err == ESP_OK) {
            remaining_attempts = (attempts <= PIN_MAX_ATTEMPTS) ? attempts
                                                                : PIN_MAX_ATTEMPTS;
        } else {
            remaining_attempts = PIN_MAX_ATTEMPTS;
        }
        nvs_close(nvs);
    } else {
        remaining_attempts = PIN_MAX_ATTEMPTS;
    }

    pin_initialized = true;
    pin_verified = false;
    ESP_LOGI(TAG, "Initialized, attempts=%d", remaining_attempts);

    return true;
}

bool pin_is_set(void)
{
    if (!pin_initialized) {
        pin_init();
    }

    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err != ESP_OK) {
        return false;
    }

    size_t hash_len = PIN_HASH_SIZE;
    err = nvs_get_blob(nvs, KEY_PIN_HASH, NULL, &hash_len);
    nvs_close(nvs);

    return (err == ESP_OK && hash_len == PIN_HASH_SIZE);
}

bool pin_set(const char *pin)
{
    if (!pin_initialized) {
        pin_init();
    }

    if (!pin_is_valid_format(pin)) {
        ESP_LOGW(TAG, "Invalid format");
        return false;
    }

    /* Hash the PIN */
    uint8_t hash[PIN_HASH_SIZE];
    hash_pin(pin, hash);

    /* Store in NVS */
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS: %d", err);
        memzero(hash, sizeof(hash));
        return false;
    }

    err = nvs_set_blob(nvs, KEY_PIN_HASH, hash, PIN_HASH_SIZE);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to store hash: %d", err);
        nvs_close(nvs);
        memzero(hash, sizeof(hash));
        return false;
    }

    /* Reset attempts */
    remaining_attempts = PIN_MAX_ATTEMPTS;
    nvs_set_u8(nvs, KEY_PIN_ATTEMPTS, remaining_attempts);

    nvs_commit(nvs);
    nvs_close(nvs);

    memzero(hash, sizeof(hash));

    /* Store current PIN for wallet encryption */
    strncpy(current_pin, pin, PIN_MAX_LENGTH);
    current_pin[PIN_MAX_LENGTH] = '\0';
    pin_verified = true;

    ESP_LOGI(TAG, "Set successfully");
    return true;
}

bool pin_verify(const char *pin)
{
    if (!pin_initialized) {
        pin_init();
    }

    ESP_LOGI(TAG, "Verify: start");

    if (!pin_is_valid_format(pin)) {
        ESP_LOGW(TAG, "Verify: invalid format");
        return false;
    }

    /* Check if already wiped */
    if (remaining_attempts == 0) {
        ESP_LOGW(TAG, "Device wiped, no attempts remaining");
        return false;
    }

    /* Spend the attempt BEFORE comparing, and commit it to flash.
     *
     * The obvious order - compare, then decrement on failure - leaves a window
     * where cutting power after the comparison costs the attacker nothing. By
     * charging for the guess up front, an interrupted attempt is a spent
     * attempt. The counter is restored only on a verified success. */
    remaining_attempts--;
    persist_attempts(remaining_attempts);

    /* Get stored hash */
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS");
        return false;
    }

    uint8_t stored_hash[PIN_HASH_SIZE];
    size_t hash_len = PIN_HASH_SIZE;
    err = nvs_get_blob(nvs, KEY_PIN_HASH, stored_hash, &hash_len);
    nvs_close(nvs);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to read stored hash");
        return false;
    }

    /* Hash input PIN */
    uint8_t input_hash[PIN_HASH_SIZE];
    hash_pin(pin, input_hash);

    /* Constant-time compare - no early exit on the first differing byte. */
    uint8_t diff = 0;
    for (size_t i = 0; i < PIN_HASH_SIZE; i++) {
        diff |= (uint8_t)(stored_hash[i] ^ input_hash[i]);
    }
    bool match = (diff == 0);

    memzero(stored_hash, sizeof(stored_hash));
    memzero(input_hash, sizeof(input_hash));

    if (match) {
        /* Refund the attempt spent above */
        pin_reset_attempts();

        /* Store current PIN for wallet encryption */
        strncpy(current_pin, pin, PIN_MAX_LENGTH);
        current_pin[PIN_MAX_LENGTH] = '\0';
        pin_verified = true;

        ESP_LOGI(TAG, "Verified successfully");
        return true;
    }

    /* The attempt was already spent and persisted above. */
    ESP_LOGW(TAG, "Verification failed, %d attempts remaining", remaining_attempts);

    if (remaining_attempts == 0) {
        ESP_LOGW(TAG, "Max attempts reached, device should be wiped!");
    }

    return false;
}

uint8_t pin_get_remaining_attempts(void)
{
    return remaining_attempts;
}

bool pin_should_wipe(void)
{
    return remaining_attempts == 0;
}

void pin_reset_attempts(void)
{
    remaining_attempts = PIN_MAX_ATTEMPTS;
    persist_attempts(remaining_attempts);
}

void pin_wipe(void)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err == ESP_OK) {
        nvs_erase_all(nvs);
        nvs_commit(nvs);
        nvs_close(nvs);
    }

    remaining_attempts = PIN_MAX_ATTEMPTS;
    memzero(current_pin, sizeof(current_pin));
    pin_verified = false;

    ESP_LOGI(TAG, "Wiped");
}

bool pin_change(const char *current_pin_str, const char *new_pin)
{
    /* Verify current PIN first */
    if (!pin_verify(current_pin_str)) {
        return false;
    }

    /* Set new PIN */
    return pin_set(new_pin);
}

bool pin_is_valid_format(const char *pin)
{
    if (!pin) {
        return false;
    }

    size_t len = strlen(pin);

    /* Check length */
    if (len < PIN_MIN_LENGTH || len > PIN_MAX_LENGTH) {
        return false;
    }

    /* Check all digits */
    for (size_t i = 0; i < len; i++) {
        if (!isdigit((unsigned char)pin[i])) {
            return false;
        }
    }

    return true;
}

bool pin_get_current(char *pin, size_t max_len)
{
    if (!pin || max_len == 0 || !pin_verified || current_pin[0] == '\0') {
        return false;
    }

    strncpy(pin, current_pin, max_len - 1);
    pin[max_len - 1] = '\0';
    return true;
}

bool pin_is_unlocked(void)
{
    return pin_verified;
}

void pin_lock(void)
{
    memzero(current_pin, sizeof(current_pin));
    pin_verified = false;
    ESP_LOGI(TAG, "Locked");
}
