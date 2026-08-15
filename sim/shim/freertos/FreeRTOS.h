/**
 * Host stand-in for freertos/FreeRTOS.h.
 *
 * Deliberately not a scheduler. Host tests call ui_handle_button() directly
 * instead of running ui_task(), so the only FreeRTOS surface that has to be
 * real is the handful of types and macros the firmware sources name at compile
 * time. Anything more would be a second implementation to keep honest.
 */

#ifndef SHIM_FREERTOS_H
#define SHIM_FREERTOS_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

typedef uint32_t TickType_t;
typedef int      BaseType_t;
typedef unsigned UBaseType_t;
typedef uintptr_t StackType_t;

#define pdTRUE   1
#define pdFALSE  0
#define pdPASS   1

#define portTICK_PERIOD_MS 1
#define portMAX_DELAY      ((TickType_t)0xFFFFFFFF)

#define pdMS_TO_TICKS(ms)  ((TickType_t)(ms))

#define configMINIMAL_STACK_SIZE 1024

#endif /* SHIM_FREERTOS_H */
