/**
 * Host stand-in for driver/usb_serial_jtag.h.
 *
 * Only the five entry points src/protocol.c names. The implementation is a
 * pair of in-memory FIFOs (fake_usb.c), which is enough to make the endpoint's
 * byte-level behaviour testable: a frame the device writes is bytes a test can
 * inspect, and a frame the test writes is bytes the device has to parse
 * without knowing they came from anywhere unusual.
 */

#ifndef SHIM_USB_SERIAL_JTAG_H
#define SHIM_USB_SERIAL_JTAG_H

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

typedef struct {
    uint32_t tx_buffer_size;
    uint32_t rx_buffer_size;
} usb_serial_jtag_driver_config_t;

#define USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT() \
    (usb_serial_jtag_driver_config_t){ .tx_buffer_size = 256, .rx_buffer_size = 256 }

esp_err_t usb_serial_jtag_driver_install(usb_serial_jtag_driver_config_t *config);
int  usb_serial_jtag_write_bytes(const void *src, size_t size, TickType_t ticks);
int  usb_serial_jtag_read_bytes(void *buf, size_t size, TickType_t ticks);
esp_err_t usb_serial_jtag_wait_tx_done(TickType_t ticks);

#endif /* SHIM_USB_SERIAL_JTAG_H */
