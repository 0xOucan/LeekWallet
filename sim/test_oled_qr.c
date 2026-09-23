/**
 * The QR renderer in oled-core.c, against a framebuffer rather than a panel.
 *
 * Two things matter. The address QR, which has shipped since the first
 * release, must come out pixel for pixel as it always did: the golden CRCs
 * below were recorded from oled-core.c BEFORE the version/scale choice was
 * added, so a refactor that moves one module fails here. And the new entry
 * point must honour the panel's two ceilings - version 10 at scale 1, version 3
 * at scale 2 - and refuse anything past them rather than draw a code whose
 * bottom rows fall off the screen.
 */

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "oled.h"
#include "oled-core.h"
#include "qrcode.h"
#include "ur.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Logging goes nowhere; esp_stubs.c would drag in far more than this needs. */
void leek_log(const char *level, const char *tag, const char *fmt, ...) { }

/* The transport half, which the host has no panel for. */
static int refreshes;
esp_err_t oled_refresh(void) { refreshes++; return ESP_OK; }

static uint32_t fb_crc(void)
{
    return ur_crc32(oled_core_framebuffer(), OLED_WIDTH * OLED_PAGES);
}

static const struct { const char *data; uint32_t crc; } GOLDEN[] = {
    { "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", 0x30b80b1au },
    { "0x0000000000000000000000000000000000000000", 0x2961556fu },
    /* Long enough to push the fallback to version 4. */
    { "ethereum:0x9858EfFD232B4033E47d90003D41EC34EcaEda94@1", 0xc1147541u },
};

static void test_address_qr_is_unchanged(bool record)
{
    printf("== the address QR is drawn exactly as before\n");
    for (size_t i = 0; i < sizeof GOLDEN / sizeof GOLDEN[0]; i++) {
        CHECK(oled_draw_qrcode(GOLDEN[i].data) == ESP_OK, "draw failed");
        const uint32_t crc = fb_crc();
        if (record) {
            printf("    { \"%s\", 0x%08xu },\n", GOLDEN[i].data, crc);
        } else {
            CHECK(crc == GOLDEN[i].crc, "'%s' drew 0x%08x, was 0x%08x",
                  GOLDEN[i].data, crc, GOLDEN[i].crc);
        }
    }
}

static bool pixel_dark(unsigned x, unsigned y)
{
    const uint8_t *fb = oled_core_framebuffer();
    return (fb[(y / 8) * OLED_WIDTH + x] & (1u << (y % 8))) == 0;
}

/* Rows and columns holding any dark module. */
static void dark_bounds(unsigned *top, unsigned *bottom, unsigned *left, unsigned *right)
{
    *top = OLED_HEIGHT; *bottom = 0; *left = OLED_WIDTH; *right = 0;
    for (unsigned y = 0; y < OLED_HEIGHT; y++) {
        for (unsigned x = 0; x < OLED_WIDTH; x++) {
            if (pixel_dark(x, y)) {
                if (y < *top) *top = y;
                if (y > *bottom) *bottom = y;
                if (x < *left) *left = x;
                if (x > *right) *right = x;
            }
        }
    }
}

/* Bounds of the lit pixels, and of the dark pixels inside a box. The QR screen
   draws only the code and its quiet zone lit, with the rest of the panel off,
   so the code is found as the dark pixels within the lit frame. */
static void lit_bounds(unsigned *top, unsigned *bottom, unsigned *left, unsigned *right)
{
    *top = OLED_HEIGHT; *bottom = 0; *left = OLED_WIDTH; *right = 0;
    for (unsigned y = 0; y < OLED_HEIGHT; y++) {
        for (unsigned x = 0; x < OLED_WIDTH; x++) {
            if (!pixel_dark(x, y)) {
                if (y < *top) *top = y;
                if (y > *bottom) *bottom = y;
                if (x < *left) *left = x;
                if (x > *right) *right = x;
            }
        }
    }
}

static void dark_bounds_in(unsigned t0, unsigned b0, unsigned l0, unsigned r0,
                           unsigned *top, unsigned *bottom, unsigned *left, unsigned *right)
{
    *top = OLED_HEIGHT; *bottom = 0; *left = OLED_WIDTH; *right = 0;
    for (unsigned y = t0; y <= b0; y++) {
        for (unsigned x = l0; x <= r0; x++) {
            if (pixel_dark(x, y)) {
                if (y < *top) *top = y;
                if (y > *bottom) *bottom = y;
                if (x < *left) *left = x;
                if (x > *right) *right = x;
            }
        }
    }
}

static void test_the_two_ceilings(void)
{
    printf("== version 10 at scale 1 and version 3 at scale 2, nothing past them\n");

    CHECK(oled_qr_fits(10, 1), "version 10 at scale 1 should fit");
    CHECK(!oled_qr_fits(11, 1), "version 11 at scale 1 is 65 rows");
    CHECK(oled_qr_fits(3, 2), "version 3 at scale 2 should fit");
    CHECK(!oled_qr_fits(4, 2), "version 4 at scale 2 is 70 rows");
    CHECK(!oled_qr_fits(0, 1) && !oled_qr_fits(1, 0) && !oled_qr_fits(1, 3),
          "a degenerate version or scale was accepted");

    CHECK(oled_draw_qrcode_at("UR:BYTES/X", 11, 1) == ESP_ERR_INVALID_ARG,
          "version 11 was drawn");
    CHECK(oled_draw_qrcode_at("UR:BYTES/X", 4, 2) == ESP_ERR_INVALID_ARG,
          "version 4 at scale 2 was drawn");
    CHECK(oled_draw_qrcode_at(NULL, 3, 2) == ESP_ERR_INVALID_ARG, "NULL was drawn");

    /* Every dark module inside the panel with its 2 px quiet zone intact.
       57 modules + 4 = 61 rows at version 10, 29 * 2 + 4 = 62 at version 3. */
    static const struct { uint8_t v, s; } MODES[] = { {10, 1}, {6, 1}, {3, 2} };
    for (size_t i = 0; i < sizeof MODES / sizeof MODES[0]; i++) {
        CHECK(oled_draw_qrcode_at("UR:ETH-SIGNATURE/1-2/LPAD", MODES[i].v,
                                  MODES[i].s) == ESP_OK,
              "version %u scale %u did not draw", MODES[i].v, MODES[i].s);
        unsigned ft, fb, fl, fr, t, b, l, r;
        lit_bounds(&ft, &fb, &fl, &fr);
        dark_bounds_in(ft, fb, fl, fr, &t, &b, &l, &r);
        const unsigned side = (MODES[i].v * 4u + 17u) * MODES[i].s;
        CHECK(t >= 2 && b <= OLED_HEIGHT - 3 && b - t + 1 == side &&
              r - l + 1 == side,
              "version %u scale %u spans rows %u-%u cols %u-%u, want a %u px square",
              MODES[i].v, MODES[i].s, t, b, l, r, side);
        /* Four modules of lit quiet zone left and right, and the panel beyond
           the frame dark: the lit slabs either side are what blinded a webcam. */
        const unsigned margin = 4u * MODES[i].s;
        CHECK(l - fl == margin && fr - r == margin,
              "version %u scale %u has a %u/%u px side margin, want %u",
              MODES[i].v, MODES[i].s, l - fl, fr - r, margin);
        CHECK(pixel_dark(0, 32) && pixel_dark(OLED_WIDTH - 1, 32),
              "version %u scale %u left the panel edges lit", MODES[i].v, MODES[i].s);
    }
}

static void test_uppercase_reaches_alphanumeric(void)
{
    printf("== an uppercased UR fits where the lowercase one cannot\n");

    /* 395 characters is version 10's alphanumeric capacity at ECC_LOW and
       well past its 271-byte byte-mode one: the 46 percent section 32
       promised, and the reason the return path uppercases. */
    char ur[396];
    memcpy(ur, "ur:eth-signature/", 17);
    for (size_t i = 17; i < 395; i++) {
        ur[i] = "lpadaxbwhdcx"[i % 12];
    }
    ur[395] = '\0';
    CHECK(oled_draw_qrcode_at(ur, 10, 1) == ESP_ERR_INVALID_SIZE,
          "a lowercase 395-character UR fit version 10, so it was not byte mode");
    for (size_t i = 0; i < 395; i++) {
        if (ur[i] >= 'a' && ur[i] <= 'z') ur[i] = (char)(ur[i] - 32);
    }
    CHECK(oled_draw_qrcode_at(ur, 10, 1) == ESP_OK,
          "an uppercase 395-character UR did not fit version 10");
    ur[394] = '\0';
    char longer[400];
    snprintf(longer, sizeof longer, "%sAB", ur);
    CHECK(oled_draw_qrcode_at(longer, 10, 1) == ESP_ERR_INVALID_SIZE,
          "396 characters fit version 10 - the capacity check is gone");
}

int main(int argc, char **argv)
{
    test_address_qr_is_unchanged(argc > 1 && strcmp(argv[1], "--record") == 0);
    test_the_two_ceilings();
    test_uppercase_reaches_alphanumeric();
    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
