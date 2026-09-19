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
#include "quirc.h"

#include "viewfinder.h"

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

/*
 * How often a captured frame is also turned into a preview.
 *
 * No frame is ever *spent* on the viewfinder: the preview is rendered from the
 * same frame that was just handed to quirc, so the decode loop never gives up
 * a capture for it. What it does cost is the downsample itself - 2 x 7168
 * sampled reads - on one frame in four. That ratio is here rather than inline
 * so it can be named in a test and moved with one edit if the bench says the
 * preview is measurably slowing the decode rate.
 */
#define PREVIEW_EVERY   4

static struct quirc *quirc_ctx;
static bool running;

/*
 * Static, not automatic. Together these are about 13 KB, and camera_next_qr()
 * is called from the UI task's loop; 13 KB of stack frame would overflow that
 * task and most others in this firmware. The bench in research/qr-spike puts
 * them on the stack because a host has megabytes of it.
 */
static struct quirc_code scan_code;
static struct quirc_data scan_data;

static uint8_t  preview[VIEWFINDER_BYTES];
static bool     preview_fresh;
static uint32_t preview_tick;

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

    quirc_ctx = quirc_new();
    if (quirc_ctx == NULL || quirc_resize(quirc_ctx, FRAME_W, FRAME_H) < 0) {
        /* quirc's image and pixel planes are 77 KB each and land in PSRAM.
           Failing here means PSRAM did not come up, which is worth a log of
           its own because everything else on this board still works. */
        ESP_LOGE(TAG, "quirc_resize failed; is PSRAM up?");
        quirc_destroy(quirc_ctx);
        quirc_ctx = NULL;
        esp_camera_deinit();
        return false;
    }

    preview_fresh = false;
    preview_tick = 0;
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
    quirc_destroy(quirc_ctx);
    quirc_ctx = NULL;
    preview_fresh = false;
    memset(preview, 0, sizeof preview);
}

bool camera_next_qr(char *out, size_t out_size, size_t *out_len)
{
    if (!running || out == NULL || out_size == 0) {
        return false;
    }

    camera_fb_t *fb = esp_camera_fb_get();
    if (fb == NULL) {
        return false;
    }
    stat_frames++;

    bool got = false;

    if (fb->format == PIXFORMAT_GRAYSCALE &&
        fb->width == FRAME_W && fb->height == FRAME_H) {

        if (++preview_tick % PREVIEW_EVERY == 0) {
            viewfinder_render(fb->buf, FRAME_W, FRAME_H, preview);
            preview_fresh = true;
        }

        /*
         * One copy, and it is not avoidable through quirc's public API: the
         * library owns its image plane, hands it out through quirc_begin() and
         * then overwrites it in place with the thresholded image during
         * identify. Pointing it at the driver's framebuffer would mean reaching
         * into quirc_internal.h and would also corrupt the buffer the driver is
         * about to reuse. 77 KB PSRAM to PSRAM is a small fraction of what the
         * identify stage on the very next line costs.
         */
        int w = 0, h = 0;
        uint8_t *img = quirc_begin(quirc_ctx, &w, &h);
        memcpy(img, fb->buf, (size_t)w * (size_t)h);
        quirc_end(quirc_ctx);

        const int n = quirc_count(quirc_ctx);
        for (int i = 0; i < n && !got; i++) {
            quirc_extract(quirc_ctx, i, &scan_code);
            if (quirc_decode(&scan_code, &scan_data) != QUIRC_SUCCESS) {
                continue;   /* blur, glare, a half-refreshed screen */
            }
            stat_decodes++;

            const size_t len = (size_t)scan_data.payload_len;

            /*
             * Anything that is not a UR is dropped here without a word. A
             * wallet pointed at the world sees Wi-Fi codes, URLs and product
             * labels, and none of them is a failure of anything - reporting
             * them upward would fill the status line with complaints about
             * whatever happened to be in frame. The decoder above is
             * case-insensitive about the scheme, so both spellings pass.
             */
            if (len < 3 || len + 1 > out_size ||
                (scan_data.payload[0] != 'u' && scan_data.payload[0] != 'U') ||
                (scan_data.payload[1] != 'r' && scan_data.payload[1] != 'R') ||
                scan_data.payload[2] != ':') {
                continue;
            }

            memcpy(out, scan_data.payload, len);
            out[len] = '\0';
            if (out_len != NULL) {
                *out_len = len;
            }
            got = true;
        }
    }

    esp_camera_fb_return(fb);
    return got;
}

const uint8_t *camera_preview_take(void)
{
    if (!preview_fresh) {
        return NULL;
    }
    preview_fresh = false;
    return preview;
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

const uint8_t *camera_preview_take(void) { return NULL; }

void camera_stats(uint32_t *frames, uint32_t *decodes)
{
    if (frames != NULL)  { *frames = 0; }
    if (decodes != NULL) { *decodes = 0; }
}

#endif
