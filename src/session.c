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
 * would make them derivable from each other.
 *
 * Bumped to v2 with the commitment handshake. The labels are part of what the
 * two ends agree on, so an old host and new firmware could not accidentally
 * derive a working channel out of half a protocol even if the version check in
 * protocol.c were somehow bypassed — they would simply fail to decrypt. */
static const char LABEL_H2D[]        = "leek-session-h2d-v2";
static const char LABEL_D2H[]        = "leek-session-d2h-v2";
static const char LABEL_PASSKEY[]    = "leek-session-passkey-v2";
static const char LABEL_COMMIT[]     = "leek-session-commit-v2";
static const char LABEL_TRANSCRIPT[] = "leek-session-transcript-v2";

/* ---------------------------------------------------- commitment, transcript */

void session_commitment(const uint8_t device_public[SESSION_PUBKEY_SIZE],
                        const uint8_t host_public[SESSION_PUBKEY_SIZE],
                        const uint8_t device_nonce[SESSION_NONCE_SIZE],
                        uint8_t out[SESSION_COMMIT_SIZE])
{
    /* Plain SHA-256 rather than an HMAC: this is a commitment, not a MAC, and
     * there is no key here for a MAC to take. Binding hygiene comes from the
     * label and from the fixed-width fields, which cannot be re-parsed into a
     * different (key, key, nonce) triple the way a delimiter-free variable
     * layout could. */
    SHA256_CTX ctx;
    sha256_Init(&ctx);
    sha256_Update(&ctx, (const uint8_t *)LABEL_COMMIT, sizeof(LABEL_COMMIT) - 1);
    sha256_Update(&ctx, device_public, SESSION_PUBKEY_SIZE);
    sha256_Update(&ctx, host_public, SESSION_PUBKEY_SIZE);
    sha256_Update(&ctx, device_nonce, SESSION_NONCE_SIZE);
    sha256_Final(&ctx, out);
}

/* The whole handshake, hashed in a fixed order.
 *
 * This is what the keys and the passkey are salted with, and it is why a relay
 * cannot substitute a public key or a nonce on one leg and keep the digits
 * from the other: every one of the four fields is inside the hash, so changing
 * any of them changes what both screens show. Ordered by ROLE — host first,
 * then device — not by who is computing it, or the two ends would hash
 * different bytes and never agree. */
static void session_transcript_hash(const SessionTranscript *t, uint8_t out[32])
{
    SHA256_CTX ctx;
    sha256_Init(&ctx);
    sha256_Update(&ctx, (const uint8_t *)LABEL_TRANSCRIPT, sizeof(LABEL_TRANSCRIPT) - 1);
    sha256_Update(&ctx, t->host_public, SESSION_PUBKEY_SIZE);
    sha256_Update(&ctx, t->device_public, SESSION_PUBKEY_SIZE);
    sha256_Update(&ctx, t->host_nonce, SESSION_NONCE_SIZE);
    sha256_Update(&ctx, t->device_nonce, SESSION_NONCE_SIZE);
    sha256_Final(&ctx, out);
}

/* ------------------------------------------------------------------ HKDF */

/* HKDF-SHA256 (RFC 5869). The salt is the transcript hash rather than a
 * constant: HKDF-Extract's salt is exactly the place for public context that
 * must not be substitutable, and using it means transcript binding costs one
 * SHA-256 rather than a second construction bolted on beside the KDF. */
static void hkdf_sha256(const uint8_t *ikm, size_t ikm_len,
                        const uint8_t salt[32],
                        const char *info, uint8_t out[32])
{
    uint8_t prk[32];
    HMAC_SHA256_CTX ctx;

    /* Extract: PRK = HMAC(salt, IKM) */
    hmac_sha256_Init(&ctx, salt, 32);
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

bool session_derive(const uint8_t local_private[SESSION_KEY_SIZE],
                    const uint8_t peer_public[SESSION_PUBKEY_SIZE],
                    const SessionTranscript *transcript,
                    uint8_t k_h2d_out[SESSION_KEY_SIZE],
                    uint8_t k_d2h_out[SESSION_KEY_SIZE],
                    char    passkey_out[SESSION_PASSKEY_LEN + 1])
{
    uint8_t shared[32];
    x25519(shared, local_private, peer_public);

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

    uint8_t salt[32];
    session_transcript_hash(transcript, salt);

    hkdf_sha256(shared, sizeof(shared), salt, LABEL_H2D, k_h2d_out);
    hkdf_sha256(shared, sizeof(shared), salt, LABEL_D2H, k_d2h_out);

    /* Six digits over the shared secret AND the whole transcript.
     *
     * The v1 comment here used to end "a relay in the middle cannot make them
     * agree", and it was wrong: the value was a pure function of the shared
     * secret, so a relay could pick its own key and search offline for one
     * that reproduced the digits already on the device's screen. That search
     * is dead twice over now. The transcript salt means the relay would have
     * to hit a value depending on nonces it does not yet have, and the
     * commitment in session_begin()/session_reveal() means the inputs it does
     * control are fixed before those nonces arrive. What is left is one online
     * guess at 1 in 10^6, in front of a user reading the screen — which is the
     * property BLE LESC's numeric comparison and ZRTP's SAS actually have.
     * See session.h for the citations, and sim/passkey_grind.c for the attack
     * re-run against this construction. */
    uint8_t pk[32];
    hkdf_sha256(shared, sizeof(shared), salt, LABEL_PASSKEY, pk);

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
    /* Live only between session_begin() and session_reveal(). The private key
     * has to survive the round trip because the shared secret is not computed
     * until the transcript is complete, which is the one cost of the extra
     * leg: a handshake abandoned half-way leaves a private key in RAM until
     * the next session_reset(). Every path that ends a session calls that, and
     * a new hello calls it first thing. */
    SessionTranscript pending_transcript;
    uint8_t      device_private[SESSION_KEY_SIZE];
} sess;

bool session_begin(const uint8_t host_public[SESSION_PUBKEY_SIZE],
                   uint8_t device_public_out[SESSION_PUBKEY_SIZE],
                   uint8_t device_commit_out[SESSION_COMMIT_SIZE])
{
    session_reset();

    /* Ephemeral per connection: a leaked long-term key would otherwise expose
     * every past session. */
    random_buffer(sess.device_private, sizeof(sess.device_private));
    x25519(device_public_out, sess.device_private, X25519_BASEPOINT);

    /* The nonce is generated HERE, before the host's is known, and only its
     * hash goes out. That ordering is the defence: whatever the peer sends
     * next, the device's contribution to the six digits is already fixed and
     * it cannot be revised to land on a chosen value. */
    memcpy(sess.pending_transcript.host_public, host_public, SESSION_PUBKEY_SIZE);
    memcpy(sess.pending_transcript.device_public, device_public_out, SESSION_PUBKEY_SIZE);
    random_buffer(sess.pending_transcript.device_nonce, SESSION_NONCE_SIZE);

    session_commitment(device_public_out, host_public,
                       sess.pending_transcript.device_nonce, device_commit_out);

    /* A small-order host key is still refused, but it can only be caught once
     * the shared secret is computed, and that does not happen until the
     * transcript is complete. So the refusal moved to session_reveal(); the
     * device has revealed nothing but a public key and a hash by then. */
    sess.state = SESSION_AWAITING_REVEAL;
    return true;
}

bool session_reveal(const uint8_t host_nonce[SESSION_NONCE_SIZE],
                    uint8_t device_nonce_out[SESSION_NONCE_SIZE])
{
    /* One reveal per commitment. Answering a second one would hand the peer a
     * fresh derivation against a nonce it had already seen, which is the
     * search this whole round trip exists to prevent. */
    if (sess.state != SESSION_AWAITING_REVEAL) {
        return false;
    }

    memcpy(sess.pending_transcript.host_nonce, host_nonce, SESSION_NONCE_SIZE);

    bool ok = session_derive(sess.device_private,
                             sess.pending_transcript.host_public,
                             &sess.pending_transcript,
                             sess.k_h2d, sess.k_d2h, sess.passkey);
    /* The private key has done its only job. Nothing after this point needs
     * it, so it does not get to sit in RAM for the length of the session. */
    memzero(sess.device_private, sizeof(sess.device_private));

    if (!ok) {
        session_reset();
        return false;
    }

    memcpy(device_nonce_out, sess.pending_transcript.device_nonce, SESSION_NONCE_SIZE);
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
