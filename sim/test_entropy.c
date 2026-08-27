/**
 * Host tests for the entropy health checks (AUDIT.md S6, ROADMAP T15).
 *
 * These feed the checker the shapes a broken hardware RNG actually produces —
 * stuck at zero, stuck at a value, heavily biased — and assert it refuses them.
 * The Coldcard 2021 regression was exactly this class of failure: a silent
 * fallback to a weak source, undetected for five years because nothing was
 * watching the output.
 *
 * A passing suite does NOT mean the RNG is good. It means a catastrophically
 * broken one gets caught. Proving quality needs offline analysis of a large
 * sample (entropy_dump_for_analysis -> dieharder).
 */

#include <stdio.h>
#include <string.h>

#include "entropy.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Deterministic PRNG — statistically fine, which is all these tests need. */
static uint32_t rng_state = 0x2545F491;
static uint8_t next_byte(void)
{
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return (uint8_t)(rng_state >> 24);
}

static void fill_good(uint8_t *buf, size_t len)
{
    for (size_t i = 0; i < len; i++) buf[i] = next_byte();
}

static void expect(const char *label, const uint8_t *buf, size_t len,
                   EntropyResult want)
{
    EntropyResult got = entropy_health_check(buf, len);
    CHECK(got == want, "%s: expected \"%s\", got \"%s\"",
          label, entropy_result_str(want), entropy_result_str(got));
}

static void test_good_entropy_passes(void)
{
    printf("== healthy entropy passes\n");

    uint8_t buf[1024];
    for (int trial = 0; trial < 200; trial++) {
        fill_good(buf, sizeof(buf));
        EntropyResult r = entropy_health_check(buf, sizeof(buf));
        if (r != ENTROPY_OK) {
            CHECK(false, "false positive on trial %d: %s", trial, entropy_result_str(r));
            return;
        }
    }

    /* And at the size that actually matters: a 256-bit seed. */
    uint8_t seed[32];
    for (int trial = 0; trial < 500; trial++) {
        fill_good(seed, sizeof(seed));
        EntropyResult r = entropy_health_check(seed, sizeof(seed));
        if (r != ENTROPY_OK) {
            CHECK(false, "false positive on 32-byte seed, trial %d: %s",
                  trial, entropy_result_str(r));
            return;
        }
    }
}

static void test_dead_source(void)
{
    printf("== a dead source is rejected\n");

    uint8_t zeros[64] = {0};
    expect("all zeros", zeros, sizeof(zeros), ENTROPY_FAIL_ALL_ZERO);

    uint8_t ones[64];
    memset(ones, 0xFF, sizeof(ones));
    expect("all 0xFF", ones, sizeof(ones), ENTROPY_FAIL_ALL_SAME);

    uint8_t stuck[64];
    memset(stuck, 0x5A, sizeof(stuck));
    expect("stuck at 0x5A", stuck, sizeof(stuck), ENTROPY_FAIL_ALL_SAME);
}

static void test_stuck_run(void)
{
    printf("== a stuck run inside good data is rejected\n");

    uint8_t buf[256];
    fill_good(buf, sizeof(buf));
    memset(buf + 100, 0xA3, 8);     /* peripheral stalls mid-read */
    expect("8-byte stuck run", buf, sizeof(buf), ENTROPY_FAIL_REPETITION);

    /* A short run is normal and must not trip it. */
    fill_good(buf, sizeof(buf));
    buf[50] = buf[51] = 0x11;
    expect("2-byte repeat", buf, sizeof(buf), ENTROPY_OK);
}

static void test_biased_source(void)
{
    printf("== a heavily biased source is rejected\n");

    /* A source emitting mostly one value, with noise sprinkled in, so neither
     * the all-same nor the repetition test would catch it. */
    uint8_t buf[512];
    for (size_t i = 0; i < sizeof(buf); i++) {
        buf[i] = (i % 3 == 0) ? next_byte() : 0x7C;
    }
    /* Break up long runs so only the proportion test can fire. */
    for (size_t i = 4; i < sizeof(buf); i += 5) {
        buf[i] = next_byte();
    }
    EntropyResult r = entropy_health_check(buf, sizeof(buf));
    CHECK(r == ENTROPY_FAIL_PROPORTION || r == ENTROPY_FAIL_REPETITION,
          "biased source accepted (%s)", entropy_result_str(r));
}

static void test_low_variety_seed(void)
{
    printf("== a low-variety seed-sized buffer is rejected\n");

    /* 32 bytes drawn from only 4 distinct values: ~8 bits of real entropy in
     * something the caller believes is 256.
     *
     * Not the shape of the Coldcard failure, despite the temptation to say so.
     * That fallback PRNG emitted a *uniform-looking* stream from a small key,
     * and the distinct-value floor cannot see it — measured at 0 detections in
     * 200,000 trials at this length (docs/AUDIT-ENTROPY.md S2). What this test
     * pins down is the narrower claim: a source whose output is visibly
     * low-variety is rejected at seed scale. */
    uint8_t seed[32];
    static const uint8_t pool[4] = {0x01, 0x02, 0x03, 0x04};
    for (size_t i = 0; i < sizeof(seed); i++) {
        seed[i] = pool[next_byte() & 3];
    }
    EntropyResult r = entropy_health_check(seed, sizeof(seed));
    CHECK(r != ENTROPY_OK, "4-value seed accepted as healthy");
}

static void test_degenerate_input(void)
{
    printf("== degenerate inputs\n");
    expect("NULL buffer", NULL, 32, ENTROPY_FAIL_NO_SOURCE);

    uint8_t one = 0x42;
    expect("zero length", &one, 0, ENTROPY_FAIL_NO_SOURCE);
}

/* ------------------------------------------------------- user entropy pool */

static void test_pool_changes_output(void)
{
    printf("== user events change the mixed output\n");

    uint8_t hw[32];
    fill_good(hw, sizeof(hw));

    uint8_t without[32], with_one[32], with_two[32];

    entropy_reset_user_pool();
    entropy_mix_pool(hw, sizeof(hw), without);

    entropy_add_user_event(1, 1000000);
    entropy_mix_pool(hw, sizeof(hw), with_one);

    entropy_add_user_event(2, 1000531);
    entropy_mix_pool(hw, sizeof(hw), with_two);

    CHECK(memcmp(without, with_one, 32) != 0, "first user event did not change the output");
    CHECK(memcmp(with_one, with_two, 32) != 0, "second user event did not change the output");
    CHECK(entropy_user_event_count() == 2, "event count is %d", entropy_user_event_count());

    entropy_reset_user_pool();
}

static void test_timing_is_the_entropy(void)
{
    printf("== press timing matters, not just which button\n");

    uint8_t hw[32];
    fill_good(hw, sizeof(hw));

    /* Same button, same count, different microsecond timings. */
    uint8_t a[32], b[32];

    entropy_reset_user_pool();
    for (int i = 0; i < 8; i++) entropy_add_user_event(1, 1000000 + i * 250000);
    entropy_mix_pool(hw, sizeof(hw), a);

    entropy_reset_user_pool();
    for (int i = 0; i < 8; i++) entropy_add_user_event(1, 1000000 + i * 250000 + i);
    entropy_mix_pool(hw, sizeof(hw), b);

    CHECK(memcmp(a, b, 32) != 0,
          "one microsecond of timing jitter produced an identical pool");

    entropy_reset_user_pool();
}

static void test_pool_is_deterministic(void)
{
    printf("== identical event sequences reproduce\n");

    uint8_t hw[32];
    fill_good(hw, sizeof(hw));
    uint8_t first[32], second[32];

    entropy_reset_user_pool();
    for (int i = 0; i < 16; i++) entropy_add_user_event((uint8_t)(i % 4), 500 + i * 137);
    entropy_mix_pool(hw, sizeof(hw), first);

    entropy_reset_user_pool();
    for (int i = 0; i < 16; i++) entropy_add_user_event((uint8_t)(i % 4), 500 + i * 137);
    entropy_mix_pool(hw, sizeof(hw), second);

    CHECK(memcmp(first, second, 32) == 0, "pool is not a pure function of its events");

    entropy_reset_user_pool();
}

/* The property that makes this safe to ship: a user with terrible "randomness"
 * cannot make the result worse than hardware alone. */
static void test_worst_case_user_cannot_weaken(void)
{
    printf("== an adversarially predictable user cannot weaken the output\n");

    uint8_t hw[64];
    fill_good(hw, sizeof(hw));

    /* Same button, perfectly regular 250ms cadence: near-zero real entropy. */
    entropy_reset_user_pool();
    for (int i = 0; i < 64; i++) entropy_add_user_event(1, i * 250000);

    uint8_t mixed[32];
    entropy_mix_pool(hw, sizeof(hw), mixed);

    CHECK(entropy_health_check(mixed, sizeof(mixed)) == ENTROPY_OK,
          "mixed output failed its own health check");

    /* Different hardware input must still give a different result - the pool
     * cannot collapse distinct hardware states into one value. */
    uint8_t hw2[64], mixed2[32];
    fill_good(hw2, sizeof(hw2));
    entropy_mix_pool(hw2, sizeof(hw2), mixed2);
    CHECK(memcmp(mixed, mixed2, 32) != 0, "pool collapsed two hardware states");

    entropy_reset_user_pool();
}

static void test_reset_clears_pool(void)
{
    printf("== reset clears the pool\n");

    entropy_reset_user_pool();
    for (int i = 0; i < 10; i++) entropy_add_user_event(3, 900 + i * 71);
    CHECK(entropy_user_event_count() == 10, "expected 10 events");
    CHECK(entropy_user_bits_estimate() >= 40, "bit estimate too low: %d",
          entropy_user_bits_estimate());

    entropy_reset_user_pool();
    CHECK(entropy_user_event_count() == 0, "events survived reset");
    CHECK(entropy_user_bits_estimate() == 0, "bit estimate survived reset");

    /* With an empty pool the mix must equal the no-pool case. */
    uint8_t hw[32], after_reset[32], fresh[32];
    fill_good(hw, sizeof(hw));
    entropy_mix_pool(hw, sizeof(hw), after_reset);
    entropy_reset_user_pool();
    entropy_mix_pool(hw, sizeof(hw), fresh);
    CHECK(memcmp(after_reset, fresh, 32) == 0, "reset left residue in the pool");
}

int main(void)
{
    test_good_entropy_passes();
    test_dead_source();
    test_stuck_run();
    test_biased_source();
    test_low_variety_seed();
    test_degenerate_input();
    test_pool_changes_output();
    test_timing_is_the_entropy();
    test_pool_is_deterministic();
    test_worst_case_user_cannot_weaken();
    test_reset_clears_pool();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
