/**
 * In-memory stand-in for ESP-IDF NVS, for host tests.
 *
 * Beyond replacing flash with a hash table, this fake can simulate a power cut
 * at an arbitrary write. That is the whole point: the interesting PIN and wipe
 * bugs are ordering bugs, and you cannot test ordering without being able to
 * stop time partway through.
 */

#ifndef FAKE_NVS_H
#define FAKE_NVS_H

#include <stdbool.h>
#include <stddef.h>

/** Wipe all simulated flash and clear any pending crash. */
void fake_nvs_reset(void);

/**
 * Allow n more committed writes, then behave as if power were removed: every
 * later write is silently dropped. Counted from the call, so setup writes do
 * not shift it. n <= 0 disables crash injection.
 */
void fake_nvs_crash_after(int n);

/** Drop every write from this point on. */
void fake_nvs_crash_now(void);

/**
 * Ordering probe. Call mark_io_start(), run the operation, then read
 * writes_before_first_read(): it reports how many writes had already been
 * committed when the operation performed its first read. This is how you
 * assert "the attempt counter was durable before the PIN hash was even
 * fetched" - a property no crash injection can demonstrate on its own,
 * because a single-write operation has nothing left to drop.
 */
void fake_nvs_mark_io_start(void);
int  fake_nvs_writes_before_first_read(void);

/** True once an injected crash has fired. */
bool fake_nvs_crashed(void);

/** Number of committed writes since the last reset. */
int fake_nvs_write_count(void);

/**
 * Simulate a reboot: keep stored data, clear the crash, and let callers
 * re-run their init paths. Modules with static state must be reset separately.
 */
void fake_nvs_reboot(void);

/** Test helper: does a key exist in the given namespace? */
bool fake_nvs_has(const char *ns, const char *key);

#endif /* FAKE_NVS_H */
