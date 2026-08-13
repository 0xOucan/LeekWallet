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
