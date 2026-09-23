/**
 * The QR return path's schedule, against the real QR encoder.
 *
 * The claim qr-out.c makes is that every frame it will ever hand the panel
 * fits the mode's version. Here every frame of a full cycle, in every mode,
 * for the message sizes the device actually sends (a signature, an xpub) and
 * the largest it accepts, is fed to qrcode_initText at that version - the
 * exact call oled_draw_qrcode_at() makes - and then read back by ur-decoder.c.
 */

#include <stdio.h>
#include <string.h>

#include "qr-out.h"
#include "qrcode.h"
#include "ur-decoder.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static uint8_t fragments[8 * 1024];
static uint8_t mixed[8 * 1024];
static UrDecoder dec;

static void test_every_frame_fits_and_decodes(void)
{
    printf("== every frame of every mode fits its version and decodes\n");

    static const size_t LENGTHS[] = { 1, 20, 87, 90, 104, 150, QR_OUT_MAX_MESSAGE };
    uint8_t msg[QR_OUT_MAX_MESSAGE];
    for (size_t i = 0; i < sizeof msg; i++) {
        msg[i] = (uint8_t)(i * 29 + 1);
    }

    for (uint8_t mode = 0; mode < QR_OUT_MODE_COUNT; mode++) {
        const QrOutMode *m = qr_out_mode_info(mode);
        for (size_t li = 0; li < sizeof LENGTHS / sizeof LENGTHS[0]; li++) {
            const size_t len = LENGTHS[li];
            int64_t now = 0;
            const bool started = qr_out_start("eth-signature", msg, len, mode, now);
            /* Version 3 at scale 2 is the mode section 32 warned about: 77
               characters, most of them envelope. It carries what the device
               actually sends - a ~90-byte signature, a ~110-byte xpub - and
               must refuse, not truncate, anything it cannot. */
            const bool must = m->version > 3 || len <= 150;
            CHECK(started || !must, "%zu bytes would not start in mode %s", len, m->name);
            if (!started) {
                CHECK(qr_out_frame() == NULL, "a refused start left a frame up");
                continue;
            }
            ur_decoder_init(&dec, fragments, sizeof fragments, mixed, sizeof mixed);
            bool complete = false;

            for (uint32_t f = 0; f < QR_OUT_SEQ_WRAP + 3; f++) {
                const char *frame = qr_out_frame();
                uint8_t grid[512];
                QRCode qr;
                CHECK(frame != NULL && qrcode_initText(&qr, grid, m->version, ECC_LOW, frame) == 0,
                      "mode %s, %zu bytes, part %u (%zu chars) does not fit version %u",
                      m->name, len, qr_out_seq_num(), frame ? strlen(frame) : 0,
                      m->version);
                if (frame != NULL && !complete) {
                    const UrPartResult r = ur_decoder_receive(&dec, frame, strlen(frame));
                    CHECK(r != UR_PART_REJECTED, "the decoder refused part %u",
                          qr_out_seq_num());
                    complete = (r == UR_PART_COMPLETE);
                }
                if (qr_out_seq_len() == 1) {
                    CHECK(!qr_out_tick(now + 10000000), "a static code advanced");
                    break;
                }
                /* Not due yet: the frame stays. */
                CHECK(!qr_out_tick(now + 1), "advanced before its period");
                now += (int64_t)m->period_ms * 1000;
                CHECK(qr_out_tick(now), "did not advance after its period");
            }
            size_t out_len = 0;
            const uint8_t *out = ur_decoder_message(&dec, &out_len);
            CHECK(complete && out != NULL && out_len == len && memcmp(out, msg, len) == 0,
                  "mode %s, %zu bytes did not reassemble", m->name, len);
        }
    }
    qr_out_stop();
}

static void test_the_wrap(void)
{
    printf("== the sequence wraps before a part can outgrow its frame\n");

    uint8_t msg[120] = {0};
    CHECK(qr_out_start("crypto-hdkey", msg, sizeof msg, 2, 0), "did not start");
    int64_t now = 0;
    uint32_t last = 0;
    for (uint32_t i = 0; i < QR_OUT_SEQ_WRAP; i++) {
        last = qr_out_seq_num();
        now += 1000000;
        qr_out_tick(now);
    }
    CHECK(last == QR_OUT_SEQ_WRAP && qr_out_seq_num() == 1,
          "after part %u came %u, not 1", last, qr_out_seq_num());
    qr_out_stop();
}

static void test_refusals_and_modes(void)
{
    printf("== a mode switch restarts; oversized input shows nothing\n");

    uint8_t msg[QR_OUT_MAX_MESSAGE + 1] = {0};
    CHECK(!qr_out_start("eth-signature", msg, sizeof msg, 0, 0),
          "a message over QR_OUT_MAX_MESSAGE started");
    CHECK(qr_out_frame() == NULL, "a refused start left a frame up");
    CHECK(!qr_out_start("Bad Type", msg, 10, 0, 0), "an invalid type started");
    CHECK(!qr_out_start("eth-signature", msg, 10, QR_OUT_MODE_COUNT, 0),
          "a mode past the table started");

    CHECK(qr_out_start("eth-signature", msg, 90, 0, 0), "did not start");
    qr_out_tick(10000000);
    CHECK(qr_out_seq_num() == 2, "did not advance");
    CHECK(qr_out_set_mode(2, 10000000) && qr_out_seq_num() == 1 &&
          qr_out_current_mode() == 2, "a mode switch did not restart at part 1");
    CHECK(!qr_out_set_mode(9, 0) && qr_out_current_mode() == 2 && qr_out_frame() != NULL,
          "a bad mode switch blanked the running one");

    /* Section 32's arithmetic, now measured: a 90-byte signature is one
       frame at version 10 and several at version 3 scale 2. */
    qr_out_set_mode(1, 0);
    const uint32_t dense = qr_out_seq_len();
    qr_out_set_mode(2, 0);
    const uint32_t chunky = qr_out_seq_len();
    printf("    90-byte eth-signature: v10 %u frame(s), v6 ", dense);
    qr_out_set_mode(0, 0);
    printf("%u, v3x2 %u\n", qr_out_seq_len(), chunky);
    CHECK(dense == 1, "a signature needs %u frames at version 10", dense);
    CHECK(chunky > 1, "version 3 at scale 2 held a whole signature");

    qr_out_stop();
    CHECK(qr_out_frame() == NULL, "stop left a frame up");
}

int main(void)
{
    test_every_frame_fits_and_decodes();
    test_the_wrap();
    test_refusals_and_modes();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
