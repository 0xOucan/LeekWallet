/* See camera.h. */

#include "camera.h"

#include "board.h"

/*
 * LEEK_CAMERA_DRIVER is set by src/CMakeLists.txt, and only when the build was
 * configured with the camera components present. It is a separate question
 * from LEEK_HAS_CAMERA, which says what the *hardware* has: the QEMU target
 * for the CAM board has the pin map and no sensor behind it, so it wants the
 * board's pins and none of this driver. Defaulting it to 0 means a build that
 * never heard of it compiles the no-camera path rather than failing on an
 * undefined identifier.
 */
#ifndef LEEK_CAMERA_DRIVER
#  define LEEK_CAMERA_DRIVER 0
#endif

#if LEEK_CAMERA_DRIVER && !LEEK_HAS_CAMERA
#  error "camera driver requested on a board whose map has no sensor"
#endif

#if LEEK_CAMERA_DRIVER

#include <string.h>

#include "esp_camera.h"
#include "esp_log.h"

static const char *TAG = "camera";

/*
 * QVGA grayscale, which is what both halves of this file want.
 *
 * Grayscale rather than JPEG or RGB565 because quirc wants exactly one byte of
 * luminance per pixel: any other format would be captured and then converted,
 * paying for the conversion in the same CPU quirc is waiting for. QVGA rather
 * than VGA because quirc's cost is dominated by the identify stage and that
 * stage grows with pixel count, and because 320x240 is enough resolution to
 * read the QR versions a phone animates from a comfortable distance. If bench
 * numbers from the board say otherwise, this is the constant to move.
 */
#define FRAME_W     320
#define FRAME_H     240

static bool running;

static uint32_t stat_frames;
static uint32_t stat_decodes;

bool camera_start(void)
{
    if (running) {
        return true;
    }

    /*
     * Pins come from board.h and are not retyped here. The CAM board's map was
     * continuity-checked once (docs/BOARD-S3CAM-PINOUT.md); a second copy of
     * fifteen GPIO numbers is a second thing to get wrong, and the one that
     * disagreed would be this one.
     */
    const camera_config_t cfg = {
        .pin_pwdn       = PIN_CAM_PWDN,
        .pin_reset      = PIN_CAM_RESET,
        .pin_xclk       = PIN_CAM_XCLK,
        .pin_sccb_sda   = PIN_CAM_SIOD,
        .pin_sccb_scl   = PIN_CAM_SIOC,
        .pin_d7         = PIN_CAM_D7,
        .pin_d6         = PIN_CAM_D6,
        .pin_d5         = PIN_CAM_D5,
        .pin_d4         = PIN_CAM_D4,
        .pin_d3         = PIN_CAM_D3,
        .pin_d2         = PIN_CAM_D2,
        .pin_d1         = PIN_CAM_D1,
        .pin_d0         = PIN_CAM_D0,
        .pin_vsync      = PIN_CAM_VSYNC,
        .pin_href       = PIN_CAM_HREF,
        .pin_pclk       = PIN_CAM_PCLK,

        .xclk_freq_hz   = 20000000,
        .ledc_timer     = LEDC_TIMER_0,
        .ledc_channel   = LEDC_CHANNEL_0,

        .pixel_format   = PIXFORMAT_GRAYSCALE,
        .frame_size     = FRAMESIZE_QVGA,

        /* Two buffers and LATEST: the decoder wants the newest view of the
           companion's screen, not a queue of stale ones. A backlog would make
           every decoded fragment older than the frame being animated, which is
           exactly the wrong thing when the sender has already moved on. */
        .fb_count       = 2,
        .fb_location    = CAMERA_FB_IN_PSRAM,
        .grab_mode      = CAMERA_GRAB_LATEST,
    };

    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        /* Not fatal, and deliberately not an abort. A board with no ribbon
           seated, or none fitted at all, must still show a Scan screen that
           says so - see camera.h. */
        ESP_LOGE(TAG, "esp_camera_init: %s", esp_err_to_name(err));
        return false;
    }

    stat_frames = 0;
    stat_decodes = 0;
    running = true;
    ESP_LOGI(TAG, "camera up: %dx%d grayscale", FRAME_W, FRAME_H);
    return true;
}

void camera_stop(void)
{
    if (!running) {
        return;
    }
    running = false;
    esp_camera_deinit();
}

bool camera_next_qr(char *out, size_t out_size, size_t *out_len)
{
    (void)out;
    (void)out_size;
    (void)out_len;

    if (!running) {
        return false;
    }

    /* Capture only, for now: this commit brings the sensor up and proves
       frames arrive at the rate and in the format the decoder will want.
       quirc, and therefore an actual decoded string, is the next commit. */
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb == NULL) {
        return false;
    }
    stat_frames++;
    esp_camera_fb_return(fb);
    return false;
}

void camera_stats(uint32_t *frames, uint32_t *decodes)
{
    if (frames != NULL)  { *frames = stat_frames; }
    if (decodes != NULL) { *decodes = stat_decodes; }
}

#else /* !LEEK_CAMERA_DRIVER */

/*
 * No sensor on this board, or no driver in this build.
 *
 * The reference board and the Pixie have no camera at all. The QEMU target for
 * the CAM board has the pins and no silicon behind them - QEMU emulates no
 * image sensor - so it lands here too and its Scan screen says the camera did
 * not start, which is the truth there.
 */

bool camera_start(void) { return false; }
void camera_stop(void) { }

bool camera_next_qr(char *out, size_t out_size, size_t *out_len)
{
    (void)out;
    (void)out_size;
    (void)out_len;
    return false;
}

void camera_stats(uint32_t *frames, uint32_t *decodes)
{
    if (frames != NULL)  { *frames = 0; }
    if (decodes != NULL) { *decodes = 0; }
}

#endif
