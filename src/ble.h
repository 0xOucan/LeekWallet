/**
 * BLE GATT transport (ROADMAP T25).
 *
 * One service, two characteristics, and nothing above the chunking layer:
 *
 *   service  6c65656b-7761-6c6c-6574-000000000001
 *     write  6c65656b-7761-6c6c-6574-000000000002  host→device (Write / WNR)
 *     notify 6c65656b-7761-6c6c-6574-000000000003  device→host (Notify)
 *
 * Frames on this channel carry NO sync marker: unlike the USB port, this
 * channel is not shared with console output and GATT already delimits every
 * write. The bytes on the wire are exactly encodeFrame()'s, split by
 * chunkForBle(). See docs/PROTOCOL.md section 2.
 *
 * Started and stopped only by transport.c. Nothing else may bring the radio up,
 * because "BLE is off unless it is the selected transport" is only true if
 * there is one place that can turn it on.
 */

#ifndef LEEK_BLE_H
#define LEEK_BLE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Bring up the stack, register the service and start advertising. */
bool ble_transport_start(void);

/** Stop advertising, drop any connection, and shut the stack down. */
void ble_transport_stop(void);

/** True while the radio is up. False means not advertising, not connectable. */
bool ble_transport_running(void);

/** ProtocolWriter: chunk one frame into notifications. */
void ble_transport_write_frame(const uint8_t *frame, size_t len);

#endif /* LEEK_BLE_H */
