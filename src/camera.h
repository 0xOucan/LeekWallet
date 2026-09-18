/**
 * The camera, as far as the wallet needs one: a source of decoded QR strings.
 *
 * Everything the air gap does after a string arrives - UR assembly, the
 * EIP-4527 reader, signing - is host-tested. What is not written yet is
 * everything before it: OV5640 bring-up, frame capture into PSRAM, and quirc
 * finding and decoding the symbol (RESEARCH-AIRGAP-VAULT.md section 38, step 2,
 * which needs the board on the bench). This header is the seam that work will
 * fill, so the scan screen above it does not change when it lands.
 */

#ifndef LEEK_CAMERA_H
#define LEEK_CAMERA_H

#include <stdbool.h>
#include <stddef.h>

/** Power the sensor and start capturing. False on a board without one. */
bool camera_start(void);

/** Stop capturing and power the sensor down. Safe to call when stopped. */
void camera_stop(void);

/**
 * The next QR symbol decoded since the last call, as text, if there is one.
 * Never blocks: the scan screen calls this from the UI task's loop.
 */
bool camera_next_qr(char *out, size_t out_size, size_t *out_len);

#endif /* LEEK_CAMERA_H */
