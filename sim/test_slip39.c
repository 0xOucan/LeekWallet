/**
 * SLIP-0039 tests.
 *
 * The acceptance criterion for a backup format is not "it round-trips with
 * itself" — that would pass for any private scheme, including a broken one.
 * It is "another implementation can recover it", so the bulk of this file is
 * the official vector set from python-shamir-mnemonic, run in both directions:
 * every valid set must recover the exact published master secret, and every
 * invalid set must be REJECTED. The invalid half matters more. A decoder that
 * accepts a mangled share and returns a plausible-looking wrong secret sends a
 * user to an empty wallet with no way to tell what went wrong.
 *
 * The generation side cannot be checked against vectors (it is randomised), so
 * it is checked structurally: shares are decoded back, recombined at exactly
 * the threshold, and every subset below the threshold is confirmed to fail.
 */

#include <stdio.h>
#include <string.h>

#include "slip39-backup.h"
#include "slip39_vectors.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

#define PASSPHRASE "TREZOR"

static size_t unhex(const char *hex, uint8_t *out, size_t cap)
{
    size_t n = strlen(hex) / 2;
    if (n > cap) {
        return 0;
    }
    for (size_t i = 0; i < n; i++) {
        unsigned v;
        sscanf(hex + i * 2, "%2x", &v);
        out[i] = (uint8_t)v;
    }
    return n;
}

/* ------------------------------------------------------------ fake entropy */

/*
 * A counter-based stand-in, so generation is reproducible and a failure is a
 * failure every time. entropy_fill() deliberately refuses on the host (it can
 * prove no hardware source is live), which is the correct production
 * behaviour and useless for tests — hence the documented test-only hook.
 */
static uint8_t rng_state;

static bool fake_rng(uint8_t *buf, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        rng_state = (uint8_t)(rng_state * 251u + 7u);
        buf[i]    = rng_state;
    }
    return true;
}

static bool refusing_rng(uint8_t *buf, size_t len)
{
    (void)buf;
    (void)len;
    return false;
}

/* ------------------------------------------------------------- the vectors */

static void test_official_vectors(void)
{
    int valid = 0, invalid = 0;

    for (int i = 0; i < SLIP39_VECTOR_COUNT; i++) {
        const slip39_vector *v = &SLIP39_VECTORS[i];
        uint8_t ms[SLIP39_MAX_SECRET_LEN];
        size_t  ms_len = 0;

        slip39_error err = slip39_combine(v->mnemonics, (size_t)v->mnemonic_count,
                                          PASSPHRASE, ms, sizeof(ms), &ms_len);

        if (v->secret_hex[0]) {
            uint8_t want[SLIP39_MAX_SECRET_LEN];
            size_t  want_len = unhex(v->secret_hex, want, sizeof(want));
            CHECK(err == SLIP39_OK, "%s: rejected (err %d)", v->description, err);
            CHECK(err != SLIP39_OK || (ms_len == want_len &&
                                       memcmp(ms, want, want_len) == 0),
                  "%s: wrong secret", v->description);
            valid++;
        } else {
            CHECK(err != SLIP39_OK, "%s: accepted an invalid set",
                  v->description);
            CHECK(ms_len == 0, "%s: wrote output on failure", v->description);
            invalid++;
        }
    }
    printf("  %d valid + %d invalid official vectors\n", valid, invalid);
}

/* Every valid vector's mnemonics must re-encode byte-identically. If encoding
 * and decoding disagree anywhere — padding, bit order, checksum — this is
 * where it shows, and it is the half the vectors cannot test on their own. */
static void test_reencode(void)
{
    for (int i = 0; i < SLIP39_VECTOR_COUNT; i++) {
        const slip39_vector *v = &SLIP39_VECTORS[i];
        if (!v->secret_hex[0]) {
            continue;
        }
        for (int m = 0; m < v->mnemonic_count; m++) {
            slip39_share share;
            char         buf[SLIP39_MNEMONIC_BUF];

            CHECK(slip39_decode_mnemonic(v->mnemonics[m], &share) == SLIP39_OK,
                  "vector %d mnemonic %d did not decode", i + 1, m);
            CHECK(slip39_encode_mnemonic(&share, buf, sizeof(buf)) == SLIP39_OK,
                  "vector %d mnemonic %d did not encode", i + 1, m);
            CHECK(strcmp(buf, v->mnemonics[m]) == 0,
                  "vector %d mnemonic %d re-encoded differently:\n    %s\n    %s",
                  i + 1, m, buf, v->mnemonics[m]);
        }
    }
}

static void test_decode_fields(void)
{
    /* Vector 4 is a 2-of-3, so the header fields are all non-trivial. */
    slip39_share s;
    const char  *m = SLIP39_VECTORS[3].mnemonics[0];

    CHECK(slip39_decode_mnemonic(m, &s) == SLIP39_OK, "2-of-3 share decode");
    CHECK(s.group_threshold == 1, "group threshold %u", s.group_threshold);
    CHECK(s.group_count == 1, "group count %u", s.group_count);
    CHECK(s.member_threshold == 2, "member threshold %u", s.member_threshold);
    CHECK(s.value_len == 16, "value len %u", s.value_len);
    CHECK(s.ext == 0, "ext %u", s.ext);
}

/* The two length vectors, checked by name rather than by "it was rejected".
 * Both are word counts that cannot come from a legal secret length, and the
 * reason differs: one is too short to hold 128 bits at all, the other implies
 * more than 8 bits of padding. */
static void test_length_rejection(void)
{
    slip39_share s;
    /* Vectors 39 and 40 (1-based) in the official set. */
    const slip39_vector *short_v = &SLIP39_VECTORS[38];
    const slip39_vector *pad_v   = &SLIP39_VECTORS[39];

    CHECK(slip39_decode_mnemonic(short_v->mnemonics[0], &s) ==
              SLIP39_ERR_SECRET_LEN, "%s: wrong error", short_v->description);
    CHECK(slip39_decode_mnemonic(pad_v->mnemonics[0], &s) ==
              SLIP39_ERR_PADDING, "%s: wrong error", pad_v->description);
}

static void test_word_rejection(void)
{
    slip39_share s;

    CHECK(slip39_decode_mnemonic("duckling enlarge", &s) == SLIP39_ERR_WORD_COUNT,
          "two words accepted");
    CHECK(slip39_decode_mnemonic("", &s) == SLIP39_ERR_WORD_COUNT,
          "empty mnemonic accepted");

    /* A four-letter prefix is enough to identify a SLIP-39 word, and some UIs
     * use that. The decoder must still not accept it: the checksum is computed
     * over words, and silently expanding one hides a transcription error. */
    char truncated[SLIP39_MNEMONIC_BUF];
    /* "duckling ..." -> "duck ..." */
    snprintf(truncated, sizeof(truncated), "duck%s",
             strchr(SLIP39_VECTORS[0].mnemonics[0], ' '));
    CHECK(slip39_decode_mnemonic(truncated, &s) == SLIP39_ERR_WORD,
          "prefix-truncated word accepted");

    /* A word that is not in the list at all. */
    char bogus[SLIP39_MNEMONIC_BUF];
    snprintf(bogus, sizeof(bogus), "%s", SLIP39_VECTORS[0].mnemonics[0]);
    bogus[0] = 'z';
    CHECK(slip39_decode_mnemonic(bogus, &s) == SLIP39_ERR_WORD,
          "non-wordlist word accepted");

    /* Extra whitespace is a transcription artefact, not an error. */
    char spaced[SLIP39_MNEMONIC_BUF * 2];
    snprintf(spaced, sizeof(spaced), "  %s  ", SLIP39_VECTORS[0].mnemonics[0]);
    CHECK(slip39_decode_mnemonic(spaced, &s) == SLIP39_OK,
          "surrounding whitespace rejected");
}

/* ------------------------------------------------------------- generation */

static slip39_error gen(uint8_t gt, const slip39_group *groups, uint8_t gc,
                        const uint8_t *ms, size_t ms_len,
                        char (*out)[SLIP39_MNEMONIC_BUF], size_t *n)
{
    return slip39_generate(gt, groups, gc, ms, ms_len, PASSPHRASE, 0, out, 40, n);
}

static void test_generate_roundtrip(void)
{
    static const uint8_t ms16[16] = {
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    };
    static const uint8_t ms32[32] = {
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
    };
    const struct {
        uint8_t      len;
        const uint8_t *ms;
    } secrets[] = { { 16, ms16 }, { 32, ms32 } };

    for (int si = 0; si < 2; si++) {
        /* The headline case: 2-of-3 on paper, which is what this exists for. */
        char   sh[40][SLIP39_MNEMONIC_BUF];
        size_t n = 0;
        slip39_group g = { 2, 3 };

        rng_state = (uint8_t)(0x5a + si);
        CHECK(gen(1, &g, 1, secrets[si].ms, secrets[si].len, sh, &n) == SLIP39_OK,
              "2-of-3 generation (%u bytes)", secrets[si].len);
        CHECK(n == 3, "expected 3 shares, got %zu", n);

        for (int a = 0; a < 3; a++) {
            for (int b = a + 1; b < 3; b++) {
                const char *pair[2] = { sh[a], sh[b] };
                uint8_t     ms[SLIP39_MAX_SECRET_LEN];
                size_t      ms_len = 0;
                CHECK(slip39_combine(pair, 2, PASSPHRASE, ms, sizeof(ms),
                                     &ms_len) == SLIP39_OK,
                      "combine %d+%d failed", a, b);
                CHECK(ms_len == secrets[si].len &&
                      memcmp(ms, secrets[si].ms, ms_len) == 0,
                      "combine %d+%d wrong secret", a, b);
            }
        }

        /* Below the threshold nothing may come out — not a wrong secret, not
         * a partial one. */
        for (int a = 0; a < 3; a++) {
            const char *one[1] = { sh[a] };
            uint8_t     ms[SLIP39_MAX_SECRET_LEN];
            size_t      ms_len = 1;
            CHECK(slip39_combine(one, 1, PASSPHRASE, ms, sizeof(ms), &ms_len) !=
                      SLIP39_OK,
                  "single share %d recovered a 2-of-3", a);
            CHECK(ms_len == 0, "single share %d produced output", a);
        }

        /* The same share twice is not two shares. Interpolating over a
         * repeated x is undefined, so this must be caught by name rather than
         * left to the digest to notice. */
        const char *dup[2] = { sh[0], sh[0] };
        uint8_t     dms[SLIP39_MAX_SECRET_LEN];
        size_t      dms_len = 1;
        CHECK(slip39_combine(dup, 2, PASSPHRASE, dms, sizeof(dms), &dms_len) ==
                  SLIP39_ERR_DUPLICATE,
              "duplicated share not reported as a duplicate");
        CHECK(dms_len == 0, "duplicated share produced output");

        /* A wrong passphrase yields a different secret without any error --
         * that is the specified behaviour (plausible deniability), and a user
         * -facing flow must never present it as "recovered". */
        const char *pair[2] = { sh[0], sh[1] };
        uint8_t     ms[SLIP39_MAX_SECRET_LEN];
        size_t      ms_len = 0;
        CHECK(slip39_combine(pair, 2, "wrong", ms, sizeof(ms), &ms_len) ==
                  SLIP39_OK,
              "wrong passphrase errored instead of decrypting");
        CHECK(ms_len == secrets[si].len &&
              memcmp(ms, secrets[si].ms, ms_len) != 0,
              "wrong passphrase produced the right secret");
    }
}

static void test_generate_groups(void)
{
    static const uint8_t ms[16] = { 1, 2, 3, 4, 5, 6, 7, 8,
                                    9, 10, 11, 12, 13, 14, 15, 16 };
    /* Alice's example from the spec: 2-of-4 groups, mixed member schemes. */
    slip39_group groups[4] = { { 1, 1 }, { 1, 1 }, { 3, 5 }, { 2, 6 } };
    char   sh[40][SLIP39_MNEMONIC_BUF];
    size_t n = 0;

    rng_state = 0x11;
    CHECK(gen(2, groups, 4, ms, sizeof(ms), sh, &n) == SLIP39_OK,
          "two-level generation");
    CHECK(n == 13, "expected 13 shares, got %zu", n);

    uint8_t out[SLIP39_MAX_SECRET_LEN];
    size_t  out_len = 0;

    /* Her own two single-member groups. */
    const char *own[2] = { sh[0], sh[1] };
    CHECK(slip39_combine(own, 2, PASSPHRASE, out, sizeof(out), &out_len) ==
              SLIP39_OK, "groups 0+1 failed");
    CHECK(out_len == 16 && memcmp(out, ms, 16) == 0, "groups 0+1 wrong secret");

    /* Three friends (group 2) plus two family members (group 3). */
    const char *others[5] = { sh[2], sh[3], sh[4], sh[7], sh[8] };
    CHECK(slip39_combine(others, 5, PASSPHRASE, out, sizeof(out), &out_len) ==
              SLIP39_OK, "groups 2+3 failed");
    CHECK(out_len == 16 && memcmp(out, ms, 16) == 0, "groups 2+3 wrong secret");

    /* All five friends but no family: one group is not the threshold. */
    const char *friends[5] = { sh[2], sh[3], sh[4], sh[5], sh[6] };
    out_len = 1;
    CHECK(slip39_combine(friends, 5, PASSPHRASE, out, sizeof(out), &out_len) ==
              SLIP39_ERR_THRESHOLD, "one group alone recovered the secret");
    CHECK(out_len == 0, "failed combine wrote output");

    /* Two friends is short of that group's threshold of 3, even with a full
     * second group. The error code matters, not just the refusal: a device
     * that says "corrupt share" when the truth is "one more share needed"
     * sends the user looking for the wrong problem. */
    const char *short_group[4] = { sh[2], sh[3], sh[7], sh[8] };
    CHECK(slip39_combine(short_group, 4, PASSPHRASE, out, sizeof(out),
                         &out_len) == SLIP39_ERR_THRESHOLD,
          "under-threshold group not reported as such");

    /* Exactly the friends' threshold, but only one group of the two. */
    const char *one_group[3] = { sh[2], sh[3], sh[4] };
    CHECK(slip39_combine(one_group, 3, PASSPHRASE, out, sizeof(out),
                         &out_len) == SLIP39_ERR_THRESHOLD,
          "single group accepted where two are required");

    /* More member shares than the group's threshold. Interpolation would
     * happily accept the extra points; the spec says the count must equal the
     * threshold, so that a user who has grabbed the wrong pile is told. */
    const char *too_many[7] = { sh[2], sh[3], sh[4], sh[5], sh[6], sh[7], sh[8] };
    CHECK(slip39_combine(too_many, 7, PASSPHRASE, out, sizeof(out),
                         &out_len) == SLIP39_ERR_THRESHOLD,
          "more shares than the threshold accepted");
}

static void test_generate_refusals(void)
{
    static const uint8_t ms[16] = { 0 };
    char   sh[40][SLIP39_MNEMONIC_BUF];
    size_t n = 0;
    slip39_group ok = { 2, 3 };

    rng_state = 1;

    /* A 1-of-N group hands N people the same share. That is a copy, not a
     * split, and the spec says do not do it. */
    slip39_group one_of_three = { 1, 3 };
    CHECK(gen(1, &one_of_three, 1, ms, 16, sh, &n) == SLIP39_ERR_PARAM,
          "1-of-3 group accepted");

    slip39_group bad = { 4, 3 };
    CHECK(gen(1, &bad, 1, ms, 16, sh, &n) == SLIP39_ERR_PARAM,
          "threshold above member count accepted");
    CHECK(gen(2, &ok, 1, ms, 16, sh, &n) == SLIP39_ERR_PARAM,
          "group threshold above group count accepted");
    CHECK(gen(1, &ok, 1, ms, 15, sh, &n) == SLIP39_ERR_SECRET_LEN,
          "odd secret length accepted");
    CHECK(gen(1, &ok, 1, ms, 8, sh, &n) == SLIP39_ERR_SECRET_LEN,
          "64-bit secret accepted");

    /* The entropy gate refusing must abort generation outright. Silently
     * falling back to a weaker source is the Coldcard 4.0.1 failure. */
    slip39_set_random_source(refusing_rng);
    n = 99;
    CHECK(gen(1, &ok, 1, ms, 16, sh, &n) == SLIP39_ERR_ENTROPY,
          "generation proceeded without entropy");
    CHECK(n == 0, "share count left set after entropy failure");
    slip39_set_random_source(fake_rng);
}

int main(void)
{
    slip39_set_random_source(fake_rng);

    test_official_vectors();
    test_reencode();
    test_decode_fields();
    test_length_rejection();
    test_word_rejection();
    test_generate_roundtrip();
    test_generate_groups();
    test_generate_refusals();

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("all slip39 tests passed\n");
    return 0;
}
