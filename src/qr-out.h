/**
 * The QR return path: a message, cut into UR parts that each fit one frame of
 * the 128x64 panel, cycled on a timer.
 *
 * ---------------------------------------------------------------------------
 * Why this is not in ui.c
 *
 * Which frame goes out when, and whether it fits, is arithmetic that can be
 * checked on the host against the real QR encoder. The screen that shows it is
 * a thin wrapper in ui.c. Kept apart, the host can prove that every frame of
 * every mode fits its version before a camera is ever pointed at one.
 *
 * ---------------------------------------------------------------------------
 * The modes
 *
 * RESEARCH-AIRGAP-VAULT.md section 32: the trade is module size against frame
 * count, and only the bench can say which one the OV5640 reads off this panel.
 * So all three candidates are here and the user can step between them; the
 * default is the one that section calls "animated, readable".
 *
 * ---------------------------------------------------------------------------
 * Fit is guaranteed, not hoped for
 *
 * A part's length grows with its sequence number (more digits, a wider CBOR
 * integer), and fountain parts go on forever. So the sequence wraps at
 * QR_OUT_SEQ_WRAP, and the fragment length is chosen at start as the largest
 * one whose part QR_OUT_SEQ_WRAP still fits the mode's alphanumeric capacity.
 * Every frame drawn is therefore no longer than one already measured.
 */

#ifndef LEEK_QR_OUT_H
#define LEEK_QR_OUT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Largest message the return path carries: an xpub or a signature is ~100. */
#define QR_OUT_MAX_MESSAGE 256

/** Longest part text, which is version 10's alphanumeric capacity. */
#define QR_OUT_MAX_PART 395

/**
 * Where the sequence starts over. Past 255 the CBOR sequence number grows a
 * byte and the part outgrows what was measured; restarting is harmless, since
 * a receiver treats a repeat as redundant.
 */
#define QR_OUT_SEQ_WRAP 255

typedef struct {
    uint8_t     version;
    uint8_t     scale;
    uint16_t    period_ms;
    const char *name;        /* six characters or fewer, for the footer */
} QrOutMode;

#define QR_OUT_MODE_COUNT 3
#define QR_OUT_MODE_DEFAULT 0

const QrOutMode *qr_out_mode_info(uint8_t mode);

/** QR alphanumeric capacity at ECC_LOW, in characters, for versions 1-10. */
uint16_t qr_out_alnum_capacity(uint8_t version);

/**
 * Start showing `cbor` as a `ur:<type>` in `mode`. The message is copied.
 * Returns false if it is too long, the type is invalid, or no fragment length
 * fits the mode - in which case nothing is shown.
 */
bool qr_out_start(const char *type, const uint8_t *cbor, size_t len,
                  uint8_t mode, int64_t now_us);

/** Same message, another mode. Starts again from part 1. */
bool qr_out_set_mode(uint8_t mode, int64_t now_us);

/** Advance if the current frame has been up for its period. True if it did. */
bool qr_out_tick(int64_t now_us);

/** The frame to draw now, uppercased, or NULL when nothing is running. */
const char *qr_out_frame(void);

uint8_t  qr_out_current_mode(void);
uint32_t qr_out_seq_len(void);      /* 1 for a static single-part code */
uint32_t qr_out_seq_num(void);

/** Forget the message and zero every buffer. */
void qr_out_stop(void);

#endif /* LEEK_QR_OUT_H */
