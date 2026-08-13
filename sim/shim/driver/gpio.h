/**
 * Host stand-in for driver/gpio.h.
 *
 * Only what src/button.c names: the pins it configures and the level reads the
 * debouncer runs on. The test drives the levels (see sim/test_button.c).
 */

#ifndef SHIM_DRIVER_GPIO_H
#define SHIM_DRIVER_GPIO_H

#include <stdint.h>
#include "esp_err.h"

typedef int gpio_num_t;

#define GPIO_NUM_5   5
#define GPIO_NUM_6   6
#define GPIO_NUM_7   7
#define GPIO_NUM_10  10

typedef enum {
    GPIO_MODE_INPUT,
    GPIO_MODE_OUTPUT,
} gpio_mode_t;

typedef enum { GPIO_PULLUP_DISABLE, GPIO_PULLUP_ENABLE } gpio_pullup_t;
typedef enum { GPIO_PULLDOWN_DISABLE, GPIO_PULLDOWN_ENABLE } gpio_pulldown_t;
typedef enum { GPIO_INTR_DISABLE } gpio_int_type_t;

typedef struct {
    uint64_t        pin_bit_mask;
    gpio_mode_t     mode;
    gpio_pullup_t   pull_up_en;
    gpio_pulldown_t pull_down_en;
    gpio_int_type_t intr_type;
} gpio_config_t;

esp_err_t gpio_config(const gpio_config_t *cfg);
int       gpio_get_level(gpio_num_t pin);

#endif /* SHIM_DRIVER_GPIO_H */
