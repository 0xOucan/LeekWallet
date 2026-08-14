/**
 * The protocol endpoint's control surface, without the endpoint.
 *
 * The UI suite exercises transport selection through the settings screen, and
 * transport.c legitimately reaches into protocol.c to detach the writer and
 * silence the cable. Linking the real protocol.c here would drag in the USB
 * pipe and a second wire protocol's worth of dependencies to prove that a menu
 * item flips a setting. The wire behaviour behind these calls is covered where
 * it belongs, in test_protocol.c.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

static bool rx_enabled = true;

void protocol_set_writer(ProtocolWriter writer) { (void)writer; }
void protocol_reset_rx(void) { }
void protocol_set_rx_enabled(bool enabled) { rx_enabled = enabled; }

/** For assertions: is the cable an endpoint right now? */
bool fake_protocol_rx_enabled(void) { return rx_enabled; }

/* Counted rather than ignored: "the device told the endpoint this passphrase
 * is not the host's" is a T42 invariant the UI suite has to be able to assert,
 * and the endpoint state it feeds lives in test_protocol.c. */
static int device_passphrase_notices = 0;

void protocol_note_device_passphrase(void) { device_passphrase_notices++; }

int fake_protocol_device_passphrase_notices(void) { return device_passphrase_notices; }
void fake_protocol_reset(void) { device_passphrase_notices = 0; }
