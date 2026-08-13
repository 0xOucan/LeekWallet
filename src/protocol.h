/**
 * LeekWallet protocol endpoint - see protocol.c and docs/PROTOCOL.md.
 *
 * The command layer is transport-blind: USB and BLE both hand complete frames
 * to protocol_handle_frame() and both get their replies through the installed
 * writer. Only one transport is live at a time (PROTOCOL.md 3b), so there is
 * one writer, not a list.
 */

#ifndef LEEK_PROTOCOL_H
#define LEEK_PROTOCOL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Largest frame the device will assemble in either direction. */
#define PROTOCOL_MAX_FRAME 512

/** Install the USB-Serial-JTAG driver and start the listener task. */
void protocol_start(void);

/**
 * Handle one complete frame: len:u16 ‖ type ‖ body, big-endian, with no sync
 * marker and no chunk headers. Must be writable — encrypted bodies are
 * decrypted in place.
 */
void protocol_handle_frame(uint8_t *frame, size_t len);

/** Sink for outgoing frames, in the same marker-free form. */
typedef void (*ProtocolWriter)(const uint8_t *frame, size_t len);

/** Route replies elsewhere; NULL restores the USB endpoint. */
void protocol_set_writer(ProtocolWriter writer);

/** Forget any partially received frame, as a transport switch must. */
void protocol_reset_rx(void);

/**
 * Whether the USB port is an endpoint. Cleared while BLE is the selected
 * transport, so the cable is drained but never answered (PROTOCOL.md 3b).
 */
void protocol_set_rx_enabled(bool enabled);

#endif /* LEEK_PROTOCOL_H */
