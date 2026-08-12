/**
 * LeekWallet Button Handler
 * Polling-based debounced button input
 */

#ifndef BUTTON_H
#define BUTTON_H

#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

/**
 * Button identifiers
 * K1=UP, K2=DOWN, K3=CANCEL, K4=ACCEPT
 */
typedef enum {
    BUTTON_NONE = 0,
    BUTTON_K1,      /* UP */
    BUTTON_K2,      /* DOWN */
    BUTTON_K3,      /* CANCEL */
    BUTTON_K4       /* ACCEPT */
} button_id_t;

/* Semantic aliases for button functions */
#define BUTTON_UP       BUTTON_K1
#define BUTTON_DOWN     BUTTON_K2
#define BUTTON_CANCEL   BUTTON_K3
#define BUTTON_ACCEPT   BUTTON_K4

/**
 * Button event structure
 */
typedef struct {
    button_id_t id;
    int64_t timestamp;
} button_event_t;

/**
 * Initialize button subsystem
 * Creates event queue and starts polling task
 * @return ESP_OK on success
 */
esp_err_t button_init(void);

/**
 * Get the button event queue handle
 * Use xQueueReceive() to wait for button events
 * @return Queue handle, or NULL if not initialized
 */
QueueHandle_t button_get_queue(void);

/**
 * Get human-readable name of a button
 * @param id Button identifier
 * @return String name (e.g., "K1", "UP")
 */
const char *button_get_name(button_id_t id);

/**
 * Get semantic name of a button
 * @param id Button identifier
 * @return Semantic name (e.g., "UP", "CANCEL")
 */
const char *button_get_action_name(button_id_t id);

/**
 * Check if a button is currently pressed (raw state)
 * @param id Button identifier
 * @return true if pressed, false if released
 */
bool button_is_pressed(button_id_t id);

#endif /* BUTTON_H */
