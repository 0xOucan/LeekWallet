/**
 * Host-native tests for src/button.c (ROADMAP T8, AUDIT S8j)
 *
 * The defect is invisible on hardware: when the UI task stalls - a PBKDF2 seed
 * derivation is ~800 ms of blocked task - the button queue fills and presses
 * are discarded with no trace. The user sees a device that ignored them, or
 * worse, a press that lands on the next screen as a mis-entry.
 *
 * So the consumer here is stalled on purpose: the test polls the debouncer for
 * a measured 800 ms of fake clock without reading the queue once, then drains
 * it and asserts every press the user made is still there, in order. The stall
 * is a number in the test, not a sleep, because the host clock is fake-driven.
 */

#include <stdio.h>
#include <string.h>

#include "esp_stubs.h"
#include "driver/gpio.h"
#include "freertos/task.h"
#include "button.h"

/* Test hooks from button.c (compiled with -DLEEK_HOST_TEST). */
void     button__poll_once_for_test(void);
uint32_t button__overflow_count_for_test(void);
unsigned button__queue_size_for_test(void);
void     button__reset_static_state_for_test(void);

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* ------------------------------------------------------------------ fakes */

/* The four pins button.c polls, in its own index order (K1..K4). */
static const int pins[4] = {10, 5, 6, 7};
static int pin_level[4] = {1, 1, 1, 1};   /* active low: 1 = released */

esp_err_t gpio_config(const gpio_config_t *cfg) { (void)cfg; return ESP_OK; }

int gpio_get_level(gpio_num_t pin)
{
    for (int i = 0; i < 4; i++) {
        if (pins[i] == pin) {
            return pin_level[i];
        }
    }
    return 1;
}

/* A real bounded queue, unlike sim/fake_input.c's, which ignores the requested
 * length - and a queue that cannot fill is exactly the thing under test here.
 * fake_input.c is not linked in anyway: it defines button_init() and friends,
 * which is the module this suite is testing for real. */
#define FAKE_QUEUE_CAP 256

static button_event_t q_items[FAKE_QUEUE_CAP];
static unsigned q_cap, q_head, q_count;
static int queue_token;

QueueHandle_t xQueueCreate(uint32_t length, uint32_t item_size)
{
    (void)item_size;
    q_cap = (length < FAKE_QUEUE_CAP) ? length : FAKE_QUEUE_CAP;
    q_head = 0;
    q_count = 0;
    return &queue_token;
}

BaseType_t xQueueSend(QueueHandle_t q, const void *item, TickType_t wait)
{
    (void)q; (void)wait;
    if (q_count >= q_cap) {
        return pdFALSE;
    }
    q_items[(q_head + q_count) % FAKE_QUEUE_CAP] = *(const button_event_t *)item;
    q_count++;
    return pdTRUE;
}

BaseType_t xQueueReceive(QueueHandle_t q, void *out, TickType_t wait)
{
    (void)q; (void)wait;
    if (q_count == 0) {
        return pdFALSE;
    }
    *(button_event_t *)out = q_items[q_head];
    q_head = (q_head + 1) % FAKE_QUEUE_CAP;
    q_count--;
    return pdTRUE;
}

BaseType_t xQueueReset(QueueHandle_t q) { (void)q; q_head = 0; q_count = 0; return pdTRUE; }

void vTaskDelay(TickType_t ticks) { (void)ticks; }

BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack,
                       void *arg, uint32_t prio, TaskHandle_t *out)
{
    (void)fn; (void)name; (void)stack; (void)arg; (void)prio;
    if (out) {
        *out = NULL;
    }
    return pdPASS;   /* no scheduler; the tests step the poll pass themselves */
}

/* ---------------------------------------------------------------- harness */

#define POLL_PERIOD_US   10000    /* what button_poll_task() runs at */
#define DEBOUNCE_US     100000    /* must match button.c */
#define STALL_US        800000    /* the ROADMAP T8 acceptance figure */

/* One tap is a press held past debounce and a release held past debounce; the
 * debouncer cannot report faster than that, which is what bounds how many
 * events a stall can possibly have to hold. */
#define TAP_HOLD_US     (DEBOUNCE_US + 10000)
#define TAP_PERIOD_US   (2 * TAP_HOLD_US)

static void boot(void)
{
    fake_clock_reset();
    button__reset_static_state_for_test();
    for (int i = 0; i < 4; i++) {
        pin_level[i] = 1;
    }
    q_cap = q_head = q_count = 0;
    button_init();
}

/* Run the poll task's loop for a span of fake time without anyone reading the
 * queue. This is the stall. */
static void poll_for(int64_t us)
{
    for (int64_t t = 0; t < us; t += POLL_PERIOD_US) {
        button__poll_once_for_test();
        fake_clock_advance_us(POLL_PERIOD_US);
    }
}

/* Tap every button in `mask` (bit i = button index i) simultaneously. */
static void tap(unsigned mask)
{
    for (int i = 0; i < 4; i++) {
        if (mask & (1u << i)) {
            pin_level[i] = 0;
        }
    }
    poll_for(TAP_HOLD_US);

    for (int i = 0; i < 4; i++) {
        pin_level[i] = 1;
    }
    poll_for(TAP_HOLD_US);
}

/* Drain what the stalled UI task would eventually read, into `out`. */
static int drain(button_id_t *out, int max)
{
    int n = 0;
    button_event_t ev;
    while (n < max && xQueueReceive(button_get_queue(), &ev, 0) == pdTRUE) {
        out[n++] = ev.id;
    }
    return n;
}

/* ------------------------------------------------------------------ tests */

static void test_one_tap_is_one_event(void)
{
    printf("== a tap produces exactly one event\n");
    boot();

    tap(1u << 0);

    button_id_t got[8];
    int n = drain(got, 8);
    CHECK(n == 1, "one tap produced %d events", n);
    CHECK(n >= 1 && got[0] == BUTTON_K1, "tap on K1 reported %s",
          n >= 1 ? button_get_name(got[0]) : "nothing");
}

static void test_queue_holds_a_full_stall(void)
{
    printf("== queue is sized for an %d ms stall\n", (int)(STALL_US / 1000));

    /* Not a magic number: debounce is the floor on the interval between two
     * events from one button, and there are four buttons. */
    unsigned worst_case = 4 * (unsigned)(STALL_US / TAP_PERIOD_US);
    CHECK(button__queue_size_for_test() >= worst_case,
          "queue holds %u events, a full stall can produce %u",
          button__queue_size_for_test(), worst_case);
}

static void test_no_press_lost_across_a_stall(void)
{
    printf("== no press lost across an %d ms stall\n", (int)(STALL_US / 1000));
    boot();

    /* Four buttons tapped as fast as the debouncer can distinguish, for the
     * whole stall. Nothing reads the queue until it is over. */
    button_id_t want[64];
    int wanted = 0;
    int64_t start = esp_timer_get_time();

    while (esp_timer_get_time() - start + TAP_PERIOD_US <= STALL_US) {
        tap(0xF);
        want[wanted++] = BUTTON_K1;
        want[wanted++] = BUTTON_K2;
        want[wanted++] = BUTTON_K3;
        want[wanted++] = BUTTON_K4;
    }

    CHECK(esp_timer_get_time() - start >= STALL_US - TAP_PERIOD_US,
          "the stall was only %lld us", (long long)(esp_timer_get_time() - start));
    CHECK(wanted >= 12, "the stall only exercised %d presses", wanted);

    button_id_t got[64];
    int n = drain(got, 64);

    CHECK(n == wanted, "%d presses made, %d survived the stall", wanted, n);
    CHECK(button__overflow_count_for_test() == 0,
          "%lu presses were dropped during a stall the queue is sized for",
          (unsigned long)button__overflow_count_for_test());

    int mismatch = -1;
    for (int i = 0; i < n && i < wanted; i++) {
        if (got[i] != want[i]) {
            mismatch = i;
            break;
        }
    }
    CHECK(mismatch < 0, "event %d was %s, expected %s", mismatch,
          mismatch >= 0 ? button_get_name(got[mismatch]) : "-",
          mismatch >= 0 ? button_get_name(want[mismatch]) : "-");
}

static void test_overflow_keeps_the_newest_and_is_not_silent(void)
{
    printf("== beyond capacity, the newest press survives and is counted\n");
    boot();

    /* Deliberately past what the queue can hold - a stall far longer than the
     * budget. The policy under test: the oldest goes, never the press the user
     * just made, and the loss is counted rather than swallowed. */
    unsigned cap = button__queue_size_for_test();
    unsigned taps = cap + 5;

    for (unsigned i = 0; i < taps; i++) {
        tap(1u << 0);
    }
    tap(1u << 3);   /* the press the user is making right now */

    button_id_t got[256];
    int n = drain(got, 256);

    CHECK((unsigned)n == cap, "queue held %d events, capacity is %u", n, cap);
    CHECK(n >= 1 && got[n - 1] == BUTTON_K4,
          "the newest press was dropped instead of the oldest (last event %s)",
          n >= 1 ? button_get_name(got[n - 1]) : "none");
    CHECK(button__overflow_count_for_test() == taps + 1 - cap,
          "overflow went uncounted: %lu, expected %u",
          (unsigned long)button__overflow_count_for_test(), taps + 1 - cap);
}

int main(void)
{
    test_one_tap_is_one_event();
    test_queue_holds_a_full_stall();
    test_no_press_lost_across_a_stall();
    test_overflow_keeps_the_newest_and_is_not_silent();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
