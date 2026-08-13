/**
 * Authenticated storage encryption - see vault-crypt.h
 */

#include "vault-crypt.h"

#include <string.h>

#include "aes/aesgcm.h"
#include "memzero.h"
#include "rand.h"

size_t vault_encrypt(const uint8_t *plaintext, size_t length,
                     const uint8_t key[32],
                     uint8_t *out, size_t out_capacity)
{
    if (!plaintext || !key || !out) {
        return 0;
    }
    if (out_capacity < length + VAULT_CRYPT_OVERHEAD) {
        return 0;
    }

    uint8_t *nonce = out;
    uint8_t *body  = out + VAULT_NONCE_SIZE;
    uint8_t *tag   = body + length;

    /* Generated here rather than accepted from a caller. GCM does not degrade
     * on nonce reuse, it fails outright: two messages under one key and nonce
     * leak the keystream and the authentication key. */
    random_buffer(nonce, VAULT_NONCE_SIZE);

    memcpy(body, plaintext, length);

    gcm_ctx ctx[1];
    if (gcm_init_and_key(key, 32, ctx) != RETURN_GOOD) {
        memzero(out, out_capacity);
        return 0;
    }

    ret_type r = gcm_encrypt_message(nonce, VAULT_NONCE_SIZE,
                                     NULL, 0,
                                     body, (unsigned long)length,
                                     tag, VAULT_TAG_SIZE,
                                     ctx);
    gcm_end(ctx);
    memzero(ctx, sizeof(ctx));

    if (r != RETURN_GOOD) {
        memzero(out, out_capacity);
        return 0;
    }

    return length + VAULT_CRYPT_OVERHEAD;
}

size_t vault_decrypt(const uint8_t *stored, size_t stored_length,
                     const uint8_t key[32],
                     uint8_t *out, size_t out_capacity)
{
    if (!stored || !key || !out) {
        return 0;
    }
    if (stored_length < VAULT_CRYPT_OVERHEAD) {
        return 0;
    }

    size_t body_len = stored_length - VAULT_CRYPT_OVERHEAD;
    if (out_capacity < body_len) {
        return 0;
    }

    const uint8_t *nonce = stored;
    const uint8_t *body  = stored + VAULT_NONCE_SIZE;
    const uint8_t *tag   = body + body_len;

    memcpy(out, body, body_len);

    gcm_ctx ctx[1];
    if (gcm_init_and_key(key, 32, ctx) != RETURN_GOOD) {
        memzero(out, out_capacity);
        return 0;
    }

    ret_type r = gcm_decrypt_message(nonce, VAULT_NONCE_SIZE,
                                     NULL, 0,
                                     out, (unsigned long)body_len,
                                     tag, VAULT_TAG_SIZE,
                                     ctx);
    gcm_end(ctx);
    memzero(ctx, sizeof(ctx));

    if (r != RETURN_GOOD) {
        /* Wrong key, corruption or tampering - indistinguishable, and the
         * caller must not act on the difference. Wipe rather than hand back a
         * partially decrypted buffer that looks like data. */
        memzero(out, out_capacity);
        return 0;
    }

    return body_len;
}
