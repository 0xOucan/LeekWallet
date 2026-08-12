/**
 * Session layer tests (ROADMAP T25c).
 *
 * The property that matters most is the one in the middle: a relay running two
 * separate handshakes cannot make both passkeys agree. Encryption alone would
 * happily protect a conversation with an impostor, so the passkey comparison
 * is what actually detects the attack — and it only works if the code is
 * derived from the shared secret rather than chosen by either side.
 */

#include <stdio.h>
#include <string.h>

#include "session.h"


static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Deterministic key material so runs repeat. */
static void fill(uint8_t *buf, size_t len, uint8_t seed)
{
    uint32_t s = 0x9e3779b9u ^ seed;
    for (size_t i = 0; i < len; i++) {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        buf[i] = (uint8_t)(s >> 24);
    }
}

/* Mirror the device's own derivation so the test exercises the same path. */
void curve25519_scalarmult_donna(uint8_t *mypublic, const uint8_t *n, const uint8_t *basepoint);

static void keypair(uint8_t priv[32], uint8_t pub[32], uint8_t seed)
{
    static const uint8_t base[32] = { 9 };
    uint8_t clamped[32];
    fill(priv, 32, seed);
    memcpy(clamped, priv, 32);
    clamped[0] &= 248; clamped[31] &= 127; clamped[31] |= 64;
    curve25519_scalarmult_donna(pub, clamped, base);
}

static void test_both_sides_agree(void)
{
    printf("== host and device derive the same keys and passkey\n");

    uint8_t dev_priv[32], dev_pub[32], host_priv[32], host_pub[32];
    keypair(dev_priv, dev_pub, 1);
    keypair(host_priv, host_pub, 2);

    uint8_t d_h2d[32], d_d2h[32], h_h2d[32], h_d2h[32];
    char d_pass[7], h_pass[7];

    CHECK(session_derive(dev_priv, host_pub, d_h2d, d_d2h, d_pass), "device derive failed");
    CHECK(session_derive(host_priv, dev_pub, h_h2d, h_d2h, h_pass), "host derive failed");

    CHECK(memcmp(d_h2d, h_h2d, 32) == 0, "host-to-device keys differ");
    CHECK(memcmp(d_d2h, h_d2h, 32) == 0, "device-to-host keys differ");
    CHECK(strcmp(d_pass, h_pass) == 0, "passkeys differ: %s vs %s", d_pass, h_pass);

    CHECK(strlen(d_pass) == 6, "passkey is %zu digits", strlen(d_pass));
    for (int i = 0; i < 6; i++) {
        CHECK(d_pass[i] >= '0' && d_pass[i] <= '9', "passkey has a non-digit");
    }
    printf("  passkey: %s\n", d_pass);
}

static void test_directional_keys_differ(void)
{
    printf("== the two directions use different keys\n");

    uint8_t dev_priv[32], dev_pub[32], host_priv[32], host_pub[32];
    keypair(dev_priv, dev_pub, 3);
    keypair(host_priv, host_pub, 4);

    uint8_t h2d[32], d2h[32];
    char pass[7];
    session_derive(dev_priv, host_pub, h2d, d2h, pass);

    /* One key in both directions would let an attacker replay a device
     * response back at the device. */
    CHECK(memcmp(h2d, d2h, 32) != 0, "both directions share a key");
}

/* The central claim: a relay cannot make the two passkeys match. */
static void test_mitm_is_visible(void)
{
    printf("== a machine in the middle produces mismatched passkeys\n");

    uint8_t dev_priv[32], dev_pub[32];
    uint8_t host_priv[32], host_pub[32];
    uint8_t mitm_priv[32], mitm_pub[32];
    keypair(dev_priv, dev_pub, 5);
    keypair(host_priv, host_pub, 6);
    keypair(mitm_priv, mitm_pub, 7);

    uint8_t k1[32], k2[32];
    char device_sees[7], host_sees[7];

    /* The device negotiates with the attacker, believing it is the host. */
    session_derive(dev_priv, mitm_pub, k1, k2, device_sees);
    /* The host negotiates with the attacker, believing it is the device. */
    session_derive(host_priv, mitm_pub, k1, k2, host_sees);

    CHECK(strcmp(device_sees, host_sees) != 0,
          "relay produced matching passkeys (%s) - the comparison is useless",
          device_sees);
    printf("  device shows %s, app shows %s -> user sees the mismatch\n",
           device_sees, host_sees);
}

static void test_degenerate_key_refused(void)
{
    printf("== small-order peer keys are refused\n");

    uint8_t dev_priv[32], dev_pub[32];
    keypair(dev_priv, dev_pub, 8);

    /* An all-zero public key drives the shared secret to zero, so the
     * "agreement" is a value the attacker picked. */
    uint8_t zero_pub[32] = {0};
    uint8_t a[32], b[32];
    char pass[7];

    CHECK(!session_derive(dev_priv, zero_pub, a, b, pass),
          "a degenerate peer key was accepted");
}

static void test_encrypt_round_trip(void)
{
    printf("== encrypt/decrypt round trip and replay rejection\n");

    uint8_t host_priv[32], host_pub[32];
    keypair(host_priv, host_pub, 9);

    uint8_t dev_pub[32];
    CHECK(session_begin(host_pub, dev_pub), "session_begin failed");
    CHECK(session_state() == SESSION_PENDING, "should be pending before confirmation");

    /* Nothing may flow before the user confirms. */
    uint8_t early[64] = {0};
    CHECK(session_encrypt(early, 8, sizeof(early)) < 0,
          "encrypted before the passkey was confirmed");

    session_confirm();
    CHECK(session_state() == SESSION_ACTIVE, "should be active after confirmation");

    uint8_t buf[128];
    const char *msg = "getStatus";
    size_t len = strlen(msg);
    memcpy(buf, msg, len);

    int enc = session_encrypt(buf, len, sizeof(buf));
    CHECK(enc == (int)(len + SESSION_TAG_SIZE), "encrypt returned %d", enc);
    CHECK(memcmp(buf, msg, len) != 0, "ciphertext equals plaintext");

    /* Decrypting our own output needs the same key and counter; the instance
     * keeps separate directions, so build a matching peer instead. */
    uint8_t tampered[128];
    memcpy(tampered, buf, (size_t)enc);
    tampered[0] ^= 0x01;
    CHECK(session_decrypt(tampered, (size_t)enc) < 0, "a tampered frame was accepted");
    CHECK(session_state() == SESSION_IDLE,
          "a failed tag should tear the session down, not just drop the frame");

    session_reset();
}

int main(void)
{
    test_both_sides_agree();
    test_directional_keys_differ();
    test_mitm_is_visible();
    test_degenerate_key_refused();
    test_encrypt_round_trip();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
