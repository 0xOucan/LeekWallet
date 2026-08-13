/**
 * LeekWallet Button Handler
 * Polling-based debounced button input
 */

#include "button.h"
#include <string.h>
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/task.h"

static const char *TAG = "button";

/* Button GPIO pins
 * K1 rewired from GPIO4 (stuck LOW) to GPIO10
 */
#define PIN_K1              GPIO_NUM_10
#define PIN_K2              GPIO_NUM_5
#define PIN_K3              GPIO_NUM_6
#define PIN_K4              GPIO_NUM_7

/* Debounce timing */
#define DEBOUNCE_TIME_US    100000  /* 100ms debounce */

/* Longest the UI task is expected to stop reading the queue: a PBKDF2 seed
 * derivation, which measures ~800 ms and blocks the task outright. */
#define STALL_BUDGET_US     800000

/* Sized so a stall of the full budget cannot overflow, rather than picked.
 * Debounce is the floor on how fast one button can produce events, so a button
 * yields at most STALL_BUDGET_US / DEBOUNCE_TIME_US events across the stall,
 * and there are four of them. The old value of 8 was under half of that. */
#define BUTTON_QUEUE_SIZE   (4 * (STALL_BUDGET_US / DEBOUNCE_TIME_US))

static QueueHandle_t button_queue = NULL;

/* Presses lost to a full queue. Should stay zero; if it does not, the sizing
 * assumption above is wrong and the log is the only trace of it. */
static uint32_t button_overflows = 0;

/**
 * Queue a press, making room if the queue is somehow full.
 *
 * The old code passed a zero timeout and ignored the result, so a full queue
 * silently discarded the NEWEST press - the worst of the choices. The user is
 * looking at the screen when they press; nothing happens; they press again,
 * and that repeat lands after the stall clears, on whatever screen came next.
 * In PIN entry or seed verification that is a mis-entry the user never sees.
 *
 * Blocking is not available either: this runs in the poll task, and blocking it
 * stops debouncing every other button for the length of the stall.
 *
 * So make room by dropping the OLDEST instead. It costs a press either way, but
 * the oldest event is the one most likely aimed at a screen that has since
 * changed - the same input button_drain() already discards on purpose - while
 * the newest is what the user is doing right now. And it is not silent: it
 * logs and counts.
 */
static void button_queue_press(const button_event_t *event)
{
    if (xQueueSend(button_queue, event, 0) == pdTRUE) {
        return;
    }

    button_event_t stale;
    if (xQueueReceive(button_queue, &stale, 0) == pdTRUE) {
        button_overflows++;
        ESP_LOGW(TAG, "queue full, dropped stale %s (total %lu)",
                 button_get_name(stale.id), (unsigned long)button_overflows);
    }

    if (xQueueSend(button_queue, event, 0) != pdTRUE) {
        button_overflows++;
        ESP_LOGW(TAG, "queue full, dropped %s (total %lu)",
                 button_get_name(event->id), (unsigned long)button_overflows);
    }
}

/* Button states for debounce */
static uint8_t button_state[4] = {1, 1, 1, 1};      /* Current debounced state (1=released) */
static uint8_t button_last_raw[4] = {1, 1, 1, 1};   /* Last raw reading */
static int64_t button_last_change[4] = {0, 0, 0, 0}; /* Time of last raw change */

/* GPIO to array index mapping */
static const gpio_num_t buttons[] = {PIN_K1, PIN_K2, PIN_K3, PIN_K4};
static const button_id_t button_ids[] = {BUTTON_K1, BUTTON_K2, BUTTON_K3, BUTTON_K4};

/**
 * One debounce pass over all four buttons. Split out of the task loop so host
 * tests can step it against a fake clock instead of a real 10 ms tick.
 */
static void button_poll_once(void)
{
    int64_t now = esp_timer_get_time();

    for (int i = 0; i < 4; i++) {
        uint8_t raw = gpio_get_level(buttons[i]);

        /* If raw state changed, record the time */
        if (raw != button_last_raw[i]) {
            button_last_raw[i] = raw;
            button_last_change[i] = now;
        }

        /* If raw state has been stable for debounce period */
        if ((now - button_last_change[i]) >= DEBOUNCE_TIME_US) {
            /* State change detected */
            if (raw != button_state[i]) {
                button_state[i] = raw;

                /* Button pressed (active low: 0 = pressed) */
                if (raw == 0) {
                    button_event_t event = {
                        .id = button_ids[i],
                        .timestamp = now,
                    };
                    button_queue_press(&event);
                }
            }
        }
    }
}

/**
 * Polling-based button task - more reliable than interrupts for noisy buttons
 */
static void button_poll_task(void *pvParameters)
{
    ESP_LOGI(TAG, "Button poll task started");

    while (1) {
        button_poll_once();

        /* Poll every 10ms */
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

esp_err_t button_init(void)
{
    /* Create event queue */
    button_queue = xQueueCreate(BUTTON_QUEUE_SIZE, sizeof(button_event_t));
    if (button_queue == NULL) {
        ESP_LOGE(TAG, "Failed to create button queue");
        return ESP_ERR_NO_MEM;
    }

    /* Configure all button GPIOs - polling mode, no interrupts */
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << PIN_K1) | (1ULL << PIN_K2) |
                        (1ULL << PIN_K3) | (1ULL << PIN_K4),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,  /* No interrupts - use polling */
    };

    esp_err_t err = gpio_config(&io_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "GPIO config failed: %s", esp_err_to_name(err));
        return err;
    }

    /* Start button polling task */
    BaseType_t ret = xTaskCreate(
        button_poll_task,
        "btn_poll",
        2048,
        NULL,
        6,  /* Higher priority than UI task */
        NULL
    );

    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create button poll task");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Buttons initialized (polling): K1=%d, K2=%d, K3=%d, K4=%d",
             PIN_K1, PIN_K2, PIN_K3, PIN_K4);
    return ESP_OK;
}

QueueHandle_t button_get_queue(void)
{
    return button_queue;
}

void button_drain(void)
{
    if (button_queue) {
        xQueueReset(button_queue);
    }
}

const char *button_get_name(button_id_t id)
{
    switch (id) {
        case BUTTON_K1: return "K1";
        case BUTTON_K2: return "K2";
        case BUTTON_K3: return "K3";
        case BUTTON_K4: return "K4";
        default:        return "??";
    }
}

const char *button_get_action_name(button_id_t id)
{
    switch (id) {
        case BUTTON_K1: return "UP";
        case BUTTON_K2: return "DOWN";
        case BUTTON_K3: return "CANCEL";
        case BUTTON_K4: return "ACCEPT";
        default:        return "??";
    }
}

bool button_is_pressed(button_id_t id)
{
    int idx = -1;
    switch (id) {
        case BUTTON_K1: idx = 0; break;
        case BUTTON_K2: idx = 1; break;
        case BUTTON_K3: idx = 2; break;
        case BUTTON_K4: idx = 3; break;
        default: return false;
    }

    return (button_state[idx] == 0);
}

#ifdef LEEK_HOST_TEST
/* Host tests step the debounce pass themselves; there is no scheduler to run
 * the poll task, and the point of the exercise is to control when polls happen
 * relative to a stalled consumer. */
void button__poll_once_for_test(void)
{
    button_poll_once();
}

uint32_t button__overflow_count_for_test(void)
{
    return button_overflows;
}

unsigned button__queue_size_for_test(void)
{
    return BUTTON_QUEUE_SIZE;
}

void button__reset_static_state_for_test(void)
{
    for (int i = 0; i < 4; i++) {
        button_state[i] = 1;
        button_last_raw[i] = 1;
        button_last_change[i] = 0;
    }
    button_overflows = 0;
    button_queue = NULL;
}
#endif
