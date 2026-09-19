/**
 * The camera, as far as the wallet needs one: a source of decoded QR strings.
 *
 * Behind this seam sit esp32-camera and quirc: an OV5640 captured at QVGA
 * grayscale into PSRAM, and quirc finding and decoding the symbol in the frame.
 * Everything above it - UR assembly, the EIP-4527 reader, signing - was written
 * and host-tested before any of it existed, which is why none of that had to
 * change when it landed.
 *
 * Only two boards in three have a sensor, and the QEMU target for the third has
 * the pins and no silicon, so every function here has a no-camera answer and
 * none of them is an error. A Scan screen on a board that cannot see says so.
 */

#ifndef LEEK_CAMERA_H
#define LEEK_CAMERA_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Power the sensor and start capturing. False on a board without one. */
bool camera_start(void);

/** Stop capturing and power the sensor down. Safe to call when stopped. */
void camera_stop(void);

/**
 * The next QR symbol decoded since the last call, as text, if there is one.
 * Never blocks: the scan screen calls this from the UI task's loop.
 */
bool camera_next_qr(char *out, size_t out_size, size_t *out_len);

/**
 * Frames captured and QR symbols decoded since camera_start().
 *
 * For the on-device decode-rate bench (research/qr-spike). Counted in the same
 * path the Scan screen uses, so the number measured is the number a user gets
 * rather than one from a loop written to look good.
 */
void camera_stats(uint32_t *frames, uint32_t *decodes);

#endif /* LEEK_CAMERA_H */
