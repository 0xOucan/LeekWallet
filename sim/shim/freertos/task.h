#ifndef SHIM_FREERTOS_TASK_H
#define SHIM_FREERTOS_TASK_H

#include "freertos/FreeRTOS.h"

typedef void *TaskHandle_t;
typedef void (*TaskFunction_t)(void *);

void vTaskDelay(TickType_t ticks);
TickType_t xTaskGetTickCount(void);
BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack,
                       void *arg, uint32_t prio, TaskHandle_t *out);

/* The stack watch in protocol.c compiles here too, so the host build needs
 * these. It reports a generous margin rather than pretending to measure one:
 * a host thread's stack tells us nothing about the device's, and a stub that
 * invented a small number would fire a warning that means nothing. The check
 * this feeds is a device-side guard; the host build only has to not lie. */
static inline UBaseType_t uxTaskGetStackHighWaterMark(TaskHandle_t task)
{
    (void)task;
    return (UBaseType_t)0x7FFFFFFF;
}

static inline const char *pcTaskGetName(TaskHandle_t task)
{
    (void)task;
    return "host";
}

#endif /* SHIM_FREERTOS_TASK_H */
