/**
 * Transport selection. See transport.h for why exactly one may be live.
 *
 * Deliberately the only place that starts or stops the radio, and the only
 * place that installs a protocol writer. "BLE is off unless it is selected" is
 * a property you can only hold if there is a single door.
 */

#include "transport.h"
#include "entropy.h"

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "ble.h"
#include "protocol.h"
#include "session.h"

static const char *TAG = "transport";

/* Shares the UI's namespace: it is a device setting the user picks on a
 * settings screen, and it is not secret. */
#define TRANSPORT_NVS_NAMESPACE "leek_ui"
#define TRANSPORT_NVS_KEY       "link"

static TransportKind current = TRANSPORT_USB;

const char *transport_label(TransportKind kind)
{
    return kind == TRANSPORT_BLE ? "BLE" : "USB";
}

TransportKind transport_get(void)
{
    return current;
}

static void transport_save(TransportKind kind)
{
    nvs_handle_t nvs;
    if (nvs_open(TRANSPORT_NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        ESP_LOGW(TAG, "Could not persist the transport setting");
        return;
    }
    nvs_set_u8(nvs, TRANSPORT_NVS_KEY, (uint8_t)kind);
    nvs_commit(nvs);
    nvs_close(nvs);
}

/**
 * Apply a selection unconditionally.
 *
 * Order matters and is the whole point: the session dies first, then the
 * outgoing channel is detached, then the other radio is silenced, and only
 * then is the new one brought up. At no instant are both reachable — not even
 * transiently, which is the failure a "start then stop" ordering would leave
 * open for as long as the stack takes to shut down.
 */
static bool transport_apply(TransportKind kind)
{
    session_reset();
    protocol_reset_rx();
    protocol_set_writer(NULL);

    if (kind == TRANSPORT_BLE) {
        protocol_set_rx_enabled(false);     /* USB endpoint stops answering */
        if (!ble_transport_start()) {
            ESP_LOGE(TAG, "BLE would not start; staying on USB");
            protocol_set_rx_enabled(true);
            current = TRANSPORT_USB;
            return false;
        }
        protocol_set_writer(ble_transport_write_frame);
        current = TRANSPORT_BLE;
    } else {
        ble_transport_stop();               /* advertising off, not just idle */
        protocol_set_rx_enabled(true);
        current = TRANSPORT_USB;
    }

    /* The entropy gate needs to know, and this is the only place that knows.
     * Reporting it here rather than from the settings screen covers the case
     * the settings screen cannot: transport_init() restores the stored link at
     * boot, so a device that was left on BLE comes up with the radio running
     * and nobody having said so. Generating a seed in that state took the
     * "no radio" branch and enabled the bootloader RNG while BLE owned the
     * ADC -- the exact condition the comment in entropy.c warns against. */
    entropy_set_ble_active(current == TRANSPORT_BLE);

    ESP_LOGI(TAG, "Link is %s", transport_label(current));
    return true;
}

void transport_init(void)
{
    TransportKind stored = TRANSPORT_USB;

    nvs_handle_t nvs;
    if (nvs_open(TRANSPORT_NVS_NAMESPACE, NVS_READONLY, &nvs) == ESP_OK) {
        uint8_t value = 0;
        if (nvs_get_u8(nvs, TRANSPORT_NVS_KEY, &value) == ESP_OK &&
            value == (uint8_t)TRANSPORT_BLE) {
            stored = TRANSPORT_BLE;
        }
        nvs_close(nvs);
    }

    /* Force the apply even when the stored value matches the default, so the
     * USB path is explicitly enabled and BLE explicitly off at boot rather than
     * relying on initialisers. */
    current = stored == TRANSPORT_USB ? TRANSPORT_BLE : TRANSPORT_USB;
    transport_apply(stored);
}

bool transport_set(TransportKind kind)
{
    if (kind == current) {
        return true;
    }
    bool ok = transport_apply(kind);
    transport_save(current);
    return ok;
}

bool transport_toggle(void)
{
    return transport_set(current == TRANSPORT_USB ? TRANSPORT_BLE
                                                  : TRANSPORT_USB);
}
