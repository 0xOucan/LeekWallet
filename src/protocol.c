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
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/usb_serial_jtag.h"
#include "esp_log.h"

#include "cbor.h"
#include "leek-wallet.h"
#include "pin.h"
#include "session.h"
#include "eth-tx.h"
#include "eth-decode.h"
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
#define FRAME_ENC_ERROR    0x7E
#define FRAME_ERROR     0x7F

/* Error codes, matching transport.ts */
#define ERR_MALFORMED    0x0001
#define ERR_NOT_UNLOCKED 0x0100
#define ERR_NO_WALLET    0x0300
#define ERR_SESSION      0x0400
#define ERR_USER_REJECTED 0x0200
#define ERR_USER_TIMEOUT  0x0201
/* Outside the decodable set: the device will not ask for approval of
 * something it cannot describe. See eth-decode.h. */
#define ERR_UNDECODABLE   0x0202

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

/**
 * Send an error.
 *
 * Once a session is active, application errors are encrypted like any other
 * reply. That is not about secrecy - it is about counters. The device advances
 * its receive counter the moment a frame decrypts, even if the reply is an
 * error, while the host only advances its send counter when it opens a reply.
 * A plaintext error therefore leaves the two one apart, and every later frame
 * fails to decrypt. Hardware testing walked straight into it: an unimplemented
 * method returned a plaintext error and the next request died with "decrypt
 * failed".
 *
 * Session-level errors stay in plaintext, because at that point there is no
 * working channel to send them over.
 */
static void send_error_ex(uint16_t code, const char *message, bool allow_encrypt)
{
    uint8_t out[128];
    CborWriter w;
    cbor_writer_init(&w, out, sizeof(out));

    cbor_write_map(&w, 2);
    cbor_write_text(&w, "code");
    cbor_write_uint(&w, code);
    cbor_write_text(&w, "message");
    cbor_write_text(&w, message);

    if (!cbor_writer_ok(&w)) {
        return;
    }

    if (allow_encrypt && session_state() == SESSION_ACTIVE) {
        int enc = session_encrypt(out, w.length, sizeof(out));
        if (enc > 0) {
            /* A distinct type. Sending an encrypted error as an encrypted
             * *response* makes it indistinguishable from success once the
             * payload is opened, and the client reports an empty result rather
             * than the failure that actually happened. */
            send_frame(FRAME_ENC_ERROR, out, (size_t)enc);
            return;
        }
    }

    send_frame(FRAME_ERROR, out, w.length);
}

static void send_error(uint16_t code, const char *message)
{
    send_error_ex(code, message, true);
}

/** For failures that mean the channel itself is unusable. */
static void send_session_error(uint16_t code, const char *message)
{
    send_error_ex(code, message, false);
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
            send_session_error(ERR_SESSION, "session required");
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
            send_session_error(ERR_SESSION, "session required");
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
            send_session_error(ERR_SESSION, "session required");
            return;
        }
        if (!pin_is_unlocked()) {
            send_error(ERR_NOT_UNLOCKED, "device is locked");
            return;
        }

        /* Accept either a bare index or a full path. The client sends a path
         * because that is what PROTOCOL.md documents and what viem thinks in;
         * reading only "index" meant every request quietly derived address
         * zero, and ten identical addresses is a symptom that looks like a
         * derivation bug rather than a parsing one. */
        uint32_t index = 0;
        if (cbor_map_find(payload, len, "index", &item) && item.type == CBOR_UINT) {
            index = item.value;
        } else if (cbor_map_find(payload, len, "path", &item) && item.type == CBOR_TEXT) {
            char path_str[40];
            if (cbor_text_copy(&item, path_str, sizeof(path_str))) {
                /* Take the trailing component of m/44'/60'/0'/0/<n>. Only the
                 * address index is variable today; accounts are T45. */
                const char *last = strrchr(path_str, '/');
                if (last && last[1] != '\0') {
                    index = (uint32_t)strtoul(last + 1, NULL, 10);
                }
            }
        }

        if (index > 0x7FFFFFFFu) {
            send_error(ERR_MALFORMED, "address index out of range");
            return;
        }

        HDPath path = HDPATH_ETH_DEFAULT;
        path.address_index = index;
        EthAddress addr;

        if (wallet_get_address_at_path(&path, &addr) != WALLET_OK) {
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

    } else if (strcmp(method, "signTransaction") == 0) {
        if (session_state() != SESSION_ACTIVE) {
            send_session_error(ERR_SESSION, "session required");
            return;
        }
        if (!pin_is_unlocked()) {
            send_error(ERR_NOT_UNLOCKED, "device is locked");
            return;
        }

        /* Build the transaction from the host's fields. Every value is parsed
         * here and nothing the host sends is treated as bytes to sign. */
        EthTx tx;
        memset(&tx, 0, sizeof(tx));

        if (!cbor_map_find(payload, len, "chainId", &item) || item.type != CBOR_UINT) {
            send_error(ERR_MALFORMED, "chainId required");
            return;
        }
        tx.chain_id = item.value;

        if (cbor_map_find(payload, len, "nonce", &item) && item.type == CBOR_UINT) {
            eth_quantity_set_u64(&tx.nonce, item.value);
        }

        if (cbor_map_find(payload, len, "to", &item) &&
            item.type == CBOR_BYTES && item.value == 20) {
            memcpy(tx.to, item.data, 20);
            tx.has_to = true;
        }

        if (cbor_map_find(payload, len, "value", &item) && item.type == CBOR_BYTES) {
            if (!eth_quantity_set(&tx.value, item.data, item.value)) {
                send_error(ERR_MALFORMED, "value too large");
                return;
            }
        }
        if (cbor_map_find(payload, len, "maxFeePerGas", &item) && item.type == CBOR_BYTES) {
            eth_quantity_set(&tx.max_fee, item.data, item.value);
        }
        if (cbor_map_find(payload, len, "maxPriorityFeePerGas", &item) &&
            item.type == CBOR_BYTES) {
            eth_quantity_set(&tx.max_priority_fee, item.data, item.value);
        }
        if (cbor_map_find(payload, len, "gas", &item) && item.type == CBOR_BYTES) {
            eth_quantity_set(&tx.gas_limit, item.data, item.value);
        }

        if (cbor_map_find(payload, len, "data", &item) && item.type == CBOR_BYTES) {
            if (item.value > ETH_MAX_DATA) {
                /* Refusing is the honest answer. Truncating would sign
                 * something other than what was asked for, and accepting an
                 * unbounded blob lets the host choose our memory usage. */
                send_error(ERR_MALFORMED, "calldata too large to display");
                return;
            }
            memcpy(tx.data, item.data, item.value);
            tx.data_length = item.value;
        }

        uint32_t sign_index = 0;
        if (cbor_map_find(payload, len, "index", &item) && item.type == CBOR_UINT) {
            sign_index = item.value;
        } else if (cbor_map_find(payload, len, "path", &item) && item.type == CBOR_TEXT) {
            char path_str[40];
            if (cbor_text_copy(&item, path_str, sizeof(path_str))) {
                const char *last = strrchr(path_str, '/');
                if (last && last[1] != '\0') {
                    sign_index = (uint32_t)strtoul(last + 1, NULL, 10);
                }
            }
        }

        /* Refuse what cannot be explained (T50).
         *
         * The alternative is to render a hash and ask for a signature that
         * means nothing to the person giving it. Every other wallet that took
         * that road ended up shipping a blind-signing toggle; better to say no
         * and grow the decodable set deliberately. */
        EthCall call;
        if (!eth_tx_is_decodable(&tx, &call)) {
            send_error(ERR_UNDECODABLE,
                       "this device cannot show what that call does");
            return;
        }

        /* Derive the source address here, on the task that will do the
         * signing, and hand it to the screen. Deriving on the UI task shares
         * state with this one and once produced a signature from a key the
         * confirmation never named (T47). */
        HDPath from_path = HDPATH_ETH_DEFAULT;
        from_path.address_index = sign_index;
        EthAddress from_addr;
        if (wallet_get_address_at_path(&from_path, &from_addr) != WALLET_OK) {
            send_error(ERR_NO_WALLET, "derivation failed");
            return;
        }

        /* Show it and wait. The screen renders these exact fields and the hash
         * below is taken from the same struct, so what is approved and what is
         * signed cannot differ. */
        ui_request_sign(&tx, sign_index, from_addr.hex);

        const TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(120000);
        SignOutcome outcome;
        for (;;) {
            outcome = ui_sign_outcome();
            if (outcome != SIGN_PENDING) {
                break;
            }
            if (xTaskGetTickCount() > deadline) {
                ui_sign_clear();
                send_error(ERR_USER_TIMEOUT, "no answer on the device");
                return;
            }
            vTaskDelay(pdMS_TO_TICKS(50));
        }
        ui_sign_clear();

        if (outcome != SIGN_APPROVED) {
            send_error(ERR_USER_REJECTED, "rejected on device");
            return;
        }

        uint8_t digest[32];
        if (!eth_tx_hash(&tx, digest)) {
            send_error(ERR_MALFORMED, "could not encode the transaction");
            return;
        }

        /* Select and sign atomically. Doing these as two calls let the UI
         * task re-derive in between and the device signed with a key nobody
         * asked for. */
        HDPath sign_path = HDPATH_ETH_DEFAULT;
        sign_path.address_index = sign_index;

        EthSignature sig;
        if (wallet_sign_hash_at_path(&sign_path, digest, &sig) != WALLET_OK) {
            send_error(ERR_NO_WALLET, "signing failed");
            return;
        }

        cbor_write_map(&w, 1);
        cbor_write_text(&w, "result");
        cbor_write_map(&w, 4);
        cbor_write_text(&w, "index");
        cbor_write_uint(&w, sign_index);
        cbor_write_text(&w, "r");
        cbor_write_bytes(&w, sig.r, sizeof(sig.r));
        cbor_write_text(&w, "s");
        cbor_write_bytes(&w, sig.s, sizeof(sig.s));
        /* Emit yParity, 0 or 1, not the legacy 27+parity form.
         *
         * wallet_sign_hash returns the legacy convention, and a client that
         * masks the low bit of that inverts it: 27 becomes 1 and 28 becomes 0.
         * The signature then recovers to an address nobody owns, and the
         * network rejects it for having no funds - which looks like a funding
         * problem rather than a signing one. EIP-1559 wants yParity, so send
         * exactly that and leave nothing to infer. */
        cbor_write_text(&w, "yParity");
        cbor_write_uint(&w, (sig.v >= 27) ? (uint32_t)(sig.v - 27) : (uint32_t)(sig.v & 1));

    } else {
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
                    send_session_error(ERR_MALFORMED, "handshake failed");
                }
            } else {
                dispatch(rx_buf + 5, body - 1);
            }
        } else if (type == FRAME_ENC_REQUEST) {
            /* Decrypt in place, dispatch, re-encrypt the reply. */
            int plain = session_decrypt(rx_buf + 5, body - 1);
            if (plain < 0) {
                send_session_error(ERR_SESSION, "decrypt failed");
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
