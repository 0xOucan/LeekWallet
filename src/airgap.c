/* The QR entrance. See airgap.h. */

#include "airgap.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

#include "memzero.h"
#include "ur-decoder.h"

static const char *TAG = "airgap";

/* ------------------------------------------------------------ assembly */

/* Sized for the largest request the reader accepts - 1 KB of sign-data plus
   its keypath and ids, well under 1.2 KB of CBOR - with room for the last
   fragment's padding. `scan_mixed` holds UR_DECODER_MIXED fragments of up to
   512 bytes, which is larger than any frame a phone animates. The decoder
   refuses anything that would not fit at the first part, so a sender cannot
   walk it past these. */
static uint8_t  scan_fragments[2048];
static uint8_t  scan_mixed[UR_DECODER_MIXED * 512];
static UrDecoder scan;
static bool     scan_ready;

/* Static rather than on the UI task's stack: it is 1.2 KB. */
static E4527SignRequest scanned_request;

void airgap_scan_reset(void)
{
    if (!scan_ready) {
        ur_decoder_init(&scan, scan_fragments, sizeof scan_fragments,
                        scan_mixed, sizeof scan_mixed);
        scan_ready = true;
    } else {
        ur_decoder_reset(&scan);
    }
    memzero(scan_fragments, sizeof scan_fragments);
    memzero(scan_mixed, sizeof scan_mixed);
}

uint32_t airgap_scan_remaining(void)
{
    return scan_ready ? ur_decoder_remaining(&scan) : 0;
}

AirgapScan airgap_scan_feed(const char *ur, size_t len)
{
    if (!scan_ready) {
        airgap_scan_reset();
    }
    const UrPartResult r = ur_decoder_receive(&scan, ur, len);
    if (r == UR_PART_ACCEPTED) {
        return AIRGAP_SCAN_ACCEPTED;
    }
    if (r == UR_PART_REDUNDANT) {
        return AIRGAP_SCAN_REDUNDANT;
    }
    if (r == UR_PART_REJECTED) {
        return AIRGAP_SCAN_UNREADABLE;
    }

    /* Complete. Whatever happens next, this assembly is finished with: the
       next scan starts clean rather than being pinned to this message. */
    AirgapScan out;
    size_t n = 0;
    const uint8_t *msg = ur_decoder_message(&scan, &n);
    const char *field = NULL;

    if (strcmp(scan.type, "eth-sign-request") != 0) {
        out = AIRGAP_SCAN_WRONG_TYPE;
    } else if (msg == NULL ||
               eip4527_decode_sign_request(msg, n, &scanned_request, &field) != E4527_OK) {
        ESP_LOGW(TAG, "sign request refused in %s", field ? field : "?");
        out = AIRGAP_SCAN_BAD_REQUEST;
    } else if (!airgap_submit(&scanned_request)) {
        out = AIRGAP_SCAN_BUSY;
    } else {
        out = AIRGAP_SCAN_SUBMITTED;
    }
    memzero(&scanned_request, sizeof scanned_request);
    airgap_scan_reset();
    return out;
}

/* -------------------------------------------------------------- worker */

size_t airgap_sign_and_encode(const E4527SignRequest *req,
                              uint8_t *out, size_t out_size, TxSignResult *rc)
{
    uint8_t sig[65];
    *rc = protocol_airgap_sign(req, sig);
    if (*rc != TXSIGN_OK) {
        return 0;
    }
    /* The request id is echoed exactly; it is how the companion knows which
       of its requests this answers, and it rejects a mismatch. No origin: the
       companion knows which device it asked. */
    const size_t n = eip4527_encode_signature(req->request_id, sig, NULL,
                                              out, out_size);
    memzero(sig, sizeof sig);
    if (n == 0) {
        *rc = TXSIGN_UNENCODABLE;
    }
    return n;
}

/* Written by the worker, read by the UI. `state` is published last with
   release ordering, so the UI never sees DONE before the bytes it names. */
static AirgapState   state = AIRGAP_IDLE;
static TxSignResult  result_rc;
static uint8_t       result[E4527_SIGNATURE_MAX];
static size_t        result_len;
static E4527SignRequest pending;

static void run_pending(void)
{
    TxSignResult rc;
    result_len = airgap_sign_and_encode(&pending, result, sizeof result, &rc);
    result_rc = rc;
    memzero(&pending, sizeof pending);
    __atomic_store_n(&state, rc == TXSIGN_OK ? AIRGAP_DONE : AIRGAP_FAILED,
                     __ATOMIC_RELEASE);
}

/* The one transition out of IDLE, so two submits cannot both win. */
static bool claim_idle(void)
{
    AirgapState expected = AIRGAP_IDLE;
    return __atomic_compare_exchange_n(&state, &expected, AIRGAP_WORKING, false,
                                       __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE);
}

#ifdef LEEK_HOST_TEST

void airgap_start(void)
{
}

bool airgap_submit(const E4527SignRequest *req)
{
    if (req == NULL || !claim_idle()) {
        return false;
    }
    pending = *req;
    run_pending();
    return true;
}

#else

static volatile bool work_queued;

static void airgap_task(void *arg)
{
    (void)arg;
    for (;;) {
        if (__atomic_load_n(&work_queued, __ATOMIC_ACQUIRE)) {
            __atomic_store_n(&work_queued, false, __ATOMIC_RELEASE);
            run_pending();
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

void airgap_start(void)
{
    /* Same size as the protocol task and for the same reasons: this runs the
       same signing path, eth_tx_hash's buffers and BIP32 derivation, plus
       eth-tx-rlp.c's re-encode check. */
    xTaskCreate(airgap_task, "airgap", 10240, NULL, 4, NULL);
}

bool airgap_submit(const E4527SignRequest *req)
{
    if (req == NULL || !claim_idle()) {
        return false;
    }
    pending = *req;
    __atomic_store_n(&work_queued, true, __ATOMIC_RELEASE);
    return true;
}

#endif

AirgapState airgap_poll(const uint8_t **cbor, size_t *len, TxSignResult *rc)
{
    const AirgapState s = __atomic_load_n(&state, __ATOMIC_ACQUIRE);
    if (s == AIRGAP_DONE) {
        if (cbor) *cbor = result;
        if (len) *len = result_len;
    }
    if (s == AIRGAP_FAILED && rc) {
        *rc = result_rc;
    }
    return s;
}

void airgap_acknowledge(void)
{
    const AirgapState s = __atomic_load_n(&state, __ATOMIC_ACQUIRE);
    if (s != AIRGAP_DONE && s != AIRGAP_FAILED) {
        return;     /* the worker still owns the buffers */
    }
    memzero(result, sizeof result);
    result_len = 0;
    result_rc = TXSIGN_OK;
    __atomic_store_n(&state, AIRGAP_IDLE, __ATOMIC_RELEASE);
}

const char *airgap_refusal_text(TxSignResult rc)
{
    switch (rc) {
        case TXSIGN_OK:             return "Signed";
        case TXSIGN_BUSY:           return "Device busy";
        case TXSIGN_LOCKED:         return "Device locked";
        case TXSIGN_MALFORMED:      return "Request refused";
        case TXSIGN_PATH_MISMATCH:  return "Not this wallet";
        case TXSIGN_UNDECODABLE:    return "Can't show call";
        case TXSIGN_NO_WALLET:      return "Derivation failed";
        case TXSIGN_TIMEOUT:        return "No answer";
        case TXSIGN_REJECTED:       return "Rejected";
        case TXSIGN_WALLET_CHANGED: return "Wallet changed";
        case TXSIGN_UNENCODABLE:    return "Encode failed";
        case TXSIGN_SIGN_FAILED:
        default:                    return "Signing failed";
    }
}
