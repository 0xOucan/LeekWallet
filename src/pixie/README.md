# The Pixie display shim — design, not yet built

`oled-pixie.c.wip` implements the ST7789 half of the Firefly Pixie port. It is
**deliberately outside the build**: `src/CMakeLists.txt` globs `src/*.c`, so a
half-finished driver there breaks the ESP32-S3 firmware, which is the one that
currently works and is flashed to a board.

## What is decided

The geometry, which was the only interesting question. 240 is not a multiple of
128, so there is no clean integer scale, and the obvious 2x overflows: 21
characters at 6 logical pixels, doubled, is 252 px into a 240 px panel — the
right-hand button label falls off the screen.

So: **glyphs doubled to 10x14, with an 11-pixel advance** (10 of glyph, 1 of
gap). 21 x 11 = 231, which fits with nine pixels spare and keeps the character
count identical to the SSD1306. Nothing that fits on the reference board fails
to fit on the Pixie. Rows are 16 px, so eight of them occupy 128 px of the 240
available and the block is centred.

The backing store stays **1 bit per pixel**, expanded to RGB565 in the driver's
fragment callback. 1 KB against 115 KB for a full colour frame, on a part with
400 KB and no PSRAM — and it keeps the port honest, because a monochrome buffer
cannot grow colour the reference build has no way to show.

## What remains

1. **Sixteen functions, not six.** `ui.c` uses six, but the firmware as a whole
   references sixteen `oled_*` entry points. All of them need implementing here
   or the C3 image will not link.
2. **Share the font and the composition code.** `font_5x7` and most of
   `src/oled.c` — text, pixels, the QR renderer — are pure framebuffer work with
   no I2C in them. They belong in a shared `oled-core.c`, leaving `oled.c` as
   SSD1306 transport and this file as ST7789 transport. That refactor touches
   the working S3 driver, so it wants doing deliberately rather than in passing.
3. **Select the driver by target** in `src/CMakeLists.txt`: exclude `oled.c` on
   the C3 and this file everywhere else. Two definitions of `oled_clear()` in
   one image is a link error, and the glob will happily produce it.
4. **A board header** for the rev.5 pin map — display DC/RESET on GPIO 4/5,
   buttons on 10/8/3/2, pixels on 9.

## What is already proven

The firmware compiles and links for the ESP32-C3 with no source changes
(`pio run -e pixie`), and `components/firefly-display` is vendored and builds
under PlatformIO, guarded to the C3 target. See `docs/PIXIE-PORT.md`.
