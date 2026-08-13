/**
 * Host stand-in for freertos/semphr.h.
 *
 * The derivation lock exists to stop the UI task preempting the protocol task.
 * Host tests are single-threaded, so a counter that always succeeds is not a
 * simplification that hides anything - there is no second task to exclude.
 */

#ifndef SHIM_SEMPHR_H
#define SHIM_SEMPHR_H

#include "freertos/FreeRTOS.h"

typedef void *SemaphoreHandle_t;

static inline SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void)
{
    static int lock;
    return &lock;
}

static inline BaseType_t xSemaphoreTakeRecursive(SemaphoreHandle_t h, TickType_t t)
{
    (void)h; (void)t;
    return pdTRUE;
}

static inline BaseType_t xSemaphoreGiveRecursive(SemaphoreHandle_t h)
{
    (void)h;
    return pdTRUE;
}

#endif /* SHIM_SEMPHR_H */
