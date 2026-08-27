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
#include "leek-wallet.h"

static const char *TAG = "pin";

/* NVS keys */
#define NVS_NAMESPACE       "leek_pin"
#define KEY_PIN_ATTEMPTS    "attempts"

/* Retired. Firmware up to this change stored a second PIN verifier here:
 * SHA-256 applied 101 times, unsalted. The PIN and the vault password are the
 * same secret, so that blob was an offline oracle for everything the vault's
 * salted PBKDF2 verifier protects - a flash dump plus a GPU turned a 4-8 digit
 * PIN into seconds of work, and one rainbow table covered every device ever
 * built because there was no salt. It is read once, only to let a device that
 * has this and nothing else finish migrating, and then erased. Never written.
 */
#define KEY_RETIRED_HASH    "pin_hash"

#define PIN_HASH_SIZE       32

/* State */
static bool pin_initialized = false;
static uint8_t remaining_attempts = PIN_MAX_ATTEMPTS;
static char current_pin[PIN_MAX_LENGTH + 1] = {0};
static bool pin_verified = false;

/* Set by the UI so a re-encryption that takes seconds can show progress
 * instead of a frozen screen. NULL everywhere else. */
static WalletProgressFn pin_change_progress = NULL;

/**
 * Reproduce the retired verifier, for migration only.
 *
 * Kept solely so a device that stored one and never got as far as creating a
 * vault password can still be opened by its owner once, at which point the
 * strong verifier is written and this blob is erased. Nothing else may call
 * it, and nothing writes its output to storage any more.
 */
static void retired_hash_pin(const char *pin, uint8_t *hash)
{
    uint8_t temp[32];
    size_t pin_len = strlen(pin);

    sha256_Raw((const uint8_t *)pin, pin_len, temp);
    for (int i = 0; i < 100; i++) {
        sha256_Raw(temp, 32, temp);
    }

    memcpy(hash, temp, PIN_HASH_SIZE);
    memzero(temp, sizeof(temp));
}

/* True if the retired verifier is still in flash. */
static bool retired_hash_present(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return false;
    }
    size_t len = PIN_HASH_SIZE;
    esp_err_t err = nvs_get_blob(nvs, KEY_RETIRED_HASH, NULL, &len);
    nvs_close(nvs);
    return err == ESP_OK && len == PIN_HASH_SIZE;
}

/* Remove the retired verifier. nvs_erase_key, not nvs_erase_all: the attempt
 * counter shares this namespace and must survive, or a migration would hand a
 * device that is three guesses down a fresh set of guesses. */
static void erase_retired_hash(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }
    if (nvs_erase_key(nvs, KEY_RETIRED_HASH) == ESP_OK) {
        nvs_commit(nvs);
        ESP_LOGW(TAG, "Retired PIN verifier erased");
    }
    nvs_close(nvs);
}

/* Has the vault a password? That hash is now the only PIN verifier, so this is
 * also the answer to "is a PIN set". The wallet is brought up if it is not
 * already: pin_init() can run before wallet_init() on some paths, and reading
 * "no password" from an uninitialised vault would look exactly like a device
 * that still needs the retired verifier. */
static bool vault_has_password(void)
{
    WalletStatus status = wallet_get_status();
    if (!status.initialized) {
        wallet_init();
        status = wallet_get_status();
    }
    return status.password_set;
}

/* Accept a PIN that has just been proved correct: cache it for key derivation
 * and give back the attempt it cost. */
static void adopt_pin(const char *pin)
{
    strncpy(current_pin, pin, PIN_MAX_LENGTH);
    current_pin[PIN_MAX_LENGTH] = '\0';
    pin_verified = true;
    pin_reset_attempts();
}

/**
 * Migrate a device that still carries the retired verifier.
 *
 * Called with a PIN that has just verified, which is the only moment the
 * strong verifier can be written for a device that has none. Two orderings,
 * both safe against a power cut because every intermediate state is one where
 * this same PIN is the only PIN that opens the device:
 *
 *   - vault already has a password: the strong verifier already agrees with
 *     this PIN, so the retired blob is pure redundancy and is simply erased.
 *     Cut power before the erase and both verifiers still answer to this PIN.
 *
 *   - vault has no password (a PIN was set but no wallet ever created): write
 *     the vault password first - one atomic record - then erase. Cut power
 *     before the write and only the retired verifier exists; cut power between
 *     and both exist, for the same PIN. Never zero.
 */
static void migrate_retired_verifier(const char *pin)
{
    if (!retired_hash_present()) {
        return;
    }

    if (!vault_has_password()) {
        if (wallet_set_password(pin, strlen(pin)) != WALLET_OK) {
            /* Leave the retired blob alone: it is the only thing that can open
             * this device, and a device nobody can open is worse than a device
             * whose PIN is cheap to guess. Retried on the next unlock. */
            ESP_LOGE(TAG, "Could not establish the vault verifier; migration deferred");
            return;
        }
    }

    erase_retired_hash();
}

#ifdef LEEK_HOST_TEST
/* Host tests only: drop all in-RAM state so pin_init() re-reads storage,
 * simulating a reboot. Compiled out of firmware builds entirely. */
void pin__reset_static_state_for_test(void)
{
    pin_initialized    = false;
    pin_verified       = false;
    pin_change_progress = NULL;
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

    /* On a device that already has a vault password the retired verifier is
     * redundant the moment this firmware boots - no PIN needed to say so - and
     * every second it stays in the live NVS entry is a second a flash dump is
     * worth taking. Devices with no vault password keep it until someone types
     * the PIN; see migrate_retired_verifier(). */
    if (vault_has_password()) {
        erase_retired_hash();
    }

    ESP_LOGI(TAG, "Initialized, attempts=%d", remaining_attempts);

    return true;
}

bool pin_is_set(void)
{
    if (!pin_initialized) {
        pin_init();
    }

    /* The vault password IS the PIN, and its verifier is the only one this
     * firmware writes, so a device that has one has a PIN. The retired blob
     * still counts until it has been migrated away - otherwise an upgraded
     * device that never created a wallet would be offered PIN setup again and
     * would silently accept a different PIN. */
    return vault_has_password() || retired_hash_present();
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

    /* Setting the PIN is setting the vault password - they are one secret, and
     * this module no longer keeps a verifier of its own. Doing it here rather
     * than lazily at the first unlock also closes the window in which a device
     * had a PIN and no strong verifier to check it against.
     *
     * A vault that already has a password is never repointed at a new one:
     * that would leave every stored mnemonic encrypted under a key nobody can
     * derive again. Changing the PIN of a provisioned device is pin_change(),
     * which re-encrypts first. So a mismatch here is a refusal, and a match is
     * an idempotent no-op. */
    if (vault_has_password()) {
        if (!wallet_verify_password(pin, strlen(pin))) {
            ESP_LOGW(TAG, "Refusing to repoint an existing vault; use pin_change");
            return false;
        }
    } else if (wallet_set_password(pin, strlen(pin)) != WALLET_OK) {
        ESP_LOGE(TAG, "Failed to establish the vault verifier");
        return false;
    }

    /* Any retired verifier left by an older firmware is redundant now. */
    erase_retired_hash();

    adopt_pin(pin);

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

    /* The vault's own verifier is the authority: salted PBKDF2 over a
     * per-device salt, the same construction that protects the ciphertext, so
     * nothing in flash answers "is this the PIN" more cheaply than the vault
     * itself does. Costs one KDF run - see docs/VAULT.md. */
    bool match;
    if (vault_has_password()) {
        match = wallet_verify_password(pin, strlen(pin));
    } else if (retired_hash_present()) {
        /* An upgraded device that had a PIN but never a wallet. Nothing secret
         * is stored on it yet, and refusing the owner's own PIN would brick
         * it, so the retired verifier is honoured exactly once - the success
         * path below writes the strong one and erases this. */
        uint8_t stored_hash[PIN_HASH_SIZE];
        uint8_t input_hash[PIN_HASH_SIZE];
        size_t hash_len = PIN_HASH_SIZE;

        nvs_handle_t nvs;
        if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
            ESP_LOGE(TAG, "Failed to open NVS");
            return false;
        }
        esp_err_t err = nvs_get_blob(nvs, KEY_RETIRED_HASH, stored_hash, &hash_len);
        nvs_close(nvs);
        if (err != ESP_OK || hash_len != PIN_HASH_SIZE) {
            memzero(stored_hash, sizeof(stored_hash));
            return false;
        }

        retired_hash_pin(pin, input_hash);

        /* Constant-time compare - no early exit on the first differing byte. */
        uint8_t diff = 0;
        for (size_t i = 0; i < PIN_HASH_SIZE; i++) {
            diff |= (uint8_t)(stored_hash[i] ^ input_hash[i]);
        }
        match = (diff == 0);

        memzero(stored_hash, sizeof(stored_hash));
        memzero(input_hash, sizeof(input_hash));
    } else {
        ESP_LOGE(TAG, "No PIN verifier stored");
        return false;
    }

    if (match) {
        /* Before the attempt is refunded and the PIN cached: this is the one
         * moment the PIN is known to be right, and so the only moment a device
         * still carrying the old verifier can be moved off it. */
        migrate_retired_verifier(pin);

        adopt_pin(pin);

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
    if (!pin_is_valid_format(new_pin)) {
        return false;
    }

    /* Verify current PIN first. Costs an attempt, refunded on success. */
    if (!pin_verify(current_pin_str)) {
        return false;
    }

    /* The PIN is the vault password: every stored mnemonic is encrypted under
     * a key derived from it. Setting a new PIN hash without re-encrypting them
     * would leave every seed locked under a key nobody can derive again -
     * silent, total loss of funds - so the vault moves first and this module's
     * hash follows.
     *
     * With one verifier instead of two there is nothing left to keep in step:
     * the generation flip and the verifier are the same single-blob write, so
     * the gap this code used to have to recover from no longer exists. */
    if (vault_has_password()) {
        WalletError err = wallet_change_password(current_pin_str, strlen(current_pin_str),
                                                 new_pin, strlen(new_pin),
                                                 pin_change_progress);
        if (err != WALLET_OK) {
            ESP_LOGE(TAG, "Vault re-encryption failed (%d); PIN unchanged", (int)err);
            return false;
        }
    } else if (wallet_set_password(new_pin, strlen(new_pin)) != WALLET_OK) {
        /* A device with a PIN and no vault yet: nothing to re-encrypt, so the
         * change is only a matter of establishing the verifier under the new
         * PIN. */
        ESP_LOGE(TAG, "Could not set the new vault verifier; PIN unchanged");
        return false;
    }

    /* The single write above already moved the only verifier there is. Nothing
     * further to persist - take the new PIN into RAM and drop anything an
     * older firmware left behind. */
    erase_retired_hash();
    adopt_pin(new_pin);
    return true;
}

void pin_set_change_progress(WalletProgressFn fn)
{
    pin_change_progress = fn;
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
