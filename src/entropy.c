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
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
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
 * Both cutoffs below are derived from ONE entropy assumption, and this is it:
 *
 *     H = 7 bits of min-entropy per 8-bit sample, alpha = 2^-30.
 *
 * Seven rather than eight because the tests exist for the case where the source
 * is *not* what its datasheet says. Assuming full entropy to derive the cutoffs
 * of the tests that are supposed to notice a shortfall is circular; the whole
 * point is to be right when esp_random() is degraded, and a degraded source has
 * H < 8. Every constant here is traceable to that line. If a future change wants
 * a different H, it has to move both numbers, which is the property that was
 * missing before: the file used to state H = 7 for the repetition test and
 * silently derive the proportion cutoff at H = 8.
 */

/*
 * Repetition Count Test (SP 800-90B 4.4.1): C = 1 + ceil(-log2(alpha) / H)
 *   = 1 + ceil(30 / 7) = 1 + 5 = 6.
 * For a sound source the odds of tripping this are about 2^-40 per position;
 * for a stuck register it fires on the sixth byte.
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
 * and it catches bias on the first buffer rather than eventually. The cost is a
 * ~256x union bound on the false-positive rate: ~1e-7 per window instead of the
 * ~4e-10 the spec's single-value form gives.
 *
 * Cutoff: the spec's C is the smallest value with P[Binomial(W-1, 2^-H) >= C]
 * <= alpha. At W = 512 that gives C = 22 for H = 7 and C = 16 for H = 8. We use
 * 16 — the H = 7 derivation's number tightened by six — deliberately, and the
 * tightening is measured rather than asserted. Against the clean reference
 * stream: 0 rejections in 2 000 000 buffers at every length, i.e. the strictness
 * costs nothing a real device would ever notice. Against a source emitting 0x00
 * 5% of the time at the 512-byte sample this module now draws, detection is
 * 0.994 at cutoff 16 versus 0.882 at the spec's 22. Being stricter than the
 * spec permits is the safe direction; being stricter for free is worth taking.
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
static int  dice_rolls    = 0;
static bool user_pool_init = false;

/*
 * Bits credited per press. This used to be 4, justified by the interval between
 * presses being measured at microsecond resolution. It is not, and the number
 * was therefore an optimistic guess wearing the word "conservative".
 *
 * What actually happens to a press before it is timestamped: button_poll_once()
 * runs on a strictly periodic 10 ms tick (button.c, vTaskDelay of 10 with
 * CONFIG_FREERTOS_HZ=1000), and only emits an event once the raw level has been
 * stable for a 100 ms debounce. So the press instant is quantised to a 10 ms
 * grid before anyone reads a clock; the microsecond digits below that are
 * scheduler and interrupt jitter, not human variation. A press cadence spanning
 * 150-600 ms covers roughly 45 of those buckets, so an *irregular* user offers
 * perhaps 3-5 bits per interval — and a user who falls into a rhythm, which a
 * 100 ms debounce actively trains, offers considerably less. Consecutive
 * intervals from one human are not independent either, which no per-event
 * constant can express.
 *
 * Two is the number that survives all of that: a floor that holds for a user
 * pressing in near-time, not a mean for a user pressing well. It matters that
 * this be a floor rather than an estimate, because the health tests above
 * cannot see a shallow-but-clean hardware source (that is Coldcard's failure
 * exactly), which leaves this pool as the only layer that covers it. A gate
 * that over-credits is a gate that opens early.
 *
 * The honest fix for the resolution, rather than for the accounting, is an
 * interrupt timestamp on the GPIO edge. That is a change to shared input code
 * with its own debounce correctness to re-argue, so the accounting is corrected
 * here and the resolution is left as it is — ENTROPY_TARGET_EVENTS in ui.c is
 * doubled to 64 so the collection screen still clears 128 bits.
 */
#define BITS_PER_EVENT 2

/*
 * Dice are here because the press pool's number is an estimate and this one is
 * not. A fair six-sided die has exactly log2(6) = 2.5849625... bits of
 * min-entropy per roll, by definition of "fair", and that figure owes nothing
 * to a scheduler measurement nobody has taken (docs/AUDIT-ENTROPY-2.md S7.1
 * shows the press pool's bits come from ui_task dequeue jitter, not from the
 * human). Fifty rolls is 129 bits; a hundred is 258. That is the whole point of
 * the feature: a claim that can be defended arithmetically rather than modelled.
 *
 * Credited as floor(n * 2585 / 1000) — fixed point, rounded DOWN, because every
 * number in this file is a floor and a gate that over-credits opens early. The
 * truncation costs at most 0.06 bits per hundred rolls against exact log2(6).
 *
 * The assumption the arithmetic rests on, stated so it can be attacked: the die
 * is physical and fair, and the user reports what it actually showed. A loaded
 * die or a bored user entering a pattern reduces the real figure — which is why
 * this is mixed with the hardware draw and never substituted for it, exactly as
 * the press pool is. The floor of the whole construction is the hardware source;
 * dice can only add.
 *
 * A dice app on a phone is not a die and is worse than rolling nothing. It is an
 * unauditable PRNG on a networked, general-purpose computer, so a compromised
 * phone hands the wallet an attacker-chosen "roll" sequence — and the user, who
 * did the ceremony properly, ends up MORE confident in a WEAKER seed. That is
 * the Coldcard 2021 shape exactly (see entropy.h): the failure was never the
 * absence of a strong source, it was confidence in one that was not there. The
 * screen says so in as many words; see screen_entropy_render() in ui.c.
 */
#define DICE_MILLIBITS_PER_ROLL 2585

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

void entropy_add_dice_roll(uint8_t face, uint64_t timestamp_us)
{
    /* Refuse anything that is not a die face rather than clamping it. A caller
     * that has lost track of its selector must not be able to feed the pool a
     * value it will then credit 2.585 bits for. */
    if (face < 1 || face > 6) {
        return;
    }

    ensure_pool();

    /*
     * Tagged 0xD1 so a roll and a button event can never hash to the same
     * record: entropy_add_user_event() writes a button id in 0..3 as its first
     * byte, and an untagged roll of 1..6 would share that space for no reason.
     *
     * The timestamp goes in even though not one bit of it is credited. Pressing
     * a button to enter a roll produces the same dequeue jitter the press pool
     * lives on, and throwing it away would be discarding entropy for the sake of
     * a tidy ledger. Crediting it would be the real mistake: the roll's presses
     * would then be counted twice, once as arithmetic and once as an estimate of
     * the same physical act. So it is mixed and not counted, which makes the
     * combined claim a strict lower bound rather than a sum of overlaps.
     */
    uint8_t rec[10];
    rec[0] = 0xD1;
    rec[1] = face;
    for (int i = 0; i < 8; i++) {
        rec[2 + i] = (uint8_t)(timestamp_us >> (8 * i));
    }

    sha256_Update(&user_pool, rec, sizeof(rec));
    dice_rolls++;

    memzero(rec, sizeof(rec));
}

int entropy_user_event_count(void) { return user_events; }

int entropy_dice_roll_count(void) { return dice_rolls; }

int entropy_dice_bits(void)
{
    return (int)(((long)dice_rolls * DICE_MILLIBITS_PER_ROLL) / 1000);
}

int entropy_total_bits_estimate(void)
{
    return entropy_user_bits_estimate() + entropy_dice_bits();
}

int entropy_user_bits_estimate(void) { return user_events * BITS_PER_EVENT; }

void entropy_reset_user_pool(void)
{
    memzero(&user_pool, sizeof(user_pool));
    user_events    = 0;
    dice_rolls     = 0;
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

    /* Both counts, not just one. They are independent sources with independent
     * ledgers, and two sessions that happened to reach the same digest by
     * different routes -- 10 presses and 5 rolls versus 5 presses and 10 rolls
     * -- should not produce the same mix input. */
    uint8_t count_le[8] = {
        (uint8_t)user_events, (uint8_t)(user_events >> 8),
        (uint8_t)(user_events >> 16), (uint8_t)(user_events >> 24),
        (uint8_t)dice_rolls, (uint8_t)(dice_rolls >> 8),
        (uint8_t)(dice_rolls >> 16), (uint8_t)(dice_rolls >> 24),
    };
    sha256_Update(&ctx, count_le, sizeof(count_le));

    sha256_Final(&ctx, out32);
    memzero(&ctx, sizeof(ctx));
}

/* -------------------------------------------------------------- gathering */

static bool ble_active = false;
static bool wifi_active = false;
static EntropyResult last_result = ENTROPY_FAIL_NO_SOURCE;

#ifndef LEEK_HOST_TEST
/*
 * One lock around the whole enable/draw/disable/check sequence.
 *
 * bootloader_random_enable() and bootloader_random_disable() are not
 * reference-counted by IDF: the second enable is a no-op and the FIRST disable
 * turns the SAR ADC noise source off for everybody. Three tasks reach
 * random_buffer() — ui_task for wallet creation, the USB protocol task, and the
 * BLE protocol task — so without this lock the interleave is
 *
 *     protocol: enable            ui: enable (no-op)
 *     ui: fill, disable
 *     protocol: fill              <- bootloader RNG now off, no radio up,
 *                                    esp_random() is documented pseudo-random
 *
 * and the victim's bytes are weak while looking perfectly normal, which is the
 * one outcome this module exists to prevent. `last_result` was equally racy: a
 * failure in one task could be overwritten by another's success before the
 * caller read it, so rand_esp32.c would report the wrong reason for an abort.
 * Both live inside the lock now.
 *
 * Not recursive, and it must stay that way: nothing under this lock calls back
 * into entropy_fill(), and a recursive mutex would quietly permit a future
 * caller that does — which would nest the enable/disable window this exists to
 * keep flat.
 *
 * Host builds are single-threaded and take the stubbed path before any of this,
 * so the lock is compiled out rather than shimmed.
 */
static SemaphoreHandle_t gate_lock = NULL;

static bool gate_lock_take(void)
{
    /* Created on first use rather than in an init function: entropy_fill() has
     * no initialisation order to rely on (vault code reaches it before ui_task
     * exists), and a gate that depends on someone having called an init first
     * is a gate that silently is not one. The first call happens long before
     * there is a second task to race with. */
    if (!gate_lock) {
        gate_lock = xSemaphoreCreateMutex();
        if (!gate_lock) {
            return false;
        }
    }
    /* Generous but finite. The critical section is a few milliseconds; waiting
     * seconds means something is deadlocked, and failing closed is the only
     * acceptable answer to that. */
    return xSemaphoreTake(gate_lock, pdMS_TO_TICKS(5000)) == pdTRUE;
}

static void gate_lock_give(void)
{
    if (gate_lock) {
        xSemaphoreGive(gate_lock);
    }
}

/*
 * Deep health check: the size the tests actually have power at.
 *
 * The windowed proportion test needs a full PROPORTION_WINDOW to run at all, so
 * checking only the caller's 32 bytes left every real seed generation covered
 * by nothing but the coarse distinct-value floor. Measured against a source
 * with roughly 1 bit of min-entropy per byte: detection is 0.21 on a 32-byte
 * sample and 1.00 on a 512-byte one. The tests were never weak; they were being
 * run on a sample sixteen times too small to say anything.
 *
 * WHEN it runs is the trade-off, and the split is by draw size:
 *
 *   - Always on the first draw of a boot, whatever its size. A source that came
 *     up dead should be caught by whoever touches it first, not by whoever
 *     happens to ask for 32 bytes later.
 *   - On every draw of >= ENTROPY_DEEP_MIN_LEN bytes thereafter. Sixteen is the
 *     smallest draw in this firmware that is key material: seed entropy (32),
 *     the session device key (32), SLIP-39 share values (16 or 32), the vault
 *     salt and the wallet-record AES IV (16). Below it sits exactly one caller,
 *     the 12-byte GCM nonce in vault-crypt.c, which needs uniqueness rather
 *     than unpredictability and is the only draw frequent enough for latency to
 *     matter.
 *
 * The cost is 512 bytes at ~178 us per 32 (IDF paces esp_random() to ~45 kHz),
 * so about 2.8 ms, plus a check whose own arithmetic is a rounding error beside
 * that. Per seed that is free. Per session key it disappears into the ECDH
 * either side of it. Per vault write it is once, when a wallet is stored or a
 * PIN changed. The alternative — deep-checking only at seed generation — was
 * rejected because it makes the strength of the check depend on the caller
 * remembering to ask for it, and every finding this module was built around is
 * a caller not remembering something.
 */
#define ENTROPY_DEEP_SAMPLE  PROPORTION_WINDOW
#define ENTROPY_DEEP_MIN_LEN 16

static bool deep_check_done = false;

/* Static rather than stack: 512 bytes is a real fraction of the protocol task's
 * stack, and access is serialised by gate_lock, which is held across every use.
 * Zeroed before it is released — it holds raw hardware entropy, which is key
 * material until proven otherwise. */
static uint8_t deep_sample[ENTROPY_DEEP_SAMPLE];

/* Caller must hold gate_lock, with a hardware source already enabled. */
static EntropyResult entropy_deep_check(void)
{
    esp_fill_random(deep_sample, sizeof(deep_sample));
    EntropyResult r = entropy_health_check(deep_sample, sizeof(deep_sample));
    memzero(deep_sample, sizeof(deep_sample));
    return r;
}
#endif /* !LEEK_HOST_TEST */

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
    if (!gate_lock_take()) {
        /* No lock means no way to guarantee another task is not about to turn
         * the bootloader RNG off underneath this draw. Fail closed; the caller
         * aborts. */
        last_result = ENTROPY_FAIL_NO_SOURCE;
        ESP_LOGE(TAG, "entropy gate lock unavailable - refusing to generate");
        return false;
    }

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

    /* Deep check first, inside the same enable window as the draw it vouches
     * for. Checking the source after handing the caller its bytes would be
     * checking a different moment of the same hardware. */
    EntropyResult deep = ENTROPY_OK;
    if (!deep_check_done || len >= ENTROPY_DEEP_MIN_LEN) {
        deep = entropy_deep_check();
        if (deep == ENTROPY_OK) {
            deep_check_done = true;
        }
    }

    if (deep == ENTROPY_OK) {
        esp_fill_random(buf, len);
    }

    if (bootloader_rng) {
        bootloader_random_disable();
    }

    if (deep != ENTROPY_OK) {
        last_result = deep;
        gate_lock_give();
        memzero(buf, len);
        ESP_LOGE(TAG, "ENTROPY DEEP CHECK FAILED (%d bytes): %s - refusing",
                 (int)ENTROPY_DEEP_SAMPLE, entropy_result_str(deep));
        return false;
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
#ifndef LEEK_HOST_TEST
        gate_lock_give();
#endif
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
     * weak software PRNG was. Its output would sail through these tests. User
     * input is the layer that survives that, because no amount of firmware
     * misconfiguration can predict a die on a table or the jitter of a hand.
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
        /* Counts and bit totals only. The roll VALUES are entropy and never
         * reach a log line, a protocol frame or the console -- the same rule
         * the seed words are under. */
        ESP_LOGI(TAG, "Mixed in %d user events + %d dice rolls (~%d bits)",
                 user_events, dice_rolls, entropy_total_bits_estimate());
    }

#ifndef LEEK_HOST_TEST
    gate_lock_give();
#endif
    return true;
}

void entropy_dump_for_analysis(size_t bytes)
{
#ifndef LEEK_HOST_TEST
    ESP_LOGW(TAG, "=== RAW RNG DUMP (%zu bytes) - NOT KEY MATERIAL ===", bytes);

    /* Same lock as entropy_fill(), for the same reason: this function also
     * opens and closes the bootloader-RNG window, and doing that concurrently
     * with a real key draw would close somebody else's. */
    if (!gate_lock_take()) {
        ESP_LOGE(TAG, "entropy gate busy - no dump");
        return;
    }

    /* Remember whether WE enabled it, exactly as entropy_fill() does, rather
     * than asking rf_is_active() again at the end. The flags are written by
     * transport.c and the Wi-Fi toggle from other tasks and are not covered by
     * this lock, so the answer can differ between the two calls -- and both
     * ways it differs are wrong. If a radio comes up mid-dump, the disable is
     * skipped and the SAR ADC noise source is left running underneath a live
     * radio, which is the one thing Espressif documents as unsafe. If a radio
     * goes down mid-dump, disable() is called for a window this function never
     * opened, turning the bootloader RNG off for whoever did. */
    bool bootloader_rng = false;
    if (!rf_is_active()) {
        bootloader_random_enable();
        bootloader_rng = true;
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

    if (bootloader_rng) {
        bootloader_random_disable();
    }

    gate_lock_give();
    ESP_LOGW(TAG, "=== END RNG DUMP ===");
#else
    (void)bytes;
#endif
}
