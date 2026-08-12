/**
 * LeekWallet OLED Driver
 * SSD1306 128x64 I2C display driver
 */

#ifndef OLED_H
#define OLED_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "esp_err.h"

/* Display dimensions */
#define OLED_WIDTH          128
#define OLED_HEIGHT         64
#define OLED_PAGES          (OLED_HEIGHT / 8)

/* Characters per line with 6-pixel width font */
#define OLED_CHARS_PER_LINE (OLED_WIDTH / 6)

/**
 * Initialize I2C bus for OLED communication
 * @return ESP_OK on success
 */
esp_err_t oled_i2c_init(void);

/**
 * Initialize SSD1306 display
 * Must call oled_i2c_init() first
 * @return ESP_OK on success
 */
esp_err_t oled_init(void);

/**
 * Clear entire display
 * @return ESP_OK on success
 */
esp_err_t oled_clear(void);

/**
 * Clear a single page (8-pixel row)
 * @param page Page number (0-7)
 * @return ESP_OK on success
 */
esp_err_t oled_clear_page(uint8_t page);

/**
 * Draw a single character at current cursor position
 * @param c Character to draw (ASCII 32-126)
 * @return ESP_OK on success
 */
esp_err_t oled_draw_char(char c);

/**
 * Draw a string at specified position
 * @param page Page number (0-7)
 * @param col Column position (0-127)
 * @param str Null-terminated string to draw
 * @return ESP_OK on success
 */
esp_err_t oled_draw_string(uint8_t page, uint8_t col, const char *str);

/**
 * Draw a string centered on a page
 * @param page Page number (0-7)
 * @param str Null-terminated string to draw
 * @return ESP_OK on success
 */
esp_err_t oled_draw_string_centered(uint8_t page, const char *str);

/**
 * Invert or un-invert a page (8-pixel row)
 * @param page Page number (0-7)
 * @param invert true to invert, false to normal
 * @return ESP_OK on success
 */
esp_err_t oled_invert_page(uint8_t page, bool invert);

/**
 * Set cursor position for subsequent drawing
 * @param page Page number (0-7)
 * @param col Column position (0-127)
 * @return ESP_OK on success
 */
esp_err_t oled_set_cursor(uint8_t page, uint8_t col);

/**
 * Draw raw data to display
 * @param data Pixel data bytes
 * @param len Number of bytes
 * @return ESP_OK on success
 */
esp_err_t oled_draw_raw(const uint8_t *data, size_t len);

/**
 * Fill a page with a pattern (useful for selection highlight)
 * @param page Page number (0-7)
 * @param pattern Byte pattern to fill
 * @return ESP_OK on success
 */
esp_err_t oled_fill_page(uint8_t page, uint8_t pattern);

/**
 * Draw a QR code centered on the display
 * @param data Data string to encode
 * @return ESP_OK on success
 */
esp_err_t oled_draw_qrcode(const char *data);

/**
 * Set a single pixel on the display
 * @param x X coordinate (0-127)
 * @param y Y coordinate (0-63)
 * @param on true for pixel on, false for off
 * @return ESP_OK on success
 */
esp_err_t oled_set_pixel(uint8_t x, uint8_t y, bool on);

/**
 * Refresh the display from framebuffer
 * @return ESP_OK on success
 */
esp_err_t oled_refresh(void);

#endif /* OLED_H */
