#ifndef SHIM_FREERTOS_QUEUE_H
#define SHIM_FREERTOS_QUEUE_H

#include "freertos/FreeRTOS.h"

typedef void *QueueHandle_t;

QueueHandle_t xQueueCreate(uint32_t length, uint32_t item_size);
BaseType_t    xQueueSend(QueueHandle_t q, const void *item, TickType_t wait);
BaseType_t    xQueueReceive(QueueHandle_t q, void *out, TickType_t wait);
BaseType_t    xQueueReset(QueueHandle_t q);

#endif /* SHIM_FREERTOS_QUEUE_H */
