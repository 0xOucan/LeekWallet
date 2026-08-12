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

/* Button event queue */
#define BUTTON_QUEUE_SIZE   8

static QueueHandle_t button_queue = NULL;

/* Button states for debounce */
static uint8_t button_state[4] = {1, 1, 1, 1};      /* Current debounced state (1=released) */
static uint8_t button_last_raw[4] = {1, 1, 1, 1};   /* Last raw reading */
static int64_t button_last_change[4] = {0, 0, 0, 0}; /* Time of last raw change */

/* GPIO to array index mapping */
static const gpio_num_t buttons[] = {PIN_K1, PIN_K2, PIN_K3, PIN_K4};
static const button_id_t button_ids[] = {BUTTON_K1, BUTTON_K2, BUTTON_K3, BUTTON_K4};

/**
 * Polling-based button task - more reliable than interrupts for noisy buttons
 */
static void button_poll_task(void *pvParameters)
{
    ESP_LOGI(TAG, "Button poll task started");

    while (1) {
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
                        xQueueSend(button_queue, &event, 0);
                    }
                }
            }
        }

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
