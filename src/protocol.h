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

/**
 * Refuse a complete request the transport could not hand over, in plaintext.
 *
 * For transports that queue rather than dispatch inline. Every complete frame
 * must produce a reply of some kind; a transport that drops one silently
 * disagrees with the cable, which is the class of bug this exists to prevent.
 */
void protocol_send_transport_busy(void);

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
bool protocol_rx_enabled(void);

/**
 * Tell the endpoint the user typed a passphrase on the device itself (T42).
 *
 * A host-supplied passphrase is scoped to the session that supplied it and is
 * dropped when that session ends. A passphrase entered on the device is not:
 * it belongs to the person holding the device, and a BLE disconnect must not
 * silently return them to the base wallet. This is how the endpoint learns
 * that whatever it applied earlier has been superseded by a passphrase it
 * has no claim over.
 */
void protocol_note_device_passphrase(void);

#endif /* LEEK_PROTOCOL_H */
