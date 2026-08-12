/**
 * LeekWallet session layer — see docs/PROTOCOL.md section 3.
 *
 * Establishes an encrypted channel between the host and the device, and gives
 * the user a way to detect a machine-in-the-middle.
 *
 *   host                                        device
 *    ── hello { hostPubkey } ──────────────────▶
 *    ◀─ helloAck { devicePubkey }
 *       both: X25519 → HKDF-SHA256 → k_h2d, k_d2h, passkey
 *    ◀─ device shows a 6-digit passkey on its OLED
 *    ── user compares it with the app and confirms on the device
 *    ── encrypted traffic ─────────────────────▶
 *
 * The passkey is *derived from the shared secret*, not random. That is the
 * whole mechanism: an attacker relaying between two sessions holds two
 * different shared secrets, so the code it can show cannot match the one the
 * device displays. The user comparing two screens is what detects the attack —
 * encryption alone would happily protect a conversation with an impostor.
 *
 * What this does NOT defend against is a compromised host, which sees
 * everything before encryption. See PROTOCOL.md section 1: the channel protects
 * the wire, and on-device confirmation protects the user.
 */

#ifndef LEEK_SESSION_H
#define LEEK_SESSION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SESSION_KEY_SIZE    32
#define SESSION_PUBKEY_SIZE 32
#define SESSION_TAG_SIZE    16
#define SESSION_PASSKEY_LEN 6

typedef enum {
    SESSION_IDLE,        /* nothing negotiated */
    SESSION_PENDING,     /* keys derived, waiting for the user to confirm */
    SESSION_ACTIVE,      /* confirmed; encrypted traffic permitted */
} SessionState;

/**
 * Derive session keys and the comparison passkey from an X25519 exchange.
 *
 * Pure function over the inputs, so the host suite can verify it against known
 * answers without an ESP32. Returns false if the peer key is degenerate.
 */
bool session_derive(const uint8_t device_private[SESSION_KEY_SIZE],
                    const uint8_t host_public[SESSION_PUBKEY_SIZE],
                    uint8_t k_h2d_out[SESSION_KEY_SIZE],
                    uint8_t k_d2h_out[SESSION_KEY_SIZE],
                    char    passkey_out[SESSION_PASSKEY_LEN + 1]);

/* ------------------------------------------------------- session instance */

/** Begin a handshake. Generates an ephemeral key pair and derives the session. */
bool session_begin(const uint8_t host_public[SESSION_PUBKEY_SIZE],
                   uint8_t device_public_out[SESSION_PUBKEY_SIZE]);

/** The passkey the user must compare, valid while SESSION_PENDING. */
const char *session_passkey(void);

/** Called when the user confirms on the device. */
void session_confirm(void);

/** Tear down and wipe all session material. */
void session_reset(void);

SessionState session_state(void);

/**
 * Decrypt a host→device payload in place.
 *
 * `input` is nonce-counter-implicit: the counter is maintained here and a
 * replayed or reordered frame fails authentication rather than being accepted.
 * Returns the plaintext length, or -1 on any failure.
 */
int session_decrypt(uint8_t *data, size_t len);

/**
 * Encrypt a device→host payload in place, appending the tag.
 * `capacity` must leave room for SESSION_TAG_SIZE. Returns total length or -1.
 */
int session_encrypt(uint8_t *data, size_t len, size_t capacity);

#endif /* LEEK_SESSION_H */
