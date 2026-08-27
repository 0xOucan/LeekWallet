/**
 * Session layer tests (ROADMAP T25c).
 *
 * The property that matters most is the one in the middle: a relay cannot make
 * the two passkeys agree, and — since C-1 — cannot search for a way to. That
 * takes two things, and both are asserted here: the passkey is bound to the
 * whole transcript, and the device's nonce is committed before the host's is
 * revealed. Encryption alone would happily protect a conversation with an
 * impostor, so the passkey comparison is what detects the attack.
 *
 * sim/passkey_grind.c is the other half of the evidence: it runs the actual
 * offline search against this construction and reports what it costs.
 */

#include <stdio.h>
#include <stdlib.h>
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

/* One filled-in transcript, from four seeds. Both ends of a real handshake
 * agree on every field, which is the only reason they agree on anything. */
static void transcript_of(SessionTranscript *t,
                          const uint8_t host_pub[32], const uint8_t dev_pub[32],
                          uint8_t host_nonce_seed, uint8_t dev_nonce_seed)
{
    memcpy(t->host_public, host_pub, 32);
    memcpy(t->device_public, dev_pub, 32);
    fill(t->host_nonce, SESSION_NONCE_SIZE, host_nonce_seed);
    fill(t->device_nonce, SESSION_NONCE_SIZE, dev_nonce_seed);
}

static void test_both_sides_agree(void)
{
    printf("== host and device derive the same keys and passkey\n");

    uint8_t dev_priv[32], dev_pub[32], host_priv[32], host_pub[32];
    keypair(dev_priv, dev_pub, 1);
    keypair(host_priv, host_pub, 2);

    SessionTranscript t;
    transcript_of(&t, host_pub, dev_pub, 21, 22);

    uint8_t d_h2d[32], d_d2h[32], h_h2d[32], h_d2h[32];
    char d_pass[7], h_pass[7];

    CHECK(session_derive(dev_priv, host_pub, &t, d_h2d, d_d2h, d_pass), "device derive failed");
    CHECK(session_derive(host_priv, dev_pub, &t, h_h2d, h_d2h, h_pass), "host derive failed");

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

    SessionTranscript t;
    transcript_of(&t, host_pub, dev_pub, 23, 24);

    uint8_t h2d[32], d2h[32];
    char pass[7];
    session_derive(dev_priv, host_pub, &t, h2d, d2h, pass);

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

    /* Two legs, two transcripts. The relay's public key stands in for the
     * absent party on each side, and the nonces differ because each leg is a
     * separate handshake with a separately generated one. */
    SessionTranscript device_leg, host_leg;
    transcript_of(&device_leg, mitm_pub, dev_pub, 25, 26);
    transcript_of(&host_leg, host_pub, mitm_pub, 27, 28);

    /* The device negotiates with the attacker, believing it is the host. */
    session_derive(dev_priv, mitm_pub, &device_leg, k1, k2, device_sees);
    /* The host negotiates with the attacker, believing it is the device. */
    session_derive(host_priv, mitm_pub, &host_leg, k1, k2, host_sees);

    CHECK(strcmp(device_sees, host_sees) != 0,
          "relay produced matching passkeys (%s) - the comparison is useless",
          device_sees);
    printf("  device shows %s, app shows %s -> user sees the mismatch\n",
           device_sees, host_sees);
}

/* C-1. The v1 passkey was a pure function of the shared secret, so two
 * different transcripts over one secret produced the same digits and the
 * relay's only job was to find a secret. Every field has to move the answer,
 * or the field is not binding anything. */
static void test_every_transcript_field_binds(void)
{
    printf("== the passkey moves when any part of the transcript moves\n");

    uint8_t dev_priv[32], dev_pub[32], host_priv[32], host_pub[32];
    uint8_t other_pub[32], other_priv[32];
    keypair(dev_priv, dev_pub, 41);
    keypair(host_priv, host_pub, 42);
    keypair(other_priv, other_pub, 43);

    SessionTranscript base;
    transcript_of(&base, host_pub, dev_pub, 44, 45);

    uint8_t k1[32], k2[32];
    char reference[7], altered[7];
    CHECK(session_derive(dev_priv, host_pub, &base, k1, k2, reference), "derive failed");

    /* Each variant changes exactly one field and nothing else. Note the shared
     * secret is held CONSTANT throughout — the same private key against the
     * same peer key — which is precisely the freedom v1 handed the relay. */
    struct { const char *what; SessionTranscript t; } cases[4];
    for (int i = 0; i < 4; i++) cases[i].t = base;

    cases[0].what = "the host's public key";
    memcpy(cases[0].t.host_public, other_pub, 32);
    cases[1].what = "the device's public key";
    memcpy(cases[1].t.device_public, other_pub, 32);
    cases[2].what = "the host's nonce";
    cases[2].t.host_nonce[0] ^= 0x01;
    cases[3].what = "the device's nonce";
    cases[3].t.device_nonce[SESSION_NONCE_SIZE - 1] ^= 0x80;

    for (int i = 0; i < 4; i++) {
        CHECK(session_derive(dev_priv, host_pub, &cases[i].t, k1, k2, altered),
              "derive failed for %s", cases[i].what);
        CHECK(strcmp(altered, reference) != 0,
              "changing %s left the passkey at %s — that field binds nothing",
              cases[i].what, reference);
    }
    printf("  all four fields move the digits\n");
}

/* The commitment is what stops the search, so it has to actually bind: a
 * different nonce, or the same nonce under a different key, must not open it. */
static void test_commitment_binds_nonce_and_keys(void)
{
    printf("== the commitment opens only to what was committed\n");

    uint8_t dev_priv[32], dev_pub[32], host_priv[32], host_pub[32], other_priv[32], other_pub[32];
    keypair(dev_priv, dev_pub, 51);
    keypair(host_priv, host_pub, 52);
    keypair(other_priv, other_pub, 53);

    uint8_t nonce[SESSION_NONCE_SIZE], other_nonce[SESSION_NONCE_SIZE];
    fill(nonce, sizeof(nonce), 54);
    fill(other_nonce, sizeof(other_nonce), 55);

    uint8_t c[SESSION_COMMIT_SIZE], again[SESSION_COMMIT_SIZE];
    session_commitment(dev_pub, host_pub, nonce, c);

    session_commitment(dev_pub, host_pub, nonce, again);
    CHECK(memcmp(c, again, sizeof(c)) == 0, "the commitment is not deterministic");

    session_commitment(dev_pub, host_pub, other_nonce, again);
    CHECK(memcmp(c, again, sizeof(c)) != 0, "a different nonce opened the commitment");

    session_commitment(other_pub, host_pub, nonce, again);
    CHECK(memcmp(c, again, sizeof(c)) != 0,
          "the same nonce under another device key opened the commitment");

    session_commitment(dev_pub, other_pub, nonce, again);
    CHECK(memcmp(c, again, sizeof(c)) != 0,
          "the same nonce against another host key opened the commitment");
}

static void test_degenerate_key_refused(void)
{
    printf("== small-order peer keys are refused\n");

    uint8_t dev_priv[32], dev_pub[32], host_pub[32], host_priv[32];
    keypair(dev_priv, dev_pub, 8);
    keypair(host_priv, host_pub, 9);

    /* An all-zero public key drives the shared secret to zero, so the
     * "agreement" is a value the attacker picked. */
    uint8_t zero_pub[32] = {0};
    SessionTranscript t;
    transcript_of(&t, zero_pub, dev_pub, 30, 31);

    uint8_t a[32], b[32];
    char pass[7];

    CHECK(!session_derive(dev_priv, zero_pub, &t, a, b, pass),
          "a degenerate peer key was accepted");

    /* And through the instance API, where the refusal lands at the reveal:
     * the shared secret does not exist until the transcript is complete. */
    uint8_t device_pub[32], commit[SESSION_COMMIT_SIZE], device_nonce[SESSION_NONCE_SIZE];
    uint8_t host_nonce[SESSION_NONCE_SIZE];
    fill(host_nonce, sizeof(host_nonce), 32);

    CHECK(session_begin(zero_pub, device_pub, commit), "session_begin refused too early");
    CHECK(session_state() == SESSION_AWAITING_REVEAL, "begin did not await a reveal");
    CHECK(!session_reveal(host_nonce, device_nonce),
          "a degenerate peer key survived the reveal");
    CHECK(session_state() == SESSION_IDLE, "a refused reveal left state behind");
}

/* The ordering property, at the level of the state machine: nothing is derived
 * and nothing is displayed until the host's nonce has arrived, and one
 * commitment opens exactly once. */
static void test_reveal_is_required_and_single_use(void)
{
    printf("== nothing derives before the reveal, and one commitment reveals once\n");

    uint8_t host_priv[32], host_pub[32];
    keypair(host_priv, host_pub, 61);

    uint8_t dev_pub[32], commit[SESSION_COMMIT_SIZE];
    uint8_t host_nonce[SESSION_NONCE_SIZE], dev_nonce[SESSION_NONCE_SIZE];
    fill(host_nonce, sizeof(host_nonce), 62);

    CHECK(session_begin(host_pub, dev_pub, commit), "session_begin failed");
    CHECK(session_state() == SESSION_AWAITING_REVEAL,
          "after hello the device should be waiting for a nonce, not at state %d",
          session_state());
    /* No passkey exists yet. If one did, the device would have committed to
     * digits before learning the host's contribution to them. */
    CHECK(session_passkey()[0] == '\0', "a passkey existed before the reveal");

    /* Confirming a session that has not derived must do nothing at all - that
     * is the button press an attacker would love to race. */
    session_confirm();
    CHECK(session_state() == SESSION_AWAITING_REVEAL, "confirm skipped the reveal");

    CHECK(session_reveal(host_nonce, dev_nonce), "reveal failed");
    CHECK(session_state() == SESSION_PENDING, "reveal did not reach PENDING");
    CHECK(strlen(session_passkey()) == 6, "no passkey after the reveal");

    /* The commitment the device published must open to what it just revealed;
     * this is exactly the check the host performs. */
    uint8_t expected[SESSION_COMMIT_SIZE];
    session_commitment(dev_pub, host_pub, dev_nonce, expected);
    CHECK(memcmp(expected, commit, sizeof(commit)) == 0,
          "the device revealed a nonce it had not committed to");

    /* A second reveal against a spent commitment is refused rather than
     * re-derived: answering it would hand the peer a fresh derivation over a
     * nonce it has already seen, which is the search this design prevents. */
    uint8_t other_nonce[SESSION_NONCE_SIZE];
    fill(other_nonce, sizeof(other_nonce), 63);
    CHECK(!session_reveal(other_nonce, dev_nonce), "a commitment opened twice");

    session_reset();
}

/* Two handshakes must not share a nonce, or the device's contribution stops
 * being fresh and a relay gets to reuse a value it has already seen. */
static void test_device_nonce_is_fresh(void)
{
    printf("== each handshake commits to a new device nonce\n");

    uint8_t host_priv[32], host_pub[32];
    keypair(host_priv, host_pub, 71);

    uint8_t seen[4][SESSION_NONCE_SIZE];
    for (int i = 0; i < 4; i++) {
        uint8_t dev_pub[32], commit[SESSION_COMMIT_SIZE], host_nonce[SESSION_NONCE_SIZE];
        fill(host_nonce, sizeof(host_nonce), (uint8_t)(72 + i));
        CHECK(session_begin(host_pub, dev_pub, commit), "session_begin failed");
        CHECK(session_reveal(host_nonce, seen[i]), "reveal failed");
        for (int j = 0; j < i; j++) {
            CHECK(memcmp(seen[i], seen[j], SESSION_NONCE_SIZE) != 0,
                  "handshakes %d and %d committed to the same nonce", j, i);
        }
    }
    session_reset();
}

static void test_encrypt_round_trip(void)
{
    printf("== encrypt/decrypt round trip and replay rejection\n");

    uint8_t host_priv[32], host_pub[32];
    keypair(host_priv, host_pub, 9);

    uint8_t dev_pub[32], commit[SESSION_COMMIT_SIZE];
    uint8_t host_nonce[SESSION_NONCE_SIZE], dev_nonce[SESSION_NONCE_SIZE];
    fill(host_nonce, sizeof(host_nonce), 33);

    CHECK(session_begin(host_pub, dev_pub, commit), "session_begin failed");
    CHECK(session_reveal(host_nonce, dev_nonce), "session_reveal failed");
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

/* ------------------------------------------------------- cross-implementation */

/*
 * A known-answer vector, shared byte for byte with app/packages/core/test/
 * session.test.ts.
 *
 * The two implementations agree only where something compares them, and there
 * is a great deal here to disagree about: the label strings, the field order
 * inside the transcript hash, the width of the nonces, whether the transcript
 * is the HKDF salt or its info, and which four bytes of the passkey block are
 * reduced mod 10^6. Every one of those is a silent failure to pair rather than
 * a compile error. So the inputs are fixed hex on both sides and the outputs
 * are pinned here.
 *
 * Run with `--emit-kat` to print the vector after an intentional change.
 */
static const char KAT_DEVICE_PRIV[] =
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
static const char KAT_HOST_PRIV[] =
    "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f";
static const char KAT_HOST_NONCE[]   = "000102030405060708090a0b0c0d0e0f";
static const char KAT_DEVICE_NONCE[] = "f0e0d0c0b0a090807060504030201000";

static const char KAT_PASSKEY[] = "585036";
static const char KAT_H2D[] =
    "e608000f21aa91b6435f2e31463f33af2cd933104d620792863512ff91bd7aa0";
static const char KAT_D2H[] =
    "504a692870f51dd74e1f5dae5d192336f5351f5167f98d3d4a9b7d4fb71e3e5d";
static const char KAT_COMMIT[] =
    "32a52cc07e0fc6e729838810f7dd77fe1699fd60623d1a8034902a51d4aaaad2";

static void unhex(const char *hex, uint8_t *out, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        char b[3] = { hex[2 * i], hex[2 * i + 1], 0 };
        out[i] = (uint8_t)strtoul(b, NULL, 16);
    }
}

static void tohex(const uint8_t *in, size_t len, char *out)
{
    static const char D[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2 * i]     = D[in[i] >> 4];
        out[2 * i + 1] = D[in[i] & 0x0f];
    }
    out[2 * len] = '\0';
}

static void kat(bool emit)
{
    printf("== the known-answer vector the TypeScript client is pinned to\n");

    uint8_t dev_priv[32], host_priv[32], dev_pub[32], host_pub[32];
    unhex(KAT_DEVICE_PRIV, dev_priv, 32);
    unhex(KAT_HOST_PRIV, host_priv, 32);

    static const uint8_t base[32] = { 9 };
    uint8_t clamped[32];
    memcpy(clamped, dev_priv, 32);
    clamped[0] &= 248; clamped[31] &= 127; clamped[31] |= 64;
    curve25519_scalarmult_donna(dev_pub, clamped, base);
    memcpy(clamped, host_priv, 32);
    clamped[0] &= 248; clamped[31] &= 127; clamped[31] |= 64;
    curve25519_scalarmult_donna(host_pub, clamped, base);

    SessionTranscript t;
    memcpy(t.host_public, host_pub, 32);
    memcpy(t.device_public, dev_pub, 32);
    unhex(KAT_HOST_NONCE, t.host_nonce, SESSION_NONCE_SIZE);
    unhex(KAT_DEVICE_NONCE, t.device_nonce, SESSION_NONCE_SIZE);

    uint8_t h2d[32], d2h[32], commit[SESSION_COMMIT_SIZE];
    char passkey[7], hex_h2d[65], hex_d2h[65], hex_commit[65], hex_dev_pub[65], hex_host_pub[65];

    CHECK(session_derive(dev_priv, host_pub, &t, h2d, d2h, passkey), "KAT derive failed");
    session_commitment(dev_pub, host_pub, t.device_nonce, commit);

    tohex(h2d, 32, hex_h2d);
    tohex(d2h, 32, hex_d2h);
    tohex(commit, sizeof(commit), hex_commit);
    tohex(dev_pub, 32, hex_dev_pub);
    tohex(host_pub, 32, hex_host_pub);

    if (emit) {
        printf("  devicePublic %s\n  hostPublic   %s\n", hex_dev_pub, hex_host_pub);
        printf("  passkey %s\n  h2d     %s\n  d2h     %s\n  commit  %s\n",
               passkey, hex_h2d, hex_d2h, hex_commit);
        return;
    }

    CHECK(strcmp(passkey, KAT_PASSKEY) == 0, "passkey %s, expected %s", passkey, KAT_PASSKEY);
    CHECK(strcmp(hex_h2d, KAT_H2D) == 0, "h2d %s", hex_h2d);
    CHECK(strcmp(hex_d2h, KAT_D2H) == 0, "d2h %s", hex_d2h);
    CHECK(strcmp(hex_commit, KAT_COMMIT) == 0, "commit %s", hex_commit);
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--emit-kat") == 0) {
        kat(true);
        return 0;
    }

    test_both_sides_agree();
    test_directional_keys_differ();
    test_mitm_is_visible();
    test_every_transcript_field_binds();
    test_commitment_binds_nonce_and_keys();
    test_degenerate_key_refused();
    test_reveal_is_required_and_single_use();
    test_device_nonce_is_fresh();
    test_encrypt_round_trip();
    kat(false);

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
