/**
 * LeekWallet Entropy Gate
 *
 * Every byte of seed material passes through here, and this is the only place
 * allowed to produce it.
 *
 * Why this module exists: the ESP32-S3 hardware RNG is only guaranteed to be a
 * true RNG while an entropy source is active — an RF subsystem (Wi-Fi/BT) or
 * the bootloader RNG path. With everything off, esp_random() degrades to
 * something far weaker, and *it does so silently*. A wallet built that way
 * produces seeds that look perfectly normal and are brute-forceable.
 *
 * That is not hypothetical. Coldcard shipped exactly this bug: a build
 * configuration error in firmware 4.0.1 (2021) made seed generation fall back
 * from the hardware source to a weak software RNG, cutting effective strength
 * from 128 bits to 40-72. It went unnoticed for five years and was drained en
 * masse in 2026.
 *
 * The lesson is not "use a better RNG" — Coldcard had one. It is that a silent
 * fallback is the failure mode, so this module is built to **fail loudly and
 * refuse to produce output** rather than degrade. A wallet that will not
 * generate a seed is an inconvenience; a wallet that generates a weak one is a
 * loss.
 */

#ifndef ENTROPY_H
#define ENTROPY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    ENTROPY_OK = 0,
    ENTROPY_FAIL_ALL_ZERO,      /* buffer is entirely 0x00 */
    ENTROPY_FAIL_ALL_SAME,      /* every byte identical */
    ENTROPY_FAIL_REPETITION,    /* one value repeated too many times in a row */
    ENTROPY_FAIL_PROPORTION,    /* one value far too frequent in a window */
    ENTROPY_FAIL_NO_SOURCE,     /* no hardware entropy source was active */
} EntropyResult;

/**
 * NIST SP 800-90B style continuous health tests over a sample buffer.
 *
 * Pure function, no hardware — the host suite drives it with deliberately
 * broken sources. These catch a *catastrophically* failed RNG (stuck, biased,
 * constant), which is the realistic firmware failure. They cannot certify
 * randomness; only offline analysis of a large sample can do that
 * (see entropy_dump_for_analysis).
 */
EntropyResult entropy_health_check(const uint8_t *buf, size_t len);

/** Human-readable name for a result code. */
const char *entropy_result_str(EntropyResult r);

/**
 * Tell the entropy gate which radios are running.
 *
 * The bootloader RNG draws from SAR ADC noise and must not be enabled while a
 * radio owns the ADC; conversely, with a radio up `esp_random()` is already a
 * true RNG and the bootloader path is not needed. So the gate has to know, and
 * the answer is "either radio", not "the last one somebody mentioned".
 *
 * Two setters rather than one flag because the two radios are owned by
 * different code and neither can speak for the other: transport.c knows about
 * BLE and is the only place that starts or stops it, and the Wi-Fi test toggle
 * knows about Wi-Fi. A single shared flag meant whichever spoke last erased
 * the other's answer.
 *
 * Both default to off, which is the safe direction: the gate enables the
 * bootloader RNG when it believes no radio is up, and believing that wrongly
 * while a radio *is* up is the case worth avoiding.
 */
void entropy_set_ble_active(bool active);
void entropy_set_wifi_active(bool active);

/* ------------------------------------------------------------- user pool */

/**
 * Mix a user-supplied entropy event into the pool.
 *
 * Called once per button press on the entropy-collection screen. The pool is
 * hashed together with hardware entropy in entropy_fill() — it **adds to** the
 * hardware source and never replaces it, so a user who mashes one button in a
 * rhythm cannot make the result worse than hardware alone.
 *
 * The bits do not come from which button was pressed (2 bits at best, and
 * humans are heavily biased in their choices). They come from `timestamp_us`:
 * the interval between two human keypresses carries jitter that no attacker can
 * predict or reproduce.
 *
 * How much jitter is smaller than this file used to claim. The parameter is
 * named `timestamp_us` and the clock behind it is microsecond-resolution, but
 * the press has already been through a 10 ms polling grid and a 100 ms debounce
 * by the time anyone reads that clock, so the honest resolution of an interval
 * is 10 ms, not 1 us. Budget **2 bits per press**, and see the derivation above
 * BITS_PER_EVENT in entropy.c for why that is a floor rather than a guess.
 *
 * Why bother when the hardware RNG works? Because Coldcard's hardware RNG also
 * "worked" — until a build flag meant it wasn't being used. A user-contributed
 * pool is the layer that survives that failure: even with a completely broken
 * silicon source, a seed generated after 64 presses is not brute-forceable.
 * Sixty-four is also, at 2 bits each, the count the collection screen requires.
 */
void entropy_add_user_event(uint8_t button, uint64_t timestamp_us);

/** Number of user events collected since the last reset. */
int entropy_user_event_count(void);

/**
 * Mix one physical die roll into the same pool.
 *
 * `face` is 1..6 and anything else is ignored rather than clamped. The pool and
 * the mixing construction are shared with the press events above: dice **add
 * to** the hardware source and never replace it, so a user who rolls badly,
 * gives up halfway, or rolls a loaded die cannot end up with a weaker seed than
 * one who rolls nothing at all.
 *
 * Why dice exist alongside the press pool, given the press pool already runs:
 * the press estimate is a model. Both audits found that its bits come from
 * `ui_task` dequeue jitter rather than from the human (docs/AUDIT-ENTROPY-2.md
 * S7.1), and that variance has never been measured on hardware. A die's
 * contribution is arithmetic instead: **log2(6) = 2.5849625 bits per roll**, so
 * 50 rolls is 129 bits and 100 rolls is 258, on the sole assumption that the die
 * is fair and the user types what it showed.
 *
 * `timestamp_us` is hashed in and credited **zero** bits, deliberately. Entering
 * a roll takes button presses, which carry the same jitter the press pool banks
 * on; discarding it would be silly, and counting it would charge the same
 * physical act twice. So the combined figure -- press bits plus dice bits -- is
 * a lower bound with no overlap between its two terms, and the uncounted jitter
 * of the dice presses sits on top of it as margin.
 *
 * A dice app on a phone is NOT a substitute and is worse than not rolling. See
 * DICE_MILLIBITS_PER_ROLL in entropy.c for why, and the entropy screen for the
 * short version the user actually reads.
 */
void entropy_add_dice_roll(uint8_t face, uint64_t timestamp_us);

/** Number of die rolls entered since the last reset. */
int entropy_dice_roll_count(void);

/**
 * Dice entropy in bits: floor(rolls * 2585 / 1000), i.e. log2(6) per roll
 * rounded down. Fixed point rather than floating, and truncated rather than
 * rounded, so the number the screen shows can never exceed the number the
 * arithmetic supports.
 */
int entropy_dice_bits(void);

/**
 * The combined floor the collection screen gates on: press bits + dice bits.
 * Summing is sound because the two terms count disjoint things -- see
 * entropy_add_dice_roll() on why a roll's press timing is credited to neither.
 */
int entropy_total_bits_estimate(void);

/**
 * Lower bound on user-contributed entropy, in bits: 2 per event.
 * Used to drive the collection screen's progress indicator.
 */
int entropy_user_bits_estimate(void);

/** Discard the user pool (after use, or on cancel). */
void entropy_reset_user_pool(void);

/**
 * Fold the user pool into `out32`, together with `hw`.
 *
 * out = SHA256(domain || hw || pool_state || event_count)
 *
 * Exposed for testing; entropy_fill() applies it automatically.
 */
void entropy_mix_pool(const uint8_t *hw, size_t hw_len, uint8_t out32[32]);

/**
 * Fill `buf` with seed-grade entropy, or fail.
 *
 * Guarantees a hardware entropy source is active for the duration, then runs
 * the health tests. Returns false without writing usable data if anything is
 * wrong — callers must treat false as fatal and must not fall back to any other
 * source.
 *
 * The tests run on two samples, because they only have power on the larger one:
 * a 512-byte sample drawn purely to be checked and then discarded, and the
 * caller's own bytes. The deep sample is drawn on the first call of a boot and
 * on every call of >= 16 bytes — i.e. everything in this firmware that is key
 * material — and costs about 2.8 ms. Draws below that (the 12-byte GCM nonce)
 * pay nothing after the first. Measured detection of a source with ~1 bit of
 * min-entropy per byte: 0.21 on 32 bytes, 1.00 on 512.
 *
 * Serialised internally. The bootloader-RNG window is process-wide and IDF does
 * not reference-count it, so concurrent callers would close each other's.
 */
bool entropy_fill(uint8_t *buf, size_t len);

/** Result of the most recent entropy_fill(), for diagnostics. */
EntropyResult entropy_last_result(void);

/**
 * Emit `bytes` of raw RNG output over the serial log, hex encoded, for offline
 * analysis (dieharder, ent, NIST STS). Debug builds only — this is a
 * measurement tool, and the output must never be used as key material.
 */
void entropy_dump_for_analysis(size_t bytes);

#endif /* ENTROPY_H */
