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
#include "esp_camera_af.h"

#ifdef CONFIG_CAMERA_AF_SUPPORT
#  define CONFIG_CAMERA_AF_ENABLED 1
#else
#  define CONFIG_CAMERA_AF_ENABLED 0
#endif
#include "driver/gpio.h"
#include "esp_rom_sys.h"
#include "esp_log.h"
#include "esp_timer.h"
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
/*
 * VGA, not QVGA.
 *
 * The first bench frames settled this: at 320x240 a companion's request code
 * filled about 160 pixels, and with that many modules each one was barely two
 * camera pixels. quirc located nothing at all - not blur, simply not enough
 * pixels to see modules with. VGA doubles the linear resolution, so the same
 * distance gives four to six pixels per module.
 *
 * The cost is quirc's image plane and the decode, both four times larger:
 * about 1.2 MB of PSRAM against 8 MB, and fewer frames per second. Frames are
 * the cheaper thing to spend here, because a frame that cannot resolve a
 * module is worth nothing however many of them arrive.
 */
/*
 * Capture size, stepped with OK on the scan screen for bench comparison. VGA
 * is the default: with exposure -5 it read a whole send in two to three
 * seconds. Applied by restarting the camera.
 */
static const struct { uint16_t w, h; framesize_t size; } FRAME_MODES[] = {
    { 640, 480, FRAMESIZE_VGA  },
    { 800, 600, FRAMESIZE_SVGA },
    { 320, 240, FRAMESIZE_QVGA },
};
#define FRAME_MODE_COUNT (sizeof FRAME_MODES / sizeof FRAME_MODES[0])
#if defined(CAMERA_FORCE_QVGA) && CAMERA_FORCE_QVGA
static uint8_t frame_mode = 2;
#else
static uint8_t frame_mode = 0;
#endif
#define FRAME_W     (FRAME_MODES[frame_mode].w)
#define FRAME_H     (FRAME_MODES[frame_mode].h)
#define FRAME_SIZE  (FRAME_MODES[frame_mode].size)

/*
 * How often a captured frame is also turned into a preview.
 *
 * No frame is ever *spent* on the viewfinder: the preview is rendered from the
 * same frame that was just handed to quirc, so the decode loop never gives up
 * a capture for it. What it does cost is the downsample itself - 2 x 7168
 * sampled reads - on one frame in four. That ratio is here rather than inline
 * so it can be named in a test and moved with one edit if the bench says the
 * preview is measurably slowing the decode rate.
 *
 * Overridable from the build, and 0 turns the preview off entirely, so the
 * bench can answer "what does the viewfinder cost?" as a measurement rather
 * than an argument:
 *
 *   pio run -e esp32s3cam-bench                                  preview on
 *   pio run -e esp32s3cam-bench -a "--build-flag=-DCAMERA_PREVIEW_EVERY=0"
 *
 * Two runs, two frames/s numbers, and the difference is the answer.
 */
#ifndef CAMERA_PREVIEW_EVERY
#  define CAMERA_PREVIEW_EVERY   4
#endif

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
/* Codes quirc LOCATED but could not read. The difference between this and
   stat_decodes is the whole diagnosis on a bench: zero located means the code
   is too small, too dim or out of frame, while located-but-not-decoded means
   it is seen and the modules are not resolved - blur, glare, or a refresh
   caught mid-frame. */
static uint32_t stat_located;
/*
 * Bit 0 hmirror, bit 1 vflip. See camera.h: one of them alone mirrors the
 * image, which no decoder can read.
 *
 * 2 (vflip) is the unmirrored image on this module, confirmed on the bench
 * twice: codes decode with it and the first air-gapped signature was read at
 * it. 1 (hmirror) should in theory be the same image turned 180 degrees, but
 * on this sensor it showed a mirror image; the driver's bits do not map onto
 * the optics the way the names suggest. Change it only against the bench.
 */
static uint8_t orientation = 2;

/* -4 by default, stepped from the scan screen. -5 read fastest against a
   phone at half brightness, but at -5 the view went black within seconds
   of opening the scanner; -4 is the user's pick after bench testing. */
static int8_t exposure_bias = -4;

/*
 * Exposure stays automatic throughout; only its target is biased. Locking it
 * on the first decode froze the device: switching this sensor to manual
 * exposure applies the manual exposure registers, not the value automatic
 * exposure had just settled on, and what those held stretched each frame
 * until capture timed out.
 */

/* Live preview to the PC viewer, off until OK on the scan screen asks. */
static bool streaming;
/* The centre of the frame at native resolution: 103 KB of base64, which
   the cable carries a couple of times a second. */
#define STREAM_W          320
#define STREAM_H          240
#define STREAM_PERIOD_US  (400 * 1000)
static void emit_frame(const uint8_t *buf, unsigned w, unsigned x0, unsigned y0,
                       unsigned ow, unsigned oh, unsigned step);

/*
 * Free the camera's control bus before probing it.
 *
 * This board has no power-down or reset pin wired, so the OV5640 stays
 * powered through a chip reset, a flash or a panic. A reset that lands while
 * the sensor is mid-reply leaves it holding SDA low, waiting for clocks that
 * never come, and every probe after that fails: "No camera" until the board
 * is unplugged. The standard I2C recovery: clock SCL until the sensor lets go
 * of SDA (at most nine bits), then a STOP. Harmless on a healthy bus.
 * Returns whether SDA ended up released.
 */
static bool sccb_recover(void)
{
    const gpio_num_t sda = PIN_CAM_SIOD, scl = PIN_CAM_SIOC;
    const gpio_config_t io = {
        .pin_bit_mask = (1ULL << sda) | (1ULL << scl),
        .mode = GPIO_MODE_INPUT_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&io);
    gpio_set_level(sda, 1);
    gpio_set_level(scl, 1);
    esp_rom_delay_us(10);
    const int sda_before = gpio_get_level(sda), scl_before = gpio_get_level(scl);
    for (int i = 0; i < 9 && gpio_get_level(sda) == 0; i++) {
        gpio_set_level(scl, 0);
        esp_rom_delay_us(10);
        gpio_set_level(scl, 1);
        esp_rom_delay_us(10);
    }
    /* STOP: SDA rises while SCL is high. */
    gpio_set_level(sda, 0);
    esp_rom_delay_us(10);
    gpio_set_level(scl, 1);
    esp_rom_delay_us(10);
    gpio_set_level(sda, 1);
    esp_rom_delay_us(10);
    const bool ok = gpio_get_level(sda) == 1 && gpio_get_level(scl) == 1;
    ESP_LOGI(TAG, "sccb bus before probe: SDA %d SCL %d -> %s", sda_before,
             scl_before, ok ? "free" : "still held");
    gpio_reset_pin(sda);
    gpio_reset_pin(scl);
    return ok;
}

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
        .frame_size     = FRAME_SIZE,

        /* Two buffers and LATEST: the decoder wants the newest view of the
           companion's screen, not a queue of stale ones. A backlog would make
           every decoded fragment older than the frame being animated, which is
           exactly the wrong thing when the sender has already moved on. */
        .fb_count       = 2,
        .fb_location    = CAMERA_FB_IN_PSRAM,
        .grab_mode      = CAMERA_GRAB_LATEST,
    };

    sccb_recover();
    /* No retry. The bench case this was for had the bus free and a sensor
       that answered nothing at all, which only a power cycle clears; a
       second probe only doubled a 17 s freeze. */
    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        /* Not fatal, and deliberately not an abort. A board with no ribbon
           seated, or none fitted at all, must still show a Scan screen that
           says so - see camera.h. */
        ESP_LOGE(TAG, "esp_camera_init: %s", esp_err_to_name(err));
        return false;
    }

    /*
     * Mirror and flip, set rather than inherited.
     *
     * We took whatever the sensor powered up with, and OV5640 modules commonly
     * come up mirrored. A 180-degree rotation is harmless - the finder patterns
     * tell a decoder which way is up - but a MIRRORED code is not a QR code at
     * all, and quirc will never read one however sharp it is. That is a fault
     * with no symptom except silence, which is what the bench saw: a clear
     * picture on the panel and nothing ever decoded.
     *
     * Both off. What matters is that the count is even: both on is a rotation,
     * one on is a mirror. If the module is physically mounted upside down the
     * picture will be too, and that costs nothing.
     */
    camera_set_orientation(orientation);
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor != NULL) {
        /*
         * Expose for the screen, not for the room.
         *
         * The first VGA frames off this board were smeared into streaks: a
         * dark room, so automatic exposure held the shutter open, and a
         * handheld device turned that into motion blur across every frame.
         * quirc located nothing, and no amount of resolution fixes a smear.
         *
         * What this camera is always pointed at is a phone or a monitor, which
         * is far brighter than the room around it. Biasing exposure down lets
         * the screen land correctly exposed with a much shorter shutter, which
         * is what stops the blur; the room going dark around it costs nothing,
         * since nothing there needs reading. Gain control stays on to make up
         * the difference on dimmer screens. How far down is exposure_bias,
         * stepped from the scan screen.
         */
        if (sensor->set_gain_ctrl != NULL)     { sensor->set_gain_ctrl(sensor, 1); }
        if (sensor->set_exposure_ctrl != NULL) { sensor->set_exposure_ctrl(sensor, 1); }
        if (sensor->set_ae_level != NULL)      { sensor->set_ae_level(sensor, exposure_bias); }

        /*
         * A QR profile, not a photo profile: nothing here is looked at by a
         * person except through a 128x64 preview. Night mode off, because it
         * exists to choose long exposures. Gain capped at 4x, because gain
         * noise lands exactly on the module edges quirc thresholds. Contrast
         * up to separate black from white modules, a little sharpening and a
         * little denoise - more of either softens or haloes the edges. White
         * balance off: the frame is grayscale and one fewer automatic loop
         * moving the picture between frames is one fewer cause of a miss.
         */
        if (sensor->set_aec2 != NULL)          { sensor->set_aec2(sensor, 0); }
        if (sensor->set_gainceiling != NULL)   { sensor->set_gainceiling(sensor, GAINCEILING_4X); }
        if (sensor->set_contrast != NULL)      { sensor->set_contrast(sensor, 2); }
        if (sensor->set_sharpness != NULL)     { sensor->set_sharpness(sensor, 1); }
        if (sensor->set_denoise != NULL)       { sensor->set_denoise(sensor, 1); }
        if (sensor->set_bpc != NULL)           { sensor->set_bpc(sensor, 1); }
        if (sensor->set_wpc != NULL)           { sensor->set_wpc(sensor, 1); }
        if (sensor->set_raw_gma != NULL)       { sensor->set_raw_gma(sensor, 1); }
        if (sensor->set_lenc != NULL)          { sensor->set_lenc(sensor, 1); }
        if (sensor->set_whitebal != NULL)      { sensor->set_whitebal(sensor, 0); }
        if (sensor->set_awb_gain != NULL)      { sensor->set_awb_gain(sensor, 0); }

        /*
         * Autofocus, if this module has the motor for it.
         *
         * The lens otherwise stays wherever it powered up, which is not where
         * a QR held at arm's length is: the first sharp frames off this board
         * still had soft modules, greys where blacks should be. Continuous
         * mode, because the user moves the device until it reads and the lens
         * should follow rather than wait to be asked.
         */
        /* Guarded twice over: the call is compiled out unless the build asks
           for AF, because on a module with no focus motor it waited for a
           reply that never came and took camera start down with it. */
        if (CONFIG_CAMERA_AF_ENABLED && esp_camera_af_is_supported(sensor)) {
            const esp_camera_af_config_t af = {
                .mode = ESP_CAMERA_AF_MODE_AUTO,
                .step_size = 1,
                .range_min = 0,
                .range_max = 1023,
                .timeout_ms = 2000,
            };
            const esp_err_t af_err = esp_camera_af_init(sensor, &af);
            ESP_LOGI(TAG, "autofocus init: %s", esp_err_to_name(af_err));
        } else {
            ESP_LOGW(TAG, "this module has no autofocus; focus is fixed");
        }
        ESP_LOGI(TAG, "sensor 0x%04x, hmirror %d, vflip %d",
                 (unsigned)sensor->id.PID, sensor->status.hmirror,
                 sensor->status.vflip);
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
    stat_located = 0;
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
    streaming = false;
    /*
     * No software standby here, though the sensor runs warm. This board has
     * no power-down or reset pin wired, so the OV5640 stays powered through
     * a chip reset, and a sensor left in standby answered the next probe
     * with 0xffff: "No camera" until the board was unplugged.
     */
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

    /*
     * One line a second while scanning, so a bench session is diagnosable over
     * the cable without swapping in the benchmark image. `located` is the
     * useful number: none means the code is too small, too dim or out of
     * frame; located without decodes means it is seen and its modules are not
     * resolved. Nothing here is derived from a decoded payload.
     */
    /*
     * Optional: a frame every so often while scanning, without anyone pressing
     * anything. Off by default; built with -DCAMERA_AUTODUMP_MS=5000 for a
     * bench session, because pressing OK at the moment somebody on the other
     * end of the cable happens to be listening is a coordination problem that
     * wasted several attempts.
     */
#if defined(CAMERA_AUTODUMP_MS) && CAMERA_AUTODUMP_MS > 0
    {
        static int64_t last_dump_us;
        const int64_t now_us = esp_timer_get_time();
        if (now_us - last_dump_us > (int64_t)CAMERA_AUTODUMP_MS * 1000) {
            last_dump_us = now_us;
            esp_camera_fb_return(fb);
            camera_dump_frame();
            return false;
        }
    }
#endif

    {
        static int64_t last_log_us;
        const int64_t now_us = esp_timer_get_time();
        if (now_us - last_log_us > 1000000) {
            last_log_us = now_us;
            ESP_LOGI(TAG, "scanning: %u frames, %u located, %u decoded",
                     (unsigned)stat_frames, (unsigned)stat_located,
                     (unsigned)stat_decodes);
        }
    }

    bool got = false;

    if (fb->format == PIXFORMAT_GRAYSCALE &&
        fb->width == FRAME_W && fb->height == FRAME_H) {

        if (streaming) {
            static int64_t last_stream_us;
            const int64_t now_us = esp_timer_get_time();
            if (now_us - last_stream_us > STREAM_PERIOD_US) {
                last_stream_us = now_us;
                emit_frame(fb->buf, FRAME_W, (FRAME_W - STREAM_W) / 2,
                           (FRAME_H - STREAM_H) / 2, STREAM_W, STREAM_H, 1);
            }
        }

        if (CAMERA_PREVIEW_EVERY > 0 &&
            ++preview_tick % CAMERA_PREVIEW_EVERY == 0) {
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
        stat_located += (uint32_t)n;
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

void camera_set_orientation(uint8_t mode)
{
    orientation = (uint8_t)(mode & 0x03);
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor == NULL) {
        return;
    }
    if (sensor->set_hmirror != NULL) {
        sensor->set_hmirror(sensor, (orientation & 1) ? 1 : 0);
    }
    if (sensor->set_vflip != NULL) {
        sensor->set_vflip(sensor, (orientation & 2) ? 1 : 0);
    }
}

uint8_t camera_orientation(void) { return orientation; }

void camera_set_exposure_bias(int8_t level)
{
    exposure_bias = (int8_t)(level < -5 ? -5 : (level > 0 ? 0 : level));
    sensor_t *sensor = esp_camera_sensor_get();
    if (running && sensor != NULL && sensor->set_ae_level != NULL) {
        sensor->set_ae_level(sensor, exposure_bias);
    }
}

int8_t camera_exposure_bias(void) { return exposure_bias; }

uint16_t camera_frame_width(void) { return FRAME_W; }

void camera_next_frame_size(void)
{
    frame_mode = (uint8_t)((frame_mode + 1) % FRAME_MODE_COUNT);
    /* The driver fixes the frame size at init, so a change is a restart. */
    if (running) {
        camera_stop();
        camera_start();
    }
}



/*
 * One grayscale image over the console as base64 between FRAME markers: an
 * ow x oh window at (x0, y0) of a frame `w` pixels wide, taking every
 * `step`-th pixel. The full dump is the whole frame at step 1; the live
 * stream is the centre 320x240 at step 1, the decoder's own pixels, because a
 * downscaled stream looked blurred for reasons that were the stream's and not
 * the camera's.
 */
static void emit_frame(const uint8_t *buf, unsigned w, unsigned x0, unsigned y0,
                       unsigned ow, unsigned oh, unsigned step)
{
    static const char B64[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const size_t total = (size_t)ow * oh;

    printf("FRAME_BEGIN %u %u\n", ow, oh);
    /* 57 input bytes per line keeps each printed line under 80 characters,
       which is what a serial monitor and a log capture both handle without
       wrapping surprises. */
    const size_t CHUNK = 57;
    #define PX(k) buf[((size_t)y0 + ((k) / ow) * step) * w + x0 + ((k) % ow) * step]
    for (size_t i = 0; i < total; i += CHUNK) {
        char line[80];
        size_t o = 0;
        for (size_t j = i; j < i + CHUNK && j < total; j += 3) {
            const uint32_t a = PX(j);
            const uint32_t b = (j + 1 < total) ? PX(j + 1) : 0;
            const uint32_t c = (j + 2 < total) ? PX(j + 2) : 0;
            const uint32_t v = (a << 16) | (b << 8) | c;
            line[o++] = B64[(v >> 18) & 0x3F];
            line[o++] = B64[(v >> 12) & 0x3F];
            line[o++] = (j + 1 < total) ? B64[(v >> 6) & 0x3F] : '=';
            line[o++] = (j + 2 < total) ? B64[v & 0x3F] : '=';
        }
        line[o] = '\0';
        printf("%s\n", line);
    }
    #undef PX
    printf("FRAME_END\n");
}

void camera_dump_frame(void)
{
    if (!running) {
        return;
    }
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb == NULL || fb->format != PIXFORMAT_GRAYSCALE) {
        if (fb != NULL) { esp_camera_fb_return(fb); }
        return;
    }
    emit_frame(fb->buf, fb->width, 0, 0, fb->width, fb->height, 1);
    esp_camera_fb_return(fb);
}

void camera_set_stream(bool on) { streaming = on; }
bool camera_streaming(void) { return streaming; }

const uint8_t *camera_preview_take(void)
{
    if (!preview_fresh) {
        return NULL;
    }
    preview_fresh = false;
    return preview;
}

void camera_stats(uint32_t *frames, uint32_t *decodes, uint32_t *located)
{
    if (frames != NULL)  { *frames = stat_frames; }
    if (decodes != NULL) { *decodes = stat_decodes; }
    if (located != NULL) { *located = stat_located; }
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

void camera_set_orientation(uint8_t mode) { (void)mode; }
void camera_dump_frame(void) { }
uint8_t camera_orientation(void) { return 0; }
void camera_set_exposure_bias(int8_t level) { (void)level; }
int8_t camera_exposure_bias(void) { return 0; }
uint16_t camera_frame_width(void) { return 0; }
void camera_next_frame_size(void) { }
void camera_set_stream(bool on) { (void)on; }
bool camera_streaming(void) { return false; }

void camera_stats(uint32_t *frames, uint32_t *decodes, uint32_t *located)
{
    if (frames != NULL)  { *frames = 0; }
    if (decodes != NULL) { *decodes = 0; }
    if (located != NULL) { *located = 0; }
}

#endif
