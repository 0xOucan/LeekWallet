/* The QR return path's frame schedule. See qr-out.h. */

#include "qr-out.h"

#include <string.h>

#include "memzero.h"
#include "ur-encoder.h"

/* Index 0 is the default. Section 32's three strategies, in the order a user
   stepping through them would want: readable first, then fewer frames, then
   bigger modules. Periods are a starting guess for the bench to replace. */
static const QrOutMode MODES[QR_OUT_MODE_COUNT] = {
    { 6,  1, 300, "v6"    },
    { 10, 1, 400, "v10"   },
    { 3,  2, 250, "v3 x2" },
};

/* ISO 18004 table 7, alphanumeric column at level L. */
static const uint16_t ALNUM_L[10] = { 25, 47, 77, 114, 154, 195, 224, 279, 335, 395 };

/* All static: the encoder alone carries ~2 KB of fountain scratch, and the UI
   task that drives this has 8 KB of stack. */
static struct {
    bool      running;
    uint8_t   mode;
    char      type[UR_TYPE_MAX + 1];
    uint8_t   message[QR_OUT_MAX_MESSAGE];
    size_t    message_len;
    UrEncoder enc;
    uint32_t  seq_num;
    int64_t   next_us;
    char      frame[QR_OUT_MAX_PART + 1];
} out;

const QrOutMode *qr_out_mode_info(uint8_t mode)
{
    return mode < QR_OUT_MODE_COUNT ? &MODES[mode] : NULL;
}

uint16_t qr_out_alnum_capacity(uint8_t version)
{
    return (version >= 1 && version <= 10) ? ALNUM_L[version - 1] : 0;
}

static bool render_part(uint32_t seq_num)
{
    const size_t n = ur_encoder_part(&out.enc, seq_num, out.frame, sizeof out.frame);
    if (n == 0) {
        return false;
    }
    ur_to_upper(out.frame);
    return true;
}

/* Largest fragment whose worst part fits `capacity` characters. Tried from the
   top down with a real encoding rather than a formula, because the CBOR and
   Bytewords overheads each have steps in them and a formula that is wrong by
   one character draws a frame the QR encoder refuses. */
static bool choose_fragment(size_t capacity)
{
    /* Start just above the best case so this is a few tries, not a hundred:
       the part is at least "ur:" type "/1-2/" of text, then two characters a
       byte for a 9-byte CBOR envelope, the fragment and a 4-byte CRC. */
    const size_t fixed = 3 + strlen(out.type) + 5;
    if (capacity <= fixed + 2 * (9 + 4 + UR_MIN_FRAGMENT_LEN)) {
        return false;
    }
    const size_t top = (capacity - fixed) / 2 - 9 - 4;
    for (size_t frag = top; frag >= UR_MIN_FRAGMENT_LEN; frag--) {
        if (!ur_encoder_init(&out.enc, out.type, out.message, out.message_len, frag)) {
            continue;   /* too many parts at this size; smaller will not help */
        }
        const uint32_t worst = ur_encoder_is_single_part(&out.enc) ? 1 : QR_OUT_SEQ_WRAP;
        if (!render_part(worst)) {
            continue;
        }
        if (strlen(out.frame) <= capacity) {
            return true;
        }
    }
    return false;
}

static bool restart(uint8_t mode, int64_t now_us)
{
    const QrOutMode *m = qr_out_mode_info(mode);
    if (m == NULL) {
        return false;
    }
    if (!choose_fragment(qr_out_alnum_capacity(m->version))) {
        return false;
    }
    out.mode = mode;
    out.seq_num = 1;
    if (!render_part(out.seq_num)) {
        return false;
    }
    out.next_us = now_us + (int64_t)m->period_ms * 1000;
    out.running = true;
    return true;
}

bool qr_out_start(const char *type, const uint8_t *cbor, size_t len,
                  uint8_t mode, int64_t now_us)
{
    qr_out_stop();
    if (type == NULL || cbor == NULL || len == 0 || len > QR_OUT_MAX_MESSAGE ||
        strlen(type) > UR_TYPE_MAX) {
        return false;
    }
    memcpy(out.type, type, strlen(type) + 1);
    memcpy(out.message, cbor, len);
    out.message_len = len;
    if (!restart(mode, now_us)) {
        qr_out_stop();
        return false;
    }
    return true;
}

bool qr_out_set_mode(uint8_t mode, int64_t now_us)
{
    if (out.message_len == 0) {
        return false;
    }
    const uint8_t was = out.mode;
    if (restart(mode, now_us)) {
        return true;
    }
    /* Leave the old mode running rather than a blank screen. */
    (void)restart(was, now_us);
    return false;
}

bool qr_out_tick(int64_t now_us)
{
    if (!out.running || ur_encoder_is_single_part(&out.enc) || now_us < out.next_us) {
        return false;
    }
    out.seq_num = out.seq_num >= QR_OUT_SEQ_WRAP ? 1 : out.seq_num + 1;
    if (!render_part(out.seq_num)) {
        out.running = false;
        return false;
    }
    out.next_us = now_us + (int64_t)MODES[out.mode].period_ms * 1000;
    return true;
}

const char *qr_out_frame(void)
{
    return out.running ? out.frame : NULL;
}

uint8_t qr_out_current_mode(void)  { return out.mode; }
uint32_t qr_out_seq_len(void)      { return out.running ? out.enc.seq_len : 0; }
uint32_t qr_out_seq_num(void)      { return out.running ? out.seq_num : 0; }

void qr_out_stop(void)
{
    /* An xpub is not a secret, but it links every address in an account, and
       a signature is somebody's transaction. Neither needs to outlive the
       screen that showed it. */
    memzero(&out, sizeof out);
}
