/**
 * The QR entrance, from scanned strings to a signature ready to show.
 *
 *   camera strings ─► airgap_scan_feed ─► ur-decoder ─► eip4527 reader
 *                                                          │
 *                         worker task ◄── airgap_submit ◄──┘
 *                              │
 *                   protocol_airgap_sign  (the same path as USB)
 *                              │
 *                   eip4527_encode_signature ─► airgap_poll ─► SCREEN_QR_OUT
 *
 * ---------------------------------------------------------------------------
 * Why a worker task
 *
 * Signing waits for the user, up to two minutes, and the UI task is the one
 * that has to draw the question and read the buttons. So the scan screen
 * hands the decoded request over and goes back to its loop; the worker blocks
 * in protocol.c exactly as the USB task does, and the UI picks the result up
 * with airgap_poll() from a service in its loop. On the host there is no
 * scheduler, so the worker's body runs inline in airgap_submit(); the code it
 * runs is the same.
 *
 * ---------------------------------------------------------------------------
 * What a scan can do
 *
 * Only offer a sign request. The screen that asks is the same confirmation the
 * USB path uses, the answer is the user's, and nothing scanned is displayed
 * that the device did not derive from the signed bytes.
 */

#ifndef LEEK_AIRGAP_H
#define LEEK_AIRGAP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "eip4527.h"
#include "eip4527-encode.h"
#include "protocol.h"

typedef enum {
    AIRGAP_SCAN_ACCEPTED,      /* a part was taken; keep scanning */
    AIRGAP_SCAN_REDUNDANT,     /* a repeat; keep scanning */
    AIRGAP_SCAN_UNREADABLE,    /* not a UR part this assembly can use */
    AIRGAP_SCAN_WRONG_TYPE,    /* a complete UR, but not eth-sign-request */
    AIRGAP_SCAN_BAD_REQUEST,   /* the EIP-4527 reader refused it */
    AIRGAP_SCAN_BUSY,          /* a request is already being signed */
    AIRGAP_SCAN_SUBMITTED,     /* complete and handed to the worker */
} AirgapScan;

typedef enum {
    AIRGAP_IDLE,
    AIRGAP_WORKING,
    AIRGAP_DONE,       /* a signature UR body is ready */
    AIRGAP_FAILED,     /* refused; see the TxSignResult */
} AirgapState;

/** Start the worker. Once, at boot, on a board with a camera. */
void airgap_start(void);

/** Forget any partial assembly. The scan screen calls this on entry. */
void airgap_scan_reset(void);

/** Feed one decoded QR string. UI task only. */
AirgapScan airgap_scan_feed(const char *ur, size_t len);

/** Parts still missing from the current assembly, for a progress line. */
uint32_t airgap_scan_remaining(void);

/**
 * Hand a decoded request to the worker. The request is copied. False if one
 * is already in progress.
 */
bool airgap_submit(const E4527SignRequest *req);

/**
 * The worker's state. On AIRGAP_DONE, `cbor`/`len` are the eth-signature
 * body, valid until airgap_acknowledge(). On AIRGAP_FAILED, `rc` says why.
 */
AirgapState airgap_poll(const uint8_t **cbor, size_t *len, TxSignResult *rc);

/** Take the result; zero it and return to idle. */
void airgap_acknowledge(void);

/**
 * The worker's body: sign `req` through protocol.c and encode the answer,
 * echoing the request id. Returns the body length, or 0 with `*rc` saying why.
 * Exposed so the host can drive it without a scheduler.
 */
size_t airgap_sign_and_encode(const E4527SignRequest *req,
                              uint8_t *out, size_t out_size, TxSignResult *rc);

/** Short, screen-sized words for a refusal. */
const char *airgap_refusal_text(TxSignResult rc);

#endif /* LEEK_AIRGAP_H */
