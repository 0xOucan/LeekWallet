/**
 * What the six-digit passkey actually costs a machine-in-the-middle.
 *
 * This program exists because C-1 was argued and then measured, and the fix
 * has to be measured in the same terms rather than believed. It runs the same
 * relay against two protocols:
 *
 *   v1 (`--v1`) — the passkey was HKDF(X25519(a,B), "…passkey…"), a
 *     deterministic function of the shared secret with no nonce, no commitment
 *     and no transcript. The relay chose its own key material, so it could
 *     compute what the HOST would display for any private key it liked and
 *     search offline until that matched the digits the device was already
 *     showing. Nothing on the wire, nothing failing, nobody notified. Measured
 *     at 91 s on one core of the audit machine, against trezor-crypto's slow
 *     reference X25519 — the slowest implementation an attacker would ever
 *     use. Reproduced here from a local copy of the v1 derivation, because
 *     src/session.c no longer contains it.
 *
 *   v2 (the default) — the shipping protocol. Both ends contribute a fresh
 *     nonce, the device commits to its own before the host reveals, and the
 *     passkey is bound to the whole transcript. The relay is run again under
 *     the rules that ordering imposes, and the search it used to win is gone:
 *     every input it controls is fixed before the value that decides the
 *     answer exists.
 *
 * Usage, after `make -C sim build/passkey_grind`:
 *
 *   ./build/passkey_grind              — v2: attack it, and report the odds
 *   ./build/passkey_grind --search     — v2: let the relay try 10^6 times over
 *   ./build/passkey_grind --v1         — v1: the rate, and the implied cost
 *   ./build/passkey_grind --v1 --search— v1: actually find a colliding key
 *
 * Deliberately outside `make test`: it measures, it does not assert, and a
 * wall-clock number is not a pass/fail.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "hmac.h"
#include "sha2.h"
#include "session.h"

void curve25519_scalarmult_donna(uint8_t *mypublic, const uint8_t *n,
                                 const uint8_t *basepoint);

static uint64_t rng = 0x243F6A8885A308D3ull;

static uint8_t rnd_byte(void)
{
    rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
    return (uint8_t)(rng >> 33);
}

static void random_bytes(uint8_t *out, size_t len)
{
    for (size_t i = 0; i < len; i++) out[i] = rnd_byte();
}

static void public_of(uint8_t pub[32], const uint8_t priv[32])
{
    static const uint8_t base[32] = { 9 };
    uint8_t clamped[32];
    memcpy(clamped, priv, 32);
    clamped[0] &= 248; clamped[31] &= 127; clamped[31] |= 64;
    curve25519_scalarmult_donna(pub, clamped, base);
}

static double now(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

/* ------------------------------------------------------------------ v1 */

/* The v1 derivation, kept here and nowhere else. Reproducing it locally is the
 * point: the finding has to stay reproducible after the code it was found in
 * has been replaced, or "we fixed it" is an assertion about a program nobody
 * can run any more. */
static void v1_passkey(const uint8_t local_priv[32], const uint8_t peer_pub[32],
                       char out[SESSION_PASSKEY_LEN + 1])
{
    static const char LABEL[] = "leek-session-passkey-v1";
    uint8_t clamped[32], shared[32], prk[32], pk[32];
    const uint8_t zero_salt[32] = {0};
    const uint8_t counter = 0x01;
    HMAC_SHA256_CTX ctx;

    memcpy(clamped, local_priv, 32);
    clamped[0] &= 248; clamped[31] &= 127; clamped[31] |= 64;
    curve25519_scalarmult_donna(shared, clamped, peer_pub);

    hmac_sha256_Init(&ctx, zero_salt, sizeof(zero_salt));
    hmac_sha256_Update(&ctx, shared, sizeof(shared));
    hmac_sha256_Final(&ctx, prk);

    hmac_sha256_Init(&ctx, prk, sizeof(prk));
    hmac_sha256_Update(&ctx, (const uint8_t *)LABEL, sizeof(LABEL) - 1);
    hmac_sha256_Update(&ctx, &counter, 1);
    hmac_sha256_Final(&ctx, pk);

    uint32_t n = ((uint32_t)pk[0] << 24) | ((uint32_t)pk[1] << 16) |
                 ((uint32_t)pk[2] << 8) | pk[3];
    n %= 1000000u;
    for (int i = SESSION_PASSKEY_LEN - 1; i >= 0; i--) {
        out[i] = (char)('0' + (n % 10));
        n /= 10;
    }
    out[SESSION_PASSKEY_LEN] = '\0';
}

static int attack_v1(bool search)
{
    printf("== v1: no nonce, no commitment, passkey = f(shared secret)\n\n");

    uint8_t host_priv[32], host_pub[32], dev_priv[32], dev_pub[32];
    random_bytes(host_priv, 32); public_of(host_pub, host_priv);
    random_bytes(dev_priv, 32);  public_of(dev_pub,  dev_priv);

    /* Leg one: the relay opens a session with the DEVICE using a key of its
     * own. This fixes the digits the OLED will display. */
    uint8_t mitm_a[32], mitm_a_pub[32];
    random_bytes(mitm_a, 32); public_of(mitm_a_pub, mitm_a);

    char device_shows[SESSION_PASSKEY_LEN + 1];
    v1_passkey(dev_priv, mitm_a_pub, device_shows);
    printf("the device will display %s\n", device_shows);

    /* Leg two: the relay searches its own key space for a key that makes the
     * HOST derive the same six digits. Nothing is sent while it looks. */
    double t0 = now();
    unsigned long tries = 0;
    uint8_t mitm_b[32];
    char host_would_show[SESSION_PASSKEY_LEN + 1];
    host_would_show[0] = '\0';

    const unsigned long budget = search ? 200000000ul : 20000ul;

    for (;;) {
        random_bytes(mitm_b, 32);
        /* The relay computes what the HOST would derive, using the host's
         * public key and its own private one — the same shared secret the
         * host will compute, so the same digits. */
        v1_passkey(mitm_b, host_pub, host_would_show);
        tries++;

        if (search && strcmp(host_would_show, device_shows) == 0) break;
        if (tries >= budget) break;
    }
    double elapsed = now() - t0;
    double rate = (double)tries / elapsed;
    printf("%lu derivations in %.2f s — %.0f/s\n", tries, elapsed, rate);

    if (search) {
        if (strcmp(host_would_show, device_shows) == 0) {
            printf("FOUND after %lu tries: the host would display %s too\n",
                   tries, host_would_show);
            printf("both screens agree; the user sees nothing wrong\n");
        } else {
            printf("no collision inside the budget\n");
        }
    } else {
        printf("expected work for a chosen 6-digit passkey: 10^6 derivations, "
               "about %.0f s on this machine\n", 1000000.0 / rate);
        printf("run with --v1 --search to do it for real\n");
    }
    return 0;
}

/* ------------------------------------------------------------------ v2 */

/*
 * The same relay, against commit-then-reveal with a bound transcript.
 *
 * The rules below are not a convenience for the simulation; they are the
 * message ordering, and they are what the attacker is actually up against:
 *
 *   Device-facing leg. The relay sends its public key in `hello`. The device
 *   answers with PKb and a commitment to Nb, and reveals Nb only after the
 *   relay has sent Na'. So the relay's PKa' and Na' are both fixed before it
 *   sees Nb — and the digits the OLED will show depend on Nb.
 *
 *   Host-facing leg. The relay must answer the host's `hello` with PKb' and a
 *   commitment to Nb' before the host sends Na. The commitment is what pins
 *   it: whatever it committed to is what it must reveal, and the host checks.
 *   So PKb' and Nb' are fixed before it sees Na — and the digits the app will
 *   show depend on Na.
 *
 * Each side's displayed value therefore depends on one value the relay does
 * not have when it must choose. The best it can do is pick, and hope. That is
 * one online guess at 1 in 10^6, in front of a user reading a screen — and
 * unlike v1 a wrong guess is a visible mismatch rather than nothing at all.
 *
 * The loop below gives the attacker MORE than the protocol does — it lets it
 * grind its own keypair and nonce freely, ten million times, against the two
 * fixed real transcripts — precisely so the result is not an artefact of a
 * stingy simulation.
 */
static int attack_v2(bool search)
{
    printf("== v2: fresh nonces from both parties, device commits first, "
           "passkey bound to the transcript\n\n");

    uint8_t host_priv[32], host_pub[32], dev_priv[32], dev_pub[32];
    random_bytes(host_priv, 32); public_of(host_pub, host_priv);
    random_bytes(dev_priv, 32);  public_of(dev_pub,  dev_priv);

    uint8_t k1[32], k2[32];

    /* ---- device-facing leg, played out in protocol order ---- */
    uint8_t mitm_a[32], mitm_a_pub[32], mitm_na[SESSION_NONCE_SIZE];
    random_bytes(mitm_a, 32); public_of(mitm_a_pub, mitm_a);
    /* Committed by being sent: the relay's `helloReveal` goes out before the
     * device's `deviceNonce` comes back. */
    random_bytes(mitm_na, sizeof(mitm_na));

    uint8_t dev_nonce[SESSION_NONCE_SIZE];
    random_bytes(dev_nonce, sizeof(dev_nonce));   /* the device's, and fresh */

    SessionTranscript device_leg;
    memcpy(device_leg.host_public, mitm_a_pub, 32);
    memcpy(device_leg.device_public, dev_pub, 32);
    memcpy(device_leg.host_nonce, mitm_na, SESSION_NONCE_SIZE);
    memcpy(device_leg.device_nonce, dev_nonce, SESSION_NONCE_SIZE);

    char device_shows[SESSION_PASSKEY_LEN + 1];
    if (!session_derive(dev_priv, mitm_a_pub, &device_leg, k1, k2, device_shows)) {
        printf("degenerate; rerun\n");
        return 1;
    }
    printf("the device will display %s\n", device_shows);
    printf("  (fixed only once the device revealed its nonce — by which point\n"
           "   the relay's own key and nonce were already on the wire)\n\n");

    /* ---- host-facing leg ---- */
    /* The host's nonce. The relay does not have this when it must commit, and
     * that is the whole game; it is generated here to stand for a value the
     * relay cannot see yet. */
    uint8_t host_nonce[SESSION_NONCE_SIZE];
    random_bytes(host_nonce, sizeof(host_nonce));

    printf("the relay now looks for its own keypair and nonce making the APP\n"
           "show %s. In v1 this search was offline and free. Here it must\n"
           "commit before the host's nonce exists, so what follows is the\n"
           "search it would LIKE to run, with the host's nonce handed to it:\n\n",
           device_shows);

    double t0 = now();
    unsigned long tries = 0;
    unsigned long hits = 0;
    const unsigned long budget = search ? 10000000ul : 20000ul;

    uint8_t mitm_b[32], mitm_b_pub[32], mitm_nb[SESSION_NONCE_SIZE];
    char host_would_show[SESSION_PASSKEY_LEN + 1];

    for (; tries < budget; tries++) {
        random_bytes(mitm_b, 32); public_of(mitm_b_pub, mitm_b);
        random_bytes(mitm_nb, sizeof(mitm_nb));

        SessionTranscript host_leg;
        memcpy(host_leg.host_public, host_pub, 32);
        memcpy(host_leg.device_public, mitm_b_pub, 32);
        memcpy(host_leg.host_nonce, host_nonce, SESSION_NONCE_SIZE);
        memcpy(host_leg.device_nonce, mitm_nb, SESSION_NONCE_SIZE);

        if (!session_derive(mitm_b, host_pub, &host_leg, k1, k2, host_would_show)) continue;

        if (strcmp(host_would_show, device_shows) == 0) {
            hits++;
            if (search) {
                printf("  a matching (key, nonce) pair exists — found after %lu tries.\n",
                       tries + 1);
                break;
            }
        }
    }
    double elapsed = now() - t0;
    double rate = (double)tries / (elapsed > 0 ? elapsed : 1e-9);

    printf("  %lu derivations in %.2f s — %.0f/s, %lu match(es)\n\n",
           tries, elapsed, rate, hits);

    /* And now the part that matters: replay it under the real ordering, where
     * the relay must fix its choice BEFORE the host's nonce arrives. */
    printf("under the protocol's actual ordering the relay must pick first.\n");

    /* Enough to be a real sample without turning this into a coffee break.
     * The expected number of wins is trials/10^6, so a run of this size
     * expects a fraction of one and any result above a handful would be the
     * interesting one. */
    const unsigned long trials = search ? 500000ul : 50000ul;
    unsigned long wins = 0;
    for (unsigned long i = 0; i < trials; i++) {
        /* The relay commits: keypair and nonce, chosen blind. */
        random_bytes(mitm_b, 32); public_of(mitm_b_pub, mitm_b);
        random_bytes(mitm_nb, sizeof(mitm_nb));

        /* Only now does the host's nonce arrive. */
        uint8_t fresh_host_nonce[SESSION_NONCE_SIZE];
        random_bytes(fresh_host_nonce, sizeof(fresh_host_nonce));

        SessionTranscript host_leg;
        memcpy(host_leg.host_public, host_pub, 32);
        memcpy(host_leg.device_public, mitm_b_pub, 32);
        memcpy(host_leg.host_nonce, fresh_host_nonce, SESSION_NONCE_SIZE);
        memcpy(host_leg.device_nonce, mitm_nb, SESSION_NONCE_SIZE);

        if (!session_derive(mitm_b, host_pub, &host_leg, k1, k2, host_would_show)) continue;
        if (strcmp(host_would_show, device_shows) == 0) wins++;
    }

    printf("  %lu committed attempts, %lu undetected — %.6f%% "
           "(1 in 10^6 is %.6f%%)\n",
           trials, wins, 100.0 * (double)wins / (double)trials, 100.0 / 1e6);
    printf("\nthe relay is reduced to guessing, and every wrong guess is a\n"
           "mismatch on two screens the user is comparing. There is no offline\n"
           "phase left to run: the value it would search for does not exist\n"
           "until after its own inputs are committed.\n");

    if (!search) {
        printf("\nrun with --search to let the (impossible) offline search go to 10^7\n");
    }
    return 0;
}

int main(int argc, char **argv)
{
    bool search = false, v1 = false;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--search") == 0) search = true;
        else if (strcmp(argv[i], "--v1") == 0) v1 = true;
        else { fprintf(stderr, "usage: %s [--v1] [--search]\n", argv[0]); return 2; }
    }

    return v1 ? attack_v1(search) : attack_v2(search);
}
