/**
 * LeekWallet Entropy Gate - see entropy.h for why this exists.
 */

#include "entropy.h"

#include <stdio.h>
#include <string.h>

#include "sha2.h"
#include "memzero.h"

#ifndef LEEK_HOST_TEST
#include "esp_random.h"
#include "esp_log.h"
#include "bootloader_random.h"
static const char *TAG = "entropy";
#else
/* Host builds test the health logic only; hardware paths are stubbed. */
#include <stdio.h>
#define ESP_LOGE(tag, ...) ((void)0)
#define ESP_LOGW(tag, ...) ((void)0)
#define ESP_LOGI(tag, ...) ((void)0)
static const char *TAG = "entropy";
#endif

/* ---------------------------------------------------------- health tests */

/*
 * Repetition Count Test (SP 800-90B 4.4.1). With 8-bit samples and a
 * conservative 7 bits/byte entropy assumption at alpha = 2^-30, the cutoff is
 * 6 consecutive identical samples. For a sound RNG the odds of tripping this
 * are about 2^-40 per position; for a stuck one it fires immediately.
 */
#define REPETITION_CUTOFF 6

/*
 * Proportion test, adapted from SP 800-90B 4.4.2.
 *
 * The spec's Adaptive Proportion Test counts occurrences of the window's *first*
 * sample, which suits a continuous stream: over many windows, a biased value
 * eventually lands in first position. We validate one-shot buffers, where that
 * almost never happens — a source emitting 53% one value passed cleanly in
 * testing because the window happened to start with a different byte.
 *
 * So we check the most frequent value in the window instead. Strictly stronger,
 * and it catches bias on the first buffer rather than eventually.
 *
 * Cutoff: in 512 samples each of 256 values is expected twice; the observed max
 * runs 9-10. Sixteen gives a false-positive rate around 1e-9 per value while
 * still catching anything meaningfully skewed.
 */
#define PROPORTION_WINDOW 512
#define PROPORTION_CUTOFF 16

EntropyResult entropy_health_check(const uint8_t *buf, size_t len)
{
    if (!buf || len == 0) {
        return ENTROPY_FAIL_NO_SOURCE;
    }

    /* All zeros: the signature of a peripheral that never started. */
    bool all_zero = true;
    for (size_t i = 0; i < len; i++) {
        if (buf[i] != 0x00) { all_zero = false; break; }
    }
    if (all_zero) {
        return ENTROPY_FAIL_ALL_ZERO;
    }

    /* All one value: a stuck register. */
    bool all_same = true;
    for (size_t i = 1; i < len; i++) {
        if (buf[i] != buf[0]) { all_same = false; break; }
    }
    if (all_same && len > 1) {
        return ENTROPY_FAIL_ALL_SAME;
    }

    /* Repetition count. */
    size_t run = 1;
    for (size_t i = 1; i < len; i++) {
        run = (buf[i] == buf[i - 1]) ? run + 1 : 1;
        if (run >= REPETITION_CUTOFF) {
            return ENTROPY_FAIL_REPETITION;
        }
    }

    /* Proportion: most frequent value in each full window. */
    for (size_t start = 0; start + PROPORTION_WINDOW <= len; start += PROPORTION_WINDOW) {
        uint16_t histogram[256] = {0};
        for (size_t i = start; i < start + PROPORTION_WINDOW; i++) {
            if (++histogram[buf[i]] >= PROPORTION_CUTOFF) {
                return ENTROPY_FAIL_PROPORTION;
            }
        }
    }

    /*
     * Short buffers (a 32-byte seed) are too small for the windowed test, so
     * apply a coarse distinct-value floor instead. 32 bytes of good entropy
     * yield ~30 distinct values; fewer than 8 means something is badly wrong.
     */
    if (len >= 16 && len < PROPORTION_WINDOW) {
        bool seen[256] = {false};
        int distinct = 0;
        for (size_t i = 0; i < len; i++) {
            if (!seen[buf[i]]) { seen[buf[i]] = true; distinct++; }
        }
        if (distinct < (int)(len / 4)) {
            return ENTROPY_FAIL_PROPORTION;
        }
    }

    return ENTROPY_OK;
}

const char *entropy_result_str(EntropyResult r)
{
    switch (r) {
        case ENTROPY_OK:                 return "ok";
        case ENTROPY_FAIL_ALL_ZERO:      return "all zero";
        case ENTROPY_FAIL_ALL_SAME:      return "all identical";
        case ENTROPY_FAIL_REPETITION:    return "repetition count";
        case ENTROPY_FAIL_PROPORTION:    return "adaptive proportion";
        case ENTROPY_FAIL_NO_SOURCE:     return "no entropy source";
        default:                         return "unknown";
    }
}

/* ------------------------------------------------------------- user pool */

/*
 * A running SHA-256 over every user event. Keeping it as a hash state rather
 * than a raw buffer means the pool is fixed-size regardless of how long the
 * user keeps pressing, and no raw timing data sits in RAM afterwards.
 */
static SHA256_CTX user_pool;
static int  user_events   = 0;
static bool user_pool_init = false;

/* Conservative: a human keypress interval at microsecond resolution carries
 * well over this, but under-counting is the safe direction for a progress bar
 * that gates seed generation. */
#define BITS_PER_EVENT 4

static void ensure_pool(void)
{
    if (!user_pool_init) {
        sha256_Init(&user_pool);
        sha256_Update(&user_pool, (const uint8_t *)"leek-user-entropy-v1", 20);
        user_pool_init = true;
    }
}

void entropy_add_user_event(uint8_t button, uint64_t timestamp_us)
{
    ensure_pool();

    uint8_t rec[9];
    rec[0] = button;
    for (int i = 0; i < 8; i++) {
        rec[1 + i] = (uint8_t)(timestamp_us >> (8 * i));
    }

    sha256_Update(&user_pool, rec, sizeof(rec));
    user_events++;

    memzero(rec, sizeof(rec));
}

int entropy_user_event_count(void) { return user_events; }

int entropy_user_bits_estimate(void) { return user_events * BITS_PER_EVENT; }

void entropy_reset_user_pool(void)
{
    memzero(&user_pool, sizeof(user_pool));
    user_events    = 0;
    user_pool_init = false;
}

void entropy_mix_pool(const uint8_t *hw, size_t hw_len, uint8_t out32[32])
{
    /*
     * out = SHA256("leek-entropy-mix-v1" || hw || pool_digest || count)
     *
     * Hashing hardware and user contributions together means the result is at
     * least as strong as the stronger input: an attacker must break both. This
     * is the standard construction and the reason user entropy can only help.
     */
    SHA256_CTX ctx;
    sha256_Init(&ctx);
    sha256_Update(&ctx, (const uint8_t *)"leek-entropy-mix-v1", 19);

    if (hw && hw_len) {
        sha256_Update(&ctx, hw, hw_len);
    }

    if (user_pool_init) {
        /* Snapshot the pool without consuming it - the user may generate more
         * than one wallet from a single collection session. */
        SHA256_CTX snapshot = user_pool;
        uint8_t digest[32];
        sha256_Final(&snapshot, digest);
        sha256_Update(&ctx, digest, sizeof(digest));
        memzero(digest, sizeof(digest));
        memzero(&snapshot, sizeof(snapshot));
    }

    uint8_t count_le[4] = {
        (uint8_t)user_events, (uint8_t)(user_events >> 8),
        (uint8_t)(user_events >> 16), (uint8_t)(user_events >> 24),
    };
    sha256_Update(&ctx, count_le, sizeof(count_le));

    sha256_Final(&ctx, out32);
    memzero(&ctx, sizeof(ctx));
}

/* -------------------------------------------------------------- gathering */

static bool ble_active = false;
static bool wifi_active = false;
static EntropyResult last_result = ENTROPY_FAIL_NO_SOURCE;

/* Either radio counts. Kept as a function rather than a cached bool so there
 * is no third piece of state to fall out of step with the two real ones. */
static inline bool rf_is_active(void)
{
    return ble_active || wifi_active;
}

void entropy_set_ble_active(bool active)
{
    ble_active = active;
}

void entropy_set_wifi_active(bool active)
{
    wifi_active = active;
}

EntropyResult entropy_last_result(void)
{
    return last_result;
}

bool entropy_fill(uint8_t *buf, size_t len)
{
    if (!buf || len == 0) {
        last_result = ENTROPY_FAIL_NO_SOURCE;
        return false;
    }

#ifndef LEEK_HOST_TEST
    /*
     * With RF off, esp_random() has no guaranteed entropy source. Enable the
     * bootloader RNG (SAR ADC noise) for the duration. It must not be enabled
     * while Wi-Fi/BT owns the ADC, hence the rf_active flag.
     */
    bool bootloader_rng = false;
    if (!rf_is_active()) {
        bootloader_random_enable();
        bootloader_rng = true;
    }

    esp_fill_random(buf, len);

    if (bootloader_rng) {
        bootloader_random_disable();
    }
#else
    /* Host builds never produce real key material. */
    memset(buf, 0, len);
    last_result = ENTROPY_FAIL_NO_SOURCE;
    return false;
#endif

    /*
     * Health-check the HARDWARE output, before mixing. Mixing first would let
     * the user pool mask a dead silicon source and turn this check into a
     * rubber stamp.
     */
    last_result = entropy_health_check(buf, len);

    if (last_result != ENTROPY_OK) {
        /* Fail closed. Never hand back material that failed its own tests. */
        memzero(buf, len);
        ESP_LOGE(TAG, "ENTROPY HEALTH CHECK FAILED: %s - refusing to generate",
                 entropy_result_str(last_result));
        return false;
    }

    /*
     * Fold in user-contributed entropy, if any was collected.
     *
     * The two layers cover different failures, which is the point of having
     * both. The health tests above catch a grossly broken source (stuck,
     * biased, dead). They cannot catch a source that is statistically clean but
     * has little real entropy behind it - which is precisely what Coldcard's
     * weak software PRNG was. Its output would sail through these tests. Human
     * keypress jitter is the layer that survives that, because no amount of
     * firmware misconfiguration can predict it.
     */
    if (user_pool_init) {
        for (size_t off = 0; off < len; off += 32) {
            uint8_t input[36];
            size_t  chunk = (len - off < 32) ? (len - off) : 32;

            memcpy(input, buf + off, chunk);
            memset(input + chunk, 0, 32 - chunk);
            uint32_t index = (uint32_t)(off / 32);
            for (int i = 0; i < 4; i++) {
                input[32 + i] = (uint8_t)(index >> (8 * i));
            }

            uint8_t mixed[32];
            entropy_mix_pool(input, sizeof(input), mixed);
            memcpy(buf + off, mixed, chunk);

            memzero(input, sizeof(input));
            memzero(mixed, sizeof(mixed));
        }
        ESP_LOGI(TAG, "Mixed in %d user events (~%d bits)",
                 user_events, entropy_user_bits_estimate());
    }

    return true;
}

void entropy_dump_for_analysis(size_t bytes)
{
#ifndef LEEK_HOST_TEST
    ESP_LOGW(TAG, "=== RAW RNG DUMP (%zu bytes) - NOT KEY MATERIAL ===", bytes);

    if (!rf_is_active()) {
        bootloader_random_enable();
    }

    uint8_t chunk[32];
    char    hex[65];
    for (size_t done = 0; done < bytes; done += sizeof(chunk)) {
        esp_fill_random(chunk, sizeof(chunk));
        for (size_t i = 0; i < sizeof(chunk); i++) {
            static const char *d = "0123456789abcdef";
            hex[i * 2]     = d[chunk[i] >> 4];
            hex[i * 2 + 1] = d[chunk[i] & 0x0F];
        }
        hex[64] = '\0';
        printf("%s\n", hex);
    }

    if (!rf_is_active()) {
        bootloader_random_disable();
    }

    ESP_LOGW(TAG, "=== END RNG DUMP ===");
#else
    (void)bytes;
#endif
}
