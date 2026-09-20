/* See viewfinder.h. */

#include "viewfinder.h"

#include <string.h>

void viewfinder_render(const uint8_t *frame, uint16_t fw, uint16_t fh,
                       uint8_t *out)
{
    if (frame == NULL || out == NULL || fw == 0 || fh == 0) {
        return;
    }

    memset(out, 0, VIEWFINDER_BYTES);

    /*
     * Keep the camera's aspect ratio. Stretching 320x240 across 128x56 made a
     * square QR look like a wide rectangle, which is not merely ugly: the
     * preview exists so someone can judge whether the code fills the frame,
     * and a distorted preview answers that question wrongly. The image is
     * letterboxed instead - full height, its proper width, centred - and the
     * bars beside it stay dark.
     */
    uint16_t vw = (uint16_t)((uint32_t)VIEWFINDER_H * fw / fh);
    if (vw > VIEWFINDER_W) {
        vw = VIEWFINDER_W;
    }
    const uint16_t vx0 = (uint16_t)((VIEWFINDER_W - vw) / 2);

    /*
     * Two passes over the sampled pixels rather than one pass into a temporary
     * image. The temporary would be 7 KB of internal RAM held for the life of
     * the scan screen; the second pass costs 7168 more array reads, which is
     * noise beside the quirc decode that runs on the same frame. Memory on
     * this device is the scarcer of the two.
     */
    uint8_t lo = 0xFF, hi = 0x00;
    for (uint16_t y = 0; y < VIEWFINDER_H; y++) {
        const uint32_t sy = (uint32_t)y * fh / VIEWFINDER_H;
        const uint8_t *row = frame + sy * (uint32_t)fw;
        for (uint16_t x = 0; x < vw; x++) {
            const uint8_t v = row[(uint32_t)x * fw / vw];
            if (v < lo) { lo = v; }
            if (v > hi) { hi = v; }
        }
    }

    /*
     * A frame with no contrast at all - a lens cap, a white wall - has lo ==
     * hi. Leaving the panel blank there is the honest picture: there is
     * nothing in view to aim at.
     */
    if (lo == hi) {
        return;
    }
    const uint8_t threshold = (uint8_t)(((uint16_t)lo + hi) / 2);

    for (uint16_t y = 0; y < VIEWFINDER_H; y++) {
        const uint32_t sy = (uint32_t)y * fh / VIEWFINDER_H;
        const uint8_t *row = frame + sy * (uint32_t)fw;
        uint8_t *page = out + (y / 8) * VIEWFINDER_W;
        const uint8_t bit = (uint8_t)(1u << (y % 8));
        for (uint16_t x = 0; x < vw; x++) {
            if (row[(uint32_t)x * fw / vw] > threshold) {
                page[vx0 + x] |= bit;
            }
        }
    }
}
