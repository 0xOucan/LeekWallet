/**
 * Test control surface for the in-memory USB-Serial-JTAG pipe. See fake_usb.c.
 */

#ifndef FAKE_USB_H
#define FAKE_USB_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Empty both directions and forget any installed driver. */
void fake_usb_reset(void);

/** Queue bytes as if the host had written them to the port. */
void fake_usb_host_write(const uint8_t *data, size_t len);

/** Everything the device has written since the last take, in order. */
size_t fake_usb_device_read(uint8_t *out, size_t max);

/** Bytes the device has written and nobody has taken yet. */
size_t fake_usb_pending(void);

/** True once protocol_start() has installed the driver. */
bool fake_usb_driver_installed(void);

#endif /* FAKE_USB_H */
