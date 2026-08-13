/**
 * src/oled.h implemented against RAM instead of I2C. See fake_oled.h.
 */

#include "fake_oled.h"
#include "oled.h"

#include <stdio.h>
#include <string.h>

static char    text[FAKE_OLED_ROWS][FAKE_OLED_COLS + 1];
static uint8_t fb[OLED_PAGES][OLED_WIDTH];   /* SSD1306 order: one byte = 8 rows */
static char    qr_data[256];
static int     flush_count;
static uint8_t contrast = 0;

static uint8_t cursor_page;
static uint8_t cursor_col;

/* Trimmed copies handed out by fake_oled_row(). Kept per row so a test can
 * hold two of them in one printf without them aliasing. */
static char trimmed[FAKE_OLED_ROWS][FAKE_OLED_COLS + 1];

static void blank_text(void)
{
    for (int p = 0; p < FAKE_OLED_ROWS; p++) {
        memset(text[p], ' ', FAKE_OLED_COLS);
        text[p][FAKE_OLED_COLS] = '\0';
    }
}

void fake_oled_reset(void)
{
    blank_text();
    memset(fb, 0, sizeof(fb));
    qr_data[0] = '\0';
    flush_count = 0;
    contrast = 0;
    cursor_page = 0;
    cursor_col = 0;
}

/* ------------------------------------------------------------ inspection */

const char *fake_oled_row(int page)
{
    if (page < 0 || page >= FAKE_OLED_ROWS) {
        return "";
    }
    memcpy(trimmed[page], text[page], FAKE_OLED_COLS + 1);
    for (int i = FAKE_OLED_COLS - 1; i >= 0 && trimmed[page][i] == ' '; i--) {
        trimmed[page][i] = '\0';
    }
    return trimmed[page];
}

bool fake_oled_row_contains(int page, const char *needle)
{
    return strstr(fake_oled_row(page), needle) != NULL;
}

int fake_oled_find_row(const char *needle)
{
    for (int p = 0; p < FAKE_OLED_ROWS; p++) {
        if (fake_oled_row_contains(p, needle)) {
            return p;
        }
    }
    return -1;
}

bool fake_oled_contains(const char *needle)
{
    return fake_oled_find_row(needle) >= 0;
}

const char *fake_oled_qr_data(void) { return qr_data; }
int         fake_oled_flush_count(void) { return flush_count; }
uint8_t     fake_oled_contrast(void) { return contrast; }

void fake_oled_dump(void)
{
    printf("    +---------------------+\n");
    for (int p = 0; p < FAKE_OLED_ROWS; p++) {
        printf("  %d |%-*s|\n", p, FAKE_OLED_COLS, fake_oled_row(p));
    }
    printf("    +---------------------+\n");
}

void fake_oled_dump_pixels(void)
{
    for (int y = 0; y < OLED_HEIGHT; y++) {
        for (int x = 0; x < OLED_WIDTH; x++) {
            putchar((fb[y / 8][x] >> (y % 8)) & 1 ? '#' : '.');
        }
        putchar('\n');
    }
}

/* ------------------------------------------------------------ oled.h API */

esp_err_t oled_i2c_init(void) { return ESP_OK; }

esp_err_t oled_init(void)
{
    fake_oled_reset();
    return ESP_OK;
}

esp_err_t oled_clear(void)
{
    blank_text();
    memset(fb, 0, sizeof(fb));
    cursor_page = 0;
    cursor_col = 0;
    return ESP_OK;
}

esp_err_t oled_flush(void)
{
    flush_count++;
    return ESP_OK;
}

esp_err_t oled_clear_panel_now(void) { return oled_clear(); }

esp_err_t oled_set_contrast(uint8_t level)
{
    contrast = level;
    return ESP_OK;
}

esp_err_t oled_clear_page(uint8_t page)
{
    if (page >= OLED_PAGES) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(text[page], ' ', FAKE_OLED_COLS);
    memset(fb[page], 0, OLED_WIDTH);
    return ESP_OK;
}

esp_err_t oled_set_cursor(uint8_t page, uint8_t col)
{
    if (page >= OLED_PAGES || col >= OLED_WIDTH) {
        return ESP_ERR_INVALID_ARG;
    }
    cursor_page = page;
    cursor_col = col;
    return ESP_OK;
}

esp_err_t oled_draw_char(char c)
{
    if (cursor_page < FAKE_OLED_ROWS) {
        int cell = cursor_col / 6;
        if (cell < FAKE_OLED_COLS) {
            text[cursor_page][cell] = c;
        }
    }
    /* The real driver wraps by advancing 6 px and stopping at the edge. */
    if (cursor_col + 6 < OLED_WIDTH) {
        cursor_col += 6;
    }
    return ESP_OK;
}

esp_err_t oled_draw_string(uint8_t page, uint8_t col, const char *str)
{
    if (page >= OLED_PAGES || !str) {
        return ESP_ERR_INVALID_ARG;
    }
    int cell = col / 6;
    for (; *str && cell < FAKE_OLED_COLS; str++, cell++) {
        text[page][cell] = *str;
    }
    return ESP_OK;
}

esp_err_t oled_draw_string_centered(uint8_t page, const char *str)
{
    if (!str) {
        return ESP_ERR_INVALID_ARG;
    }
    /* Same arithmetic as the driver, so a string that would be clipped on the
     * panel is clipped here too. */
    int len = (int)strlen(str);
    int col = (OLED_WIDTH - len * 6) / 2;
    if (col < 0) {
        col = 0;
    }
    return oled_draw_string(page, (uint8_t)col, str);
}

esp_err_t oled_invert_page(uint8_t page, bool invert)
{
    if (page >= OLED_PAGES) {
        return ESP_ERR_INVALID_ARG;
    }
    for (int x = 0; x < OLED_WIDTH; x++) {
        fb[page][x] = invert ? (uint8_t)~fb[page][x] : fb[page][x];
    }
    return ESP_OK;
}

esp_err_t oled_fill_page(uint8_t page, uint8_t pattern)
{
    if (page >= OLED_PAGES) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(fb[page], pattern, OLED_WIDTH);
    return ESP_OK;
}

esp_err_t oled_draw_raw(const uint8_t *data, size_t len)
{
    for (size_t i = 0; i < len && cursor_col < OLED_WIDTH; i++) {
        fb[cursor_page][cursor_col++] = data[i];
    }
    return ESP_OK;
}

esp_err_t oled_set_pixel(uint8_t x, uint8_t y, bool on)
{
    if (x >= OLED_WIDTH || y >= OLED_HEIGHT) {
        return ESP_ERR_INVALID_ARG;
    }
    if (on) {
        fb[y / 8][x] |= (uint8_t)(1u << (y % 8));
    } else {
        fb[y / 8][x] &= (uint8_t)~(1u << (y % 8));
    }
    return ESP_OK;
}

/* The QR encoder itself lives in qrcode.c and is tested on its own terms; what
 * the UI layer can get wrong is *which string* it asks for. Record that. */
esp_err_t oled_draw_qrcode(const char *data)
{
    if (!data) {
        return ESP_ERR_INVALID_ARG;
    }
    snprintf(qr_data, sizeof(qr_data), "%s", data);
    return ESP_OK;
}

esp_err_t oled_refresh(void) { return oled_flush(); }
