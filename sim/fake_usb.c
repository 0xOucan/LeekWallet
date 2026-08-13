/**
 * In-memory stand-in for the ESP32-S3 USB-Serial-JTAG port.
 *
 * src/protocol.c is the only place the wire protocol actually exists on the
 * device, and until now it could only be executed on a board. Everything it
 * touches outside its own logic is these four calls, so replacing them with a
 * pair of byte FIFOs puts the real endpoint on the host, parsing the same
 * bytes a real host would send.
 *
 * Deliberately not a serial port: no timing, no partial-write failures, no
 * ordering surprises. Those belong to the cable. What this reproduces is the
 * only thing the parser can observe — that bytes arrive in chunks it does not
 * choose, which is why the read side hands out at most what was asked for and
 * a test can hand a frame over in pieces.
 */

#include "fake_usb.h"

#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "freertos/task.h"

#define PIPE_CAP 16384

static struct {
    uint8_t buf[PIPE_CAP];
    size_t  len;
} to_device, to_host;

static bool installed;

void fake_usb_reset(void)
{
    to_device.len = 0;
    to_host.len = 0;
    installed = false;
}

void fake_usb_host_write(const uint8_t *data, size_t len)
{
    if (to_device.len + len > PIPE_CAP) {
        return;         /* a test that overruns this is testing the fake */
    }
    memcpy(to_device.buf + to_device.len, data, len);
    to_device.len += len;
}

size_t fake_usb_device_read(uint8_t *out, size_t max)
{
    size_t n = to_host.len < max ? to_host.len : max;
    memcpy(out, to_host.buf, n);
    memmove(to_host.buf, to_host.buf + n, to_host.len - n);
    to_host.len -= n;
    return n;
}

size_t fake_usb_pending(void) { return to_host.len; }

bool fake_usb_driver_installed(void) { return installed; }

/* ------------------------------------------------- driver/usb_serial_jtag.h */

esp_err_t usb_serial_jtag_driver_install(usb_serial_jtag_driver_config_t *config)
{
    (void)config;
    installed = true;
    return ESP_OK;
}

int usb_serial_jtag_write_bytes(const void *src, size_t size, TickType_t ticks)
{
    (void)ticks;
    if (to_host.len + size > PIPE_CAP) {
        return 0;
    }
    memcpy(to_host.buf + to_host.len, src, size);
    to_host.len += size;
    return (int)size;
}

int usb_serial_jtag_read_bytes(void *buf, size_t size, TickType_t ticks)
{
    (void)ticks;
    size_t n = to_device.len < size ? to_device.len : size;
    memcpy(buf, to_device.buf, n);
    memmove(to_device.buf, to_device.buf + n, to_device.len - n);
    to_device.len -= n;
    return (int)n;
}

esp_err_t usb_serial_jtag_wait_tx_done(TickType_t ticks)
{
    (void)ticks;
    return ESP_OK;
}

/* ---------------------------------------------------------------- FreeRTOS */

/* protocol.c waits for the user with a tick-count deadline. The host has no
 * scheduler, so ticks advance only when something delays — which means a test
 * that never answers still reaches the timeout instead of spinning forever.
 * These live here rather than in fake_input.c so a protocol test does not have
 * to drag in the button queue. */
static TickType_t ticks_now;

TickType_t xTaskGetTickCount(void) { return ticks_now; }

void vTaskDelay(TickType_t ticks) { ticks_now += ticks ? ticks : 1; }

BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack,
                       void *arg, uint32_t prio, TaskHandle_t *out)
{
    (void)fn; (void)name; (void)stack; (void)arg; (void)prio;
    if (out) {
        *out = NULL;
    }
    return pdPASS;
}
