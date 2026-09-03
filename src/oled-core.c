/**
 * Everything about the screen that is not the screen.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 *
 * There are two panels now: an SSD1306 over I2C on the reference board, and an
 * ST7789 over SPI on the Firefly Pixie. Almost nothing about drawing differs
 * between them. The glyphs are the same glyphs, the 8x21 grid is the same grid,
 * the clip-at-the-right-edge rule is the same rule, and the QR renderer does
 * not care what it is eventually shown on.
 *
 * Only four things are actually panel-specific: bringing the bus up, pushing
 * the framebuffer out, contrast, and clearing the physical panel. Those live in
 * `oled.c` and `oled-pixie.c`. Everything else lives here and is compiled once.
 *
 * The alternative was to copy this into the second driver, and the reason not
 * to is not tidiness: two copies of `oled_draw_string_centered` would drift,
 * and the first symptom would be a wallet whose address is centred differently
 * depending on which board a user bought. The whole argument for the port is
 * that both boards show the same thing.
 *
 * ---------------------------------------------------------------------------
 * The contract with a transport
 *
 * This owns the framebuffer, laid out as the SSD1306 lays out its pages: one
 * byte per column per page, bit 0 the top row. A transport calls
 * `oled_core_framebuffer()` and sends or expands it. That layout is the
 * SSD1306's because it was here first, and it costs the ST7789 driver one shift
 * per pixel to read — a fair price for one buffer, one format, one truth about
 * what is on screen.
 */

#include "oled.h"
#include "oled-core.h"

#include <string.h>
#include "esp_log.h"
#include "qrcode.h"

static const char *TAG = "oled-core";

static const uint8_t font_5x7[][5] = {
    {0x00, 0x00, 0x00, 0x00, 0x00}, /* 32: space */
    {0x00, 0x00, 0x5F, 0x00, 0x00}, /* 33: ! */
    {0x00, 0x07, 0x00, 0x07, 0x00}, /* 34: " */
    {0x14, 0x7F, 0x14, 0x7F, 0x14}, /* 35: # */
    {0x24, 0x2A, 0x7F, 0x2A, 0x12}, /* 36: $ */
    {0x23, 0x13, 0x08, 0x64, 0x62}, /* 37: % */
    {0x36, 0x49, 0x55, 0x22, 0x50}, /* 38: & */
    {0x00, 0x05, 0x03, 0x00, 0x00}, /* 39: ' */
    {0x00, 0x1C, 0x22, 0x41, 0x00}, /* 40: ( */
    {0x00, 0x41, 0x22, 0x1C, 0x00}, /* 41: ) */
    {0x08, 0x2A, 0x1C, 0x2A, 0x08}, /* 42: * */
    {0x08, 0x08, 0x3E, 0x08, 0x08}, /* 43: + */
    {0x00, 0x50, 0x30, 0x00, 0x00}, /* 44: , */
    {0x08, 0x08, 0x08, 0x08, 0x08}, /* 45: - */
    {0x00, 0x60, 0x60, 0x00, 0x00}, /* 46: . */
    {0x20, 0x10, 0x08, 0x04, 0x02}, /* 47: / */
    {0x3E, 0x51, 0x49, 0x45, 0x3E}, /* 48: 0 */
    {0x00, 0x42, 0x7F, 0x40, 0x00}, /* 49: 1 */
    {0x42, 0x61, 0x51, 0x49, 0x46}, /* 50: 2 */
    {0x21, 0x41, 0x45, 0x4B, 0x31}, /* 51: 3 */
    {0x18, 0x14, 0x12, 0x7F, 0x10}, /* 52: 4 */
    {0x27, 0x45, 0x45, 0x45, 0x39}, /* 53: 5 */
    {0x3C, 0x4A, 0x49, 0x49, 0x30}, /* 54: 6 */
    {0x01, 0x71, 0x09, 0x05, 0x03}, /* 55: 7 */
    {0x36, 0x49, 0x49, 0x49, 0x36}, /* 56: 8 */
    {0x06, 0x49, 0x49, 0x29, 0x1E}, /* 57: 9 */
    {0x00, 0x36, 0x36, 0x00, 0x00}, /* 58: : */
    {0x00, 0x56, 0x36, 0x00, 0x00}, /* 59: ; */
    {0x00, 0x08, 0x14, 0x22, 0x41}, /* 60: < */
    {0x14, 0x14, 0x14, 0x14, 0x14}, /* 61: = */
    {0x41, 0x22, 0x14, 0x08, 0x00}, /* 62: > */
    {0x02, 0x01, 0x51, 0x09, 0x06}, /* 63: ? */
    {0x32, 0x49, 0x79, 0x41, 0x3E}, /* 64: @ */
    {0x7E, 0x11, 0x11, 0x11, 0x7E}, /* 65: A */
    {0x7F, 0x49, 0x49, 0x49, 0x36}, /* 66: B */
    {0x3E, 0x41, 0x41, 0x41, 0x22}, /* 67: C */
    {0x7F, 0x41, 0x41, 0x22, 0x1C}, /* 68: D */
    {0x7F, 0x49, 0x49, 0x49, 0x41}, /* 69: E */
    {0x7F, 0x09, 0x09, 0x01, 0x01}, /* 70: F */
    {0x3E, 0x41, 0x41, 0x51, 0x32}, /* 71: G */
    {0x7F, 0x08, 0x08, 0x08, 0x7F}, /* 72: H */
    {0x00, 0x41, 0x7F, 0x41, 0x00}, /* 73: I */
    {0x20, 0x40, 0x41, 0x3F, 0x01}, /* 74: J */
    {0x7F, 0x08, 0x14, 0x22, 0x41}, /* 75: K */
    {0x7F, 0x40, 0x40, 0x40, 0x40}, /* 76: L */
    {0x7F, 0x02, 0x04, 0x02, 0x7F}, /* 77: M */
    {0x7F, 0x04, 0x08, 0x10, 0x7F}, /* 78: N */
    {0x3E, 0x41, 0x41, 0x41, 0x3E}, /* 79: O */
    {0x7F, 0x09, 0x09, 0x09, 0x06}, /* 80: P */
    {0x3E, 0x41, 0x51, 0x21, 0x5E}, /* 81: Q */
    {0x7F, 0x09, 0x19, 0x29, 0x46}, /* 82: R */
    {0x46, 0x49, 0x49, 0x49, 0x31}, /* 83: S */
    {0x01, 0x01, 0x7F, 0x01, 0x01}, /* 84: T */
    {0x3F, 0x40, 0x40, 0x40, 0x3F}, /* 85: U */
    {0x1F, 0x20, 0x40, 0x20, 0x1F}, /* 86: V */
    {0x7F, 0x20, 0x18, 0x20, 0x7F}, /* 87: W */
    {0x63, 0x14, 0x08, 0x14, 0x63}, /* 88: X */
    {0x03, 0x04, 0x78, 0x04, 0x03}, /* 89: Y */
    {0x61, 0x51, 0x49, 0x45, 0x43}, /* 90: Z */
    {0x00, 0x00, 0x7F, 0x41, 0x41}, /* 91: [ */
    {0x02, 0x04, 0x08, 0x10, 0x20}, /* 92: \ */
    {0x41, 0x41, 0x7F, 0x00, 0x00}, /* 93: ] */
    {0x04, 0x02, 0x01, 0x02, 0x04}, /* 94: ^ */
    {0x40, 0x40, 0x40, 0x40, 0x40}, /* 95: _ */
    {0x00, 0x01, 0x02, 0x04, 0x00}, /* 96: ` */
    {0x20, 0x54, 0x54, 0x54, 0x78}, /* 97: a */
    {0x7F, 0x48, 0x44, 0x44, 0x38}, /* 98: b */
    {0x38, 0x44, 0x44, 0x44, 0x20}, /* 99: c */
    {0x38, 0x44, 0x44, 0x48, 0x7F}, /* 100: d */
    {0x38, 0x54, 0x54, 0x54, 0x18}, /* 101: e */
    {0x08, 0x7E, 0x09, 0x01, 0x02}, /* 102: f */
    {0x08, 0x14, 0x54, 0x54, 0x3C}, /* 103: g */
    {0x7F, 0x08, 0x04, 0x04, 0x78}, /* 104: h */
    {0x00, 0x44, 0x7D, 0x40, 0x00}, /* 105: i */
    {0x20, 0x40, 0x44, 0x3D, 0x00}, /* 106: j */
    {0x00, 0x7F, 0x10, 0x28, 0x44}, /* 107: k */
    {0x00, 0x41, 0x7F, 0x40, 0x00}, /* 108: l */
    {0x7C, 0x04, 0x18, 0x04, 0x78}, /* 109: m */
    {0x7C, 0x08, 0x04, 0x04, 0x78}, /* 110: n */
    {0x38, 0x44, 0x44, 0x44, 0x38}, /* 111: o */
    {0x7C, 0x14, 0x14, 0x14, 0x08}, /* 112: p */
    {0x08, 0x14, 0x14, 0x18, 0x7C}, /* 113: q */
    {0x7C, 0x08, 0x04, 0x04, 0x08}, /* 114: r */
    {0x48, 0x54, 0x54, 0x54, 0x20}, /* 115: s */
    {0x04, 0x3F, 0x44, 0x40, 0x20}, /* 116: t */
    {0x3C, 0x40, 0x40, 0x20, 0x7C}, /* 117: u */
    {0x1C, 0x20, 0x40, 0x20, 0x1C}, /* 118: v */
    {0x3C, 0x40, 0x30, 0x40, 0x3C}, /* 119: w */
    {0x44, 0x28, 0x10, 0x28, 0x44}, /* 120: x */
    {0x0C, 0x50, 0x50, 0x50, 0x3C}, /* 121: y */
    {0x44, 0x64, 0x54, 0x4C, 0x44}, /* 122: z */
    {0x00, 0x08, 0x36, 0x41, 0x00}, /* 123: { */
    {0x00, 0x00, 0x7F, 0x00, 0x00}, /* 124: | */
    {0x00, 0x41, 0x36, 0x08, 0x00}, /* 125: } */
    {0x08, 0x04, 0x08, 0x10, 0x08}, /* 126: ~ */
};

static uint8_t framebuffer[OLED_WIDTH * OLED_PAGES];
static uint8_t cursor_page = 0;
static uint8_t cursor_col = 0;

uint8_t *oled_core_framebuffer(void) { return framebuffer; }

const uint8_t *font_5x7_glyph(char c)
{
    if (c < 32 || c > 126) { c = ' '; }
    return font_5x7[c - 32];
}

esp_err_t oled_clear(void)
{
    /* Clears the buffer, not the panel. The panel changes once, at flush. */
    memset(framebuffer, 0, sizeof(framebuffer));
    cursor_page = 0;
    cursor_col = 0;
    return ESP_OK;
}

esp_err_t oled_clear_page(uint8_t page)
{
    /* Clears the framebuffer row, not the panel.
     *
     * It used to push zeros straight down the I2C bus, which made it the one
     * drawing call with an immediate side effect and left the framebuffer
     * disagreeing with the glass until the next flush. Nothing calls it, so
     * nothing depended on that; and a driver that has to work for two very
     * different panels cannot have one function that writes to hardware behind
     * the others' backs. */
    if (page >= OLED_PAGES) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(&oled_core_framebuffer()[(size_t)page * OLED_WIDTH], 0x00, OLED_WIDTH);
    return ESP_OK;
}

esp_err_t oled_set_cursor(uint8_t page, uint8_t col)
{
    cursor_page = (page < OLED_PAGES) ? page : (uint8_t)(OLED_PAGES - 1);
    cursor_col = (col < OLED_WIDTH) ? col : (uint8_t)(OLED_WIDTH - 1);
    return ESP_OK;
}

esp_err_t oled_draw_char(char c)
{
    if (c < 32 || c > 126) {
        c = ' ';  /* Replace unprintable with space */
    }

    const uint8_t *glyph = font_5x7[c - 32];
    size_t base = (size_t)cursor_page * OLED_WIDTH;

    for (int i = 0; i < 6; i++) {
        if (cursor_col >= OLED_WIDTH) {
            break;   /* clip at the right edge rather than wrapping */
        }
        framebuffer[base + cursor_col] = (i < 5) ? glyph[i] : 0x00;
        cursor_col++;
    }

    return ESP_OK;
}

esp_err_t oled_draw_string(uint8_t page, uint8_t col, const char *str)
{
    oled_set_cursor(page, col);

    while (*str) {
        esp_err_t err = oled_draw_char(*str);
        if (err != ESP_OK) {
            return err;
        }
        str++;
    }

    return ESP_OK;
}

esp_err_t oled_draw_string_centered(uint8_t page, const char *str)
{
    size_t len = strlen(str);
    if (len > OLED_CHARS_PER_LINE) {
        len = OLED_CHARS_PER_LINE;
    }

    /* Each character is 6 pixels wide (5 + 1 spacing) */
    uint8_t text_width = len * 6;
    uint8_t col = (OLED_WIDTH - text_width) / 2;

    return oled_draw_string(page, col, str);
}

esp_err_t oled_invert_page(uint8_t page, bool invert)
{
    if (page >= OLED_PAGES) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Read not supported on SSD1306, so we just fill with pattern */
    uint8_t pattern = invert ? 0xFF : 0x00;
    return oled_fill_page(page, pattern);
}

esp_err_t oled_fill_page(uint8_t page, uint8_t pattern)
{
    if (page >= OLED_PAGES) {
        return ESP_ERR_INVALID_ARG;
    }

    /* The framebuffer, like every other drawing call here. This pushed to the
       bus directly before there were two panels; the render loop flushes at the
       end of a frame regardless, so the visible behaviour is unchanged and the
       framebuffer no longer disagrees with the glass in between. */
    memset(&oled_core_framebuffer()[(size_t)page * OLED_WIDTH], pattern, OLED_WIDTH);
    return ESP_OK;
}

/* Framebuffer for pixel-level operations */


esp_err_t oled_set_pixel(uint8_t x, uint8_t y, bool on)
{
    if (x >= OLED_WIDTH || y >= OLED_HEIGHT) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t page = y / 8;
    uint8_t bit = y % 8;
    uint16_t index = page * OLED_WIDTH + x;

    if (on) {
        framebuffer[index] |= (1 << bit);
    } else {
        framebuffer[index] &= ~(1 << bit);
    }

    return ESP_OK;
}

esp_err_t oled_draw_qrcode(const char *data)
{
    /*
     * QR Code requirements:
     * - ETH address: 42 chars (0x + 40 hex) requires byte mode
     * - Version 3 (29x29 modules) can hold 53 bytes with ECC_LOW
     * - QR scanners need DARK modules on LIGHT background
     * - Quiet zone (white border) is required
     */

    /* Try version 3 first (29x29), fallback to version 4 if needed */
    uint8_t qr_version = 3;
    uint8_t qr_buffer[qrcode_getBufferSize(4)];  /* Allocate for v4 max */
    QRCode qrcode;

    int result = qrcode_initText(&qrcode, qr_buffer, qr_version, ECC_LOW, data);
    if (result != 0) {
        /* Try version 4 (33x33 modules, 78 byte capacity) */
        qr_version = 4;
        result = qrcode_initText(&qrcode, qr_buffer, qr_version, ECC_LOW, data);
        if (result != 0) {
            ESP_LOGE(TAG, "QR code generation failed for: %s", data);
            return ESP_FAIL;
        }
    }

    uint8_t qr_size = qrcode.size;
    ESP_LOGI(TAG, "QR version %d, size %dx%d for %d chars",
             qr_version, qr_size, qr_size, strlen(data));

    /*
     * Calculate optimal scale:
     * - Display is 128x64 pixels
     * - Need at least 2px quiet zone on each side (4px total)
     * - Available: 64 - 4 = 60px height
     * - v3 (29 modules): scale 2 = 58px (fits)
     * - v4 (33 modules): scale 1 = 33px (fits but small)
     */
    uint8_t scale;
    if (qr_size <= 30) {
        scale = 2;  /* 2px per module for v3 and below */
    } else {
        scale = 1;  /* 1px per module for larger codes */
    }

    uint8_t total_size = qr_size * scale;
    uint8_t quiet_zone = 2;  /* 2px quiet zone */
    uint8_t total_with_quiet = total_size + quiet_zone * 2;

    /* Center on display */
    uint8_t offset_x = (OLED_WIDTH - total_with_quiet) / 2 + quiet_zone;
    uint8_t offset_y = (OLED_HEIGHT - total_with_quiet) / 2 + quiet_zone;

    /*
     * IMPORTANT: QR codes need dark modules on light background!
     * Fill framebuffer with WHITE (all 0xFF), then draw dark modules.
     */
    memset(framebuffer, 0xFF, sizeof(framebuffer));

    /* Draw QR code dark modules (turn pixels OFF) */
    for (uint8_t y = 0; y < qr_size; y++) {
        for (uint8_t x = 0; x < qr_size; x++) {
            if (qrcode_getModule(&qrcode, x, y)) {
                /* Dark module - turn pixels OFF (false) */
                for (uint8_t sy = 0; sy < scale; sy++) {
                    for (uint8_t sx = 0; sx < scale; sx++) {
                        uint8_t px = offset_x + x * scale + sx;
                        uint8_t py = offset_y + y * scale + sy;
                        if (px < OLED_WIDTH && py < OLED_HEIGHT) {
                            oled_set_pixel(px, py, false);
                        }
                    }
                }
            }
        }
    }

    return oled_refresh();
}
