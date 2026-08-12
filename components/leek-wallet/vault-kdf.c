/**
 * LeekWallet Vault Key Derivation - see vault-kdf.h
 */

#include "vault-kdf.h"

#include <string.h>

#include "sha2.h"
#include "pbkdf2.h"
#include "memzero.h"

/*
 * Domain separators. These are what make the encryption key and the verifier
 * independent: same PIN, same salt, two unrelated outputs. Without them an
 * attacker who cracks the stored verifier has also cracked the storage key.
 *
 * Never reuse or reorder these strings - doing so silently changes every
 * derived key and orphans existing vaults.
 */
static const char DOMAIN_ENC[] = "leek-enc-v2";
static const char DOMAIN_VER[] = "leek-ver-v2";

/* Largest domain string build_salt() may be handed. Enforced at compile time so
 * adding a longer separator is a build error rather than a stack overflow in
 * the middle of key derivation. */
#define MAX_DOMAIN_LEN 16
_Static_assert(sizeof(DOMAIN_ENC) - 1 <= MAX_DOMAIN_LEN, "DOMAIN_ENC too long");
_Static_assert(sizeof(DOMAIN_VER) - 1 <= MAX_DOMAIN_LEN, "DOMAIN_VER too long");

/* PBKDF2 salt = device salt || domain separator. */
static void build_salt(const uint8_t salt[VAULT_SALT_SIZE], const char *domain,
                       uint8_t *out, size_t out_size, size_t *out_len)
{
    size_t dlen = strlen(domain);

    /* Belt and braces alongside the static asserts: a truncated salt would
     * silently change every derived key, so clamp rather than overflow. */
    if (dlen > MAX_DOMAIN_LEN) {
        dlen = MAX_DOMAIN_LEN;
    }
    if (VAULT_SALT_SIZE + dlen > out_size) {
        dlen = out_size - VAULT_SALT_SIZE;
    }

    memcpy(out, salt, VAULT_SALT_SIZE);
    memcpy(out + VAULT_SALT_SIZE, domain, dlen);
    *out_len = VAULT_SALT_SIZE + dlen;
}

/* PBKDF2-HMAC-SHA512 truncated to 32 bytes. */
static void derive_v2(const char *pin, size_t pin_len,
                      const uint8_t salt[VAULT_SALT_SIZE],
                      const char *domain,
                      uint8_t out32[32])
{
    uint8_t full_salt[VAULT_SALT_SIZE + MAX_DOMAIN_LEN];
    size_t  full_salt_len = 0;
    build_salt(salt, domain, full_salt, sizeof(full_salt), &full_salt_len);

    uint8_t out64[64];
    pbkdf2_hmac_sha512((const uint8_t *)pin, (int)pin_len,
                       full_salt, (int)full_salt_len,
                       VAULT_KDF_V2_ITERATIONS, out64, 64);

    memcpy(out32, out64, 32);

    memzero(out64, sizeof(out64));
    memzero(full_salt, sizeof(full_salt));
}

void vault_derive_key(VaultKdfVersion version,
                      const char *pin, size_t pin_len,
                      const uint8_t salt[VAULT_SALT_SIZE],
                      uint8_t key_out[VAULT_KEY_SIZE])
{
    if (version == VAULT_KDF_V1_LEGACY) {
        /* Legacy: double SHA256, unsalted. Reproduced bit-for-bit so existing
         * vaults can be opened once and migrated - never for new data. */
        uint8_t temp[32];
        sha256_Raw((const uint8_t *)pin, pin_len, temp);
        sha256_Raw(temp, 32, key_out);
        memzero(temp, sizeof(temp));
        return;
    }

    derive_v2(pin, pin_len, salt, DOMAIN_ENC, key_out);
}

void vault_derive_verifier(VaultKdfVersion version,
                           const char *pin, size_t pin_len,
                           const uint8_t salt[VAULT_SALT_SIZE],
                           uint8_t hash_out[VAULT_HASH_SIZE])
{
    if (version == VAULT_KDF_V1_LEGACY) {
        /* Legacy: triple SHA256, unsalted. */
        uint8_t temp[32];
        sha256_Raw((const uint8_t *)pin, pin_len, temp);
        sha256_Raw(temp, 32, temp);
        sha256_Raw(temp, 32, hash_out);
        memzero(temp, sizeof(temp));
        return;
    }

    derive_v2(pin, pin_len, salt, DOMAIN_VER, hash_out);
}

bool vault_hash_equals(const uint8_t a[VAULT_HASH_SIZE],
                       const uint8_t b[VAULT_HASH_SIZE])
{
    uint8_t diff = 0;
    for (size_t i = 0; i < VAULT_HASH_SIZE; i++) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0;
}

#ifndef LEEK_HOST_TEST
#include "esp_timer.h"
#include "esp_log.h"

uint32_t vault_kdf_benchmark_ms(void)
{
    static const uint8_t probe_salt[VAULT_SALT_SIZE] = {0};
    uint8_t key[VAULT_KEY_SIZE];

    int64_t start = esp_timer_get_time();
    vault_derive_key(VAULT_KDF_V2, "000000", 6, probe_salt, key);
    int64_t elapsed_us = esp_timer_get_time() - start;

    memzero(key, sizeof(key));

    uint32_t ms = (uint32_t)(elapsed_us / 1000);
    ESP_LOGW("vault-kdf", "KDF benchmark: %u iterations in %u ms (target ~500)",
             (unsigned)VAULT_KDF_V2_ITERATIONS, (unsigned)ms);
    return ms;
}
#endif
