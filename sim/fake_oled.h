/**
 * Framebuffer OLED for host tests - the display half of T0.3.
 *
 * Two views of the same draw calls:
 *
 *   Text  - an 8x21 character grid, laid out at the same page/column the
 *           firmware asked for. This is the view tests assert on. "Row 3 says
 *           the recipient address" is the kind of claim that catches a real
 *           bug, and it survives a font change or a two-pixel nudge, which a
 *           pixel golden does not.
 *
 *   Pixels - the 128x64 bit buffer, for the handful of things that genuinely
 *           are pixels. Text is not rasterised into it: inventing a font here
 *           would only produce goldens that assert the fake is consistent with
 *           itself.
 */

#ifndef FAKE_OLED_H
#define FAKE_OLED_H

#include <stdbool.h>
#include <stdint.h>

#define FAKE_OLED_ROWS  8
#define FAKE_OLED_COLS  21   /* 128 px / 6 px per character */

/** Clear both views and the counters. Call between tests. */
void fake_oled_reset(void);

/** Text drawn on `page` since the last clear, trailing blanks removed. */
const char *fake_oled_row(int page);

/** Substring search within one row. */
bool fake_oled_row_contains(int page, const char *needle);

/** Substring search across every row. */
bool fake_oled_contains(const char *needle);

/** Row holding `needle`, or -1. Lets a test assert on placement, not just presence. */
int fake_oled_find_row(const char *needle);

/** Payload of the last oled_draw_qrcode(), or "" if none. */
const char *fake_oled_qr_data(void);

/** Times the frame was pushed to the (imaginary) panel. */
int fake_oled_flush_count(void);

/** Last contrast level written. */
uint8_t fake_oled_contrast(void);

/** Print the character grid, boxed. For eyeballing a failure. */
void fake_oled_dump(void);

/** Print the bit buffer as ASCII art. Secondary - see the header comment. */
void fake_oled_dump_pixels(void);

#endif /* FAKE_OLED_H */
