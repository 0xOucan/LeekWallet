/**
 * Host stand-in for mbedtls/aes.h, over trezor-crypto's AES.
 *
 * Only the CBC entry points leek-wallet.c uses are provided, and only because
 * the legacy (pre-GCM) vault format needs them: a legacy vault must still open
 * after a PIN change, which is precisely what the host tests check.
 */

#ifndef SHIM_MBEDTLS_AES_H
#define SHIM_MBEDTLS_AES_H

#include <stddef.h>
#include <stdint.h>

#include "aes/aes.h"

#define MBEDTLS_AES_ENCRYPT 1
#define MBEDTLS_AES_DECRYPT 0

typedef struct {
    aes_encrypt_ctx enc;
    aes_decrypt_ctx dec;
    int mode;
} mbedtls_aes_context;

static inline void mbedtls_aes_init(mbedtls_aes_context *ctx) { ctx->mode = -1; }
static inline void mbedtls_aes_free(mbedtls_aes_context *ctx) { ctx->mode = -1; }

static inline int mbedtls_aes_setkey_enc(mbedtls_aes_context *ctx,
                                         const unsigned char *key, unsigned bits)
{
    ctx->mode = MBEDTLS_AES_ENCRYPT;
    return aes_encrypt_key(key, bits / 8, &ctx->enc) == EXIT_SUCCESS ? 0 : -1;
}

static inline int mbedtls_aes_setkey_dec(mbedtls_aes_context *ctx,
                                         const unsigned char *key, unsigned bits)
{
    ctx->mode = MBEDTLS_AES_DECRYPT;
    return aes_decrypt_key(key, bits / 8, &ctx->dec) == EXIT_SUCCESS ? 0 : -1;
}

static inline int mbedtls_aes_crypt_cbc(mbedtls_aes_context *ctx, int mode,
                                        size_t length, unsigned char iv[16],
                                        const unsigned char *input,
                                        unsigned char *output)
{
    if (mode == MBEDTLS_AES_ENCRYPT) {
        return aes_cbc_encrypt_T(input, output, (int)length, iv, &ctx->enc) == EXIT_SUCCESS ? 0 : -1;
    }
    return aes_cbc_decrypt_T(input, output, (int)length, iv, &ctx->dec) == EXIT_SUCCESS ? 0 : -1;
}

#endif /* SHIM_MBEDTLS_AES_H */
