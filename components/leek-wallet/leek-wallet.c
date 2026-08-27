/**
 * LeekWallet HD Wallet Core
 *
 * BIP39/BIP32/BIP44 hierarchical deterministic wallet with encrypted mnemonic
 * storage in NVS.
 *
 * Originally named after the Colibri hardware wallet, whose JSON-RPC method
 * naming and general shape inspired this design. No code was taken from it:
 * upstream Colibri is AGPL-3.0 C++ built on Arduino and ArduinoJson, while this
 * is an independent C implementation for ESP-IDF. The name was dropped to make
 * that boundary unambiguous, and because the two have diverged - see
 * docs/VAULT.md.
 */

#include "leek-wallet.h"
#include "bip39.h"
#include "bip32.h"
#include "curves.h"
#include "sha2.h"
#include "sha3.h"
#include "memzero.h"
#include "vault-kdf.h"
#include "vault-crypt.h"
#include "rand.h"
#include "ecdsa.h"
#include "bignum.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"
#include "mbedtls/aes.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

static const char *TAG = "wallet";

// Storage keys
#define NVS_NAMESPACE "colibri"
#define KEY_PASSWORD_HASH "pwd_hash"
#define KEY_WALLET_COUNT "wallet_cnt"
#define KEY_ACTIVE_WALLET "active_idx"
#define KEY_KDF_VERSION "kdf_ver"    // absent => legacy v1
#define KEY_KDF_SALT "kdf_salt"      // 16 bytes, per device
#define KEY_BACKUP_OK "backup_ok"    // bitmask: wallet N verified
#define KEY_VAULT_REC "vault_rec"    // generation + verifiers, see VaultRecord
// Indexed keys: m<gen>_1, m<gen>_2, ..., iv<gen>_1, ... (legacy: m_1, iv_1)

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

    /* Deliberately says nothing about whether a passphrase is applied. Whether
     * a hidden wallet exists is the secret a passphrase keeps (docs/VAULT.md,
     * "Do not record which seeds have a passphrase"), and the serial console
     * is readable by anyone holding the device while it is unlocked. */
    ESP_LOGI(TAG, "Caching seed (PBKDF2)...");

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

// ========== Generation-Scoped Slots ========== //
//
// Changing the PIN changes the key every mnemonic is encrypted under, so every
// mnemonic has to be rewritten. Rewriting them in place is not crash-safe: cut
// power halfway and half the vault is under the old key and half under the new,
// and whichever PIN the user types afterwards opens only half their wallets.
//
// So slots are generation-scoped instead. The re-encryption writes into the
// generation that is *not* live, leaving the live one untouched, and a single
// record then names which generation is authoritative. Until that one write
// lands the old generation is still the vault; after it lands the new one is.
// There is no in-between state to be interrupted in.
//
// Two generations are enough: at any moment there is the live one and the one
// being built.
//
// The record carries the password verifier as well, and that pairing is the
// whole point. A generation stored separately from the hash that opens it can
// be updated separately, which is the bug this design exists to remove.

#define VAULT_REC_VERSION 1

typedef struct {
    uint8_t version;
    uint8_t generation;         // 0 or 1
    uint8_t reserved[2];
    uint8_t password_hash[HASH_SIZE];
    /* Retired. This used to carry a second PIN verifier owned by src/pin.c,
     * an unsalted SHA-256 chain that was six orders of magnitude cheaper to
     * brute-force than password_hash above - so a flash dump was attacked
     * here, and the whole point of the KDF was lost. src/pin.c now verifies
     * through password_hash and stores nothing of its own.
     *
     * The field stays because sizeof(VaultRecord) is load-bearing:
     * load_vault_record() rejects a record of the wrong length, and shrinking
     * the struct would make every field device's record unreadable and send it
     * down the legacy pwd_hash path it may no longer have. It is written as
     * zero and purged from existing records at boot - see
     * purge_retired_companion(). */
    uint8_t retired_companion[HASH_SIZE];
    uint8_t retired_has_companion;
} VaultRecord;

/* Which slots the read/write helpers currently address. Swapped around
 * individual load/save calls during a re-encryption, the same way
 * vault_version is. */
typedef struct {
    bool    legacy;   // un-suffixed m_N / iv_N, from before generations existed
    uint8_t gen;
} VaultLayout;

static VaultLayout active_layout = { .legacy = true, .gen = 0 };
static bool    vault_rec_present = false;
static bool    vault_rec_loaded  = false;
static uint8_t vault_stored_hash[HASH_SIZE] = {0};
static bool    vault_stored_hash_valid = false;

// Read the authoritative record, falling back to the pre-generation layout.
//
// A device that has never had its PIN changed has no record: its mnemonics sit
// under un-suffixed keys and its verifier under pwd_hash. That vault must keep
// opening, so its absence is a valid state rather than an error - it is simply
// read as the legacy layout until the first PIN change moves it.
static void load_vault_record(void) {
    if (vault_rec_loaded) {
        return;
    }
    vault_rec_loaded = true;

    active_layout.legacy = true;
    active_layout.gen = 0;
    vault_rec_present = false;
    vault_stored_hash_valid = false;

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }

    VaultRecord rec;
    size_t len = sizeof(rec);
    esp_err_t err = nvs_get_blob(nvs, KEY_VAULT_REC, &rec, &len);
    if (err == ESP_OK && len == sizeof(rec) &&
        rec.version == VAULT_REC_VERSION && rec.generation <= 1) {
        vault_rec_present = true;
        active_layout.legacy = false;
        active_layout.gen = rec.generation;
        memcpy(vault_stored_hash, rec.password_hash, HASH_SIZE);
        vault_stored_hash_valid = true;
    } else {
        size_t hlen = HASH_SIZE;
        if (nvs_get_blob(nvs, KEY_PASSWORD_HASH, vault_stored_hash, &hlen) == ESP_OK &&
            hlen == HASH_SIZE) {
            vault_stored_hash_valid = true;
        }
    }
    memzero(&rec, sizeof(rec));
    nvs_close(nvs);
}

// The entire atomicity of a PIN change: one blob, one commit. Generation and
// verifier flip together or neither does.
static WalletError write_vault_record(uint8_t generation,
                                      const uint8_t password_hash[HASH_SIZE]) {
    VaultRecord rec;
    memzero(&rec, sizeof(rec));
    rec.version = VAULT_REC_VERSION;
    rec.generation = generation;
    memcpy(rec.password_hash, password_hash, HASH_SIZE);

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        memzero(&rec, sizeof(rec));
        return WALLET_ERROR_STORAGE_FAILED;
    }
    esp_err_t err = nvs_set_blob(nvs, KEY_VAULT_REC, &rec, sizeof(rec));
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);

    if (err != ESP_OK) {
        memzero(&rec, sizeof(rec));
        return WALLET_ERROR_STORAGE_FAILED;
    }

    vault_rec_loaded = true;
    vault_rec_present = true;
    active_layout.legacy = false;
    active_layout.gen = generation;
    memcpy(vault_stored_hash, password_hash, HASH_SIZE);
    vault_stored_hash_valid = true;
    memzero(&rec, sizeof(rec));
    return WALLET_OK;
}

// Rewrite the record without the retired PIN verifier, if one is still there.
//
// Needs no password: it removes a value rather than replacing one, and the
// record it rewrites is otherwise byte-identical. That is why it runs at boot
// instead of waiting for an unlock - the sooner the cheap verifier leaves the
// live NVS entry, the smaller the window in which a flash dump is worth
// taking. Single blob, single commit, so a power cut lands either on the old
// record or the new one and password_hash opens the vault in both.
static void purge_retired_companion(void) {
    load_vault_record();
    if (!vault_rec_present) {
        return;
    }

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }
    VaultRecord rec;
    size_t len = sizeof(rec);
    esp_err_t err = nvs_get_blob(nvs, KEY_VAULT_REC, &rec, &len);
    nvs_close(nvs);

    bool stale = (err == ESP_OK && len == sizeof(rec) &&
                  rec.retired_has_companion != 0);
    memzero(&rec, sizeof(rec));
    if (!stale) {
        return;
    }

    if (write_vault_record(active_layout.gen, vault_stored_hash) == WALLET_OK) {
        ESP_LOGW(TAG, "Dropped the retired PIN verifier from the vault record");
    }
}

static void slot_key(const char *prefix, uint8_t index, char *key, size_t key_size) {
    load_vault_record();
    if (active_layout.legacy) {
        snprintf(key, key_size, "%s_%d", prefix, index);
    } else {
        snprintf(key, key_size, "%s%u_%d", prefix, (unsigned)active_layout.gen, index);
    }
}

static void get_mnemonic_key(uint8_t index, char *key, size_t key_size) {
    slot_key("m", index, key, key_size);
}

static void get_iv_key(uint8_t index, char *key, size_t key_size) {
    slot_key("iv", index, key, key_size);
}

// Erase everything the authoritative record does not point at.
//
// Best-effort by design. A crash before the flip leaves a half-written
// generation nobody reads; a crash after it leaves the previous generation
// orphaned. Both are harmless - stale ciphertext under a key the user no
// longer types - so this runs at boot and after a change, and failing is fine.
static void erase_stale_slots(void) {
    load_vault_record();

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }

    for (uint8_t i = 1; i <= MAX_WALLETS; i++) {
        char key[16];
        if (!active_layout.legacy) {
            /* The record is authoritative, so the pre-generation slots are
             * dead weight - and leaving old ciphertext behind is worse than
             * pointless, it is a copy of the seed under a retired key. */
            snprintf(key, sizeof(key), "m_%d", i);   nvs_erase_key(nvs, key);
            snprintf(key, sizeof(key), "iv_%d", i);  nvs_erase_key(nvs, key);
        }
        for (uint8_t g = 0; g <= 1; g++) {
            if (!active_layout.legacy && g == active_layout.gen) {
                continue;
            }
            snprintf(key, sizeof(key), "m%u_%d", (unsigned)g, i);  nvs_erase_key(nvs, key);
            snprintf(key, sizeof(key), "iv%u_%d", (unsigned)g, i); nvs_erase_key(nvs, key);
        }
    }

    nvs_commit(nvs);
    nvs_close(nvs);
}

// ========== Helper Functions ========== //

// ========== Vault Key Derivation ========== //
//
// The derivation itself lives in src/vault-kdf.c so the host suite can verify
// it. This layer owns only the persisted parameters: which version a vault was
// written with, and its per-device salt.

static VaultKdfVersion vault_version = VAULT_KDF_V2;
static uint8_t vault_salt[VAULT_SALT_SIZE] = {0};
static bool vault_params_loaded = false;

// Load kdf_ver and kdf_salt, creating them on first use.
//
// A vault with no version key predates the salted scheme and is read as v1 so
// its mnemonics stay recoverable; wallet_unlock() migrates it on the next
// successful unlock.
static void load_vault_params(void) {
    if (vault_params_loaded) {
        return;
    }

    vault_version = VAULT_KDF_V1_LEGACY;
    memzero(vault_salt, sizeof(vault_salt));

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) == ESP_OK) {
        uint8_t ver = 0;
        if (nvs_get_u8(nvs, KEY_KDF_VERSION, &ver) == ESP_OK &&
            (ver == VAULT_KDF_V2 || ver == VAULT_KDF_V3)) {
            size_t salt_len = VAULT_SALT_SIZE;
            if (nvs_get_blob(nvs, KEY_KDF_SALT, vault_salt, &salt_len) == ESP_OK &&
                salt_len == VAULT_SALT_SIZE) {
                vault_version = (VaultKdfVersion)ver;
            } else {
                ESP_LOGE(TAG, "kdf_ver=%d but salt is missing or malformed", (int)ver);
            }
        }
        nvs_close(nvs);
    }

    vault_params_loaded = true;
    ESP_LOGI(TAG, "Vault KDF v%d", (int)vault_version);
}

// Generate and persist a fresh salt, switching the vault to v2.
// Fails rather than proceeding if entropy is unavailable - a predictable salt
// would silently undo the point of having one.
static WalletError init_vault_params_v3(void) {
    uint8_t salt[VAULT_SALT_SIZE];
    random_buffer(salt, sizeof(salt));

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        memzero(salt, sizeof(salt));
        return WALLET_ERROR_STORAGE_FAILED;
    }

    esp_err_t err = nvs_set_blob(nvs, KEY_KDF_SALT, salt, VAULT_SALT_SIZE);
    if (err == ESP_OK) {
        err = nvs_set_u8(nvs, KEY_KDF_VERSION, VAULT_KDF_CURRENT);
    }
    if (err == ESP_OK) {
        nvs_commit(nvs);
    }
    nvs_close(nvs);

    if (err != ESP_OK) {
        memzero(salt, sizeof(salt));
        return WALLET_ERROR_STORAGE_FAILED;
    }

    memcpy(vault_salt, salt, VAULT_SALT_SIZE);
    vault_version = VAULT_KDF_CURRENT;
    vault_params_loaded = true;
    memzero(salt, sizeof(salt));

    ESP_LOGI(TAG, "Vault initialized at v%d", (int)VAULT_KDF_CURRENT);
    return WALLET_OK;
}

static void derive_key_from_password(const char *password, size_t length, uint8_t key_out[32]) {
    load_vault_params();
    vault_derive_key(vault_version, password, length, vault_salt, key_out);
}

static void compute_password_hash(const char *password, size_t length, uint8_t hash_out[32]) {
    load_vault_params();
    vault_derive_verifier(vault_version, password, length, vault_salt, hash_out);
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

    char mnemonic_key_v3[16], iv_key_v3[16];
    get_mnemonic_key(index, mnemonic_key_v3, sizeof(mnemonic_key_v3));
    get_iv_key(index, iv_key_v3, sizeof(iv_key_v3));

    if (VAULT_USES_GCM(vault_version)) {
        /* One self-contained blob: nonce, ciphertext, tag. The separate iv_N
         * key that CBC needed is deleted, so a stale IV cannot be paired with
         * a v3 blob by a half-finished migration. */
        size_t blob_cap = mnemonic_len + 1 + VAULT_CRYPT_OVERHEAD;
        uint8_t *blob = calloc(blob_cap, 1);
        if (!blob) {
            nvs_close(nvs);
            return WALLET_ERROR_STORAGE_FAILED;
        }

        size_t blob_len = vault_encrypt((const uint8_t *)state.mnemonic,
                                        mnemonic_len + 1,
                                        state.encryption_key, blob, blob_cap);
        if (blob_len == 0) {
            memzero(blob, blob_cap);
            free(blob);
            nvs_close(nvs);
            return WALLET_ERROR_STORAGE_FAILED;
        }

        err = nvs_set_blob(nvs, mnemonic_key_v3, blob, blob_len);
        memzero(blob, blob_cap);
        free(blob);

        if (err != ESP_OK) {
            nvs_close(nvs);
            return WALLET_ERROR_STORAGE_FAILED;
        }

        nvs_erase_key(nvs, iv_key_v3);   /* absent is fine; unused under GCM */
        nvs_commit(nvs);
        nvs_close(nvs);
        return WALLET_OK;
    }

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

    if (VAULT_USES_GCM(vault_version)) {
        /* v3: one blob carrying its own nonce and tag. A wrong key, a
         * corrupted blob and a tampered one are indistinguishable here, and
         * deliberately so - all three mean the same thing to the caller. */
        uint8_t *blob = calloc(cipher_len, 1);
        if (!blob) {
            nvs_close(nvs);
            return WALLET_ERROR_STORAGE_FAILED;
        }

        err = nvs_get_blob(nvs, mnemonic_key, blob, &cipher_len);
        nvs_close(nvs);

        if (err != ESP_OK) {
            memzero(blob, cipher_len);
            free(blob);
            return WALLET_ERROR_NO_MNEMONIC;
        }

        uint8_t plain[MAX_MNEMONIC_LENGTH] = {0};
        size_t plain_len = vault_decrypt(blob, cipher_len, state.encryption_key,
                                         plain, sizeof(plain));
        memzero(blob, cipher_len);
        free(blob);

        if (plain_len == 0) {
            memzero(plain, sizeof(plain));
            return WALLET_ERROR_WRONG_PASSWORD;
        }

        plain[sizeof(plain) - 1] = '\0';
        strncpy(state.mnemonic, (const char *)plain, MAX_MNEMONIC_LENGTH - 1);
        state.mnemonic[MAX_MNEMONIC_LENGTH - 1] = '\0';
        memzero(plain, sizeof(plain));

        if (!mnemonic_check(state.mnemonic)) {
            memzero(state.mnemonic, sizeof(state.mnemonic));
            return WALLET_ERROR_INVALID_MNEMONIC;
        }

        state.has_mnemonic = true;
        invalidate_seed_cache();
        return WALLET_OK;
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

// ========== Backup Verification Tracking ========== //
//
// Records which wallets have had their seed phrase read back correctly. Not a
// security control - it drives warnings before destructive actions, because
// wiping a wallet whose backup was never confirmed is how people actually lose
// funds. A wrong PIN prompt would not catch that; this does.

static uint32_t load_backup_mask(void) {
    uint32_t mask = 0;
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) == ESP_OK) {
        size_t len = sizeof(mask);
        if (nvs_get_blob(nvs, KEY_BACKUP_OK, &mask, &len) != ESP_OK || len != sizeof(mask)) {
            mask = 0;
        }
        nvs_close(nvs);
    }
    return mask;
}

void wallet_mark_backup_verified(uint8_t index) {
    if (index == 0 || index > MAX_WALLETS) {
        return;
    }

    uint32_t mask = load_backup_mask() | (1u << (index - 1));

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_blob(nvs, KEY_BACKUP_OK, &mask, sizeof(mask));
        nvs_commit(nvs);
        nvs_close(nvs);
        ESP_LOGI(TAG, "Wallet %d marked as backed up", index);
    }
}

bool wallet_is_backup_verified(uint8_t index) {
    if (index == 0 || index > MAX_WALLETS) {
        return false;
    }
    return (load_backup_mask() & (1u << (index - 1))) != 0;
}

uint8_t wallet_unverified_count(void) {
    uint32_t mask = load_backup_mask();
    uint8_t count = 0;
    for (uint8_t i = 1; i <= state.wallet_count && i <= MAX_WALLETS; i++) {
        if (!(mask & (1u << (i - 1)))) {
            count++;
        }
    }
    return count;
}

// ========== Vault Migration (v1 -> v2) ========== //

/**
 * Re-encrypt every stored mnemonic under the v2 key derivation.
 *
 * Only callable immediately after a successful v1 unlock, which is the one
 * moment both the password and the legacy key are available.
 *
 * Ordering is what makes this safe against power loss. Every mnemonic is
 * rewritten under the new key *before* the version marker flips, and the marker
 * is the last write. Losing power partway leaves the vault still tagged v1, so
 * the next boot simply reads it as v1 and tries again. The cost of a crash is a
 * repeated migration, never an unreadable wallet.
 *
 * This does mean a window where blobs are v2-encrypted while the marker says
 * v1. Recovery relies on load_encrypted_mnemonic_at_index() failing cleanly on
 * a wrong key, which it does: a bad decrypt yields a mnemonic that fails its
 * BIP39 checksum and is rejected.
 */
/**
 * Load wallet `index` with the active key, falling back to `alt_key`.
 *
 * Needed because a migration interrupted during pass 2 leaves some blobs
 * encrypted under v2 while the version marker still reads v1. Without this,
 * the retry on the next unlock would fail its own pre-check and the user would
 * be stuck with a vault that is intact but unopenable.
 *
 * Safe because a wrong key does not silently succeed: the decrypted bytes fail
 * their BIP39 checksum and load_encrypted_mnemonic_at_index() rejects them.
 */
static WalletError load_mnemonic_with_alt(uint8_t index, const uint8_t *alt_key) {
    WalletError err = load_encrypted_mnemonic_at_index(index);
    if (err == WALLET_OK || alt_key == NULL) {
        return err;
    }

    uint8_t saved[32];
    memcpy(saved, state.encryption_key, sizeof(saved));
    memcpy(state.encryption_key, alt_key, 32);

    err = load_encrypted_mnemonic_at_index(index);
    if (err != WALLET_OK) {
        memcpy(state.encryption_key, saved, sizeof(saved));
    } else {
        ESP_LOGW(TAG, "Wallet %d opened with the alternate key "
                      "(interrupted migration)", index);
    }

    memzero(saved, sizeof(saved));
    return err;
}

/**
 * Bring an older vault up to the current format.
 *
 * Two cases, and they differ in cost. v1 needs a new salt and new keys, so
 * every mnemonic is re-derived and re-encrypted. v2 already uses the current
 * derivation and differs only in storage, so the key is unchanged and the
 * blobs are simply rewritten under GCM.
 *
 * Both share the same ordering, which is what makes them crash-safe: prove
 * everything is readable, rewrite it, and flip the version marker last. Losing
 * power leaves the vault on its old version and the next unlock tries again.
 */
static WalletError migrate_vault_to_current(const char *password, size_t length) {
    VaultKdfVersion from = vault_version;
    ESP_LOGW(TAG, "Migrating vault from v%d to v%d (%d wallets)",
             (int)from, (int)VAULT_KDF_CURRENT, state.wallet_count);

    uint8_t old_key[32], new_key[32];
    memcpy(old_key, state.encryption_key, sizeof(old_key));

    /*
     * If a salt already exists, a previous migration was interrupted and some
     * blobs may already be under v2. Derive that key up front so both passes
     * can fall back to it.
     */
    uint8_t  resume_key[32];
    uint8_t *resume = NULL;
    {
        nvs_handle_t nvs;
        if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) == ESP_OK) {
            uint8_t existing[VAULT_SALT_SIZE];
            size_t  slen = VAULT_SALT_SIZE;
            if (nvs_get_blob(nvs, KEY_KDF_SALT, existing, &slen) == ESP_OK &&
                slen == VAULT_SALT_SIZE) {
                vault_derive_key(VAULT_KDF_V2, password, length, existing, resume_key);
                resume = resume_key;
                ESP_LOGW(TAG, "Found an existing salt; resuming a prior migration");
            }
            memzero(existing, sizeof(existing));
            nvs_close(nvs);
        }
    }

    // Pass 1: prove every wallet is readable under the legacy key before
    // writing anything. If one is corrupt we abort with the vault untouched,
    // rather than half-converting it.
    for (uint8_t i = 1; i <= state.wallet_count && i <= MAX_WALLETS; i++) {
        memcpy(state.encryption_key, old_key, sizeof(old_key));
        if (load_mnemonic_with_alt(i, resume) != WALLET_OK) {
            ESP_LOGE(TAG, "Wallet %d unreadable; aborting migration", i);
            memzero(old_key, sizeof(old_key));
            memzero(resume_key, sizeof(resume_key));
            return WALLET_ERROR_STORAGE_FAILED;
        }
    }

    // Establish v2 parameters and derive the new key.
    WalletError err = init_vault_params_v3();
    if (err != WALLET_OK) {
        memzero(old_key, sizeof(old_key));
        memzero(resume_key, sizeof(resume_key));
        return err;
    }
    vault_derive_key(VAULT_KDF_V2, password, length, vault_salt, new_key);

    // Pass 2: re-encrypt one wallet at a time, swapping the active key around
    // each operation. Holding two 32-byte keys instead of every plaintext keeps
    // this off the RAM budget - buffering 30 mnemonics would cost ~7.7 KB and
    // park every seed in .bss for the duration.
    for (uint8_t i = 1; i <= state.wallet_count && i <= MAX_WALLETS; i++) {
        /* Read under the old format, write under the new one. vault_version
         * selects the format on both sides, so it is moved around each pair. */
        VaultKdfVersion target = vault_version;
        vault_version = from;
        memcpy(state.encryption_key, old_key, sizeof(old_key));
        WalletError rerr = load_mnemonic_with_alt(i, new_key);
        vault_version = target;

        if (rerr != WALLET_OK) {
            memzero(old_key, sizeof(old_key));
            memzero(new_key, sizeof(new_key));
            memzero(resume_key, sizeof(resume_key));
            return WALLET_ERROR_STORAGE_FAILED;
        }

        memcpy(state.encryption_key, new_key, sizeof(new_key));
        if (save_encrypted_mnemonic_at_index(i) != WALLET_OK) {
            ESP_LOGE(TAG, "Failed to rewrite wallet %d", i);
            memzero(old_key, sizeof(old_key));
            memzero(new_key, sizeof(new_key));
            return WALLET_ERROR_STORAGE_FAILED;
        }
    }

    // Publish the new verifier last. Until this write lands the vault still
    // authenticates against the v1 hash, so an interrupted migration is retried
    // on the next unlock rather than locking the user out.
    //
    // A crash inside pass 2 leaves some blobs under v2 while the marker still
    // says v1. Both passes handle that via load_mnemonic_with_alt(), so the
    // retry on the next unlock picks up where this one stopped.
    compute_password_hash(password, length, state.password_hash);

    /* Same generation - a KDF migration rewrites blobs in place - but the
     * verifier must travel with whichever record is authoritative, or the new
     * hash and the generation it belongs to end up in different places. */
    load_vault_record();
    WalletError nerr;
    if (vault_rec_present) {
        nerr = write_vault_record(active_layout.gen, state.password_hash);
    } else {
        nvs_handle_t nvs;
        if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
            memzero(old_key, sizeof(old_key));
            memzero(new_key, sizeof(new_key));
            return WALLET_ERROR_STORAGE_FAILED;
        }
        esp_err_t werr = nvs_set_blob(nvs, KEY_PASSWORD_HASH, state.password_hash, HASH_SIZE);
        if (werr == ESP_OK) {
            werr = nvs_commit(nvs);
        }
        nvs_close(nvs);
        if (werr == ESP_OK) {
            memcpy(vault_stored_hash, state.password_hash, HASH_SIZE);
            vault_stored_hash_valid = true;
        }
        nerr = (werr == ESP_OK) ? WALLET_OK : WALLET_ERROR_STORAGE_FAILED;
    }

    memzero(old_key, sizeof(old_key));
    memzero(resume_key, sizeof(resume_key));
    memcpy(state.encryption_key, new_key, sizeof(new_key));
    memzero(new_key, sizeof(new_key));

    if (nerr != WALLET_OK) {
        return WALLET_ERROR_STORAGE_FAILED;
    }

    if (state.active_wallet_index > 0) {
        load_encrypted_mnemonic_at_index(state.active_wallet_index);
    }

    nvs_handle_t vnvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &vnvs) == ESP_OK) {
        nvs_set_u8(vnvs, KEY_KDF_VERSION, VAULT_KDF_CURRENT);
        nvs_commit(vnvs);
        nvs_close(vnvs);
    }

    ESP_LOGW(TAG, "Vault migrated to v%d", (int)VAULT_KDF_CURRENT);
    return WALLET_OK;
}

/* ========== Derivation lock ==========
 *
 * wallet_select_path() and wallet_sign_hash() communicate through state.node,
 * and two tasks reach them: the UI at priority 5 and the protocol endpoint at
 * 4. The UI therefore preempts. Selecting a path and then signing as separate
 * calls is not atomic, and the UI switching screens in between re-derives to
 * its own address index - so the device signs with a key nobody asked for.
 *
 * That is not hypothetical: it produced a real signature over a real
 * transaction from the wrong account, which the network rejected for having no
 * funds. The failure was safe only by accident.
 */
static SemaphoreHandle_t derive_lock = NULL;

static void derive_lock_init(void) {
    if (!derive_lock) {
        derive_lock = xSemaphoreCreateRecursiveMutex();
    }
}

static bool derive_lock_take(void) {
    derive_lock_init();
    return derive_lock && xSemaphoreTakeRecursive(derive_lock, pdMS_TO_TICKS(5000)) == pdTRUE;
}

static void derive_lock_give(void) {
    if (derive_lock) {
        xSemaphoreGiveRecursive(derive_lock);
    }
}

/**
 * Select a path and sign in one indivisible step.
 *
 * The only safe way to sign: nothing can re-derive between choosing the key
 * and using it.
 */
WalletError wallet_sign_hash_at_path(const HDPath *path, const uint8_t hash[32],
                                     EthSignature *signature_out) {
    if (!derive_lock_take()) {
        return WALLET_ERROR_STORAGE_FAILED;
    }

    WalletError err = wallet_select_path(path);
    if (err == WALLET_OK) {
        err = wallet_sign_hash(hash, signature_out);
    }

    derive_lock_give();
    return err;
}

/**
 * Derive an address at a path, atomically.
 *
 * Same reasoning: reading back an address that another task re-derived under
 * you is how the app and the device came to disagree about which address index
 * zero was.
 */
WalletError wallet_get_address_at_path(const HDPath *path, EthAddress *address_out) {
    if (!derive_lock_take()) {
        return WALLET_ERROR_STORAGE_FAILED;
    }

    WalletError err = wallet_select_path(path);
    if (err == WALLET_OK) {
        err = wallet_get_eth_address(address_out);
    }

    derive_lock_give();
    return err;
}

#ifdef LEEK_HOST_TEST
/* Host tests only: drop every byte of RAM state so wallet_init() re-reads
 * storage, which is the only way to simulate a reboot in-process. Compiled out
 * of firmware builds entirely. */
void wallet__reset_static_state_for_test(void) {
    memzero(&state, sizeof(state));
    vault_rec_loaded = false;
    vault_rec_present = false;
    vault_stored_hash_valid = false;
    vault_params_loaded = false;
    active_layout.legacy = true;
    active_layout.gen = 0;
    memzero(vault_stored_hash, sizeof(vault_stored_hash));
}
#endif

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

    // Whether a password exists, and which generation opens it, come from the
    // same record - asking two sources is how they get to disagree.
    load_vault_record();
    state.password_set = vault_stored_hash_valid;

    state.initialized = true;
    state.unlocked = false;
    state.has_mnemonic = false;

    /* How many wallets exist and which is active are not secret - they are two
     * plain counters, and the mnemonics they refer to stay encrypted. Loading
     * them here rather than at unlock means the UI knows the device holds a
     * wallet before anyone has authenticated, which is what lets it offer to
     * open one. */
    load_wallet_metadata();
    load_vault_params();

    /* Sweep up whatever an interrupted PIN change left behind. Safe at any
     * boot because the record already decided which generation is real. */
    erase_stale_slots();

    /* Devices upgraded from a firmware that kept a second, unsalted PIN
     * verifier still carry it inside the record. Drop it here, before anything
     * has been unlocked. */
    purge_retired_companion();

    ESP_LOGI(TAG, "Wallet initialized, password_set=%d, wallets=%d, active=%d, vault=v%d",
             state.password_set, state.wallet_count, state.active_wallet_index,
             (int)vault_version);
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

    // A brand-new vault is always v2. Establish the salt before deriving
    // anything, so the very first key is salted.
    load_vault_params();
    if (vault_version != VAULT_KDF_V2) {
        WalletError verr = init_vault_params_v3();
        if (verr != WALLET_OK) {
            return verr;
        }
    }

    // Compute password hash and encryption key
    compute_password_hash(password, length, state.password_hash);
    derive_key_from_password(password, length, state.encryption_key);

    /* A vault that already has a password and no record is a pre-generation
     * device, and its mnemonics live under un-suffixed keys. Publishing a
     * record here would silently repoint the vault at an empty generation, so
     * that case keeps the old key. Moving it is the PIN change's job, which
     * re-encrypts before it flips. */
    load_vault_record();
    bool keep_legacy = active_layout.legacy && vault_stored_hash_valid;

    if (!keep_legacy) {
        WalletError rerr = write_vault_record(active_layout.legacy ? 0 : active_layout.gen,
                                              state.password_hash);
        if (rerr != WALLET_OK) {
            return rerr;
        }
    } else {
        nvs_handle_t nvs;
        esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
        if (err != ESP_OK) {
            return WALLET_ERROR_STORAGE_FAILED;
        }
        err = nvs_set_blob(nvs, KEY_PASSWORD_HASH, state.password_hash, HASH_SIZE);
        if (err == ESP_OK) {
            err = nvs_commit(nvs);
        }
        nvs_close(nvs);
        if (err != ESP_OK) {
            return WALLET_ERROR_STORAGE_FAILED;
        }
        memcpy(vault_stored_hash, state.password_hash, HASH_SIZE);
        vault_stored_hash_valid = true;
    }

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

    load_vault_record();
    /* vault_hash_equals, not memcmp: vault-kdf.h requires it, and a compare
     * that exits on the first differing byte leaks how much of a guessed
     * verifier was right. */
    if (!vault_stored_hash_valid || !vault_hash_equals(hash, vault_stored_hash)) {
        memzero(hash, sizeof(hash));
        return WALLET_ERROR_WRONG_PASSWORD;
    }

    // Store password hash and derive encryption key
    memcpy(state.password_hash, hash, HASH_SIZE);
    derive_key_from_password(password, length, state.encryption_key);

    memzero(hash, sizeof(hash));

    state.unlocked = true;

    // Load wallet metadata
    load_wallet_metadata();

    /* An older vault just proved its password, which is the only moment it can
     * be re-encrypted. Do so now. */
    ESP_LOGI(TAG, "Unlock complete: vault is v%d, current is v%d",
             (int)vault_version, (int)VAULT_KDF_CURRENT);

    if (vault_version != VAULT_KDF_CURRENT) {
        WalletError merr = migrate_vault_to_current(password, length);
        if (merr != WALLET_OK) {
            /* Migration failed but the vault is still readable in its old
             * format, so stay unlocked and retry on the next unlock rather
             * than locking the user out of their own funds. */
            ESP_LOGE(TAG, "Vault migration failed (%d); staying on v%d",
                     merr, (int)vault_version);
        }
    }

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
    /* The verifier too: it is a KDF output over the PIN, so a copy left in RAM
     * is an offline oracle for the PIN behind a device that is supposed to be
     * locked. Every path that needs it recomputes it from a PIN it was just
     * given. */
    memzero(state.password_hash, sizeof(state.password_hash));

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

    load_vault_record();
    bool match = vault_stored_hash_valid &&
                 vault_hash_equals(hash, vault_stored_hash);

    memzero(hash, sizeof(hash));

    return match;
}

// ========== Change Password ========== //

/**
 * Re-encrypt the whole vault under a new password.
 *
 * This is the one moment both keys can exist: the caller has just supplied
 * both passwords. There is no resuming it later from one PIN and two keys, so
 * it cannot be made restartable - it has to be made atomic instead, which is
 * what the generation split above buys.
 *
 * Order:
 *   1. verify the old password;
 *   2. prove every wallet is readable under the old key, writing nothing;
 *   3. copy each wallet into the other generation under the new key;
 *   4. flip the record - one blob, one commit, generation and verifier
 *      together;
 *   5. erase the generation nobody reads any more.
 *
 * Step 2 matters as much as step 4: converting a vault with one corrupt slot
 * would turn "one wallet is broken" into "the PIN opens a vault missing a
 * wallet", and the user would find out much later. Aborting leaves the vault
 * exactly as it was.
 *
 * A crash in step 3 leaves the old generation and old verifier authoritative;
 * a crash in step 5 leaves the new generation authoritative with dead blobs
 * beside it. Both boot into a device where one PIN opens everything.
 */
WalletError wallet_get_master_fingerprint(uint32_t *fingerprint_out) {
    if (!fingerprint_out) {
        return WALLET_ERROR_DERIVATION_FAILED;
    }
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.unlocked) {
        return WALLET_ERROR_LOCKED;
    }
    if (!state.has_mnemonic) {
        return WALLET_ERROR_NO_MNEMONIC;
    }

    if (!derive_lock_take()) {
        return WALLET_ERROR_DERIVATION_FAILED;
    }

    cache_seed_from_mnemonic();

    /* A local node, never state.node.
     *
     * state.node is where the last derivation left off, and this runs from the
     * UI while the protocol task may be signing. Reusing it to compute a
     * display value is exactly the shape of bug that once signed with a key the
     * confirmation screen never named. Nothing here touches shared state. */
    HDNode master;
    WalletError err = WALLET_OK;

    if (hdnode_from_seed(state.seed, SEED_SIZE, SECP256K1_NAME, &master) != 1) {
        err = WALLET_ERROR_DERIVATION_FAILED;
        goto done;
    }
    hdnode_fill_public_key(&master);
    *fingerprint_out = hdnode_fingerprint(&master);

done:
    memzero(&master, sizeof(master));
    derive_lock_give();
    return err;
}

WalletError wallet_change_password(const char *old_password, size_t old_length,
                                   const char *new_password, size_t new_length,
                                   WalletProgressFn progress) {
    if (!state.initialized) {
        return WALLET_ERROR_NOT_INITIALIZED;
    }
    if (!state.password_set) {
        return WALLET_ERROR_WRONG_PASSWORD;
    }
    if (!new_password || new_length < MIN_PASSWORD_LENGTH) {
        return WALLET_ERROR_WRONG_PASSWORD;
    }
    if (!wallet_verify_password(old_password, old_length)) {
        return WALLET_ERROR_WRONG_PASSWORD;
    }

    load_vault_record();
    const VaultLayout from_layout = active_layout;
    const VaultLayout to_layout = {
        .legacy = false,
        /* From the legacy layout, generation 0 is free by definition: nothing
         * has ever been written to a suffixed slot. */
        .gen = active_layout.legacy ? 0 : (uint8_t)(active_layout.gen ^ 1u),
    };

    uint8_t old_key[32], new_key[32], new_hash[HASH_SIZE];
    derive_key_from_password(old_password, old_length, old_key);
    derive_key_from_password(new_password, new_length, new_key);
    compute_password_hash(new_password, new_length, new_hash);

    /* Saved so a failure anywhere below can put the caller's session back the
     * way it was, rather than leaving it holding a key for a vault that was
     * never written. */
    uint8_t saved_key[32];
    memcpy(saved_key, state.encryption_key, sizeof(saved_key));

    /* The legacy CBC read path sets the active index as a side effect, and the
     * loops below walk every slot. Without this the user's selected wallet
     * silently becomes the last one. */
    const uint8_t saved_active = state.active_wallet_index;

    WalletError result = WALLET_OK;
    const uint8_t total = (state.wallet_count <= MAX_WALLETS) ? state.wallet_count
                                                              : MAX_WALLETS;

    // Pass 1: read-only proof. Nothing has been written yet, so any failure
    // here costs the user nothing.
    for (uint8_t i = 1; i <= total; i++) {
        active_layout = from_layout;
        memcpy(state.encryption_key, old_key, sizeof(old_key));
        if (load_encrypted_mnemonic_at_index(i) != WALLET_OK) {
            ESP_LOGE(TAG, "Wallet %d unreadable; refusing to change the password", i);
            result = WALLET_ERROR_STORAGE_FAILED;
            goto done;
        }
        if (progress) {
            progress(i, (uint8_t)(total * 2));
        }
    }

    // Pass 2: one wallet at a time, old generation to new. Only a single
    // plaintext mnemonic is ever in RAM - buffering all 30 would park every
    // seed the device holds in .bss for the duration.
    for (uint8_t i = 1; i <= total; i++) {
        active_layout = from_layout;
        memcpy(state.encryption_key, old_key, sizeof(old_key));
        if (load_encrypted_mnemonic_at_index(i) != WALLET_OK) {
            result = WALLET_ERROR_STORAGE_FAILED;
            goto done;
        }

        active_layout = to_layout;
        memcpy(state.encryption_key, new_key, sizeof(new_key));
        WalletError serr = save_encrypted_mnemonic_at_index(i);
        if (serr != WALLET_OK) {
            ESP_LOGE(TAG, "Failed to write wallet %d; vault unchanged", i);
            result = serr;
            goto done;
        }
        if (progress) {
            progress((uint8_t)(total + i), (uint8_t)(total * 2));
        }
    }

    // The flip. Everything before this was invisible; everything after is
    // cleanup.
    result = write_vault_record(to_layout.gen, new_hash);
    if (result != WALLET_OK) {
        ESP_LOGE(TAG, "Could not publish the new vault record; vault unchanged");
        goto done;
    }

    memcpy(state.password_hash, new_hash, HASH_SIZE);
    memcpy(state.encryption_key, new_key, sizeof(new_key));
    memcpy(saved_key, new_key, sizeof(new_key));
    state.active_wallet_index = saved_active;

    erase_stale_slots();

    /* Reload through the new generation so the session is not still holding a
     * mnemonic read out of storage that no longer exists. */
    if (state.wallet_count > 0 && state.active_wallet_index > 0) {
        load_encrypted_mnemonic_at_index(state.active_wallet_index);
    }

    ESP_LOGW(TAG, "Vault re-encrypted into generation %u", (unsigned)to_layout.gen);

done:
    if (result != WALLET_OK) {
        /* The record still names the old generation, so restoring the layout
         * and key is all that is needed - nothing durable changed. */
        active_layout = from_layout;
        memcpy(state.encryption_key, saved_key, sizeof(saved_key));
        state.active_wallet_index = saved_active;
        if (state.wallet_count > 0 && state.active_wallet_index > 0) {
            load_encrypted_mnemonic_at_index(state.active_wallet_index);
        }
    }

    memzero(old_key, sizeof(old_key));
    memzero(new_key, sizeof(new_key));
    memzero(new_hash, sizeof(new_hash));
    memzero(saved_key, sizeof(saved_key));
    return result;
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

    // Reset state, including the cached record - storage is empty now, and a
    // stale generation cached in RAM would send the next write to a slot the
    // next boot does not look at.
    memzero(&state, sizeof(state));
    vault_rec_loaded = false;
    vault_rec_present = false;
    vault_stored_hash_valid = false;
    vault_params_loaded = false;
    active_layout.legacy = true;
    active_layout.gen = 0;
    memzero(vault_stored_hash, sizeof(vault_stored_hash));

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

    /* Clear the passphrase too.
     *
     * Carrying it across a switch derives seed N + the previous passphrase,
     * which is a real wallet nobody asked for and which looks empty. The user
     * concludes seed N has no funds while their actual seed-N wallet sits
     * elsewhere, unshown. Same failure as a mistyped passphrase, arrived at
     * without typing anything. A passphrase belongs to the seed it was entered
     * for, and does not survive leaving it. */
    if (state.has_passphrase) {
        ESP_LOGI(TAG, "Clearing passphrase on wallet switch");
    }
    memzero(state.passphrase, sizeof(state.passphrase));
    state.has_passphrase = false;

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
