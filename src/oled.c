/**
 * LeekWallet OLED Driver
 * SSD1306 128x64 I2C display driver
 */

#include "oled.h"
#include "oled-core.h"
#include "board.h"
#include <string.h>
#include "driver/i2c.h"
#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "oled";

/* I2C Configuration */
/* See board.h. On a board with no I2C panel these are not merely unused, they
   belong to something else, so nothing here may initialise them. */
#define PIN_SDA             PIN_I2C_SDA
#define PIN_SCL             PIN_I2C_SCL
#define I2C_PORT            I2C_NUM_0
#define I2C_FREQ_HZ         400000

/* SSD1306 I2C address */
#define OLED_ADDR           0x3C

/* 5x7 font for basic ASCII (32-127), stored as columns */

/* ============================================================================
 * Low-level I2C/SSD1306 functions
 * ============================================================================ */

/*
 * Whether the panel is actually there.
 *
 * `ui_init()` runs whether or not a display was found — the UI task is what
 * drives the auto-lock timer, the hold-to-lock poll and the sign-expiry
 * service, none of which need a screen — so every redraw reaches this file
 * regardless. On a board with no I2C panel that produced two
 * `i2c driver not installed` errors per frame, which is a log nobody can read
 * and, worse, a log in which a real fault would be invisible.
 *
 * Guarded here rather than at the call sites because this is the one place
 * every byte to the panel passes through. Drawing into the framebuffer stays
 * legal and free; only talking to hardware that is not there is refused.
 */
static bool panel_ready = false;

static esp_err_t ssd1306_send_cmd(uint8_t cmd)
{
    if (!panel_ready) { return ESP_ERR_INVALID_STATE; }
    uint8_t buf[2] = {0x00, cmd};  /* Co=0, D/C#=0 (command) */
    return i2c_master_write_to_device(I2C_PORT, OLED_ADDR, buf, sizeof(buf),
                                      pdMS_TO_TICKS(100));
}

static esp_err_t ssd1306_send_data(const uint8_t *data, size_t len)
{
    if (!panel_ready) { return ESP_ERR_INVALID_STATE; }
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
    /* Opened before the sequence below, because that sequence goes through the
       same guarded path. Closed again on any failure, so a panel that did not
       answer cannot leave the driver believing it is there. */
    panel_ready = true;

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
            panel_ready = false;
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
/* Owned by oled-core.c now; this file only sends it. */
#define framebuffer (oled_core_framebuffer())
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
    /* The explicit size, never sizeof.
     *
     * `framebuffer` here is a macro that calls oled_core_framebuffer(), so
     * sizeof() measures a POINTER -- four bytes -- and this sent four bytes of
     * a 1024-byte frame. The panel kept whatever was in the rest of its GDDRAM,
     * which is what a screen full of stale pixels looks like. The array lives
     * in oled-core.c now and this file cannot see its extent, so the extent has
     * to be named. */
    return ssd1306_send_data(framebuffer, (size_t)OLED_WIDTH * OLED_PAGES);
}

esp_err_t oled_set_contrast(uint8_t level)
{
    ssd1306_send_cmd(0x81);      /* Set Contrast Control */
    ssd1306_send_cmd(level);
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







esp_err_t oled_draw_raw(const uint8_t *data, size_t len)
{
    return ssd1306_send_data(data, len);
}



esp_err_t oled_refresh(void)
{
    ssd1306_send_cmd(0x21);  /* Set column address */
    ssd1306_send_cmd(0x00);  /* Start column 0 */
    ssd1306_send_cmd(0x7F);  /* End column 127 */
    ssd1306_send_cmd(0x22);  /* Set page address */
    ssd1306_send_cmd(0x00);  /* Start page 0 */
    ssd1306_send_cmd(0x07);  /* End page 7 */

    /* Explicit, for the reason given in oled_flush(). */
    return ssd1306_send_data(framebuffer, (size_t)OLED_WIDTH * OLED_PAGES);
}


