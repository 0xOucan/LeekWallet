/* See qr-bench.h. */

#include "qr-bench.h"

#if LEEK_QR_BENCH

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"

#include "camera.h"

static const char *TAG = "qr-bench";

/*
 * How long each report covers. One second is long enough that a single slow
 * frame does not dominate the number and short enough that the operator sees
 * the effect of moving the phone while they are still moving it.
 */
#define WINDOW_US   1000000

/*
 * The number research/qr-spike could not produce.
 *
 * The spike measured quirc on a host and then modelled the device, because
 * QEMU emulates no image sensor and its wall-clock times are artefacts of TCG.
 * The one honest way to replace that model is to run the real pipeline on the
 * real board, so this loop calls camera_next_qr() - the same function the Scan
 * screen calls, unchanged, viewfinder and all - as fast as it will go, and
 * reports what came back.
 *
 * It deliberately does not build its own faster loop. A benchmark that
 * measures a path no user takes produces a number nobody gets.
 */
static void bench_task(void *arg)
{
    (void)arg;

    vTaskDelay(pdMS_TO_TICKS(1500));    /* let the boot log drain */

    ESP_LOGI(TAG, "starting; point the sensor at an animated ur:eth-sign-request");
    ESP_LOGI(TAG, "internal free %u, psram free %u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));

    if (!camera_start()) {
        ESP_LOGE(TAG, "camera did not start; nothing to measure");
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "after camera_start: internal free %u, psram free %u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));

    static char payload[1100];
    uint32_t last_frames = 0, last_decodes = 0;
    int64_t window_start = esp_timer_get_time();

    for (;;) {
        size_t len = 0;
        (void)camera_next_qr(payload, sizeof payload, &len);

        const int64_t now = esp_timer_get_time();
        const int64_t elapsed = now - window_start;
        if (elapsed < WINDOW_US) {
            continue;
        }

        uint32_t frames = 0, decodes = 0;
        camera_stats(&frames, &decodes);

        const double secs = (double)elapsed / 1000000.0;
        const double fps = (frames - last_frames) / secs;
        const double dps = (decodes - last_decodes) / secs;

        /* Frames per second is capture plus decode together, because that is
           what bounds the transfer; decodes per second is how many of those
           frames actually yielded a symbol, which is the miss rate budget.py
           has been guessing at. */
        ESP_LOGI(TAG, "%.1f frames/s  %.1f decodes/s  (%u frames, %u decodes, "
                      "stack headroom %u B)",
                 fps, dps, (unsigned)frames, (unsigned)decodes,
                 (unsigned)uxTaskGetStackHighWaterMark(NULL));

        last_frames = frames;
        last_decodes = decodes;
        window_start = now;
    }
}

void qr_bench_start(void)
{
    /*
     * 16 KB. quirc's buffers are heap, and camera.c keeps its 13 KB of
     * quirc_code and quirc_data static for exactly this reason, so what is
     * left on the stack is the driver's own call depth plus printf with
     * doubles. The task reports its own high-water mark every second, which is
     * how the number stops being a guess.
     */
    xTaskCreate(bench_task, "qr-bench", 16384, NULL, 4, NULL);
}

#endif /* LEEK_QR_BENCH */
