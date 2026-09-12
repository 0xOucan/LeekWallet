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

/**
 * Re-open the advertising window after it lapsed (see BLE_ADV_WINDOW_MS).
 *
 * The device stops advertising after two minutes with nobody connecting,
 * because the radio was the board's largest continuous draw and a wallet
 * nobody is pairing with has no reason to be discoverable. This re-opens it.
 *
 * Does nothing when it would be wrong to act: transport stopped, already
 * advertising, or a peer connected. Callers may therefore invoke it blindly.
 */
void ble_transport_advertise_again(void);

/** Whether the controller is advertising right now. Not the same as running. */
bool ble_transport_advertising(void);

/** True while the radio is up. False means not advertising, not connectable. */
bool ble_transport_running(void);

/**
 * Re-read the device name and put it back on air (T56).
 *
 * A rename has to reach both the GAP name and the scan response, and NimBLE
 * will not take new advertising data while advertising, so this stops and
 * restarts it. A no-op while the radio is down: the next start reads the name
 * anyway.
 */
void ble_transport_refresh_name(void);

/** ProtocolWriter: chunk one frame into notifications. */
void ble_transport_write_frame(const uint8_t *frame, size_t len);

#endif /* LEEK_BLE_H */
