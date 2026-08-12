/**
 * Host-native tests for src/pin.c
 *
 * The interesting cases are the power-cut ones (AUDIT.md S4). The fake NVS can
 * stop accepting writes partway through an operation, so "what does the device
 * do if you yank the cable right here" becomes an assertion instead of an
 * argument.
 */

#include <stdio.h>
#include <string.h>

#include "esp_stubs.h"
#include "fake_nvs.h"
#include "pin.h"

void pin__reset_static_state_for_test(void);

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Fresh device: empty storage, no PIN, cleared RAM. */
static void fresh_device(void)
{
    fake_nvs_reset();
    pin__reset_static_state_for_test();
    pin_init();
}

/* Power-cycle: storage survives, RAM does not. */
static void reboot(void)
{
    fake_nvs_reboot();
    pin__reset_static_state_for_test();
    pin_init();
}

static void test_set_and_verify(void)
{
    printf("== set and verify\n");
    fresh_device();

    CHECK(pin_is_set() == false, "fresh device reports a PIN is set");
    CHECK(pin_set("123456") == true, "pin_set failed");
    CHECK(pin_is_set() == true, "PIN not persisted");
    CHECK(pin_verify("123456") == true, "correct PIN rejected");
    CHECK(pin_get_remaining_attempts() == PIN_MAX_ATTEMPTS,
          "success did not restore attempts (%d)", pin_get_remaining_attempts());
}

static void test_lengths(void)
{
    printf("== PIN lengths 4 through 8 (S2)\n");

    static const char *pins[] = {"1234", "12345", "123456", "1234567", "12345678"};
    for (size_t i = 0; i < sizeof(pins) / sizeof(pins[0]); i++) {
        fresh_device();
        CHECK(pin_set(pins[i]) == true, "could not set %zu-digit PIN", strlen(pins[i]));
        CHECK(pin_verify(pins[i]) == true, "could not verify %zu-digit PIN", strlen(pins[i]));
    }

    fresh_device();
    CHECK(pin_set("123") == false, "accepted a 3-digit PIN");
    CHECK(pin_set("123456789") == false, "accepted a 9-digit PIN");
    CHECK(pin_set("12a4") == false, "accepted a non-digit PIN");
    CHECK(pin_set("") == false, "accepted an empty PIN");
}

static void test_attempts_decrement(void)
{
    printf("== failed attempts count down to a wipe\n");
    fresh_device();
    pin_set("1234");

    CHECK(pin_verify("9999") == false, "wrong PIN accepted");
    CHECK(pin_get_remaining_attempts() == 2, "expected 2, got %d", pin_get_remaining_attempts());
    CHECK(pin_should_wipe() == false, "wiping too early");

    pin_verify("9999");
    CHECK(pin_get_remaining_attempts() == 1, "expected 1, got %d", pin_get_remaining_attempts());

    pin_verify("9999");
    CHECK(pin_get_remaining_attempts() == 0, "expected 0, got %d", pin_get_remaining_attempts());
    CHECK(pin_should_wipe() == true, "should be requesting a wipe");
}

static void test_correct_pin_restores_attempts(void)
{
    printf("== a correct PIN refunds spent attempts\n");
    fresh_device();
    pin_set("1234");

    pin_verify("9999");
    CHECK(pin_get_remaining_attempts() == 2, "setup: expected 2");

    CHECK(pin_verify("1234") == true, "correct PIN rejected");
    CHECK(pin_get_remaining_attempts() == PIN_MAX_ATTEMPTS,
          "attempts not restored (%d)", pin_get_remaining_attempts());

    reboot();
    CHECK(pin_get_remaining_attempts() == PIN_MAX_ATTEMPTS,
          "restored count did not survive reboot (%d)", pin_get_remaining_attempts());
}

/* S4, part one: the attempt must be charged before the comparison, so cutting
 * power mid-verify cannot buy a free guess. */
static void test_powercut_during_verify(void)
{
    printf("== power cut mid-verify still spends the attempt (S4)\n");
    fresh_device();
    pin_set("1234");

    /* The attempt must be durable before the stored hash is even read.
     * Compare-then-decrement would report 0 writes here, and every power cut
     * during the comparison would be a free guess. */
    fake_nvs_mark_io_start();
    pin_verify("9999");
    CHECK(fake_nvs_writes_before_first_read() >= 1,
          "attempt was not persisted before the hash was read (%d writes)",
          fake_nvs_writes_before_first_read());

    /* And the charge survives losing power immediately afterwards. */
    fake_nvs_crash_after(1);
    reboot();
    CHECK(pin_get_remaining_attempts() == 2,
          "power cut refunded the attempt: %d remaining (expected 2)",
          pin_get_remaining_attempts());
}

/* S4, part two: exhausting attempts and cutting power before the wipe finishes
 * must NOT hand back a fresh set of attempts on the next boot. */
static void test_powercut_during_wipe(void)
{
    printf("== power cut mid-wipe does not reset the counter (S4)\n");
    fresh_device();
    pin_set("1234");

    pin_verify("9999");
    pin_verify("9999");
    pin_verify("9999");
    CHECK(pin_get_remaining_attempts() == 0, "setup: attempts should be exhausted");
    CHECK(pin_should_wipe() == true, "setup: should be requesting a wipe");

    /* Power dies before the UI ever gets to run pin_wipe(). */
    reboot();

    CHECK(pin_get_remaining_attempts() == 0,
          "reboot handed back %d attempts with the wallet intact",
          pin_get_remaining_attempts());
    CHECK(pin_should_wipe() == true, "reboot cleared the pending wipe");
}

static void test_wipe_clears_pin(void)
{
    printf("== wipe clears the stored PIN\n");
    fresh_device();
    pin_set("1234");
    CHECK(pin_is_set() == true, "setup failed");

    pin_wipe();
    CHECK(pin_is_set() == false, "PIN survived the wipe");
    CHECK(pin_is_unlocked() == false, "still unlocked after wipe");

    reboot();
    CHECK(pin_is_set() == false, "PIN reappeared after reboot");
    CHECK(pin_get_remaining_attempts() == PIN_MAX_ATTEMPTS,
          "a completed wipe should restore attempts");
}

static void test_lock_and_current_pin(void)
{
    printf("== lock clears the cached PIN\n");
    fresh_device();
    pin_set("123456");

    char buf[PIN_MAX_LENGTH + 1];
    CHECK(pin_get_current(buf, sizeof(buf)) == true, "cached PIN unavailable after set");
    CHECK(strcmp(buf, "123456") == 0, "cached PIN is \"%s\"", buf);

    /* S8c: a zero-length buffer must be rejected, not written to. */
    CHECK(pin_get_current(buf, 0) == false, "accepted max_len == 0");
    CHECK(pin_get_current(NULL, sizeof(buf)) == false, "accepted a NULL buffer");

    pin_lock();
    CHECK(pin_is_unlocked() == false, "still unlocked after pin_lock()");
    CHECK(pin_get_current(buf, sizeof(buf)) == false, "PIN still cached after lock");
}

static void test_change_pin(void)
{
    printf("== change PIN\n");
    fresh_device();
    pin_set("1234");

    CHECK(pin_change("9999", "5678") == false, "changed PIN with the wrong current PIN");
    CHECK(pin_verify("1234") == true, "original PIN stopped working after a failed change");

    CHECK(pin_change("1234", "567890") == true, "valid change rejected");
    CHECK(pin_verify("567890") == true, "new PIN does not verify");
    CHECK(pin_verify("1234") == false, "old PIN still works");
}

int main(void)
{
    test_set_and_verify();
    test_lengths();
    test_attempts_decrement();
    test_correct_pin_restores_attempts();
    test_powercut_during_verify();
    test_powercut_during_wipe();
    test_wipe_clears_pin();
    test_lock_and_current_pin();
    test_change_pin();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
