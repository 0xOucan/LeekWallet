/**
 * Button queue and the FreeRTOS calls ui.c names, for host tests.
 *
 * Tests normally call ui_handle_button() directly - that is the whole point of
 * T0.2 - but ui.c still has to link, and button_drain() has observable meaning
 * (it is what stops presses made during a slow derivation from replaying).
 * So the queue is real, just single-threaded.
 */

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "button.h"

#include <string.h>

#define QUEUE_CAP 16

static button_event_t items[QUEUE_CAP];
static int head, count;
static int queue_token;   /* address handed out as the opaque handle */

void fake_input_reset(void)
{
    head = 0;
    count = 0;
    memset(items, 0, sizeof(items));
}

esp_err_t button_init(void)
{
    fake_input_reset();
    return ESP_OK;
}

QueueHandle_t button_get_queue(void) { return &queue_token; }

void button_drain(void) { head = 0; count = 0; }

const char *button_get_name(button_id_t id)
{
    switch (id) {
        case BUTTON_K1: return "K1";
        case BUTTON_K2: return "K2";
        case BUTTON_K3: return "K3";
        case BUTTON_K4: return "K4";
        default:        return "NONE";
    }
}

const char *button_get_action_name(button_id_t id)
{
    switch (id) {
        case BUTTON_UP:     return "UP";
        case BUTTON_DOWN:   return "DOWN";
        case BUTTON_CANCEL: return "CANCEL";
        case BUTTON_ACCEPT: return "ACCEPT";
        default:            return "NONE";
    }
}

/* Which button the test is holding down, if any. The real driver reads a
 * debounced GPIO level; a hold has no event of its own, so anything that polls
 * it needs this to be steerable. */
static button_id_t held_button = BUTTON_NONE;

void fake_button_hold(button_id_t id)  { held_button = id; }
void fake_button_release(void)         { held_button = BUTTON_NONE; }

bool button_is_pressed(button_id_t id) { return held_button == id; }

/* ------------------------------------------------------------- FreeRTOS */

QueueHandle_t xQueueCreate(uint32_t length, uint32_t item_size)
{
    (void)length;
    (void)item_size;
    return &queue_token;
}

BaseType_t xQueueSend(QueueHandle_t q, const void *item, TickType_t wait)
{
    (void)q;
    (void)wait;
    if (count >= QUEUE_CAP) {
        return pdFALSE;
    }
    items[(head + count) % QUEUE_CAP] = *(const button_event_t *)item;
    count++;
    return pdTRUE;
}

BaseType_t xQueueReceive(QueueHandle_t q, void *out, TickType_t wait)
{
    (void)q;
    (void)wait;
    if (count == 0) {
        return pdFALSE;   /* no scheduler to block on; report the timeout */
    }
    *(button_event_t *)out = items[head];
    head = (head + 1) % QUEUE_CAP;
    count--;
    return pdTRUE;
}

BaseType_t xQueueReset(QueueHandle_t q) { (void)q; button_drain(); return pdTRUE; }

void vTaskDelay(TickType_t ticks) { (void)ticks; }

BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack,
                       void *arg, uint32_t prio, TaskHandle_t *out)
{
    (void)fn; (void)name; (void)stack; (void)arg; (void)prio;
    if (out) {
        *out = NULL;
    }
    return pdPASS;
}
