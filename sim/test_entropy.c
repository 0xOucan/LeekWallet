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

/*
 * Why entropy_fill() draws a 512-byte sample it throws away.
 *
 * This is the measurement the deep check exists for, run as an assertion. The
 * source is one emitting 0x00 half the time — roughly 1 bit of min-entropy per
 * byte, so a 32-byte draw from it is worth about 32 bits, comfortably
 * brute-forceable. At the 32 bytes bip39.c asks for, the tests catch it about a
 * fifth of the time. At 512 bytes they catch it every time, because that is the
 * first length at which the windowed proportion test runs at all.
 *
 * The assertion is deliberately two-sided. If the 512-byte detection ever stops
 * being total the deep check has been broken; if the 32-byte detection ever
 * becomes total, the deep check is no longer buying anything and this test
 * should be the thing that says so rather than a comment nobody re-measures.
 */
static void test_deep_sample_is_why(void)
{
    printf("== a shallow source is caught at 512 bytes and missed at 32\n");

    const int trials = 4000;
    int caught_short = 0, caught_deep = 0;
    uint8_t deep[512];

    for (int t = 0; t < trials; t++) {
        for (size_t i = 0; i < sizeof(deep); i++) {
            uint8_t b = next_byte();
            deep[i] = (next_byte() & 1) ? 0x00 : b;
        }
        if (entropy_health_check(deep, 32) != ENTROPY_OK) caught_short++;
        if (entropy_health_check(deep, sizeof(deep)) != ENTROPY_OK) caught_deep++;
    }

    CHECK(caught_deep == trials,
          "512-byte sample missed a ~1 bit/byte source %d/%d times",
          trials - caught_deep, trials);
    CHECK(caught_short < trials / 2,
          "32-byte detection is unexpectedly high (%d/%d) - re-measure the "
          "deep check's justification before trusting this",
          caught_short, trials);

    printf("   detection: len=32 %.4f, len=512 %.4f\n",
           (double)caught_short / trials, (double)caught_deep / trials);
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
    /* Two bits per event, not four: the press is quantised by a 10 ms poll and
     * a 100 ms debounce before anything timestamps it, so the old estimate was
     * an optimistic one wearing the word "conservative". The assertion is >=
     * rather than == because raising the credit per event is a claim that needs
     * evidence, while this test only guards against it silently reaching zero. */
    CHECK(entropy_user_bits_estimate() >= 20, "bit estimate too low: %d",
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

/* ------------------------------------------------------------- dice entropy */

/*
 * The arithmetic, asserted rather than asserted-in-a-comment.
 *
 * log2(6) = 2.5849625007... bits per roll of a fair d6. The module credits
 * floor(n * 2585 / 1000), i.e. the same figure truncated to three decimal
 * places and then rounded DOWN, so the credited number can never exceed the
 * real one. The table below is the claim the screen makes; if anyone retunes
 * the constant, this is what says so.
 */
static void test_dice_bits_are_arithmetic(void)
{
    printf("== dice bits are log2(6) per roll, rounded down\n");

    static const struct { int rolls; int bits; } table[] = {
        {  0,   0},
        {  1,   2},   /* 2.585  */
        { 10,  25},   /* 25.85  */
        { 37,  95},   /* 95.64  */
        { 50, 129},   /* 129.25 -- the 128-bit gate */
        { 99, 255},   /* 255.91 */
        {100, 258},   /* 258.50 -- 256-bit strength from dice alone */
    };

    for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
        entropy_reset_user_pool();
        for (int r = 0; r < table[i].rolls; r++) {
            entropy_add_dice_roll((uint8_t)(r % 6 + 1), 1000000 + r * 700);
        }
        CHECK(entropy_dice_roll_count() == table[i].rolls,
              "%d rolls counted as %d", table[i].rolls, entropy_dice_roll_count());
        CHECK(entropy_dice_bits() == table[i].bits,
              "%d rolls credited %d bits, expected %d",
              table[i].rolls, entropy_dice_bits(), table[i].bits);

        /* Never over-credit against the real value, at any count. */
        double exact = table[i].rolls * 2.5849625007211562;
        CHECK((double)entropy_dice_bits() <= exact + 1e-9,
              "%d rolls over-credited: %d > %.3f",
              table[i].rolls, entropy_dice_bits(), exact);
    }

    entropy_reset_user_pool();
}

/* Rolls and presses are credited to separate ledgers and summed. They must be,
 * because a roll's press timing is deliberately mixed in and credited zero -
 * see entropy_add_dice_roll(). A roll that also bumped the press counter would
 * charge one physical act twice and the total would stop being a lower bound. */
static void test_dice_and_presses_are_separate_ledgers(void)
{
    printf("== a roll is not also counted as a press\n");

    entropy_reset_user_pool();
    for (int r = 0; r < 20; r++) entropy_add_dice_roll((uint8_t)(r % 6 + 1), r * 900);
    CHECK(entropy_user_event_count() == 0, "rolls inflated the press counter");
    CHECK(entropy_user_bits_estimate() == 0, "rolls were credited press bits");

    for (int i = 0; i < 10; i++) entropy_add_user_event(1, 5000000 + i * 210000);
    CHECK(entropy_dice_roll_count() == 20, "presses disturbed the roll count");
    CHECK(entropy_total_bits_estimate()
              == entropy_dice_bits() + entropy_user_bits_estimate(),
          "the combined total is not the sum of its two ledgers");
    CHECK(entropy_total_bits_estimate() == 51 + 20,
          "20 rolls + 10 presses is %d bits, expected 71",
          entropy_total_bits_estimate());

    entropy_reset_user_pool();
}

static void test_dice_change_the_output(void)
{
    printf("== rolls reach the mixed output, and their values matter\n");

    uint8_t hw[32];
    fill_good(hw, sizeof(hw));
    uint8_t none[32], a[32], b[32], timing[32];

    entropy_reset_user_pool();
    entropy_mix_pool(hw, sizeof(hw), none);

    entropy_reset_user_pool();
    for (int r = 0; r < 5; r++) entropy_add_dice_roll((uint8_t)(r % 6 + 1), r * 1000);
    entropy_mix_pool(hw, sizeof(hw), a);

    /* Same count, same timings, different faces. */
    entropy_reset_user_pool();
    for (int r = 0; r < 5; r++) entropy_add_dice_roll((uint8_t)(6 - r % 6), r * 1000);
    entropy_mix_pool(hw, sizeof(hw), b);

    /* Same faces, one microsecond of difference in when they were entered. The
     * timing is credited nothing but it is still mixed, which is the margin the
     * combined claim leaves on the table. */
    entropy_reset_user_pool();
    for (int r = 0; r < 5; r++) entropy_add_dice_roll((uint8_t)(r % 6 + 1), r * 1000 + 1);
    entropy_mix_pool(hw, sizeof(hw), timing);

    CHECK(memcmp(none, a, 32) != 0, "rolls did not reach the output");
    CHECK(memcmp(a, b, 32) != 0, "the face values do not affect the output");
    CHECK(memcmp(a, timing, 32) != 0, "roll timing is not mixed in");

    entropy_reset_user_pool();
}

/* The rule the whole design rests on: mixed, never substituted. A user who
 * rolls a loaded die - every face a 1 - must not end up worse off than one who
 * rolls nothing at all. */
static void test_loaded_die_cannot_weaken(void)
{
    printf("== a loaded die cannot weaken the output\n");

    uint8_t hw[64];
    fill_good(hw, sizeof(hw));

    uint8_t without[32], with_loaded[32];
    entropy_reset_user_pool();
    entropy_mix_pool(hw, sizeof(hw), without);

    entropy_reset_user_pool();
    for (int r = 0; r < 99; r++) entropy_add_dice_roll(1, 250000);
    entropy_mix_pool(hw, sizeof(hw), with_loaded);

    CHECK(entropy_health_check(with_loaded, 32) == ENTROPY_OK,
          "a loaded-die mix failed its own health check");
    CHECK(memcmp(without, with_loaded, 32) != 0,
          "99 identical rolls collapsed onto the no-pool output");

    /* And distinct hardware states stay distinct underneath it. */
    uint8_t hw2[64], mixed2[32];
    fill_good(hw2, sizeof(hw2));
    entropy_mix_pool(hw2, sizeof(hw2), mixed2);
    CHECK(memcmp(with_loaded, mixed2, 32) != 0,
          "the dice pool collapsed two hardware states");

    entropy_reset_user_pool();
}

static void test_dice_rejects_impossible_faces(void)
{
    printf("== a value that is not a die face is refused, not clamped\n");

    entropy_reset_user_pool();
    uint8_t hw[32];
    fill_good(hw, sizeof(hw));
    uint8_t before[32], after[32];
    entropy_mix_pool(hw, sizeof(hw), before);

    entropy_add_dice_roll(0, 1000);
    entropy_add_dice_roll(7, 1000);
    entropy_add_dice_roll(255, 1000);
    CHECK(entropy_dice_roll_count() == 0, "a non-face was credited as a roll");
    CHECK(entropy_dice_bits() == 0, "a non-face was credited bits");

    entropy_mix_pool(hw, sizeof(hw), after);
    CHECK(memcmp(before, after, 32) == 0, "a rejected face still entered the pool");

    entropy_reset_user_pool();
}

static void test_reset_clears_dice(void)
{
    printf("== reset clears the dice ledger too\n");

    entropy_reset_user_pool();
    for (int r = 0; r < 12; r++) entropy_add_dice_roll((uint8_t)(r % 6 + 1), r * 313);
    CHECK(entropy_dice_bits() > 0, "no dice bits to clear");

    entropy_reset_user_pool();
    CHECK(entropy_dice_roll_count() == 0, "rolls survived reset");
    CHECK(entropy_dice_bits() == 0, "dice bits survived reset");
    CHECK(entropy_total_bits_estimate() == 0, "the combined total survived reset");
}

int main(void)
{
    test_good_entropy_passes();
    test_dead_source();
    test_stuck_run();
    test_biased_source();
    test_low_variety_seed();
    test_deep_sample_is_why();
    test_degenerate_input();
    test_pool_changes_output();
    test_timing_is_the_entropy();
    test_pool_is_deterministic();
    test_worst_case_user_cannot_weaken();
    test_reset_clears_pool();
    test_dice_bits_are_arithmetic();
    test_dice_and_presses_are_separate_ledgers();
    test_dice_change_the_output();
    test_loaded_die_cannot_weaken();
    test_dice_rejects_impossible_faces();
    test_reset_clears_dice();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
