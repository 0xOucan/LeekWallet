/**
 * QR generation bounds.
 *
 * Upstream ricmoo/QRCode checks nothing: bb_appendBits wrote wherever the bit
 * offset pointed, and qrcode_initText never compared the data against the
 * version's capacity. The codeword buffer is sized to the version's total
 * modules while the usable data capacity is that minus the error-correction
 * codewords, and the difference was the only thing between a long string and a
 * smashed stack.
 *
 * Nothing shipping reached it - the sole call site draws a 42-character
 * address - so this suite exists to keep it that way while the QR output path
 * starts feeding the encoder strings whose length comes off the wire.
 */

#include <stdio.h>
#include <string.h>

#include "qrcode.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* A canary either side of the module buffer, so a write past the end is caught
   here rather than by whatever the stack happened to hold on a device. */
static void test_oversized_input_is_refused(void)
{
    printf("== a string too long for the version is refused\n");

    for (uint8_t version = 1; version <= 6; version++) {
        struct {
            uint8_t guard_low[32];
            uint8_t modules[qrcode_getBufferSize(6)];
            uint8_t guard_high[32];
        } arena;
        memset(&arena, 0xA5, sizeof arena);

        /* Comfortably past any version-6 capacity. */
        char data[512];
        memset(data, 'M', sizeof data - 1);
        data[sizeof data - 1] = '\0';

        QRCode qr;
        const int8_t rc = qrcode_initText(&qr, arena.modules, version,
                                          ECC_LOW, data);
        CHECK(rc != 0, "version %u accepted a 511-character string", version);

        for (size_t i = 0; i < sizeof arena.guard_low; i++) {
            CHECK(arena.guard_low[i] == 0xA5,
                  "version %u wrote before the module buffer", version);
            CHECK(arena.guard_high[i] == 0xA5,
                  "version %u wrote past the module buffer", version);
        }
    }
}

/* The refusal must be tight enough to be useful: what fits still has to work,
   or the fix has broken the only feature that uses this. */
static void test_what_fits_still_encodes(void)
{
    printf("== an address still encodes, at the versions the UI uses\n");

    const char *address = "0x8ed185f95d62a60cc3cf2688ffe3a250b3a8262b";
    CHECK(strlen(address) == 42, "test address is the wrong length");

    for (uint8_t version = 3; version <= 4; version++) {
        uint8_t modules[qrcode_getBufferSize(4)];
        QRCode qr;
        const int8_t rc = qrcode_initText(&qr, modules, version, ECC_LOW,
                                          address);
        if (version == 4) {
            CHECK(rc == 0, "version 4 refused a 42-character address");
            CHECK(qr.size == 33, "version 4 should be 33 modules, got %u",
                  qr.size);
        }
        /* Version 3 at ECC_LOW holds 53 bytes, so it should also fit. */
        if (version == 3) {
            CHECK(rc == 0, "version 3 refused a 42-character address");
        }
    }
}

/* Walk the boundary: at some length the encoder must switch from success to
   refusal exactly once, and never come back. */
static void test_boundary_is_monotonic(void)
{
    printf("== the accept/refuse boundary is crossed once\n");

    uint8_t modules[qrcode_getBufferSize(4)];
    char data[256];
    int transitions = 0;
    int8_t previous = 0;

    for (size_t len = 1; len < 200; len++) {
        memset(data, 'M', len);
        data[len] = '\0';

        QRCode qr;
        const int8_t rc = qrcode_initText(&qr, modules, 4, ECC_LOW, data);
        const int8_t ok = (rc == 0);
        if (len > 1 && ok != previous) {
            transitions++;
        }
        previous = ok;
    }
    CHECK(transitions == 1, "boundary crossed %d times, want 1", transitions);
    CHECK(previous == 0, "a 199-character string was still accepted at v4");
}

int main(void)
{
    test_oversized_input_is_refused();
    test_what_fits_still_encodes();
    test_boundary_is_monotonic();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
