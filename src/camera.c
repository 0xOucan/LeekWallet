/* See camera.h. */

#include "camera.h"

#include "board.h"

#if LEEK_HAS_CAMERA

/*
 * ===========================================================================
 * STUB. No camera driver exists yet.
 *
 * The CAM board has an OV5640 wired as board.h describes, but bring-up needs
 * the hardware on the bench, and a driver written blind would be the one part
 * of this path that has never run. Until then the scan screen opens, says it
 * is scanning, and never receives a frame - which is exactly what a camera
 * pointed at nothing does, so nothing above this file has to special-case it.
 *
 * To fill in: esp32-camera (or a direct DVP driver) into a PSRAM frame buffer,
 * grayscale, quirc_decode(), and hand each decoded payload out here. The
 * research spike in research/qr-spike measured quirc on this silicon.
 * ===========================================================================
 */

bool camera_start(void)
{
    return true;    /* STUB: nothing to power up yet */
}

void camera_stop(void)
{
}

bool camera_next_qr(char *out, size_t out_size, size_t *out_len)
{
    (void)out;
    (void)out_size;
    (void)out_len;
    return false;   /* STUB: no frames until the driver exists */
}

#else /* !LEEK_HAS_CAMERA */

/* No sensor on this board. The scan screen is not reachable here either, but
   the functions exist so nothing has to be compiled conditionally above. */

bool camera_start(void) { return false; }
void camera_stop(void) { }

bool camera_next_qr(char *out, size_t out_size, size_t *out_len)
{
    (void)out;
    (void)out_size;
    (void)out_len;
    return false;
}

#endif
