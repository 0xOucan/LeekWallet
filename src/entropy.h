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
 * the interval between two human keypresses, measured at microsecond
 * resolution, carries several bits of genuine jitter that no attacker can
 * predict or reproduce. Budget ~4 bits per press and stay conservative.
 *
 * Why bother when the hardware RNG works? Because Coldcard's hardware RNG also
 * "worked" — until a build flag meant it wasn't being used. A user-contributed
 * pool is the layer that survives that failure: even with a completely broken
 * silicon source, a seed generated after 64 presses is not brute-forceable.
 */
void entropy_add_user_event(uint8_t button, uint64_t timestamp_us);

/** Number of user events collected since the last reset. */
int entropy_user_event_count(void);

/**
 * Conservative lower bound on user-contributed entropy, in bits.
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
 * the health tests on the output. Returns false without writing usable data if
 * anything is wrong — callers must treat false as fatal and must not fall back
 * to any other source.
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
