/**
 * LeekWallet OLED Driver
 * SSD1306 128x64 I2C display driver
 */

#include "oled.h"
#include <string.h>
#include "driver/i2c.h"
#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "oled";

/* I2C Configuration */
#define PIN_SDA             GPIO_NUM_8
#define PIN_SCL             GPIO_NUM_9
#define I2C_PORT            I2C_NUM_0
#define I2C_FREQ_HZ         400000

/* SSD1306 I2C address */
#define OLED_ADDR           0x3C

/* 5x7 font for basic ASCII (32-127), stored as columns */
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

/* ============================================================================
 * Low-level I2C/SSD1306 functions
 * ============================================================================ */

static esp_err_t ssd1306_send_cmd(uint8_t cmd)
{
    uint8_t buf[2] = {0x00, cmd};  /* Co=0, D/C#=0 (command) */
    return i2c_master_write_to_device(I2C_PORT, OLED_ADDR, buf, sizeof(buf),
                                      pdMS_TO_TICKS(100));
}

static esp_err_t ssd1306_send_data(const uint8_t *data, size_t len)
{
    uint8_t buf[129];  /* 1 control byte + up to 128 data bytes */
    buf[0] = 0x40;     /* Co=0, D/C#=1 (data) */

    size_t offset = 0;
    while (offset < len) {
        size_t chunk = (len - offset > 128) ? 128 : (len - offset);
        memcpy(&buf[1], &data[offset], chunk);
        esp_err_t err = i2c_master_write_to_device(I2C_PORT, OLED_ADDR, buf,
                                                   chunk + 1, pdMS_TO_TICKS(100));
        if (err != ESP_OK) {
            return err;
        }
        offset += chunk;
    }
    return ESP_OK;
}

/* ============================================================================
 * Public API
 * ============================================================================ */

esp_err_t oled_i2c_init(void)
{
    i2c_config_t conf = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = PIN_SDA,
        .scl_io_num = PIN_SCL,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = I2C_FREQ_HZ,
    };

    esp_err_t err = i2c_param_config(I2C_PORT, &conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "I2C param config failed: %s", esp_err_to_name(err));
        return err;
    }

    err = i2c_driver_install(I2C_PORT, conf.mode, 0, 0, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "I2C driver install failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "I2C initialized: SDA=%d, SCL=%d, freq=%d Hz",
             PIN_SDA, PIN_SCL, I2C_FREQ_HZ);
    return ESP_OK;
}

esp_err_t oled_init(void)
{
    /* SSD1306 initialization sequence for 128x64 */
    const uint8_t init_cmds[] = {
        0xAE,       /* Display OFF */
        0xD5, 0x80, /* Set display clock divide ratio/oscillator frequency */
        0xA8, 0x3F, /* Set multiplex ratio (1 to 64) */
        0xD3, 0x00, /* Set display offset */
        0x40,       /* Set start line address */
        0x8D, 0x14, /* Enable charge pump */
        0x20, 0x00, /* Set memory addressing mode: horizontal */
        0xA1,       /* Set segment re-map (column address 127 mapped to SEG0) */
        0xC8,       /* Set COM output scan direction (remapped) */
        0xDA, 0x12, /* Set COM pins hardware configuration */
        0x81, 0xCF, /* Set contrast control */
        0xD9, 0xF1, /* Set pre-charge period */
        0xDB, 0x40, /* Set VCOMH deselect level */
        0xA4,       /* Entire display ON (resume to RAM content) */
        0xA6,       /* Set normal display (not inverted) */
        0xAF,       /* Display ON */
    };

    for (size_t i = 0; i < sizeof(init_cmds); i++) {
        esp_err_t err = ssd1306_send_cmd(init_cmds[i]);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "SSD1306 init cmd %02X failed", init_cmds[i]);
            return err;
        }
    }

    ESP_LOGI(TAG, "SSD1306 initialized: %dx%d @ 0x%02X", OLED_WIDTH, OLED_HEIGHT, OLED_ADDR);
    return ESP_OK;
}

/* Single frame buffer, pushed to the panel once per render.
 *
 * Text used to be written straight to the display: oled_clear() blanked the
 * panel over I2C and then every character was its own transaction. At 400 kHz
 * that is a visible blank-then-refill on each keypress, which reads as the
 * screen flickering. Nothing wrong with the hardware - the frame was simply
 * being composed in front of the user. */
static uint8_t framebuffer[OLED_WIDTH * OLED_PAGES];
static uint8_t cursor_page = 0;
static uint8_t cursor_col = 0;

esp_err_t oled_flush(void)
{
    ssd1306_send_cmd(0x21);
    ssd1306_send_cmd(0x00);
    ssd1306_send_cmd(OLED_WIDTH - 1);
    ssd1306_send_cmd(0x22);
    ssd1306_send_cmd(0x00);
    ssd1306_send_cmd(OLED_PAGES - 1);
    return ssd1306_send_data(framebuffer, sizeof(framebuffer));
}

esp_err_t oled_set_contrast(uint8_t level)
{
    ssd1306_send_cmd(0x81);      /* Set Contrast Control */
    ssd1306_send_cmd(level);
    return ESP_OK;
}

esp_err_t oled_clear(void)
{
    /* Clears the buffer, not the panel. The panel changes once, at flush. */
    memset(framebuffer, 0, sizeof(framebuffer));
    cursor_page = 0;
    cursor_col = 0;
    return ESP_OK;
}

esp_err_t oled_clear_panel_now(void)
{
    /* Set column and page address to cover entire display */
    ssd1306_send_cmd(0x21);  /* Set column address */
    ssd1306_send_cmd(0x00);  /* Start column 0 */
    ssd1306_send_cmd(0x7F);  /* End column 127 */
    ssd1306_send_cmd(0x22);  /* Set page address */
    ssd1306_send_cmd(0x00);  /* Start page 0 */
    ssd1306_send_cmd(0x07);  /* End page 7 */

    /* Send zeros to clear all pixels */
    uint8_t zeros[128];
    memset(zeros, 0x00, sizeof(zeros));

    for (int page = 0; page < OLED_PAGES; page++) {
        esp_err_t err = ssd1306_send_data(zeros, sizeof(zeros));
        if (err != ESP_OK) {
            return err;
        }
    }

    return ESP_OK;
}

esp_err_t oled_clear_page(uint8_t page)
{
    if (page >= OLED_PAGES) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t zeros[128];
    memset(zeros, 0x00, sizeof(zeros));
    oled_set_cursor(page, 0);
    return ssd1306_send_data(zeros, sizeof(zeros));
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

esp_err_t oled_draw_raw(const uint8_t *data, size_t len)
{
    return ssd1306_send_data(data, len);
}

esp_err_t oled_fill_page(uint8_t page, uint8_t pattern)
{
    if (page >= OLED_PAGES) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t fill[128];
    memset(fill, pattern, sizeof(fill));
    oled_set_cursor(page, 0);
    return ssd1306_send_data(fill, sizeof(fill));
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

esp_err_t oled_refresh(void)
{
    ssd1306_send_cmd(0x21);  /* Set column address */
    ssd1306_send_cmd(0x00);  /* Start column 0 */
    ssd1306_send_cmd(0x7F);  /* End column 127 */
    ssd1306_send_cmd(0x22);  /* Set page address */
    ssd1306_send_cmd(0x00);  /* Start page 0 */
    ssd1306_send_cmd(0x07);  /* End page 7 */

    return ssd1306_send_data(framebuffer, sizeof(framebuffer));
}

#include "qrcode.h"

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
