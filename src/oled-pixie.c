/**
 * The ST7789 transport, for the Firefly Pixie.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it is not
 *
 * The panel-specific half of the display and nothing else: bus bring-up, the
 * flush, contrast, and clearing the glass. Every glyph, the 8x21 grid, the
 * clip-at-the-right-edge rule and the QR renderer live in `oled-core.c` and are
 * shared with the SSD1306 driver, so the two boards cannot drift into showing
 * different layouts. That sharing is the whole point: the argument for
 * supporting a second board is that it is the same wallet.
 *
 * ---------------------------------------------------------------------------
 * The geometry, which is the only interesting decision here
 *
 * The framebuffer is 128x64. The panel is 240x240. Those look awkward together
 * and are not:
 *
 *     240 / 128 = 1.875 exactly
 *
 * so the frame maps to 240x120 using the panel's full width, centred
 * vertically with 60 rows of black above and below. Sampling is done the other
 * way round — for each physical pixel, ask which logical one it came from —
 * with the scale as integer arithmetic:
 *
 *     logical_x = physical_x * 128 / 240
 *
 * which is exact, needs no floating point, and gives each glyph column two
 * physical pixels with the occasional one. That unevenness is what
 * non-integer scaling of a bitmap font looks like; the alternative, an honest
 * 1x, would put a 128x64 island in the middle of a 240x240 screen and waste
 * three quarters of the panel a user paid for.
 *
 * ---------------------------------------------------------------------------
 * Why a pull model, and why flush blocks
 *
 * `firefly-display` renders in fragments: it calls back for a slice at a time
 * rather than taking a whole frame, which is what keeps a 240x240 RGB565 panel
 * inside a part with 400 KB and no PSRAM — a full colour frame would be 115 KB.
 * `oled_flush()` drives that loop to completion so it means the same thing here
 * as on the reference board: the screen now shows what was drawn. Leaking the
 * fragment loop up into `ui.c` would make the port visible to code that has no
 * business knowing which panel it is talking to.
 */

#include "oled.h"
#include "oled-core.h"
#include "board.h"

#include <string.h>

#include "esp_log.h"
#include "firefly-display.h"

static const char *TAG = "oled-pixie";

#define PANEL_W   240
#define PANEL_H   240

/* 128 * 1.875 = 240 wide, 64 * 1.875 = 120 tall. */
#define DRAWN_H   (OLED_HEIGHT * PANEL_W / OLED_WIDTH)
#define ORIGIN_Y  ((PANEL_H - DRAWN_H) / 2)

/* The SSD1306's white is faintly blue, and matching it means a photograph of
   one board is recognisably the same device as the other. */
#define FG_565    0x8F7F
#define BG_565    0x0000

static FfxDisplayContext display = NULL;

/* --------------------------------------------------------------- fragment */

static void render_fragment(uint8_t *buffer, uint32_t y0, void *context)
{
    (void)context;
    uint16_t *px = (uint16_t *)buffer;
    const int w = FfxDisplayFragmentWidth;
    const int h = FfxDisplayFragmentHeight;
    const uint8_t *fb = oled_core_framebuffer();

    for (int fy = 0; fy < h; fy++) {
        const int py = (int)y0 + fy;
        const int ly = (py - ORIGIN_Y) * OLED_WIDTH / PANEL_W;
        const bool inside = (py >= ORIGIN_Y) && (ly >= 0) && (ly < OLED_HEIGHT);

        if (!inside) {
            /* Whole row is off the drawn area. Filling it directly skips
               128 divisions per fragment row for the sixty rows above and
               below the frame, which on a single-core part is not nothing. */
            for (int fx = 0; fx < w; fx++) { px[fy * w + fx] = BG_565; }
            continue;
        }

        const size_t page_base = (size_t)(ly / 8) * OLED_WIDTH;
        const uint8_t bit = (uint8_t)(1u << (ly % 8));

        for (int fx = 0; fx < w; fx++) {
            const int lx = fx * OLED_WIDTH / PANEL_W;
            px[fy * w + fx] = (fb[page_base + lx] & bit) ? FG_565 : BG_565;
        }
    }
}

/* -------------------------------------------------------------------- API */

esp_err_t oled_i2c_init(void)
{
    /* There is no I2C panel on this board, and the pins the SSD1306 driver
       would use belong to a button and the LED string. Succeeding here without
       touching anything keeps main() a single sequence rather than a pair of
       board-specific branches. */
    return ESP_OK;
}

esp_err_t oled_init(void)
{
    display = ffx_display_init(FfxDisplaySpiBus2, PIN_DISPLAY_DC,
                               PIN_DISPLAY_RESET,
                               FfxDisplayRotationRibbonRight,
                               render_fragment, NULL);
    if (display == NULL) {
        /* The driver allocates DMA-capable RAM and returns NULL when it
           cannot. Said out loud rather than swallowed: main() checks this, and
           a wallet with no screen must not reach the PIN prompt believing it
           has one. */
        ESP_LOGE(TAG, "ST7789 init failed (DMA allocation)");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "ST7789 %dx%d, frame %dx%d drawn at %dx%d",
             PANEL_W, PANEL_H, OLED_WIDTH, OLED_HEIGHT, PANEL_W, DRAWN_H);
    return ESP_OK;
}

esp_err_t oled_flush(void)
{
    if (display == NULL) { return ESP_ERR_INVALID_STATE; }
    /* Non-zero marks the last fragment. Driven to completion so that flush
       means here what it means on the SSD1306. */
    while (ffx_display_renderFragment(display) == 0) { }
    return ESP_OK;
}

esp_err_t oled_set_contrast(uint8_t level)
{
    /* An ST7789 has no contrast register. The setting is accepted and kept by
       ui.c either way, so a user's choice survives a reboot; wiring it to a
       backlight needs a pin the rev.5 map does not document, and inventing one
       would be worse than doing nothing. */
    (void)level;
    return ESP_OK;
}

esp_err_t oled_clear_panel_now(void)
{
    memset(oled_core_framebuffer(), 0, (size_t)OLED_WIDTH * OLED_PAGES);
    return oled_flush();
}

esp_err_t oled_draw_raw(const uint8_t *data, size_t len)
{
    /* Raw SSD1306 command bytes have no meaning on an ST7789, and guessing a
       translation would be worse than refusing. Nothing in the firmware calls
       this on a path the Pixie reaches. */
    (void)data; (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t oled_refresh(void)
{
    return oled_flush();
}
