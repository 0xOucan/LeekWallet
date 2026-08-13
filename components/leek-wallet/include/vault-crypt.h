/**
 * Authenticated storage encryption for the vault.
 *
 * Replaces AES-256-CBC with AES-256-GCM. The CBC scheme had two problems and
 * only one of them was theoretical:
 *
 *   - **No authentication.** A modified ciphertext decrypted to garbage, and
 *     nothing detected it. Recovery relied on the plaintext happening to be a
 *     NUL-terminated string, so a flipped bit somewhere harmless produced a
 *     different, valid-looking mnemonic rather than an error.
 *   - **Zero padding**, which cannot represent a plaintext that legitimately
 *     ends in a zero byte. Mnemonics never do, so it worked by luck.
 *
 * GCM gives a tag that fails loudly on any change to the ciphertext, the nonce,
 * or the key. Stored layout is `nonce(12) || ciphertext || tag(16)`.
 *
 * No ESP-IDF dependency, so the host suite verifies it. Uses the AES-GCM
 * already vendored in trezor-crypto rather than mbedtls, for exactly that
 * reason: crypto that only runs on the target is crypto that only gets tested
 * on the target.
 */

#ifndef VAULT_CRYPT_H
#define VAULT_CRYPT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VAULT_NONCE_SIZE 12
#define VAULT_TAG_SIZE   16
#define VAULT_CRYPT_OVERHEAD (VAULT_NONCE_SIZE + VAULT_TAG_SIZE)

/**
 * Encrypt `plaintext` into `out`.
 *
 * `out` needs `length + VAULT_CRYPT_OVERHEAD` bytes. The nonce is generated
 * internally from the entropy gate: a caller-supplied nonce is one API away
 * from a reused one, and a repeated nonce under the same key breaks GCM
 * completely rather than gracefully.
 *
 * Returns the total written, or 0 on failure.
 */
size_t vault_encrypt(const uint8_t *plaintext, size_t length,
                     const uint8_t key[32],
                     uint8_t *out, size_t out_capacity);

/**
 * Decrypt and verify.
 *
 * Returns the plaintext length, or 0 if the tag does not match — which means
 * the wrong key, a corrupted blob, or tampering. The caller cannot tell which,
 * and should not try to.
 */
size_t vault_decrypt(const uint8_t *stored, size_t stored_length,
                     const uint8_t key[32],
                     uint8_t *out, size_t out_capacity);

#endif /* VAULT_CRYPT_H */
