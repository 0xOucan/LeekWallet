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

/* The air-gap entrance. Its real behaviour - every check, the owned slot, the
 * shared signing path - is test_protocol.c's; the UI suite only needs to see
 * what the screens do with each answer. */
static TxSignResult airgap_answer = TXSIGN_OK;
static int airgap_calls;

TxSignResult protocol_airgap_sign(const E4527SignRequest *req,
                                  uint8_t signature_out[65])
{
    airgap_calls++;
    if (airgap_answer != TXSIGN_OK) {
        return airgap_answer;
    }
    for (int i = 0; i < 65; i++) {
        signature_out[i] = (uint8_t)(req->sign_data[i % (req->sign_data_len ? req->sign_data_len : 1)] + i);
    }
    signature_out[64] = 1;
    return TXSIGN_OK;
}

void fake_protocol_airgap_answer(TxSignResult rc) { airgap_answer = rc; }
int  fake_protocol_airgap_calls(void) { return airgap_calls; }
