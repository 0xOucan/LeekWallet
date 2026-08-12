/**
 * Colibri Wallet Implementation
 * BIP39/BIP32 HD wallet for ESP32-C3
 */

#include "colibri-wallet.h"
#include "bip39.h"
#include "bip32.h"
#include "curves.h"
#include "sha2.h"
#include "sha3.h"
#include "memzero.h"
#include "rand.h"
#include "ecdsa.h"
#include "bignum.h"

#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"
#include "mbedtls/aes.h"

#include <string.h>
#include <stdlib.h>

static const char *TAG = "wallet";

// Storage keys
#define NVS_NAMESPACE "colibri"
#define KEY_PASSWORD_HASH "pwd_hash"
#define KEY_WALLET_COUNT "wallet_cnt"
#define KEY_ACTIVE_WALLET "active_idx"
// Indexed keys: mnemonic_1, mnemonic_2, ..., iv_1, iv_2, ...

// Limits
#define MAX_MNEMONIC_LENGTH 256
#define MIN_PASSWORD_LENGTH 4  // Matches PIN_MIN_LENGTH for PIN-based security
#define AES_IV_SIZE 16
#define HASH_SIZE 32

// Seed cache size (BIP39 seed is 64 bytes)
#define SEED_SIZE 64

// BIP39 passphrase max length (not stored in NVS, only in RAM)
#define MAX_PASSPHRASE_LENGTH 128

// Internal state (cleared on lock)
static struct {
    bool initialized;
    bool password_set;
    bool unlocked;
    bool has_mnemonic;
    bool seed_cached;  // True if seed[] contains valid cached seed
    bool has_passphrase;  // True if passphrase is set (25th word)
    uint8_t password_hash[HASH_SIZE];
    uint8_t encryption_key[HASH_SIZE];
    char mnemonic[MAX_MNEMONIC_LENGTH];
    char passphrase[MAX_PASSPHRASE_LENGTH];  // BIP39 passphrase (RAM only)
    uint8_t seed[SEED_SIZE];  // Cached seed to avoid repeated PBKDF2
    HDNode node;
    HDPath current_path;
    uint8_t wallet_count;
    uint8_t active_wallet_index;  // 1-based, 0 = none
} state = {0};

// ========== Seed Cache Management ========== //

/**
 * Derive and cache seed from current mnemonic
 * PBKDF2-HMAC-SHA512 with 2048 iterations (~800ms)
 * Call once after mnemonic load, reuse for all path derivations
 * Uses passphrase if set (BIP39 25th word)
 */
static void cache_seed_from_mnemonic(void) {
    if (!state.has_mnemonic || state.seed_cached) {
        return;
    }

    ESP_LOGI(TAG, "Caching seed (PBKDF2)%s...",
             state.has_passphrase ? " with passphrase" : "");

    // Use passphrase if set, otherwise empty string
    const char *pass = state.has_passphrase ? state.passphrase : "";
    mnemonic_to_seed(state.mnemonic, pass, state.seed, NULL);

    state.seed_cached = true;
    ESP_LOGI(TAG, "Seed cached");
}

/**
 * Invalidate and securely clear cached seed
 * Called on: lock, wipe, wallet switch
 */
static void invalidate_seed_cache(void) {
    if (state.seed_cached) {
        memzero(state.seed, sizeof(state.seed));
        state.seed_cached = false;
    }
}

// ========== Indexed Storage Helpers ========== //

static void get_mnemonic_key(uint8_t index, char *key, size_t key_size) {
    snprintf(key, key_size, "m_%d", index);
}

static void get_iv_key(uint8_t index, char *key, size_t key_size) {
    snprintf(key, key_size, "iv_%d", index);
}

// ========== Helper Functions ========== //

static void derive_key_from_password(const char *password, size_t length, uint8_t key_out[32]) {
    // Double SHA256 for key derivation
    uint8_t temp[32];
    sha256_Raw((const uint8_t *)password, length, temp);
    sha256_Raw(temp, 32, key_out);
    memzero(temp, sizeof(temp));
}

static void compute_password_hash(const char *password, size_t length, uint8_t hash_out[32]) {
    // Triple SHA256 for password verification (different from encryption key)
    uint8_t temp[32];
    sha256_Raw((const uint8_t *)password, length, temp);
    sha256_Raw(temp, 32, temp);
    sha256_Raw(temp, 32, hash_out);
    memzero(temp, sizeof(temp));
}

static WalletError encrypt_data(const uint8_t *plaintext, size_t length,
                                 uint8_t *ciphertext, const uint8_t key[32], uint8_t iv[16]) {
    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);

    // Generate random IV
    random_buffer(iv, AES_IV_SIZE);

    // Encrypt using AES-256-CBC
    if (mbedtls_aes_setkey_enc(&aes, key, 256) != 0) {
        mbedtls_aes_free(&aes);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    // Pad to 16-byte boundary
    size_t padded_length = ((length + 15) / 16) * 16;
    uint8_t *padded = calloc(padded_length, 1);
    if (!padded) {
        mbedtls_aes_free(&aes);
        return WALLET_ERROR_STORAGE_FAILED;
    }
    memcpy(padded, plaintext, length);

    uint8_t iv_copy[16];
    memcpy(iv_copy, iv, 16);

    if (mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, padded_length, iv_copy, padded, ciphertext) != 0) {
        memzero(padded, padded_length);
        free(padded);
        mbedtls_aes_free(&aes);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    memzero(padded, padded_length);
    free(padded);
    mbedtls_aes_free(&aes);
    return WALLET_OK;
}

static WalletError decrypt_data(const uint8_t *ciphertext, size_t length,
                                 uint8_t *plaintext, const uint8_t key[32], const uint8_t iv[16]) {
    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);

    if (mbedtls_aes_setkey_dec(&aes, key, 256) != 0) {
        mbedtls_aes_free(&aes);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    uint8_t iv_copy[16];
    memcpy(iv_copy, iv, 16);

    if (mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_DECRYPT, length, iv_copy, ciphertext, plaintext) != 0) {
        mbedtls_aes_free(&aes);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    mbedtls_aes_free(&aes);
    return WALLET_OK;
}

static WalletError save_encrypted_mnemonic_at_index(uint8_t index) {
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS: %s", esp_err_to_name(err));
        return WALLET_ERROR_STORAGE_FAILED;
    }

    size_t mnemonic_len = strlen(state.mnemonic);
    size_t padded_len = ((mnemonic_len + 15) / 16) * 16;
    uint8_t *ciphertext = calloc(padded_len, 1);
    uint8_t iv[AES_IV_SIZE];

    if (!ciphertext) {
        nvs_close(nvs);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    WalletError result = encrypt_data((uint8_t *)state.mnemonic, mnemonic_len + 1,
                                       ciphertext, state.encryption_key, iv);
    if (result != WALLET_OK) {
        free(ciphertext);
        nvs_close(nvs);
        return result;
    }

    // Use indexed keys
    char mnemonic_key[16], iv_key[16];
    get_mnemonic_key(index, mnemonic_key, sizeof(mnemonic_key));
    get_iv_key(index, iv_key, sizeof(iv_key));

    err = nvs_set_blob(nvs, mnemonic_key, ciphertext, padded_len);
    if (err != ESP_OK) {
        free(ciphertext);
        nvs_close(nvs);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    err = nvs_set_blob(nvs, iv_key, iv, AES_IV_SIZE);
    if (err != ESP_OK) {
        free(ciphertext);
        nvs_close(nvs);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    nvs_commit(nvs);
    nvs_close(nvs);
    memzero(ciphertext, padded_len);
    free(ciphertext);

    return WALLET_OK;
}

static WalletError load_encrypted_mnemonic_at_index(uint8_t index) {
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err != ESP_OK) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    // Use indexed keys
    char mnemonic_key[16], iv_key[16];
    get_mnemonic_key(index, mnemonic_key, sizeof(mnemonic_key));
    get_iv_key(index, iv_key, sizeof(iv_key));

    size_t cipher_len = 0;
    err = nvs_get_blob(nvs, mnemonic_key, NULL, &cipher_len);
    if (err != ESP_OK || cipher_len == 0) {
        nvs_close(nvs);
        return WALLET_ERROR_NO_MNEMONIC;
    }

    uint8_t *ciphertext = calloc(cipher_len, 1);
    uint8_t iv[AES_IV_SIZE];
    size_t iv_len = AES_IV_SIZE;

    if (!ciphertext) {
        nvs_close(nvs);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    err = nvs_get_blob(nvs, mnemonic_key, ciphertext, &cipher_len);
    if (err != ESP_OK) {
        free(ciphertext);
        nvs_close(nvs);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    err = nvs_get_blob(nvs, iv_key, iv, &iv_len);
    if (err != ESP_OK) {
        free(ciphertext);
        nvs_close(nvs);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    nvs_close(nvs);

    uint8_t *plaintext = calloc(cipher_len, 1);
    if (!plaintext) {
        free(ciphertext);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    WalletError result = decrypt_data(ciphertext, cipher_len, plaintext,
                                       state.encryption_key, iv);

    memzero(ciphertext, cipher_len);
    free(ciphertext);

    if (result != WALLET_OK) {
        free(plaintext);
        return result;
    }

    strncpy(state.mnemonic, (char *)plaintext, MAX_MNEMONIC_LENGTH - 1);
    state.mnemonic[MAX_MNEMONIC_LENGTH - 1] = '\0';

    memzero(plaintext, cipher_len);
    free(plaintext);

    // Validate loaded mnemonic
    if (!mnemonic_check(state.mnemonic)) {
        memzero(state.mnemonic, sizeof(state.mnemonic));
        return WALLET_ERROR_INVALID_MNEMONIC;
    }

    state.has_mnemonic = true;
    state.active_wallet_index = index;
    return WALLET_OK;
}

// Save wallet count and active index to NVS
static void save_wallet_metadata(void) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_u8(nvs, KEY_WALLET_COUNT, state.wallet_count);
        nvs_set_u8(nvs, KEY_ACTIVE_WALLET, state.active_wallet_index);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
}

// Load wallet count and active index from NVS
static void load_wallet_metadata(void) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) == ESP_OK) {
        uint8_t count = 0, active = 0;
        nvs_get_u8(nvs, KEY_WALLET_COUNT, &count);
        nvs_get_u8(nvs, KEY_ACTIVE_WALLET, &active);
        state.wallet_count = count;
        state.active_wallet_index = active;
        nvs_close(nvs);
    }
}

// ========== Public API ========== //

WalletError wallet_init(void) {
    if (state.initialized) {
        return WALLET_OK;
    }

    // Initialize NVS
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS init failed: %s", esp_err_to_name(err));
        return WALLET_ERROR_STORAGE_FAILED;
    }

    // Check if password hash exists
    nvs_handle_t nvs;
    err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err == ESP_OK) {
        size_t hash_len = HASH_SIZE;
        err = nvs_get_blob(nvs, KEY_PASSWORD_HASH, NULL, &hash_len);
        state.password_set = (err == ESP_OK && hash_len == HASH_SIZE);
        nvs_close(nvs);
    }

    state.initialized = true;
    state.unlocked = false;
    state.has_mnemonic = false;

    ESP_LOGI(TAG, "Wallet initialized, password_set=%d", state.password_set);
    return WALLET_OK;
}

WalletStatus wallet_get_status(void) {
    WalletStatus status = {
        .initialized = state.initialized,
        .password_set = state.password_set,
        .unlocked = state.unlocked,
        .has_mnemonic = state.has_mnemonic,
        .active_wallet_index = state.active_wallet_index,
        .wallet_count = state.wallet_count,
    };
    return status;
}

WalletError wallet_set_password(const char *password, size_t length) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (length < MIN_PASSWORD_LENGTH) {
        return WALLET_ERROR_WRONG_PASSWORD;
    }

    // Compute password hash and encryption key
    compute_password_hash(password, length, state.password_hash);
    derive_key_from_password(password, length, state.encryption_key);

    // Save password hash
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return WALLET_ERROR_STORAGE_FAILED;
    }

    err = nvs_set_blob(nvs, KEY_PASSWORD_HASH, state.password_hash, HASH_SIZE);
    if (err != ESP_OK) {
        nvs_close(nvs);
        return WALLET_ERROR_STORAGE_FAILED;
    }

    nvs_commit(nvs);
    nvs_close(nvs);

    state.password_set = true;
    state.unlocked = true;

    ESP_LOGI(TAG, "Password set and wallet unlocked");
    return WALLET_OK;
}

WalletError wallet_unlock(const char *password, size_t length) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.password_set) {
        return WALLET_ERROR_WRONG_PASSWORD;
    }

    // Verify password
    uint8_t hash[HASH_SIZE];
    compute_password_hash(password, length, hash);

    // Load stored hash
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err != ESP_OK) {
        return WALLET_ERROR_STORAGE_FAILED;
    }

    uint8_t stored_hash[HASH_SIZE];
    size_t hash_len = HASH_SIZE;
    err = nvs_get_blob(nvs, KEY_PASSWORD_HASH, stored_hash, &hash_len);
    nvs_close(nvs);

    if (err != ESP_OK || memcmp(hash, stored_hash, HASH_SIZE) != 0) {
        memzero(hash, sizeof(hash));
        memzero(stored_hash, sizeof(stored_hash));
        return WALLET_ERROR_WRONG_PASSWORD;
    }

    // Store password hash and derive encryption key
    memcpy(state.password_hash, hash, HASH_SIZE);
    derive_key_from_password(password, length, state.encryption_key);

    memzero(hash, sizeof(hash));
    memzero(stored_hash, sizeof(stored_hash));

    state.unlocked = true;

    // Load wallet metadata
    load_wallet_metadata();

    // Try to load active wallet mnemonic
    if (state.wallet_count > 0 && state.active_wallet_index > 0) {
        load_encrypted_mnemonic_at_index(state.active_wallet_index);
    }

    ESP_LOGI(TAG, "Wallet unlocked, count=%d, active=%d, has_mnemonic=%d",
             state.wallet_count, state.active_wallet_index, state.has_mnemonic);
    return WALLET_OK;
}

void wallet_lock(void) {
    // Invalidate seed cache first (secure zeroization)
    invalidate_seed_cache();

    // Clear sensitive data from memory
    memzero(state.mnemonic, sizeof(state.mnemonic));
    memzero(state.passphrase, sizeof(state.passphrase));
    memzero(state.encryption_key, sizeof(state.encryption_key));
    memzero(&state.node, sizeof(state.node));

    state.unlocked = false;
    state.has_mnemonic = false;
    state.has_passphrase = false;

    ESP_LOGI(TAG, "Wallet locked");
}

bool wallet_verify_password(const char *password, size_t length) {
    if (!state.password_set) {
        return false;
    }

    uint8_t hash[HASH_SIZE];
    compute_password_hash(password, length, hash);

    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err != ESP_OK) {
        return false;
    }

    uint8_t stored_hash[HASH_SIZE];
    size_t hash_len = HASH_SIZE;
    err = nvs_get_blob(nvs, KEY_PASSWORD_HASH, stored_hash, &hash_len);
    nvs_close(nvs);

    bool match = (err == ESP_OK && memcmp(hash, stored_hash, HASH_SIZE) == 0);

    memzero(hash, sizeof(hash));
    memzero(stored_hash, sizeof(stored_hash));

    return match;
}

// ========== BIP39 Passphrase ========== //

WalletError wallet_set_passphrase(const char *passphrase, size_t length) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }

    // Clear existing passphrase
    memzero(state.passphrase, sizeof(state.passphrase));

    if (passphrase && length > 0) {
        // Validate length
        if (length >= MAX_PASSPHRASE_LENGTH) {
            return WALLET_ERROR_INVALID_MNEMONIC;  // Reuse error code
        }

        memcpy(state.passphrase, passphrase, length);
        state.passphrase[length] = '\0';
        state.has_passphrase = true;
        ESP_LOGI(TAG, "Passphrase set (%zu chars)", length);
    } else {
        state.has_passphrase = false;
        ESP_LOGI(TAG, "Passphrase cleared");
    }

    // Invalidate cached seed since passphrase affects derivation
    invalidate_seed_cache();

    return WALLET_OK;
}

void wallet_clear_passphrase(void) {
    memzero(state.passphrase, sizeof(state.passphrase));
    state.has_passphrase = false;
    invalidate_seed_cache();
}

bool wallet_has_passphrase(void) {
    return state.has_passphrase;
}

WalletError wallet_create_mnemonic(int word_count, char *mnemonic_out, size_t max_length) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }

    // Determine entropy size (128 bits for 12 words, 256 bits for 24 words)
    int strength = (word_count == 24) ? 256 : 128;

    // Generate mnemonic
    const char *mnemonic = mnemonic_generate(strength);
    if (!mnemonic || !mnemonic_check(mnemonic)) {
        return WALLET_ERROR_DERIVATION_FAILED;
    }

    // Store internally
    strncpy(state.mnemonic, mnemonic, MAX_MNEMONIC_LENGTH - 1);
    state.mnemonic[MAX_MNEMONIC_LENGTH - 1] = '\0';
    state.has_mnemonic = true;

    // Output to caller
    if (mnemonic_out && max_length > 0) {
        strncpy(mnemonic_out, state.mnemonic, max_length - 1);
        mnemonic_out[max_length - 1] = '\0';
    }

    // Check storage limit
    if (state.wallet_count >= MAX_WALLETS) {
        state.has_mnemonic = false;
        memzero(state.mnemonic, sizeof(state.mnemonic));
        return WALLET_ERROR_STORAGE_FULL;
    }

    // Save to next wallet slot
    uint8_t new_index = state.wallet_count + 1;
    WalletError result = save_encrypted_mnemonic_at_index(new_index);
    if (result != WALLET_OK) {
        state.has_mnemonic = false;
        memzero(state.mnemonic, sizeof(state.mnemonic));
        return result;
    }

    // Update metadata
    state.wallet_count = new_index;
    state.active_wallet_index = new_index;
    save_wallet_metadata();

    ESP_LOGI(TAG, "Created %d-word mnemonic as wallet #%d", word_count, new_index);
    return WALLET_OK;
}

WalletError wallet_import_mnemonic(const char *mnemonic) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }

    // Validate mnemonic
    if (!mnemonic_check(mnemonic)) {
        return WALLET_ERROR_INVALID_MNEMONIC;
    }

    // Check storage limit
    if (state.wallet_count >= MAX_WALLETS) {
        return WALLET_ERROR_STORAGE_FULL;
    }

    // Store internally
    strncpy(state.mnemonic, mnemonic, MAX_MNEMONIC_LENGTH - 1);
    state.mnemonic[MAX_MNEMONIC_LENGTH - 1] = '\0';
    state.has_mnemonic = true;

    // Save to next wallet slot
    uint8_t new_index = state.wallet_count + 1;
    WalletError result = save_encrypted_mnemonic_at_index(new_index);
    if (result != WALLET_OK) {
        state.has_mnemonic = false;
        memzero(state.mnemonic, sizeof(state.mnemonic));
        return result;
    }

    // Update metadata
    state.wallet_count = new_index;
    state.active_wallet_index = new_index;
    save_wallet_metadata();

    ESP_LOGI(TAG, "Imported mnemonic as wallet #%d", new_index);
    return WALLET_OK;
}

WalletError wallet_get_mnemonic(char *mnemonic_out, size_t max_length) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    if (mnemonic_out && max_length > 0) {
        strncpy(mnemonic_out, state.mnemonic, max_length - 1);
        mnemonic_out[max_length - 1] = '\0';
    }

    return WALLET_OK;
}

bool wallet_validate_mnemonic(const char *mnemonic) {
    return mnemonic_check(mnemonic);
}

// ========== HD Path Parsing ========== //

bool wallet_parse_path(const char *path_str, HDPath *path_out) {
    if (!path_str || !path_out) {
        return false;
    }

    const char *p = path_str;

    // Skip optional "m/" prefix
    if (*p == 'm' || *p == 'M') {
        p++;
        if (*p == '/') {
            p++;
        } else if (*p != '\0') {
            return false;  // Invalid: 'm' not followed by '/'
        }
    }

    // Parse 5 path components: purpose'/coin'/account'/change/index
    uint32_t parts[5] = {0};
    bool hardened[5] = {false};
    int count = 0;

    while (*p && count < 5) {
        // Parse number
        if (*p < '0' || *p > '9') {
            return false;
        }

        uint32_t val = 0;
        while (*p >= '0' && *p <= '9') {
            uint32_t digit = *p - '0';
            // Check for overflow
            if (val > (0x7FFFFFFF - digit) / 10) {
                return false;
            }
            val = val * 10 + digit;
            p++;
        }
        parts[count] = val;

        // Check for hardened marker (' or h or H)
        if (*p == '\'' || *p == 'h' || *p == 'H') {
            hardened[count] = true;
            p++;
        }

        count++;

        // Expect '/' between components or end of string
        if (*p == '/') {
            p++;
        } else if (*p != '\0') {
            return false;
        }
    }

    // Must have exactly 5 components for BIP44
    if (count != 5 || *p != '\0') {
        return false;
    }

    // Validate BIP44 structure (first 3 should be hardened)
    if (!hardened[0] || !hardened[1] || !hardened[2]) {
        return false;
    }
    // Last 2 should NOT be hardened for standard BIP44
    if (hardened[3] || hardened[4]) {
        return false;
    }

    path_out->purpose = parts[0];
    path_out->coin_type = parts[1];
    path_out->account = parts[2];
    path_out->change = parts[3];
    path_out->address_index = parts[4];

    return true;
}

bool wallet_format_path(const HDPath *path, char *out, size_t out_size) {
    if (!path || !out || out_size < 24) {
        return false;
    }

    int len = snprintf(out, out_size, "m/%lu'/%lu'/%lu'/%lu/%lu",
                       (unsigned long)path->purpose,
                       (unsigned long)path->coin_type,
                       (unsigned long)path->account,
                       (unsigned long)path->change,
                       (unsigned long)path->address_index);

    return len > 0 && (size_t)len < out_size;
}

WalletError wallet_select_path(const HDPath *path) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    // Ensure seed is cached (only runs PBKDF2 if not already cached)
    cache_seed_from_mnemonic();

    // Create HD node from cached seed (no PBKDF2, fast ~50ms)
    if (hdnode_from_seed(state.seed, SEED_SIZE, SECP256K1_NAME, &state.node) != 1) {
        return WALLET_ERROR_DERIVATION_FAILED;
    }

    // Derive path: m/purpose'/coin_type'/account'/change/address_index
    uint32_t path_parts[] = {
        path->purpose | 0x80000000,     // Hardened
        path->coin_type | 0x80000000,   // Hardened
        path->account | 0x80000000,     // Hardened
        path->change,                    // Not hardened
        path->address_index              // Not hardened
    };

    for (int i = 0; i < 5; i++) {
        if (path_parts[i] & 0x80000000) {
            if (hdnode_private_ckd_prime(&state.node, path_parts[i] & 0x7FFFFFFF) != 1) {
                return WALLET_ERROR_DERIVATION_FAILED;
            }
        } else {
            if (hdnode_private_ckd(&state.node, path_parts[i]) != 1) {
                return WALLET_ERROR_DERIVATION_FAILED;
            }
        }
    }

    // Fill public key
    hdnode_fill_public_key(&state.node);

    // Store current path
    memcpy(&state.current_path, path, sizeof(HDPath));

    ESP_LOGI(TAG, "Selected path m/%lu'/%lu'/%lu'/%lu/%lu",
             (unsigned long)path->purpose, (unsigned long)path->coin_type,
             (unsigned long)path->account, (unsigned long)path->change,
             (unsigned long)path->address_index);

    return WALLET_OK;
}

bool wallet_get_current_path(HDPath *path_out) {
    if (!state.has_mnemonic || !path_out) {
        return false;
    }
    memcpy(path_out, &state.current_path, sizeof(HDPath));
    return true;
}

WalletError wallet_get_eth_address(EthAddress *address_out) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    // Get address from public key
    uint8_t addr[20];
    hdnode_get_ethereum_pubkeyhash(&state.node, addr);

    // Format as hex string
    address_out->hex[0] = '0';
    address_out->hex[1] = 'x';
    for (int i = 0; i < 20; i++) {
        sprintf(&address_out->hex[2 + i * 2], "%02x", addr[i]);
    }
    address_out->hex[42] = '\0';

    return WALLET_OK;
}

WalletError wallet_get_public_key(PublicKey *pubkey_out) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    // Decompress public key from 33 bytes to 65 bytes (0x04 + x + y)
    const ecdsa_curve *curve = state.node.curve->params;
    if (!curve) {
        return WALLET_ERROR_DERIVATION_FAILED;
    }

    curve_point point;
    if (!ecdsa_read_pubkey(curve, state.node.public_key, &point)) {
        return WALLET_ERROR_DERIVATION_FAILED;
    }

    pubkey_out->data[0] = 0x04;
    bn_write_be(&point.x, &pubkey_out->data[1]);
    bn_write_be(&point.y, &pubkey_out->data[33]);

    return WALLET_OK;
}

WalletError wallet_sign_hash(const uint8_t hash[32], EthSignature *signature_out) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    uint8_t sig[65];
    uint8_t pby;

    if (hdnode_sign_digest(&state.node, hash, sig, &pby, NULL) != 0) {
        return WALLET_ERROR_SIGNING_FAILED;
    }

    memcpy(signature_out->r, sig, 32);
    memcpy(signature_out->s, sig + 32, 32);
    signature_out->v = 27 + pby;  // Ethereum recovery ID

    return WALLET_OK;
}

WalletError wallet_sign_message(const uint8_t *message, size_t length, EthSignature *signature_out) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    // EIP-191 personal_sign: keccak256("\x19" + "Ethereum Signed Message:\n" + length + message)
    const char *prefix = "\x19" "Ethereum Signed Message:\n";
    size_t prefix_len = strlen(prefix);

    // Convert length to string
    char len_str[16];
    snprintf(len_str, sizeof(len_str), "%zu", length);
    size_t len_str_len = strlen(len_str);

    // Concatenate: prefix + length_string + message
    size_t total_len = prefix_len + len_str_len + length;
    uint8_t *data = malloc(total_len);
    if (!data) {
        return WALLET_ERROR_SIGNING_FAILED;
    }

    memcpy(data, prefix, prefix_len);
    memcpy(data + prefix_len, len_str, len_str_len);
    memcpy(data + prefix_len + len_str_len, message, length);

    // Keccak256 hash
    uint8_t hash[32];
    keccak_256(data, total_len, hash);
    free(data);

    // Sign the hash
    return wallet_sign_hash(hash, signature_out);
}

WalletError wallet_sign_typed_data(const uint8_t domain_separator[32],
                                    const uint8_t message_hash[32],
                                    EthSignature *signature_out) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    // EIP-712: keccak256("\x19\x01" + domainSeparator + hashStruct)
    // Total: 2 + 32 + 32 = 66 bytes
    uint8_t data[66];
    data[0] = 0x19;
    data[1] = 0x01;
    memcpy(data + 2, domain_separator, 32);
    memcpy(data + 34, message_hash, 32);

    // Keccak256 hash
    uint8_t hash[32];
    keccak_256(data, 66, hash);

    // Sign the hash
    WalletError result = wallet_sign_hash(hash, signature_out);

    memzero(data, sizeof(data));
    memzero(hash, sizeof(hash));

    return result;
}

WalletError wallet_sign_transaction(const uint8_t *tx_bytes, size_t tx_length,
                                     EthSignature *signature_out) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }
    if (tx_length == 0 || tx_bytes == NULL) {
        return WALLET_ERROR_SIGNING_FAILED;
    }

    // Keccak256 hash of the serialized unsigned transaction
    uint8_t hash[32];
    keccak_256(tx_bytes, tx_length, hash);

    // Sign the hash
    uint8_t sig[65];
    uint8_t pby;
    if (hdnode_sign_digest(&state.node, hash, sig, &pby, NULL) != 0) {
        memzero(hash, sizeof(hash));
        return WALLET_ERROR_SIGNING_FAILED;
    }

    memcpy(signature_out->r, sig, 32);
    memcpy(signature_out->s, sig + 32, 32);

    // For EIP-1559 (type 2) transactions, v is the parity (0 or 1)
    // For legacy transactions, v is 27 + parity
    // Check if this is an EIP-2718 typed transaction (first byte is type)
    if (tx_length > 0 && tx_bytes[0] == 0x02) {
        // EIP-1559: v = parity (0 or 1)
        signature_out->v = pby;
    } else {
        // Legacy: v = 27 + parity
        signature_out->v = 27 + pby;
    }

    memzero(hash, sizeof(hash));
    memzero(sig, sizeof(sig));

    return WALLET_OK;
}

WalletError wallet_wipe(void) {
    // Lock first
    wallet_lock();

    // Erase NVS namespace
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err == ESP_OK) {
        nvs_erase_all(nvs);
        nvs_commit(nvs);
        nvs_close(nvs);
    }

    // Reset state
    memzero(&state, sizeof(state));

    ESP_LOGI(TAG, "Wallet wiped");
    return WALLET_OK;
}

uint8_t wallet_get_count(void) {
    return state.wallet_count;
}

uint8_t wallet_get_active_index(void) {
    return state.active_wallet_index;
}

WalletError wallet_select_wallet(uint8_t index) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (index < 1 || index > state.wallet_count) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    // Invalidate seed cache (new mnemonic = new seed)
    invalidate_seed_cache();

    // Clear current mnemonic
    memzero(state.mnemonic, sizeof(state.mnemonic));
    memzero(&state.node, sizeof(state.node));
    state.has_mnemonic = false;

    // Load the selected wallet
    WalletError result = load_encrypted_mnemonic_at_index(index);
    if (result != WALLET_OK) {
        return result;
    }

    // Update and save active index
    state.active_wallet_index = index;
    save_wallet_metadata();

    ESP_LOGI(TAG, "Selected wallet #%d", index);
    return WALLET_OK;
}

uint8_t wallet_add_mnemonic(const char *mnemonic) {
    if (!state.initialized || !state.unlocked) {
        return 0;
    }

    // Validate mnemonic
    if (!mnemonic_check(mnemonic)) {
        return 0;
    }

    // Check storage limit
    if (state.wallet_count >= MAX_WALLETS) {
        return 0;
    }

    // Store internally
    strncpy(state.mnemonic, mnemonic, MAX_MNEMONIC_LENGTH - 1);
    state.mnemonic[MAX_MNEMONIC_LENGTH - 1] = '\0';
    state.has_mnemonic = true;

    // Save to next wallet slot
    uint8_t new_index = state.wallet_count + 1;
    WalletError result = save_encrypted_mnemonic_at_index(new_index);
    if (result != WALLET_OK) {
        state.has_mnemonic = false;
        memzero(state.mnemonic, sizeof(state.mnemonic));
        return 0;
    }

    // Update metadata
    state.wallet_count = new_index;
    state.active_wallet_index = new_index;
    save_wallet_metadata();

    ESP_LOGI(TAG, "Added mnemonic as wallet #%d", new_index);
    return new_index;
}

WalletError wallet_delete_mnemonic(uint8_t index) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (index < 1 || index > state.wallet_count) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return WALLET_ERROR_STORAGE_FAILED;
    }

    // If deleting the last wallet, just erase it
    if (index == state.wallet_count) {
        char mnemonic_key[16], iv_key[16];
        get_mnemonic_key(index, mnemonic_key, sizeof(mnemonic_key));
        get_iv_key(index, iv_key, sizeof(iv_key));

        nvs_erase_key(nvs, mnemonic_key);
        nvs_erase_key(nvs, iv_key);
        nvs_commit(nvs);
        nvs_close(nvs);

        state.wallet_count--;

        // Adjust active wallet if needed
        if (state.active_wallet_index == index) {
            if (state.wallet_count > 0) {
                state.active_wallet_index = state.wallet_count;
                load_encrypted_mnemonic_at_index(state.active_wallet_index);
            } else {
                state.active_wallet_index = 0;
                state.has_mnemonic = false;
                memzero(state.mnemonic, sizeof(state.mnemonic));
            }
        }
    } else {
        // Shift all wallets after the deleted one
        for (uint8_t i = index; i < state.wallet_count; i++) {
            char src_mnemonic_key[16], src_iv_key[16];
            char dst_mnemonic_key[16], dst_iv_key[16];

            get_mnemonic_key(i + 1, src_mnemonic_key, sizeof(src_mnemonic_key));
            get_iv_key(i + 1, src_iv_key, sizeof(src_iv_key));
            get_mnemonic_key(i, dst_mnemonic_key, sizeof(dst_mnemonic_key));
            get_iv_key(i, dst_iv_key, sizeof(dst_iv_key));

            // Read source
            size_t mnemonic_len = 0, iv_len = AES_IV_SIZE;
            nvs_get_blob(nvs, src_mnemonic_key, NULL, &mnemonic_len);

            if (mnemonic_len > 0) {
                uint8_t *mnemonic_data = malloc(mnemonic_len);
                uint8_t iv_data[AES_IV_SIZE];

                if (mnemonic_data) {
                    nvs_get_blob(nvs, src_mnemonic_key, mnemonic_data, &mnemonic_len);
                    nvs_get_blob(nvs, src_iv_key, iv_data, &iv_len);

                    // Write to destination
                    nvs_set_blob(nvs, dst_mnemonic_key, mnemonic_data, mnemonic_len);
                    nvs_set_blob(nvs, dst_iv_key, iv_data, iv_len);

                    memzero(mnemonic_data, mnemonic_len);
                    free(mnemonic_data);
                }
            }
        }

        // Erase the last slot (now empty)
        char last_mnemonic_key[16], last_iv_key[16];
        get_mnemonic_key(state.wallet_count, last_mnemonic_key, sizeof(last_mnemonic_key));
        get_iv_key(state.wallet_count, last_iv_key, sizeof(last_iv_key));
        nvs_erase_key(nvs, last_mnemonic_key);
        nvs_erase_key(nvs, last_iv_key);

        nvs_commit(nvs);
        nvs_close(nvs);

        state.wallet_count--;

        // Adjust active wallet index if needed
        if (state.active_wallet_index >= index) {
            if (state.active_wallet_index > index) {
                state.active_wallet_index--;
            }
            // Reload current wallet
            if (state.wallet_count > 0) {
                if (state.active_wallet_index > state.wallet_count) {
                    state.active_wallet_index = state.wallet_count;
                }
                load_encrypted_mnemonic_at_index(state.active_wallet_index);
            } else {
                state.active_wallet_index = 0;
                state.has_mnemonic = false;
                memzero(state.mnemonic, sizeof(state.mnemonic));
            }
        }
    }

    save_wallet_metadata();

    ESP_LOGI(TAG, "Deleted wallet #%d, count now %d, active %d",
             index, state.wallet_count, state.active_wallet_index);
    return WALLET_OK;
}
