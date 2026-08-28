/**
 * Host stand-ins for the ESP-IDF headers firmware sources include.
 *
 * The include path puts this directory ahead of ESP-IDF, so `#include "nvs.h"`
 * and friends resolve to the shims in this directory, which all forward here.
 */

#ifndef ESP_STUBS_H
#define ESP_STUBS_H

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ------------------------------------------------------------ error codes */

typedef int esp_err_t;

#define ESP_OK                          0
#define ESP_FAIL                       -1
#define ESP_ERR_NO_MEM                  0x101
#define ESP_ERR_INVALID_ARG             0x102
#define ESP_ERR_INVALID_STATE           0x103
#define ESP_ERR_NVS_NOT_FOUND           0x1102
#define ESP_ERR_NVS_READ_ONLY           0x1107
#define ESP_ERR_NVS_NOT_ENOUGH_SPACE    0x1108
#define ESP_ERR_NVS_INVALID_LENGTH      0x110D
#define ESP_ERR_NVS_VALUE_TOO_LONG      0x1110
#define ESP_ERR_NVS_NO_FREE_PAGES       0x1100
#define ESP_ERR_NVS_NEW_VERSION_FOUND   0x1110

/* ------------------------------------------------------------------- NVS */

typedef uint32_t nvs_handle_t;

typedef enum {
    NVS_READONLY,
    NVS_READWRITE,
} nvs_open_mode_t;

esp_err_t nvs_flash_init(void);
esp_err_t nvs_flash_erase(void);
esp_err_t nvs_flash_deinit(void);
esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out);
void      nvs_close(nvs_handle_t handle);
esp_err_t nvs_commit(nvs_handle_t handle);
esp_err_t nvs_set_u8(nvs_handle_t h, const char *key, uint8_t value);
esp_err_t nvs_get_u8(nvs_handle_t h, const char *key, uint8_t *out);
esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *v, size_t len);
esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *len);
esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key);
esp_err_t nvs_erase_all(nvs_handle_t handle);

/* ----------------------------------------------------------------- clock */

/* A clock the test drives, not one that drifts with wall time: auto-lock is a
 * timeout, and a timeout you cannot fast-forward is a timeout you cannot test. */
int64_t esp_timer_get_time(void);
void    fake_clock_advance_us(int64_t us);
void    fake_clock_reset(void);

/* -------------------------------------------------------------------- RNG */

/* Deterministic so a failing UI test replays identically. Never key material -
 * the only firmware caller here picks which words to quiz the user on. */
uint32_t esp_random(void);
void     esp_fill_random(void *buf, size_t len);

/* --------------------------------------------------------------- logging */

extern int leek_log_quiet;
void leek_log(const char *level, const char *tag, const char *fmt, ...);

#define ESP_LOGE(tag, ...) leek_log("E", tag, __VA_ARGS__)
#define ESP_LOGW(tag, ...) leek_log("W", tag, __VA_ARGS__)
#define ESP_LOGI(tag, ...) leek_log("I", tag, __VA_ARGS__)
#define ESP_LOGD(tag, ...) leek_log("D", tag, __VA_ARGS__)
#define ESP_LOGV(tag, ...) leek_log("V", tag, __VA_ARGS__)

#define ESP_ERROR_CHECK(x) ((void)(x))

static inline const char *esp_err_to_name(esp_err_t e) { (void)e; return "ESP_ERR"; }

#endif /* ESP_STUBS_H */
