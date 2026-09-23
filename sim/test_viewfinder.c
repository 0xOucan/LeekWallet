/**
 * Host-native tests for src/viewfinder.c - the Scan screen's aiming aid.
 *
 * A preview that is mirrored, rotated, or off by a factor of the downsample
 * ratio is worse than none: the user corrects their aim in the wrong
 * direction and concludes the camera is broken. On hardware that is a
 * bring-up day; here it is a synthetic frame with a bright rectangle in a
 * known corner and an assertion about which corner it lands in.
 *
 * The other thing checked here is the per-frame threshold. A fixed one is
 * wrong under the next light source, so a dim frame and a bright frame that
 * differ only by a constant offset must produce the identical panel.
 */

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "viewfinder.h"

#define FW 320
#define FH 240

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static uint8_t frame[FW * FH];
static uint8_t panel[VIEWFINDER_BYTES];

static void frame_fill(uint8_t v)
{
    memset(frame, v, sizeof frame);
}

/* Bright block over [x0,x1) x [y0,y1) in frame coordinates. */
static void frame_rect(int x0, int y0, int x1, int y1, uint8_t v)
{
    for (int y = y0; y < y1; y++) {
        for (int x = x0; x < x1; x++) {
            frame[y * FW + x] = v;
        }
    }
}

static bool panel_pixel(int x, int y)
{
    return (panel[(y / 8) * VIEWFINDER_W + x] >> (y % 8)) & 1u;
}

static int panel_lit(void)
{
    int n = 0;
    for (int y = 0; y < VIEWFINDER_H; y++) {
        for (int x = 0; x < VIEWFINDER_W; x++) {
            n += panel_pixel(x, y) ? 1 : 0;
        }
    }
    return n;
}

/* ------------------------------------------------------------------ tests */

/* The corner test. Each quadrant of the frame, one at a time, and only the
   matching quadrant of the panel may light: that pins orientation in both
   axes at once, which a single centred rectangle cannot do. */
static void test_quadrants(void)
{
    printf("Quadrant mapping\n");

    const struct { int x0, y0, x1, y1; const char *name; } q[4] = {
        {   0,   0, FW / 2, FH / 2, "top-left"     },
        { FW/2,   0, FW,     FH / 2, "top-right"   },
        {   0, FH/2, FW / 2, FH,     "bottom-left" },
        { FW/2, FH/2, FW,    FH,     "bottom-right"},
    };

    /* The picture is letterboxed to the camera's aspect ratio, so a quadrant
       fills half of that image rather than half of the panel, and the bars
       either side stay dark. */
    const int vw = VIEWFINDER_H * FW / FH;
    const int vx0 = (VIEWFINDER_W - vw) / 2;

    for (int i = 0; i < 4; i++) {
        frame_fill(0x20);
        frame_rect(q[i].x0, q[i].y0, q[i].x1, q[i].y1, 0xF0);
        viewfinder_render(frame, FW, FH, panel);

        int inside = 0, outside = 0;
        for (int y = 0; y < VIEWFINDER_H; y++) {
            for (int x = 0; x < VIEWFINDER_W; x++) {
                const bool want_x = (q[i].x0 == 0)
                        ? (x >= vx0 && x < vx0 + vw / 2)
                        : (x >= vx0 + vw / 2 && x < vx0 + vw);
                const bool want_y = (q[i].y0 == 0) ? (y < VIEWFINDER_H / 2)
                                                   : (y >= VIEWFINDER_H / 2);
                if (panel_pixel(x, y)) {
                    if (want_x && want_y) { inside++; } else { outside++; }
                }
            }
        }
        CHECK(outside == 0, "%s: %d lit pixels outside the quadrant",
              q[i].name, outside);
        CHECK(inside == (vw / 2) * (VIEWFINDER_H / 2),
              "%s: %d lit inside, expected %d", q[i].name, inside,
              (vw / 2) * (VIEWFINDER_H / 2));
        /* And the letterbox bars are dark, which is what makes a square code
           look square. */
        int bars = 0;
        for (int y = 0; y < VIEWFINDER_H; y++) {
            for (int x = 0; x < VIEWFINDER_W; x++) {
                if ((x < vx0 || x >= vx0 + vw) && panel_pixel(x, y)) { bars++; }
            }
        }
        CHECK(bars == 0, "%s: %d lit pixels in the letterbox bars",
              q[i].name, bars);
    }
}

/* A QR sitting in the middle of the view is the ordinary case: it must appear
   in the middle, at roughly the same fraction of the panel it occupies of the
   frame. */
static void test_centred_block(void)
{
    printf("Centred block\n");

    frame_fill(0x10);
    frame_rect(FW / 4, FH / 4, FW * 3 / 4, FH * 3 / 4, 0xE0);
    viewfinder_render(frame, FW, FH, panel);

    CHECK(panel_pixel(VIEWFINDER_W / 2, VIEWFINDER_H / 2),
          "centre of the panel is dark");
    CHECK(!panel_pixel(1, 1), "top-left corner is lit");
    CHECK(!panel_pixel(VIEWFINDER_W - 2, VIEWFINDER_H - 2),
          "bottom-right corner is lit");

    const int lit = panel_lit();
    /* Half the letterboxed image, not half the panel. */
    const int want = ((VIEWFINDER_H * FW / FH) / 2) * (VIEWFINDER_H / 2);
    CHECK(lit > want * 9 / 10 && lit < want * 11 / 10,
          "lit area %d, expected about %d", lit, want);
}

/* The threshold comes from the frame, so the same scene under more light is
   the same picture. Two frames differing by a constant must render alike. */
static void test_threshold_is_per_frame(void)
{
    printf("Per-frame threshold\n");

    frame_fill(0x08);
    frame_rect(20, 20, 120, 120, 0x40);
    viewfinder_render(frame, FW, FH, panel);
    uint8_t dim[VIEWFINDER_BYTES];
    memcpy(dim, panel, sizeof dim);

    frame_fill(0x8F);
    frame_rect(20, 20, 120, 120, 0xC7);   /* same scene, +0x87 everywhere */
    viewfinder_render(frame, FW, FH, panel);

    CHECK(memcmp(dim, panel, sizeof dim) == 0,
          "the same scene under different light rendered differently");
    CHECK(panel_lit() > 0, "nothing lit at all");
}

/* A lens cap, a white wall, a frame the sensor has not exposed yet: no
   contrast means nothing to aim at, and a blank panel says that honestly
   rather than showing amplified noise. */
static void test_flat_frame_is_blank(void)
{
    printf("Flat frame\n");

    frame_fill(0x77);
    memset(panel, 0xAA, sizeof panel);
    viewfinder_render(frame, FW, FH, panel);
    CHECK(panel_lit() == 0, "%d pixels lit for a frame with no contrast",
          panel_lit());
}

/* Nothing here may write past the bitmap it was handed, and a null argument
   is a no-op rather than a crash: camera.c calls this on whatever the driver
   returned. */
static void test_guards(void)
{
    printf("Guards\n");

    viewfinder_render(NULL, FW, FH, panel);
    viewfinder_render(frame, 0, FH, panel);
    viewfinder_render(frame, FW, FH, NULL);
    printf("  (no crash)\n");
}

int main(void)
{
    printf("=== viewfinder ===\n");
    test_quadrants();
    test_centred_block();
    test_threshold_is_per_frame();
    test_flat_frame_is_blank();
    test_guards();

    if (failures) {
        printf("\n%d failure(s)\n", failures);
        return 1;
    }
    printf("\nAll viewfinder tests passed\n");
    return 0;
}
