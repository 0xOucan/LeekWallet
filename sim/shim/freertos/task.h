#ifndef SHIM_FREERTOS_TASK_H
#define SHIM_FREERTOS_TASK_H

#include "freertos/FreeRTOS.h"

typedef void *TaskHandle_t;
typedef void (*TaskFunction_t)(void *);

void vTaskDelay(TickType_t ticks);
TickType_t xTaskGetTickCount(void);
BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack,
                       void *arg, uint32_t prio, TaskHandle_t *out);

#endif /* SHIM_FREERTOS_TASK_H */
