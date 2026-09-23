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
 * Mirror and flip, as bit 0 (hmirror) and bit 1 (vflip) of `mode`.
 *
 * Which combination shows the world the right way up depends on how the module
 * is mounted, and it is not a cosmetic question: a MIRRORED image is not a QR
 * code at all and will never decode, however sharp it is, while a 180-degree
 * rotation reads fine. Both bits set is a rotation; exactly one is a mirror.
 * Adjustable because the answer is a property of the board in someone's hand,
 * and a wrong guess here looks exactly like a camera that does not work.
 */
void camera_set_orientation(uint8_t mode);

/**
 * Print one raw frame over the console as base64, between FRAME markers.
 *
 * For judging focus, exposure and distance from the other end of the cable:
 * "nothing decodes" says nothing about why, and the panel's 1-bit preview
 * cannot show blur. Raw sensor pixels only, never anything decoded.
 */
void camera_dump_frame(void);

/**
 * Stream the centre 320x240 of the scanned frames at full resolution, about
 * two a second, in the same FRAME format, for a live view on the PC. Off whenever the camera
 * stops. Raw sensor pixels only, never anything decoded.
 */
void camera_set_stream(bool on);
bool camera_streaming(void);

/** The current mirror/flip bits. */
uint8_t camera_orientation(void);

/** Exposure bias, -5 (darkest) to 0; clamped. Default -4. Bench control. */
void camera_set_exposure_bias(int8_t level);
int8_t camera_exposure_bias(void);

/** Step the capture size QVGA -> VGA -> SVGA and (re)start the camera. */
bool camera_next_frame_size(void);
uint16_t camera_frame_width(void);

/**
 * The next QR symbol decoded since the last call, as text, if there is one.
 * Never blocks: the scan screen calls this from the UI task's loop.
 */
bool camera_next_qr(char *out, size_t out_size, size_t *out_len);

/**
 * The newest viewfinder bitmap, if one has been rendered since the last call.
 *
 * VIEWFINDER_BYTES of SSD1306 page layout, ready to blit; NULL when nothing is
 * new, so a caller that polls faster than frames arrive redraws nothing. It is
 * produced from raw sensor pixels and from nothing else: no decoded byte has a
 * path to the panel through here.
 */
const uint8_t *camera_preview_take(void);

/**
 * Frames captured and QR symbols decoded since camera_start().
 *
 * For the on-device decode-rate bench (research/qr-spike). Counted in the same
 * path the Scan screen uses, so the number measured is the number a user gets
 * rather than one from a loop written to look good.
 */
/**
 * Frames grabbed, codes decoded, and codes LOCATED but unreadable.
 *
 * The third is what makes a bench session diagnosable: none located means the
 * code is too small, too dim or out of frame; located without decodes means it
 * is seen but its modules are not resolved.
 */
void camera_stats(uint32_t *frames, uint32_t *decodes, uint32_t *located);

#endif /* LEEK_CAMERA_H */
