/**
 * BLE GATT transport — see ble.h for the UUIDs and the sync-marker decision.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. **Requests are dispatched off the NimBLE host task.** A signing request
 *    blocks for as long as the user takes to press a button, and the reply is
 *    sent as a notification — from the host task. Dispatching inline would have
 *    the stack waiting on a human while holding the only thread that can talk
 *    to the radio. So a write is reassembled on the host task (cheap, bounded)
 *    and the finished frame is handed to a worker over a one-deep queue.
 *
 * 2. **The queue is one deep and REFUSES when full.** A peer that pipelines
 *    requests gets the extras refused rather than buffered. There are no
 *    request IDs in this protocol (PROTOCOL.md 3b), so a queue of pending
 *    requests would produce replies nobody can match to a request, and an
 *    unbounded one is just a memory exhaustion primitive. But refusing is not
 *    the same as dropping: the cable dispatches every complete frame inline
 *    and always answers, so a queue that swallowed one made the two transports
 *    disagree — see on_rx_write().
 *
 * 3. **Disconnect tears the session down.** Session state and nonce counters
 *    belong to a connection; carrying them across would let the next peer
 *    inherit a confirmed session it never took part in.
 */

#include "ble.h"

/* Before the check, not after: CONFIG_BT_NIMBLE_ENABLED lives here, and
 * testing it first silently compiles the no-radio stub into a build that has a
 * radio — which looks like a successful build and a device that never
 * advertises. The host suite has no sdkconfig.h, hence the guard. */
#ifndef LEEK_HOST_TEST
#include "sdkconfig.h"
#endif

#if defined(CONFIG_BT_NIMBLE_ENABLED)

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "ble-chunk.h"
#include "ble-name.h"
#include "protocol.h"
#include "session.h"

static const char *TAG = "ble";

#define BLE_DEVICE_NAME BLE_NAME_DEFAULT

/* Caught at build time rather than as a log line on a battery-powered device.
 *
 * Advertisement: 3 (flags) + 2 + 16 (128-bit UUID) = 21 of the 31 available.
 * Scan response: 2 + strlen(name). T56 makes the name user-configurable, and
 * this is the bound that keeps a long one from silently stopping the radio. */
_Static_assert(2 + sizeof(BLE_DEVICE_NAME) - 1 <= 31,
               "device name too long for a legacy scan response");

/* And the runtime bound is the same bound. ble_name_set() refuses anything
 * longer, which is what makes a user-supplied name as safe as the compile-time
 * default above; if the two ever stop agreeing, this stops the build rather
 * than letting a rename silence the radio. */
_Static_assert(2 + BLE_NAME_MAX_LEN <= 31,
               "BLE_NAME_MAX_LEN would overflow a legacy scan response");

/* 6c65656b-7761-6c6c-6574-0000000000NN — "leekwallet" in ASCII, so the UUID is
 * recognisable in a scanner log. NimBLE takes the bytes little-endian. */
#define LEEK_UUID(last)                                                     \
    BLE_UUID128_INIT((last), 0x00, 0x00, 0x00, 0x00, 0x00, 0x74, 0x65,      \
                     0x6c, 0x6c, 0x61, 0x77, 0x6b, 0x65, 0x65, 0x6c)

static const ble_uuid128_t svc_uuid    = LEEK_UUID(0x01);
static const ble_uuid128_t rx_chr_uuid = LEEK_UUID(0x02);   /* host → device */
static const ble_uuid128_t tx_chr_uuid = LEEK_UUID(0x03);   /* device → host */

static uint8_t  addr_type;
static uint16_t conn_handle = BLE_HS_CONN_HANDLE_NONE;

/*
 * How long the device stays discoverable with nobody connecting.
 *
 * The radio was the largest continuous power draw on the board, and a wallet
 * that advertises forever is warm in the hand for no benefit: LeekWallet is
 * used for an operation and put down, not carried connected. Two minutes is
 * long enough to open the companion, pick the device and pair; past that,
 * advertising is serving nobody.
 *
 * This is a power measure that happens to reduce attack surface, and not the
 * other way round -- nothing here touches pairing, the session key or the
 * encryption. A device that is not advertising is simply not discoverable,
 * which is strictly less exposure than advertising into an empty room.
 *
 * NimBLE takes the window as `ble_gap_adv_start`'s duration and ends it with
 * BLE_GAP_EVENT_ADV_COMPLETE, so the timing lives in the controller rather
 * than in a task of ours that would have to be woken to check a clock.
 */
#define BLE_ADV_WINDOW_MS 120000

/*
 * Whether the controller is advertising right now.
 *
 * Distinct from `running`: `running` is "the transport is enabled", this is
 * "somebody could find us". They differ for exactly the case this exists for --
 * enabled, but the window has closed. A press re-opens it
 * (ble_transport_advertise_again), so a lapsed window is never a dead end.
 */
static bool advertising;
static uint16_t tx_val_handle;
static bool     running;
static bool     host_task_started;

static BleReassembler rx;

/* One in flight. See note 2 above. */
typedef struct {
    uint16_t len;
    uint8_t  data[PROTOCOL_MAX_FRAME];
} BleFrameJob;

static QueueHandle_t   work_queue;
static TaskHandle_t    work_task;
static BleFrameJob     job;          /* worker-owned scratch, not shared */

/* ------------------------------------------------------------- outbound */

static bool notify_chunk(void *ctx, const uint8_t *chunk, size_t len)
{
    (void)ctx;

    uint16_t handle = conn_handle;
    if (handle == BLE_HS_CONN_HANDLE_NONE) {
        return false;
    }

    struct os_mbuf *om = ble_hs_mbuf_from_flat(chunk, len);
    if (!om) {
        ESP_LOGW(TAG, "Out of mbufs; dropping a reply chunk");
        return false;
    }

    int rc = ble_gatts_notify_custom(handle, tx_val_handle, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify failed: %d", rc);
        return false;
    }
    return true;
}

void ble_transport_write_frame(const uint8_t *frame, size_t len)
{
    uint16_t handle = conn_handle;
    if (handle == BLE_HS_CONN_HANDLE_NONE) {
        return;
    }

    /* The negotiated MTU, not an assumed one. Plenty of stacks never negotiate
     * past the 23-byte default, which leaves 19 payload bytes per chunk — the
     * case the chunking layer exists for. */
    uint16_t mtu = ble_att_mtu(handle);
    if (mtu < 23) {
        mtu = 23;
    }

    if (!ble_chunk_split(frame, len, mtu, notify_chunk, NULL)) {
        ESP_LOGW(TAG, "Reply truncated; the host will see no complete frame");
    }
}

/* -------------------------------------------------------------- inbound */

static void ble_work_task(void *arg)
{
    (void)arg;
    for (;;) {
        if (xQueueReceive(work_queue, &job, portMAX_DELAY) == pdTRUE) {
            protocol_handle_frame(job.data, job.len);
        }
    }
}

/**
 * Forget requests nobody is waiting for any more.
 *
 * A queued frame outlives the connection it arrived on unless it is thrown
 * away here, and dispatching it into the NEXT connection is two faults at
 * once: the new peer gets a reply to a request it never sent — which, with no
 * request IDs, silently pairs every later reply with the wrong request until
 * one of them times out — and a stranger's command runs against a session that
 * connection never established.
 */
static void ble_drop_queued_requests(void)
{
    if (work_queue) {
        xQueueReset(work_queue);
    }
}

static int on_rx_write(uint16_t conn, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn; (void)attr_handle; (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    /* Static, not stack: this runs on NimBLE's host task, whose stack size
     * this project does not set, and the buffer doubled when the frame limit
     * followed the protocol's to 1024. NimBLE dispatches GATT callbacks
     * serially on that one task, so a single scratch buffer has no second
     * writer -- the same reasoning as `job` above, and stated here because a
     * static buffer in a callback is worth justifying rather than assuming. */
    static uint8_t chunk[BLE_CHUNK_MAX_FRAME];
    uint16_t got = 0;

    /* A write longer than any chunk we would accept is refused without being
     * copied anywhere. */
    if (OS_MBUF_PKTLEN(ctxt->om) > sizeof(chunk)) {
        ble_chunk_reset(&rx);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (ble_hs_mbuf_to_flat(ctxt->om, chunk, sizeof(chunk), &got) != 0) {
        ble_chunk_reset(&rx);
        return BLE_ATT_ERR_UNLIKELY;
    }

    switch (ble_chunk_push(&rx, chunk, got)) {
        case BLE_CHUNK_NEED_MORE:
            return 0;

        case BLE_CHUNK_ERROR:
            /* Deliberately not an error frame: at this point we do not have a
             * frame, so there is nothing the peer could correlate a reply
             * with. It resends from sequence zero or gets nothing. */
            ESP_LOGW(TAG, "Discarded a malformed chunk");
            return BLE_ATT_ERR_INVALID_PDU;

        case BLE_CHUNK_FRAME_READY: {
            /* Host-task-owned staging. Static because it is larger than this
             * stack should carry; the queue copies it, so the worker never
             * reads it. */
            static BleFrameJob staged;
            staged.len = (uint16_t)rx.len;
            memcpy(staged.data, rx.buf, rx.len);
            ble_chunk_reset(&rx);

            if (xQueueSend(work_queue, &staged, 0) != pdTRUE) {
                /* Refused, not dropped.
                 *
                 * This is the BLE/USB divergence that was found on hardware:
                 * an unknown method answered over the cable and produced
                 * nothing at all over the radio. The cable has no queue —
                 * consume() dispatches whatever it finds, inline — so on USB
                 * every complete frame produces a frame back. Here a full
                 * queue used to be one log line the peer never sees, and a
                 * request that gets no answer is strictly worse than one that
                 * gets an error: the host waits out its timeout with no way to
                 * tell a lost request from a slow one, and no request IDs to
                 * resynchronise with.
                 *
                 * Emitted from the host task, which is safe because it only
                 * assembles a fixed-size error frame and notifies it. Nothing
                 * here parses the request or touches the session. */
                ESP_LOGW(TAG, "Request queue full; refusing rather than dropping");
                protocol_send_transport_busy();
            }
            return 0;
        }
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def gatt_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &rx_chr_uuid.u,
                .access_cb = on_rx_write,
                /* Write-without-response as well: it is the fast path every
                 * client uses for bulk chunks, and the chunk header already
                 * detects a lost write. */
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid = &tx_chr_uuid.u,
                .access_cb = on_rx_write,   /* never read; notify only */
                .flags = BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &tx_val_handle,
            },
            { 0 }
        },
    },
    { 0 }
};

/* ----------------------------------------------------------------- GAP */

static int on_gap_event(struct ble_gap_event *event, void *arg);

static void ble_advertise(void)
{
    struct ble_hs_adv_fields fields;
    struct ble_gap_adv_params adv_params;

    /* The advertisement carries the service UUID; the NAME goes in the scan
     * response.
     *
     * Both together do not fit. A legacy advertisement is 31 bytes: 3 for
     * flags, 18 for a complete 128-bit UUID list, and 2 + strlen(name) for the
     * name - 33 for "LeekWallet". ble_gap_adv_set_fields() then rejects the
     * lot with BLE_HS_EMSGSIZE and advertising never starts at all. The device
     * looks powered and idle, the failure is one log line, and on battery
     * there is no console to read it on. That is how this shipped and was
     * only found by nothing appearing in a scan.
     *
     * Splitting them is also correct rather than merely smaller: a scanner
     * filtering by service UUID (see leek-ble-probe) matches on the
     * advertisement, and anything showing a human a device list issues a scan
     * request and gets the name. */
    memset(&fields, 0, sizeof(fields));
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = (ble_uuid128_t *)&svc_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_set_fields failed: %d", rc);
        return;
    }

    /* The user's name if they set one, the default otherwise. ble_name_get()
     * never returns anything longer than BLE_NAME_MAX_LEN, so the size check
     * ble_gap_adv_rsp_set_fields() performs below cannot fail on account of
     * it - which is the entire reason that bound exists. */
    const char *adv_name = ble_name_get();

    struct ble_hs_adv_fields rsp;
    memset(&rsp, 0, sizeof(rsp));
    rsp.name = (uint8_t *)adv_name;
    rsp.name_len = (uint8_t)strlen(adv_name);
    rsp.name_is_complete = 1;

    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_rsp_set_fields failed: %d", rc);
        return;
    }

    memset(&adv_params, 0, sizeof(adv_params));
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    adv_params.itvl_min = 160;   /* 100 ms */
    adv_params.itvl_max = 160;

    rc = ble_gap_adv_start(addr_type, NULL, BLE_ADV_WINDOW_MS, &adv_params,
                           on_gap_event, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_start failed: %d", rc);
        advertising = false;
        return;
    }
    advertising = true;
    ESP_LOGI(TAG, "Advertising for %d s", BLE_ADV_WINDOW_MS / 1000);
}

static int on_gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;

    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                conn_handle = event->connect.conn_handle;
                ble_chunk_reset(&rx);
                /* A new peer starts from nothing. Whatever the last one
                 * negotiated - or left half-asked - is not theirs to
                 * continue. */
                ble_drop_queued_requests();
                session_reset();
                /* The MTU is logged at connect and again if it changes: the
                 * host cannot read the negotiated value on any btleplug
                 * backend, so this line is how bring-up sees it. Chunking uses
                 * the negotiated value, never an assumed one — a notification
                 * larger than the link MTU is truncated silently and reaches
                 * the host as a corrupt frame. */
                ESP_LOGI(TAG, "Connected; MTU %d", ble_att_mtu(conn_handle));
                /* The controller stops advertising on connect. Recording it
                 * keeps `advertising` honest, so a button press during a live
                 * session does not try to re-open a window that is not open
                 * and does not need to be. */
                advertising = false;
            } else if (running) {
                ble_advertise();
            }
            return 0;

        case BLE_GAP_EVENT_ADV_COMPLETE:
            /* The window closed with nobody connecting. Not an error and not a
             * fault: it is the whole point. The transport stays enabled, so a
             * press re-opens it without a reboot or a menu. */
            advertising = false;
            ESP_LOGI(TAG, "Advertising window closed; press a button to advertise again");
            return 0;

        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGI(TAG, "Disconnected: %d", event->disconnect.reason);
            conn_handle = BLE_HS_CONN_HANDLE_NONE;
            ble_chunk_reset(&rx);
            ble_drop_queued_requests();
            session_reset();
            if (running) {
                ble_advertise();
            }
            return 0;

        case BLE_GAP_EVENT_MTU:
            ESP_LOGI(TAG, "MTU now %d", event->mtu.value);
            return 0;

        default:
            return 0;
    }
}

/*
 * Drop the radio to 0 dBm once the controller is up.
 *
 * The build's PHY ceiling is 20 dBm (100 mW) and nothing lowered it, which is a
 * setting for reaching across a building. This device is held in one hand and
 * talks to a laptop on the same desk; 0 dBm still covers several metres. The
 * radio was the board's largest continuous draw and the Pixie is a small sealed
 * handheld, so the same watts are felt directly in the hand.
 *
 * It is worth being clear that this is not a security trade. Nothing here
 * touches pairing, the session key or the encryption; the only thing that
 * shrinks is the distance from which the device can be heard at all, which
 * moves in the safe direction.
 *
 * ESP32-C3 only: `esp_ble_tx_power_set` is not provided for the S3 in this
 * IDF, and the S3 devkit is mains-powered on an open board with room to shed
 * heat -- it is not the one anybody is holding.
 */
#if defined(CONFIG_IDF_TARGET_ESP32C3)
#include "esp_bt.h"
static void ble_lower_tx_power(void)
{
    esp_err_t err = esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, ESP_PWR_LVL_N0);
    if (err != ESP_OK) {
        /* Not fatal: a radio at full power still works, it is just warm. Say
         * so rather than fail a transport the user is waiting on. */
        ESP_LOGW(TAG, "Could not lower BLE TX power: %d", err);
        return;
    }
    ESP_LOGI(TAG, "BLE TX power set to 0 dBm");
}
#else
static void ble_lower_tx_power(void) { }
#endif

static void on_sync(void)
{
    ble_lower_tx_power();

    if (ble_hs_util_ensure_addr(0) != 0) {
        ESP_LOGE(TAG, "No usable BLE address");
        return;
    }
    if (ble_hs_id_infer_auto(0, &addr_type) != 0) {
        ESP_LOGE(TAG, "Could not determine address type");
        return;
    }
    if (running) {
        ble_advertise();
    }
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "BLE stack reset: %d", reason);
    conn_handle = BLE_HS_CONN_HANDLE_NONE;
    ble_chunk_reset(&rx);
}

static void ble_host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

/* ------------------------------------------------------------- lifecycle */

bool ble_transport_start(void)
{
    if (running) {
        return true;
    }

    if (!work_queue) {
        work_queue = xQueueCreate(1, sizeof(BleFrameJob));
        if (!work_queue) {
            ESP_LOGE(TAG, "Out of memory for the request queue");
            return false;
        }
    }
    if (!work_task &&
        /* 10 KB: see the note on the USB task in protocol.c. This is the one
         * that actually overflowed -- unlock, over BLE, on a 4 KB stack. */
        xTaskCreate(ble_work_task, "bleproto", 10240, NULL, 4, &work_task) != pdPASS) {
        ESP_LOGE(TAG, "Could not start the BLE request task");
        return false;
    }

    if (nimble_port_init() != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init failed");
        return false;
    }

    ble_hs_cfg.sync_cb  = on_sync;
    ble_hs_cfg.reset_cb = on_reset;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set(ble_name_get());

    int rc = ble_gatts_count_cfg(gatt_services);
    if (rc == 0) {
        rc = ble_gatts_add_svcs(gatt_services);
    }
    if (rc != 0) {
        ESP_LOGE(TAG, "GATT registration failed: %d", rc);
        nimble_port_deinit();
        return false;
    }

    ble_chunk_reset(&rx);
    ble_drop_queued_requests();
    conn_handle = BLE_HS_CONN_HANDLE_NONE;
    running = true;

    if (!host_task_started) {
        nimble_port_freertos_init(ble_host_task);
        host_task_started = true;
    }

    ESP_LOGI(TAG, "BLE transport up, advertising as '%s'", ble_name_get());
    return true;
}

void ble_transport_refresh_name(void)
{
    if (!running) {
        return;     /* nothing on air; the next start reads the new name */
    }

    /* The GAP name and the scan response are two separate copies of the same
     * string, and a rename that updated only one would leave a device calling
     * itself two things depending on how you looked at it. Stopping first is
     * required: NimBLE will not accept new advertising data while advertising,
     * so a rename without this would silently keep the old name. */
    ble_svc_gap_device_name_set(ble_name_get());
    ble_gap_adv_stop();
    ble_advertise();
}

/*
 * Re-open the advertising window after it has lapsed.
 *
 * Safe to call at any time and does nothing unless it is needed: not while a
 * peer is connected (there is nothing to advertise for, and NimBLE would
 * refuse), not while already advertising, and not while the transport is
 * stopped. That means a caller may wire it to "any button press" without
 * knowing the radio's state, which is what ui.c does.
 */
void ble_transport_advertise_again(void)
{
    if (!running || advertising || conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        return;
    }
    ESP_LOGI(TAG, "Advertising window re-opened by a button press");
    ble_advertise();
}

bool ble_transport_advertising(void)
{
    return advertising;
}

void ble_transport_stop(void)
{
    if (!running) {
        return;
    }

    running = false;
    advertising = false;
    ble_gap_adv_stop();
    if (conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_terminate(conn_handle, BLE_ERR_REM_USER_CONN_TERM);
        conn_handle = BLE_HS_CONN_HANDLE_NONE;
    }
    ble_chunk_reset(&rx);
    ble_drop_queued_requests();

    nimble_port_stop();
    nimble_port_deinit();
    host_task_started = false;

    ESP_LOGI(TAG, "BLE transport down; not advertising");
}

bool ble_transport_running(void)
{
    return running;
}

#elif defined(LEEK_HOST_TEST)

/* Host stand-in: no radio, but the on/off state is real, so the host suite can
 * assert that selecting USB leaves BLE off. The chunking and dispatch this file
 * wraps are tested directly — see sim/test_ble_chunk.c. */
static bool running;
/*
 * The advertising window, modelled rather than real.
 *
 * There is no radio here, but the STATE is what ui.c drives: any button press
 * calls ble_transport_advertise_again(), so the host suite can assert that a
 * lapsed window re-opens on a press and that a press does nothing when the
 * transport is off. Modelling it as "advertising whenever running" keeps the
 * stand-in honest for every case except the lapse itself, which only the
 * controller's timer can produce.
 */
static bool advertising;

bool ble_transport_start(void)   { running = true;  advertising = true;  return true; }
void ble_transport_stop(void)    { running = false; advertising = false; }
bool ble_transport_running(void) { return running; }
bool ble_transport_advertising(void) { return advertising; }
void ble_transport_advertise_again(void)
{
    if (!running) return;      /* a press cannot start a stopped transport */
    advertising = true;
}

/* Host suite only: close the window, which on real hardware only the
 * controller's timer can do. Declared where it is used (sim/test_ui.c) rather
 * than in ble.h, so no firmware caller can reach it. */
void ble_test_close_window(void);
void ble_test_close_window(void) { advertising = false; }
/* No radio to re-advertise on; the name itself is real and tested directly
 * (src/ble-name.c, sim/test_protocol.c). */
void ble_transport_refresh_name(void) { }
void ble_transport_write_frame(const uint8_t *frame, size_t len)
{
    (void)frame; (void)len;
}

#else

/* Built without a Bluetooth stack: BLE cannot be selected, and saying so is
 * better than a transport that reports success and never advertises. */
bool ble_transport_start(void)   { return false; }
void ble_transport_stop(void)    { }
bool ble_transport_running(void) { return false; }
/* The advertising window has no meaning without a radio, but the symbols must
 * exist or every caller needs its own #if. Saying "not advertising" is also the
 * true answer on a board that cannot advertise. */
void ble_transport_advertise_again(void) { }
bool ble_transport_advertising(void)     { return false; }
void ble_transport_refresh_name(void) { }
void ble_transport_write_frame(const uint8_t *frame, size_t len)
{
    (void)frame; (void)len;
}

#endif
