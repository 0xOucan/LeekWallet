/**
 * Minimal persistent vault for host suites that link src/pin.c without the
 * real components/leek-wallet.c.
 *
 * pin.c has no PIN verifier of its own any more: the vault's salted PBKDF2
 * hash is the only one, so a stub that merely reports "no password" would make
 * pin_set() and pin_verify() untestable. This is therefore a real, if tiny,
 * vault: the verifier is the same vault_derive_verifier() the firmware uses,
 * over a per-device salt, and both live in NVS under the wallet's own
 * namespace so a simulated reboot behaves like a real one and a wipe of that
 * namespace removes them.
 *
 * What it deliberately is NOT is a store of mnemonics. The crash-safety of
 * re-encrypting them is a property of the real file's write ordering, and is
 * tested against the real file in test_pin_change.c.
 */

#include "leek-wallet.h"
#include "vault-kdf.h"

#include <stddef.h>
#include <string.h>

#include "nvs.h"
#include "memzero.h"
#include "rand.h"

#define NS        "colibri"
#define KEY_HASH  "pwd_hash"
#define KEY_SALT  "kdf_salt"

static bool initialized = false;

/* Load the salt, minting one on first use. A fixed salt would be simpler and
 * would also quietly stop the suite from noticing if the firmware ever went
 * back to an unsalted verifier. */
static bool load_salt(uint8_t salt[VAULT_SALT_SIZE], bool create)
{
    nvs_handle_t nvs;
    if (nvs_open(NS, NVS_READWRITE, &nvs) != ESP_OK) {
        return false;
    }

    size_t len = VAULT_SALT_SIZE;
    bool have = (nvs_get_blob(nvs, KEY_SALT, salt, &len) == ESP_OK &&
                 len == VAULT_SALT_SIZE);
    if (!have && create) {
        random_buffer(salt, VAULT_SALT_SIZE);
        have = (nvs_set_blob(nvs, KEY_SALT, salt, VAULT_SALT_SIZE) == ESP_OK);
        nvs_commit(nvs);
    }
    nvs_close(nvs);
    return have;
}

static bool stored_verifier(uint8_t out[VAULT_HASH_SIZE])
{
    nvs_handle_t nvs;
    if (nvs_open(NS, NVS_READONLY, &nvs) != ESP_OK) {
        return false;
    }
    size_t len = VAULT_HASH_SIZE;
    bool ok = (nvs_get_blob(nvs, KEY_HASH, out, &len) == ESP_OK &&
               len == VAULT_HASH_SIZE);
    nvs_close(nvs);
    return ok;
}

WalletError wallet_init(void)
{
    initialized = true;
    return WALLET_OK;
}

WalletStatus wallet_get_status(void)
{
    uint8_t hash[VAULT_HASH_SIZE];
    WalletStatus s = {0};
    s.initialized = initialized;
    s.password_set = initialized && stored_verifier(hash);
    memzero(hash, sizeof(hash));
    return s;
}

WalletError wallet_set_password(const char *password, size_t length)
{
    uint8_t salt[VAULT_SALT_SIZE];
    uint8_t hash[VAULT_HASH_SIZE];

    if (!password || length == 0 || !load_salt(salt, true)) {
        return WALLET_ERROR_STORAGE_FAILED;
    }

    vault_derive_verifier(VAULT_KDF_V2, password, length, salt, hash);

    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &nvs);
    if (err == ESP_OK) {
        err = nvs_set_blob(nvs, KEY_HASH, hash, VAULT_HASH_SIZE);
        if (err == ESP_OK) {
            err = nvs_commit(nvs);
        }
        nvs_close(nvs);
    }

    memzero(salt, sizeof(salt));
    memzero(hash, sizeof(hash));
    initialized = true;
    return err == ESP_OK ? WALLET_OK : WALLET_ERROR_STORAGE_FAILED;
}

bool wallet_verify_password(const char *password, size_t length)
{
    uint8_t salt[VAULT_SALT_SIZE];
    uint8_t want[VAULT_HASH_SIZE];
    uint8_t got[VAULT_HASH_SIZE];

    if (!password || !stored_verifier(want) || !load_salt(salt, false)) {
        return false;
    }

    vault_derive_verifier(VAULT_KDF_V2, password, length, salt, got);
    bool ok = vault_hash_equals(want, got);

    memzero(salt, sizeof(salt));
    memzero(want, sizeof(want));
    memzero(got, sizeof(got));
    return ok;
}

WalletError wallet_change_password(const char *old_password, size_t old_length,
                                   const char *new_password, size_t new_length,
                                   WalletProgressFn progress)
{
    if (!wallet_verify_password(old_password, old_length)) {
        return WALLET_ERROR_WRONG_PASSWORD;
    }
    if (progress) {
        progress(1, 1);
    }
    /* No mnemonics here, so there is nothing to re-encrypt - just move the
     * verifier. The real one moves the ciphertext with it. */
    return wallet_set_password(new_password, new_length);
}
