/**
 * ESP-IDF stand-ins for the host test harness: NVS, logging, and the handful
 * of helpers firmware sources pull in. See fake_nvs.h for the crash-injection
 * contract.
 */

#include "esp_stubs.h"
#include "fake_nvs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------------------------------------------------------------- storage */

#define MAX_ENTRIES 128
#define MAX_NS      16
#define MAX_KEY     32
#define MAX_VALUE   512

typedef struct {
    bool    used;
    char    ns[MAX_NS];
    char    key[MAX_KEY];
    uint8_t value[MAX_VALUE];
    size_t  length;
} Entry;

static Entry  entries[MAX_ENTRIES];
static int    write_count = 0;
static int    crash_at    = 0;      /* 0 = never */
static bool   crashed     = false;
static int    first_read_after = -1;  /* write_count at the first read */

/* Open handles. The handle value is an index+1 into this table. */
#define MAX_HANDLES 8
static struct {
    bool used;
    char ns[MAX_NS];
    bool readonly;
} handles[MAX_HANDLES];

void fake_nvs_reset(void)
{
    memset(entries, 0, sizeof(entries));
    memset(handles, 0, sizeof(handles));
    write_count = 0;
    crash_at    = 0;
    crashed     = false;
    first_read_after = -1;
}

void fake_nvs_crash_after(int n)
{
    /* Relative to now, not to the last reset - callers set this up after
     * arranging state, and would otherwise have to count the setup's writes. */
    crash_at = (n > 0) ? write_count + n : 0;
    crashed  = false;
}

void fake_nvs_crash_now(void) { crash_at = write_count; crashed = false; }

void fake_nvs_mark_io_start(void) { first_read_after = -1; }
int  fake_nvs_writes_before_first_read(void) { return first_read_after; }
bool fake_nvs_crashed(void)      { return crashed; }
int  fake_nvs_write_count(void)  { return write_count; }

void fake_nvs_reboot(void)
{
    memset(handles, 0, sizeof(handles));
    crash_at    = 0;
    crashed     = false;
    write_count = 0;
}

static Entry *find(const char *ns, const char *key)
{
    for (int i = 0; i < MAX_ENTRIES; i++) {
        if (entries[i].used &&
            strcmp(entries[i].ns, ns) == 0 &&
            strcmp(entries[i].key, key) == 0) {
            return &entries[i];
        }
    }
    return NULL;
}

bool fake_nvs_has(const char *ns, const char *key)
{
    return find(ns, key) != NULL;
}

static Entry *find_or_create(const char *ns, const char *key)
{
    Entry *e = find(ns, key);
    if (e) {
        return e;
    }
    for (int i = 0; i < MAX_ENTRIES; i++) {
        if (!entries[i].used) {
            entries[i].used = true;
            snprintf(entries[i].ns,  MAX_NS,  "%s", ns);
            snprintf(entries[i].key, MAX_KEY, "%s", key);
            return &entries[i];
        }
    }
    return NULL;
}

/* Every mutating path funnels through here so crash injection is total. */
static esp_err_t store(nvs_handle_t handle, const char *key,
                       const void *value, size_t length)
{
    if (handle == 0 || handle > MAX_HANDLES || !handles[handle - 1].used) {
        return ESP_ERR_INVALID_ARG;
    }
    if (handles[handle - 1].readonly) {
        return ESP_ERR_NVS_READ_ONLY;
    }
    if (length > MAX_VALUE) {
        return ESP_ERR_NVS_VALUE_TOO_LONG;
    }

    /* Power is already gone - accept the call, drop the data. */
    if (crashed) {
        return ESP_OK;
    }

    write_count++;
    if (crash_at > 0 && write_count > crash_at) {
        crashed = true;
        return ESP_OK;
    }

    Entry *e = find_or_create(handles[handle - 1].ns, key);
    if (!e) {
        return ESP_ERR_NVS_NOT_ENOUGH_SPACE;
    }
    memcpy(e->value, value, length);
    e->length = length;
    return ESP_OK;
}

static esp_err_t load(nvs_handle_t handle, const char *key,
                      void *out, size_t *length)
{
    if (first_read_after < 0) {
        first_read_after = write_count;
    }

    if (handle == 0 || handle > MAX_HANDLES || !handles[handle - 1].used) {
        return ESP_ERR_INVALID_ARG;
    }

    Entry *e = find(handles[handle - 1].ns, key);
    if (!e) {
        return ESP_ERR_NVS_NOT_FOUND;
    }

    if (out == NULL) {          /* size query */
        *length = e->length;
        return ESP_OK;
    }
    if (*length < e->length) {
        return ESP_ERR_NVS_INVALID_LENGTH;
    }

    memcpy(out, e->value, e->length);
    *length = e->length;
    return ESP_OK;
}

/* ------------------------------------------------------------- public API */

esp_err_t nvs_flash_init(void)  { return ESP_OK; }
esp_err_t nvs_flash_erase(void) { fake_nvs_reset(); return ESP_OK; }

esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out)
{
    for (int i = 0; i < MAX_HANDLES; i++) {
        if (!handles[i].used) {
            handles[i].used     = true;
            handles[i].readonly = (mode == NVS_READONLY);
            snprintf(handles[i].ns, MAX_NS, "%s", ns);
            *out = (nvs_handle_t)(i + 1);
            return ESP_OK;
        }
    }
    return ESP_ERR_NO_MEM;
}

void nvs_close(nvs_handle_t handle)
{
    if (handle > 0 && handle <= MAX_HANDLES) {
        handles[handle - 1].used = false;
    }
}

esp_err_t nvs_commit(nvs_handle_t handle) { (void)handle; return ESP_OK; }

esp_err_t nvs_set_u8(nvs_handle_t h, const char *key, uint8_t value)
{
    return store(h, key, &value, sizeof(value));
}

esp_err_t nvs_get_u8(nvs_handle_t h, const char *key, uint8_t *out)
{
    size_t len = sizeof(*out);
    return load(h, key, out, &len);
}

esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *v, size_t len)
{
    return store(h, key, v, len);
}

esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *len)
{
    return load(h, key, out, len);
}

esp_err_t nvs_erase_all(nvs_handle_t handle)
{
    if (handle == 0 || handle > MAX_HANDLES || !handles[handle - 1].used) {
        return ESP_ERR_INVALID_ARG;
    }
    if (crashed) {
        return ESP_OK;
    }

    write_count++;
    if (crash_at > 0 && write_count > crash_at) {
        crashed = true;
        return ESP_OK;
    }

    for (int i = 0; i < MAX_ENTRIES; i++) {
        if (entries[i].used && strcmp(entries[i].ns, handles[handle - 1].ns) == 0) {
            memset(&entries[i], 0, sizeof(entries[i]));
        }
    }
    return ESP_OK;
}

/* --------------------------------------------------------------- logging */

int leek_log_quiet = 1;

void leek_log(const char *level, const char *tag, const char *fmt, ...)
{
    if (leek_log_quiet) {
        return;
    }
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "%s (%s) ", level, tag);
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
}
