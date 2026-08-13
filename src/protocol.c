/**
 * LeekWallet protocol endpoint — device side.
 *
 * Speaks the wire protocol from docs/PROTOCOL.md over the ESP32-S3's native
 * USB-Serial-JTAG, which is the same port the console logs to and the same
 * cable used for flashing. No extra hardware, no TinyUSB reconfiguration.
 *
 * Sharing the port with log output means the host has to find frames in a
 * stream that also carries text, so every frame is preceded by a two-byte sync
 * marker. Log lines are UTF-8 and essentially never contain it, and a receiver
 * that loses sync simply scans forward to the next marker rather than
 * misparsing. A dedicated CDC interface (T25b) removes the need, but this works
 * over the cable already attached.
 *
 *   ┌──────┬──────┬────────┬─────────────┐
 *   │ 'L'  │ 'K'  │ len:u16│ type + CBOR │
 *   └──────┴──────┴────────┴─────────────┘
 *
 * Only the commands that reveal nothing are implemented here. Anything touching
 * keys waits for the session layer, because shipping getAddress before session
 * establishment exists would mean shipping it unauthenticated.
 */

#include "protocol.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/usb_serial_jtag.h"
#include "esp_log.h"

#include "cbor.h"
#include "leek-wallet.h"
#include "pin.h"
#include "session.h"
#include "ui.h"

static const char *TAG = "protocol";

#define SYNC0 'L'
#define SYNC1 'K'

#define MAX_FRAME 512          /* far above anything the device answers today */
#define RX_CHUNK  64

/* Frame types, matching app/packages/core/src/framing.ts */
#define FRAME_REQUEST   0x01
#define FRAME_RESPONSE  0x02
#define FRAME_ENC_REQUEST  0x11
#define FRAME_ENC_RESPONSE 0x12
#define FRAME_ERROR     0x7F

/* Error codes, matching transport.ts */
#define ERR_MALFORMED    0x0001
#define ERR_NOT_UNLOCKED 0x0100
#define ERR_NO_WALLET    0x0300
#define ERR_SESSION      0x0400

static uint8_t rx_buf[MAX_FRAME];
static size_t  rx_len = 0;

static void send_frame(uint8_t type, const uint8_t *payload, size_t len)
{
    uint8_t header[4];
    size_t body = len + 1;      /* type byte counts toward the length */

    header[0] = SYNC0;
    header[1] = SYNC1;
    header[2] = (uint8_t)(body >> 8);
    header[3] = (uint8_t)body;

    usb_serial_jtag_write_bytes(header, sizeof(header), portMAX_DELAY);
    usb_serial_jtag_write_bytes(&type, 1, portMAX_DELAY);
    if (len) {
        usb_serial_jtag_write_bytes(payload, len, portMAX_DELAY);
    }
    usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(100));
}

static void send_error(uint16_t code, const char *message)
{
    uint8_t out[128];
    CborWriter w;
    cbor_writer_init(&w, out, sizeof(out));

    cbor_write_map(&w, 2);
    cbor_write_text(&w, "code");
    cbor_write_uint(&w, code);
    cbor_write_text(&w, "message");
    cbor_write_text(&w, message);

    if (cbor_writer_ok(&w)) {
        send_frame(FRAME_ERROR, out, w.length);
    }
}

/* Handle the plaintext handshake. Runs before any session exists, so it must
 * reveal nothing: a device public key and a version, and no user-specific
 * state at all. */
static bool handle_hello(const uint8_t *payload, size_t len,
                         uint8_t *out, size_t out_size, size_t *out_len)
{
    CborItem item;
    if (!cbor_map_find(payload, len, "hostPubkey", &item) ||
        item.type != CBOR_BYTES || item.value != SESSION_PUBKEY_SIZE) {
        return false;
    }

    uint8_t device_pub[SESSION_PUBKEY_SIZE];
    if (!session_begin(item.data, device_pub)) {
        return false;
    }

    /* The user now has to compare a six-digit code on the OLED with the one
     * the app computes. Until they confirm, nothing encrypted is accepted. */
    ui_request_session_confirm();

    CborWriter w;
    cbor_writer_init(&w, out, out_size);
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "result");
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "devicePubkey");
    cbor_write_bytes(&w, device_pub, sizeof(device_pub));
    cbor_write_text(&w, "version");
    cbor_write_uint(&w, 1);

    if (!cbor_writer_ok(&w)) {
        return false;
    }
    *out_len = w.length;
    return true;
}

/* Handle one decoded request. */
static void dispatch(const uint8_t *payload, size_t len)
{
    CborItem item;
    if (!cbor_map_find(payload, len, "method", &item)) {
        send_error(ERR_MALFORMED, "no method");
        return;
    }

    char method[32];
    if (!cbor_text_copy(&item, method, sizeof(method))) {
        send_error(ERR_MALFORMED, "bad method");
        return;
    }

    uint8_t out[192];
    CborWriter w;
    cbor_writer_init(&w, out, sizeof(out));

    if (strcmp(method, "ping") == 0) {
        cbor_write_map(&w, 1);
        cbor_write_text(&w, "result");
        cbor_write_map(&w, 1);
        cbor_write_text(&w, "pong");
        cbor_write_uint(&w, 1);

    } else if (strcmp(method, "getFeatures") == 0) {
        cbor_write_map(&w, 1);
        cbor_write_text(&w, "result");
        cbor_write_map(&w, 3);
        cbor_write_text(&w, "blindSigning");
        cbor_write_uint(&w, 0);
        cbor_write_text(&w, "firmware");
        cbor_write_text(&w, "0.1.0");
        cbor_write_text(&w, "model");
        cbor_write_text(&w, "LeekWallet-S3");

    } else if (strcmp(method, "getStatus") == 0) {
        WalletStatus status = wallet_get_status();
        cbor_write_map(&w, 1);
        cbor_write_text(&w, "result");
        cbor_write_map(&w, 4);
        cbor_write_text(&w, "activeWallet");
        cbor_write_uint(&w, status.active_wallet_index);
        cbor_write_text(&w, "passphrase");
        cbor_write_uint(&w, wallet_has_passphrase() ? 1 : 0);
        cbor_write_text(&w, "unlocked");
        cbor_write_uint(&w, pin_is_unlocked() ? 1 : 0);
        cbor_write_text(&w, "walletCount");
        cbor_write_uint(&w, status.wallet_count);

    } else if (strcmp(method, "unlock") == 0) {
        /* Never carries a PIN. It asks the device to prompt, the user types on
         * the device, and the host learns the outcome by polling getStatus.
         * A PIN crossing the wire would defeat the point of having one. */
        if (session_state() != SESSION_ACTIVE) {
            send_error(ERR_SESSION, "session required");
            return;
        }

        if (pin_is_unlocked()) {
            cbor_write_map(&w, 1);
            cbor_write_text(&w, "result");
            cbor_write_map(&w, 1);
            cbor_write_text(&w, "unlocked");
            cbor_write_uint(&w, 1);
        } else {
            ui_request_unlock();
            cbor_write_map(&w, 1);
            cbor_write_text(&w, "result");
            cbor_write_map(&w, 2);
            cbor_write_text(&w, "prompted");
            cbor_write_uint(&w, 1);
            cbor_write_text(&w, "unlocked");
            cbor_write_uint(&w, 0);
        }

    } else if (strcmp(method, "lock") == 0) {
        if (session_state() != SESSION_ACTIVE) {
            send_error(ERR_SESSION, "session required");
            return;
        }
        ui_request_lock();
        cbor_write_map(&w, 1);
        cbor_write_text(&w, "result");
        cbor_write_map(&w, 1);
        cbor_write_text(&w, "unlocked");
        cbor_write_uint(&w, 0);

    } else if (strcmp(method, "getAddress") == 0) {
        /* Behind the session: an address list is not secret, but it is
         * user-specific, and anything plugged into this port should not be able
         * to enumerate a wallet without the user confirming a passkey. */
        if (session_state() != SESSION_ACTIVE) {
            send_error(ERR_SESSION, "session required");
            return;
        }
        if (!pin_is_unlocked()) {
            send_error(ERR_NOT_UNLOCKED, "device is locked");
            return;
        }

        uint32_t index = 0;
        if (cbor_map_find(payload, len, "index", &item) && item.type == CBOR_UINT) {
            index = item.value;
        }

        HDPath path = HDPATH_ETH_DEFAULT;
        path.address_index = index;
        EthAddress addr;

        if (wallet_select_path(&path) != WALLET_OK ||
            wallet_get_eth_address(&addr) != WALLET_OK) {
            send_error(ERR_NO_WALLET, "derivation failed");
            return;
        }

        cbor_write_map(&w, 1);
        cbor_write_text(&w, "result");
        cbor_write_map(&w, 2);
        cbor_write_text(&w, "address");
        cbor_write_text(&w, addr.hex);
        cbor_write_text(&w, "index");
        cbor_write_uint(&w, index);

    } else {
        /* Signing waits for on-device transaction rendering (T12). Answering
         * it before the device can display what it signs would be blind
         * signing with extra steps. */
        send_error(ERR_MALFORMED, "unknown or not yet implemented");
        return;
    }

    if (!cbor_writer_ok(&w)) {
        send_error(ERR_MALFORMED, "response too large");
        return;
    }

    if (session_state() == SESSION_ACTIVE) {
        int enc = session_encrypt(out, w.length, sizeof(out));
        if (enc < 0) {
            send_error(ERR_SESSION, "encrypt failed");
            return;
        }
        send_frame(FRAME_ENC_RESPONSE, out, (size_t)enc);
    } else {
        send_frame(FRAME_RESPONSE, out, w.length);
    }
}

/* Pull complete frames out of the receive buffer, resynchronising on garbage. */
static void consume(void)
{
    for (;;) {
        /* Discard anything before a sync marker: console output shares this
         * port, so leading noise is expected rather than exceptional. */
        size_t start = 0;
        while (start + 1 < rx_len &&
               !(rx_buf[start] == SYNC0 && rx_buf[start + 1] == SYNC1)) {
            start++;
        }
        if (start > 0) {
            memmove(rx_buf, rx_buf + start, rx_len - start);
            rx_len -= start;
        }

        if (rx_len < 4) return;

        size_t body = ((size_t)rx_buf[2] << 8) | rx_buf[3];
        if (body < 1 || body > MAX_FRAME - 4) {
            /* Not a length we would ever send. Drop the marker and rescan
             * rather than trusting it. */
            memmove(rx_buf, rx_buf + 2, rx_len - 2);
            rx_len -= 2;
            continue;
        }

        if (rx_len < 4 + body) return;      /* wait for the rest */

        uint8_t type = rx_buf[4];
        if (type == FRAME_REQUEST) {
            /* Plaintext is only ever the handshake. */
            uint8_t out[128];
            size_t  out_len = 0;
            CborItem probe;
            char method[32] = {0};

            if (cbor_map_find(rx_buf + 5, body - 1, "method", &probe) &&
                cbor_text_copy(&probe, method, sizeof(method)) &&
                strcmp(method, "hello") == 0) {
                if (handle_hello(rx_buf + 5, body - 1, out, sizeof(out), &out_len)) {
                    send_frame(FRAME_RESPONSE, out, out_len);
                } else {
                    send_error(ERR_MALFORMED, "handshake failed");
                }
            } else {
                dispatch(rx_buf + 5, body - 1);
            }
        } else if (type == FRAME_ENC_REQUEST) {
            /* Decrypt in place, dispatch, re-encrypt the reply. */
            int plain = session_decrypt(rx_buf + 5, body - 1);
            if (plain < 0) {
                send_error(ERR_SESSION, "decrypt failed");
            } else {
                dispatch(rx_buf + 5, (size_t)plain);
            }
        } else {
            send_error(ERR_MALFORMED, "unexpected frame type");
        }

        memmove(rx_buf, rx_buf + 4 + body, rx_len - (4 + body));
        rx_len -= 4 + body;
    }
}

static void protocol_task(void *arg)
{
    (void)arg;
    ESP_LOGI(TAG, "Protocol endpoint listening on USB-Serial-JTAG");

    uint8_t chunk[RX_CHUNK];
    for (;;) {
        int n = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(100));
        if (n <= 0) {
            continue;
        }
        if (rx_len + (size_t)n > sizeof(rx_buf)) {
            /* Never grow past the fixed buffer on the host's say-so. */
            ESP_LOGW(TAG, "Receive buffer overrun; resynchronising");
            rx_len = 0;
            continue;
        }
        memcpy(rx_buf + rx_len, chunk, (size_t)n);
        rx_len += (size_t)n;
        consume();
    }
}

void protocol_start(void)
{
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    cfg.rx_buffer_size = 256;
    cfg.tx_buffer_size = 256;

    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "USB-Serial-JTAG driver install failed: %d", err);
        return;
    }

    xTaskCreate(protocol_task, "protocol", 4096, NULL, 4, NULL);
}
