/**
 * LeekWallet session layer — see docs/PROTOCOL.md section 3.
 *
 * Establishes an encrypted channel between the host and the device, and gives
 * the user a way to detect a machine-in-the-middle.
 *
 *   host                                              device
 *    ── hello { version, hostPubkey PKa } ─────────────▶
 *                                    device picks Nb, commits to it
 *    ◀─ helloAck { version, devicePubkey PKb, deviceCommit Cb }
 *    ── helloReveal { hostNonce Na } ──────────────────▶
 *    ◀─ helloReveal ack { deviceNonce Nb }
 *       host checks Cb == H(PKb ‖ PKa ‖ Nb); both derive over the transcript
 *    ◀─ device shows a 6-digit passkey on its OLED
 *    ── user compares it with the app and confirms on the device
 *    ── encrypted traffic ─────────────────────────────▶
 *
 * WHY the extra round trip, since v1 had none. In v1 the passkey was
 * HKDF(X25519(a,B), "…passkey…") — a deterministic function of the shared
 * secret with no nonce and no commitment. A relay knows the host's public key,
 * so it could compute what the host *would* display for any private key it
 * picked and search offline until that matched the digits the device was
 * already showing. sim/passkey_grind.c found one in 91 s on a single core
 * against the slowest X25519 in the tree; nothing crossed the wire while it
 * searched, and no attempt failed for anyone to notice.
 *
 * The fix is the mechanism BLE Secure Connections and ZRTP actually use, not
 * an approximation of it. Both parties contribute a fresh nonce, and the party
 * who would otherwise be free to search must commit to its choice before it
 * learns the other's:
 *
 *   - Bluetooth Core Specification v5.4, Vol 3, Part H, §2.3.5.6.4 (Numeric
 *     Comparison): the non-initiator sends Cb = f4(PKbx, PKax, Nb, 0) before
 *     the initiator reveals Na, and the six digits shown on both screens are
 *     g2(PKax, PKbx, Na, Nb) — over BOTH public keys and BOTH nonces.
 *   - RFC 6189 (ZRTP) §4.4.1.1: "A hash commitment precludes this attack by
 *     forcing the MiTM to choose his own two DH public values before learning
 *     the public values of either of the two parties." Its SAS is derived from
 *     the total hash of the transcript (§4.5.2).
 *
 * Here the device is the non-initiator, so the device commits, exactly as in
 * LESC. A relay must send its device-facing nonce choice before it sees the
 * real device's nonce, and must send its host-facing commitment before it sees
 * the real host's nonce. Every input it controls is therefore pinned before
 * the input that randomises the answer arrives, so it cannot search — it can
 * only guess, once, online, at 1 in 10^6, and a wrong guess is a mismatch the
 * user is looking straight at.
 *
 * The passkey and both directional keys are bound to the whole transcript
 * (PKa ‖ PKb ‖ Na ‖ Nb) rather than to the raw shared secret, so substituting
 * either public key or either nonce changes every derived value.
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

/* 128 bits of freshness each. The nonces are public the moment they are
 * revealed and carry no secrecy requirement; what they need is to be
 * unguessable in advance by the party that has already committed, and 2^-128
 * is not a number anyone is going to work around. */
#define SESSION_NONCE_SIZE  16
#define SESSION_COMMIT_SIZE 32

typedef enum {
    SESSION_IDLE,            /* nothing negotiated */
    SESSION_AWAITING_REVEAL, /* device committed; waiting for the host's nonce */
    SESSION_PENDING,         /* keys derived, waiting for the user to confirm */
    SESSION_ACTIVE,          /* confirmed; encrypted traffic permitted */
} SessionState;

/**
 * Everything the passkey and the keys are bound to, in one ordered structure.
 *
 * Ordered by role, never by "mine and theirs": the two ends fill this in
 * identically or they do not agree at all, and a transcript that depended on
 * who was looking at it would bind nothing. Nothing in here is secret — all
 * four fields travel in plaintext — so this structure is not sensitive and is
 * deliberately not zeroised.
 */
typedef struct {
    uint8_t host_public[SESSION_PUBKEY_SIZE];
    uint8_t device_public[SESSION_PUBKEY_SIZE];
    uint8_t host_nonce[SESSION_NONCE_SIZE];
    uint8_t device_nonce[SESSION_NONCE_SIZE];
} SessionTranscript;

/**
 * The device's commitment to its nonce: H(label ‖ PKb ‖ PKa ‖ Nb).
 *
 * Public and non-secret, but it is what pins the device's nonce before the
 * host reveals its own, so the host MUST check it after the reveal. Both keys
 * are inside the hash for the same reason LESC's f4 takes both: a commitment
 * over the nonce alone could be replayed under a substituted public key.
 */
void session_commitment(const uint8_t device_public[SESSION_PUBKEY_SIZE],
                        const uint8_t host_public[SESSION_PUBKEY_SIZE],
                        const uint8_t device_nonce[SESSION_NONCE_SIZE],
                        uint8_t out[SESSION_COMMIT_SIZE]);

/**
 * Derive session keys and the comparison passkey from an X25519 exchange.
 *
 * `local_private` and `peer_public` are whichever end is calling; the
 * transcript says who is who, so both ends reach the same answer from mirrored
 * inputs. Pure function over its arguments, so the host suite can verify it
 * against known answers without an ESP32. Returns false if the peer key is
 * degenerate.
 */
bool session_derive(const uint8_t local_private[SESSION_KEY_SIZE],
                    const uint8_t peer_public[SESSION_PUBKEY_SIZE],
                    const SessionTranscript *transcript,
                    uint8_t k_h2d_out[SESSION_KEY_SIZE],
                    uint8_t k_d2h_out[SESSION_KEY_SIZE],
                    char    passkey_out[SESSION_PASSKEY_LEN + 1]);

/* ------------------------------------------------------- session instance */

/**
 * Begin a handshake: generate an ephemeral key pair and a nonce, and commit.
 *
 * Nothing is derived yet and nothing is displayed yet — the passkey does not
 * exist until the host's nonce arrives, which is the entire point. Leaves the
 * session in SESSION_AWAITING_REVEAL.
 */
bool session_begin(const uint8_t host_public[SESSION_PUBKEY_SIZE],
                   uint8_t device_public_out[SESSION_PUBKEY_SIZE],
                   uint8_t device_commit_out[SESSION_COMMIT_SIZE]);

/**
 * Second leg: the host reveals its nonce, the device reveals its own.
 *
 * Only valid in SESSION_AWAITING_REVEAL — a reveal at any other moment is
 * either a confused host or someone trying to get a second derivation out of
 * one commitment, and both are refused rather than accommodated. On success
 * the keys and the passkey exist and the state is SESSION_PENDING.
 */
bool session_reveal(const uint8_t host_nonce[SESSION_NONCE_SIZE],
                    uint8_t device_nonce_out[SESSION_NONCE_SIZE]);

/** The passkey the user must compare, valid while SESSION_PENDING. */
const char *session_passkey(void);

/** Called when the user confirms on the device. */
void session_confirm(void);

/** Tear down and wipe all session material. */
void session_reset(void);

/**
 * Register something to run whenever the session goes away (T42).
 *
 * The session is torn down from four places — a disconnect, a new connection,
 * a transport switch, and a frame that failed to authenticate — and state
 * that belongs to the *host* rather than to the device has to die with it.
 * Today that means a passphrase the app typed on the user's behalf: keeping it
 * applied after the host that supplied it is gone leaves the device deriving
 * from a hidden wallet that nothing on screen chose and no one is watching.
 *
 * A callback rather than a direct call so this file stays free of the wallet
 * and the UI. It is the piece of the firmware that must run under a host test
 * suite with nothing else linked in, and it decrypts attacker-controlled bytes
 * — that isolation is worth keeping. NULL to unregister.
 */
void session_set_on_reset(void (*callback)(void));

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
