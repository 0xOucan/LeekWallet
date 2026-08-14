/**
 * LeekWallet session layer - see session.h
 */

#include "session.h"

#include <string.h>

#include "chacha20poly1305/rfc7539.h"
#include "hmac.h"
#include "sha2.h"
#include "memzero.h"
#include "rand.h"

/* X25519 via the Montgomery ladder directly, rather than
 * curve25519_scalarmult_basepoint(). The "fast basepoint" variant routes
 * through the ed25519 group and its precomputed tables, which is a large
 * dependency for one multiplication and drags Edwards code into a file that
 * only needs Diffie-Hellman. Clamping is done here, as RFC 7748 specifies. */


void curve25519_scalarmult_donna(uint8_t *mypublic, const uint8_t *n,
                                 const uint8_t *basepoint);

static const uint8_t X25519_BASEPOINT[32] = { 9 };

static void x25519_clamp(uint8_t k[32])
{
    k[0]  &= 248;
    k[31] &= 127;
    k[31] |= 64;
}

static void x25519(uint8_t out[32], const uint8_t scalar[32], const uint8_t point[32])
{
    uint8_t clamped[32];
    memcpy(clamped, scalar, 32);
    x25519_clamp(clamped);
    curve25519_scalarmult_donna(out, clamped, point);
    memzero(clamped, sizeof(clamped));
}

/* Domain separators. Distinct labels mean the two directional keys and the
 * passkey are independent outputs of the same shared secret; reusing one label
 * would make them derivable from each other. */
static const char LABEL_H2D[]     = "leek-session-h2d-v1";
static const char LABEL_D2H[]     = "leek-session-d2h-v1";
static const char LABEL_PASSKEY[] = "leek-session-passkey-v1";

/* ------------------------------------------------------------------ HKDF */

/* HKDF-SHA256 (RFC 5869) with an empty salt. The shared secret is already
 * uniform-ish, but extract-then-expand is the construction with the proof, and
 * the cost is two HMACs. */
static void hkdf_sha256(const uint8_t *ikm, size_t ikm_len,
                        const char *info, uint8_t out[32])
{
    uint8_t prk[32];
    const uint8_t zero_salt[32] = {0};
    HMAC_SHA256_CTX ctx;

    /* Extract: PRK = HMAC(salt, IKM) */
    hmac_sha256_Init(&ctx, zero_salt, sizeof(zero_salt));
    hmac_sha256_Update(&ctx, ikm, (uint32_t)ikm_len);
    hmac_sha256_Final(&ctx, prk);

    /* Expand: one 32-byte block, so T(1) = HMAC(PRK, info || 0x01) */
    size_t info_len = strlen(info);
    const uint8_t counter = 0x01;

    hmac_sha256_Init(&ctx, prk, sizeof(prk));
    hmac_sha256_Update(&ctx, (const uint8_t *)info, (uint32_t)info_len);
    hmac_sha256_Update(&ctx, &counter, 1);
    hmac_sha256_Final(&ctx, out);

    memzero(prk, sizeof(prk));
    memzero(&ctx, sizeof(ctx));
}

/* --------------------------------------------------------------- derivation */

bool session_derive(const uint8_t device_private[SESSION_KEY_SIZE],
                    const uint8_t host_public[SESSION_PUBKEY_SIZE],
                    uint8_t k_h2d_out[SESSION_KEY_SIZE],
                    uint8_t k_d2h_out[SESSION_KEY_SIZE],
                    char    passkey_out[SESSION_PASSKEY_LEN + 1])
{
    uint8_t shared[32];
    x25519(shared, device_private, host_public);

    /* An all-zero shared secret means a small-order peer key: the "agreement"
     * would be a value the attacker chose. Refuse rather than proceed. */
    uint8_t acc = 0;
    for (size_t i = 0; i < sizeof(shared); i++) {
        acc |= shared[i];
    }
    if (acc == 0) {
        memzero(shared, sizeof(shared));
        return false;
    }

    hkdf_sha256(shared, sizeof(shared), LABEL_H2D, k_h2d_out);
    hkdf_sha256(shared, sizeof(shared), LABEL_D2H, k_d2h_out);

    /* Six digits from an independent derivation of the same secret. Both sides
     * compute it; a relay in the middle cannot make them agree. */
    uint8_t pk[32];
    hkdf_sha256(shared, sizeof(shared), LABEL_PASSKEY, pk);

    uint32_t n = ((uint32_t)pk[0] << 24) | ((uint32_t)pk[1] << 16) |
                 ((uint32_t)pk[2] << 8) | pk[3];
    n %= 1000000u;
    for (int i = SESSION_PASSKEY_LEN - 1; i >= 0; i--) {
        passkey_out[i] = (char)('0' + (n % 10));
        n /= 10;
    }
    passkey_out[SESSION_PASSKEY_LEN] = '\0';

    memzero(pk, sizeof(pk));
    memzero(shared, sizeof(shared));
    return true;
}

/* ---------------------------------------------------------------- instance */

static struct {
    SessionState state;
    uint8_t      k_h2d[SESSION_KEY_SIZE];
    uint8_t      k_d2h[SESSION_KEY_SIZE];
    char         passkey[SESSION_PASSKEY_LEN + 1];
    uint32_t     rx_counter;
    uint32_t     tx_counter;
} sess;

bool session_begin(const uint8_t host_public[SESSION_PUBKEY_SIZE],
                   uint8_t device_public_out[SESSION_PUBKEY_SIZE])
{
    session_reset();

    /* Ephemeral per connection: a leaked long-term key would otherwise expose
     * every past session. */
    uint8_t device_private[SESSION_KEY_SIZE];
    random_buffer(device_private, sizeof(device_private));

    x25519(device_public_out, device_private, X25519_BASEPOINT);

    bool ok = session_derive(device_private, host_public,
                             sess.k_h2d, sess.k_d2h, sess.passkey);
    memzero(device_private, sizeof(device_private));

    if (!ok) {
        session_reset();
        return false;
    }

    sess.state = SESSION_PENDING;
    return true;
}

const char *session_passkey(void)
{
    return sess.passkey;
}

void session_confirm(void)
{
    if (sess.state == SESSION_PENDING) {
        sess.state = SESSION_ACTIVE;
    }
}

/* Whoever cares that the channel died. See session_set_on_reset(). */
static void (*on_reset)(void) = NULL;

void session_set_on_reset(void (*callback)(void))
{
    on_reset = callback;
}

void session_reset(void)
{
    memzero(&sess, sizeof(sess));
    sess.state = SESSION_IDLE;

    /* After the wipe, never before: the callback may look at the session, and
     * it must see one that is already gone. A callback that resets the session
     * itself would recurse, which is why nothing here re-enters. */
    if (on_reset) {
        on_reset();
    }
}

SessionState session_state(void)
{
    return sess.state;
}

/* --------------------------------------------------------------- transport */

/* Nonce = 4 zero bytes || 8-byte big-endian counter. Counters never repeat
 * within a session, and never reset, because a reused nonce with ChaCha20
 * leaks the keystream. */
static void make_nonce(uint32_t counter, uint8_t nonce[12])
{
    memset(nonce, 0, 12);
    nonce[8]  = (uint8_t)(counter >> 24);
    nonce[9]  = (uint8_t)(counter >> 16);
    nonce[10] = (uint8_t)(counter >> 8);
    nonce[11] = (uint8_t)counter;
}

int session_decrypt(uint8_t *data, size_t len)
{
    if (sess.state != SESSION_ACTIVE || len < SESSION_TAG_SIZE) {
        return -1;
    }

    size_t body = len - SESSION_TAG_SIZE;
    uint8_t nonce[12];
    make_nonce(sess.rx_counter, nonce);

    chacha20poly1305_ctx ctx;
    rfc7539_init(&ctx, sess.k_h2d, nonce);
    chacha20poly1305_decrypt(&ctx, data, data, body);

    uint8_t tag[SESSION_TAG_SIZE];
    rfc7539_finish(&ctx, 0, body, tag);
    memzero(&ctx, sizeof(ctx));

    /* Constant-time tag comparison: a byte-at-a-time memcmp would leak how much
     * of a forged tag was correct. */
    uint8_t diff = 0;
    for (size_t i = 0; i < SESSION_TAG_SIZE; i++) {
        diff |= (uint8_t)(tag[i] ^ data[body + i]);
    }
    memzero(tag, sizeof(tag));

    if (diff != 0) {
        /* A failed tag is either corruption or an attack. Either way the
         * session is no longer trustworthy - do not simply skip the frame. */
        session_reset();
        return -1;
    }

    sess.rx_counter++;
    return (int)body;
}

int session_encrypt(uint8_t *data, size_t len, size_t capacity)
{
    if (sess.state != SESSION_ACTIVE || len + SESSION_TAG_SIZE > capacity) {
        return -1;
    }

    uint8_t nonce[12];
    make_nonce(sess.tx_counter, nonce);

    chacha20poly1305_ctx ctx;
    rfc7539_init(&ctx, sess.k_d2h, nonce);
    chacha20poly1305_encrypt(&ctx, data, data, len);
    rfc7539_finish(&ctx, 0, len, data + len);
    memzero(&ctx, sizeof(ctx));

    sess.tx_counter++;
    return (int)(len + SESSION_TAG_SIZE);
}
