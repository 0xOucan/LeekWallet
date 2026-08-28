/**
 * LeekWallet Vault Key Derivation
 *
 * Turns a PIN into the keys that protect stored mnemonics. Pure logic with no
 * ESP-IDF dependency, so the host suite can verify it — see sim/test_vault_kdf.c
 * and docs/VAULT.md.
 *
 * What this replaces: the original scheme derived the AES-256 key as
 * SHA256(SHA256(pin)) with no salt, and the stored verification hash as
 * SHA256 three times over the same input. Two consequences, both fatal:
 *
 *   1. A 6-digit PIN is 10^6 candidates at a few nanoseconds each. Anyone able
 *      to read the flash recovers the seed essentially instantly.
 *   2. Both values derive from the same unsalted input, so the verification
 *      hash stored next to the ciphertext is a free oracle — an attacker
 *      confirms a PIN guess without touching AES at all.
 *
 * v2 fixes both: PBKDF2-HMAC-SHA512 over a per-device random salt, with
 * distinct domain separators so the encryption key and the verifier are
 * independent. Cracking the verifier no longer yields the encryption key.
 *
 * Do not over-read that last sentence. It removes a shortcut between the two
 * outputs; it does not deny the attacker a way to test a PIN. The stored
 * mnemonic is AES-GCM, and its tag verifies the encryption key at exactly the
 * cost of deriving it - so an attacker with a flash dump ignores the verifier
 * and attacks the ciphertext, at one PBKDF2 per candidate either way. The
 * separation buys the honest case (a leaked verifier is not a key), not the
 * dump case. Only the iteration count and the PIN's own entropy price that one.
 */

#ifndef VAULT_KDF_H
#define VAULT_KDF_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VAULT_SALT_SIZE  16
#define VAULT_KEY_SIZE   32
#define VAULT_HASH_SIZE  32

/** Storage format version, persisted so old vaults can be migrated. */
/**
 * Vault format version.
 *
 * Covers both key derivation and storage encryption, because a stored blob is
 * only interpretable if you know both. v2 and v3 share the same derivation and
 * differ only in how the mnemonic is encrypted, so migrating between them
 * re-encrypts without re-keying.
 */
typedef enum {
    VAULT_KDF_V1_LEGACY = 1,   /* SHA256^2 / SHA256^3 unsalted, AES-CBC        */
    VAULT_KDF_V2        = 2,   /* PBKDF2-HMAC-SHA512 salted, AES-CBC           */
    VAULT_KDF_V3        = 3,   /* PBKDF2-HMAC-SHA512 salted, AES-GCM           */
} VaultKdfVersion;

/** The version new vaults are created at. */
#define VAULT_KDF_CURRENT VAULT_KDF_V3

/** True if `v` stores mnemonics with authenticated encryption. */
#define VAULT_USES_GCM(v) ((v) >= VAULT_KDF_V3)

/**
 * Iteration count for v2.
 *
 * Measured on hardware, not guessed. On an ESP32-S3 at 160 MHz this
 * implementation costs 0.226 ms per iteration: vault_kdf_benchmark_ms() reports
 * 508 ms for the 2250 below, on a board running this code. A desktop core runs
 * the same work ~310x faster (1.63 ms/derivation, gcc -O2), which is exactly why
 * this number could not be chosen from the host suite.
 *
 * One derivation is 508 ms, but an unlock pays for more than one - see
 * docs/AUDIT-SECRETS-2.md, N1. Raising this number costs the user in multiples
 * of that, and collapsing the count is the cheaper half of the same trade.
 *
 * This is still a modest work factor in absolute terms. PBKDF2-HMAC-SHA512 is
 * slow here because SHA-512's 64-bit operations are expensive on a 32-bit core
 * and this is a pure software implementation. Routing it through the S3's SHA
 * accelerator, or moving to PBKDF2-HMAC-SHA256, would buy several times the
 * iterations at the same latency - tracked as T9e. Note the KDF is defence in
 * depth: with flash encryption enabled (T11) an attacker cannot obtain the
 * ciphertext to attack in the first place.
 */
#define VAULT_KDF_V2_ITERATIONS 2250

/**
 * Derive the storage encryption key.
 * v1 ignores `salt` and reproduces the legacy scheme exactly, so existing
 * vaults stay readable during migration.
 */
void vault_derive_key(VaultKdfVersion version,
                      const char *pin, size_t pin_len,
                      const uint8_t salt[VAULT_SALT_SIZE],
                      uint8_t key_out[VAULT_KEY_SIZE]);

/**
 * Derive the PIN verification hash.
 *
 * Independent of the encryption key under v2. Compare it with
 * vault_hash_equals(), never with memcmp().
 */
void vault_derive_verifier(VaultKdfVersion version,
                           const char *pin, size_t pin_len,
                           const uint8_t salt[VAULT_SALT_SIZE],
                           uint8_t hash_out[VAULT_HASH_SIZE]);

/** Constant-time comparison of two verification hashes. */
bool vault_hash_equals(const uint8_t a[VAULT_HASH_SIZE],
                       const uint8_t b[VAULT_HASH_SIZE]);

/**
 * Time one key derivation and return the cost in milliseconds.
 *
 * The iteration count has to be tuned on real silicon: a desktop is two orders
 * of magnitude faster, and QEMU's timing is not faithful. Called once at boot
 * so the number is in the log without needing a user to sit through an unlock.
 */
uint32_t vault_kdf_benchmark_ms(void);

#endif /* VAULT_KDF_H */
