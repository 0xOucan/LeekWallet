/**
 * Hardware RNG bridge for trezor-crypto.
 *
 * trezor-crypto calls random_buffer() for everything, including
 * mnemonic_generate(). Routing it through the entropy gate means seed material
 * cannot be produced without passing the health checks — there is no second
 * path to forget about. See entropy.h for why that matters.
 */

#include <stdint.h>
#include <stddef.h>

#include "esp_random.h"
#include "esp_log.h"
#include "entropy.h"

static const char *TAG = "rand";

/* Override the weak random32() from trezor-crypto.
 *
 * Used for non-key-material purposes (blinding, nonces where a failure is not
 * catastrophic). Key material goes through random_buffer below. */
uint32_t random32(void)
{
    return esp_random();
}

/**
 * Fill a buffer with random bytes.
 *
 * This is the function mnemonic_generate() uses, so it is the one that decides
 * whether a wallet's seed is worth anything.
 *
 * On health-check failure it aborts rather than returning weak bytes. That is
 * deliberate: a wallet that refuses to generate a seed is a support ticket, and
 * a wallet that generates a guessable one is somebody's life savings. Coldcard's
 * 2021 build regression silently took the second path and nobody noticed for
 * five years.
 */
void random_buffer(uint8_t *buf, size_t len)
{
    if (entropy_fill(buf, len)) {
        return;
    }

    ESP_LOGE(TAG, "FATAL: entropy source unhealthy (%s)",
             entropy_result_str(entropy_last_result()));
    ESP_LOGE(TAG, "Refusing to produce key material. Halting.");

    /* Do not return. A caller that ignores this would derive a weak key. */
    abort();
}
