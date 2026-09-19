/**
 * The Scan screen's aiming aid: a camera frame reduced to the panel.
 *
 * Split out from camera.c because it is arithmetic over a byte buffer and
 * nothing else - no sensor, no driver, no ESP-IDF - so the host suite can
 * check that a bright rectangle in the frame lands in the right place on the
 * panel. That is the whole correctness question: a preview that mirrors or
 * rotates the view makes aiming worse than no preview at all, and only a test
 * catches it before a user does.
 *
 * It is deliberately incapable of showing anything but raw camera pixels.
 * Nothing decoded ever reaches this file, so the preview cannot become a way
 * for whoever controls the QR code to put text of their choosing on the
 * trusted display.
 */

#ifndef LEEK_VIEWFINDER_H
#define LEEK_VIEWFINDER_H

#include <stdint.h>

/*
 * The preview occupies the top seven pages; the eighth is left for the status
 * line, which is the only row on this screen the firmware writes words to.
 */
#define VIEWFINDER_W        128
#define VIEWFINDER_H        56
#define VIEWFINDER_BYTES    (VIEWFINDER_W * VIEWFINDER_H / 8)

/**
 * Reduce a grayscale frame to a 1-bit SSD1306 page bitmap.
 *
 * `out` is VIEWFINDER_BYTES laid out as the panel lays out its framebuffer:
 * one byte per 8-row column, page 0 first, bit 0 the topmost row. A pixel is
 * lit when the frame is brighter there than the midpoint of that frame's own
 * darkest and brightest sampled pixel - per frame, because any fixed threshold
 * is wrong under the next light source.
 *
 * Nearest-neighbour, no interpolation: 320/128 is 2.5 and 240/56 is 4.3, and
 * the user needs to see where the bright rectangle sits, not a photograph.
 */
void viewfinder_render(const uint8_t *frame, uint16_t fw, uint16_t fh,
                       uint8_t *out);

#endif /* LEEK_VIEWFINDER_H */
