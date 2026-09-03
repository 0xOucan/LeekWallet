/**
 * Which board this firmware is being built for.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 *
 * The pin numbers were spread across the files that used them, which was fine
 * while there was one board and actively dangerous the moment there were two.
 * The reference build drives I2C on GPIO 8 and 9; on a Firefly Pixie those are
 * **Button 2 and the WS2812B data line**, and GPIO9 is additionally the
 * ESP32-C3's boot strapping pin — held low at reset it enters download mode.
 * Flashing the unmodified reference build onto a Pixie would therefore drive an
 * I2C clock down the LED string and toggle the strapping pin, which damages
 * nothing but is exactly the sort of thing nobody notices until a board behaves
 * strangely at boot.
 *
 * One header, selected by target, so a pin is chosen once and the compiler
 * catches the case nobody thought about.
 *
 * ---------------------------------------------------------------------------
 * Sources
 *
 * The Pixie map is `firefly-hollows/src/config.h`, `BOARD_REV == 5`. Earlier
 * revisions differ — rev.2 and rev.4 use other button pins and rev.4 has one
 * LED rather than four — so the revision is named here rather than assumed.
 */

#ifndef LEEK_BOARD_H
#define LEEK_BOARD_H

#include "driver/gpio.h"

#if defined(CONFIG_IDF_TARGET_ESP32C3)

/* ------------------------------------------------------- Firefly Pixie rev.5 */

#define BOARD_NAME              "Firefly Pixie"
#define BOARD_MODEL             "LeekWallet-Pixie"

/*
 * Buttons, in PHYSICAL order — SW1..SW4 left to right — not in Firefly's
 * semantic order.
 *
 * Firefly's own config assigns meanings to its four keys: Button 1 is Cancel,
 * Button 2 is OK, Button 3 North and Button 4 South. Mapping those meanings
 * straight through looked like the respectful thing to do and was wrong in
 * use: it puts Up and Down on the third and fourth keys, so the same gesture
 * is in a different place depending on which board you picked up. Reported
 * from a Pixie after the first wallet was created on one.
 *
 * The reference board is UP, DOWN, BACK, OK across the row, and that is what a
 * user's hand learns. The Pixie matches it. Firefly's labels are theirs and
 * still correct for their firmware; this is a different application on the same
 * hardware, and consistency between OUR two boards is worth more than agreement
 * with somebody else's key names.
 *
 * Active low with internal pull-ups, same as the reference board.
 */
#define PIN_BUTTON_UP           GPIO_NUM_10   /* SW1 — Firefly calls it Button 1 */
#define PIN_BUTTON_DOWN         GPIO_NUM_8    /* SW2 — Firefly's Button 2 */
#define PIN_BUTTON_CANCEL       GPIO_NUM_3    /* SW3 — Firefly's Button 3 */
#define PIN_BUTTON_ACCEPT       GPIO_NUM_2    /* SW4 — Firefly's Button 4 */

/* Display: ST7789 on SPI2. CS is tied to ground from rev.3 onward, which is
   why the bus variant without it is the correct one. */
#define PIN_DISPLAY_DC          GPIO_NUM_4
#define PIN_DISPLAY_RESET       GPIO_NUM_5

/* Four addressable LEDs, one beside each button. */
#define PIN_PIXELS              GPIO_NUM_9
#define PIXEL_COUNT             4

/*
 * No I2C panel on this board.
 *
 * The SSD1306 driver is still compiled — the C3 has an I2C peripheral and the
 * code is target-neutral — but it must not be *initialised*, because its pins
 * here belong to the LED string and a button. `main.c` checks this rather than
 * calling oled_i2c_init() unconditionally.
 */
#define BOARD_HAS_I2C_PANEL     0
#define BOARD_HAS_SPI_PANEL     1

/* Defined so the SSD1306 driver still compiles, and pointed at nothing so a
   stray initialisation fails loudly rather than quietly driving the LEDs. */
#define PIN_I2C_SDA             GPIO_NUM_NC
#define PIN_I2C_SCL             GPIO_NUM_NC

#else

/* --------------------------------------------------- ESP32-S3 reference board */

#define BOARD_NAME              "ESP32-S3"
#define BOARD_MODEL             "LeekWallet-S3"

#define PIN_BUTTON_UP           GPIO_NUM_10   /* K1 */
#define PIN_BUTTON_DOWN         GPIO_NUM_5    /* K2 */
#define PIN_BUTTON_CANCEL       GPIO_NUM_6    /* K3 */
#define PIN_BUTTON_ACCEPT       GPIO_NUM_7    /* K4 */

/* SSD1306, 128x64, at 0x3C. GPIO4 was unusable on the reference board — stuck
   low — which is why K1 is on GPIO10 and not where a datasheet would put it. */
#define PIN_I2C_SDA             GPIO_NUM_8
#define PIN_I2C_SCL             GPIO_NUM_9

#define BOARD_HAS_I2C_PANEL     1
#define BOARD_HAS_SPI_PANEL     0

#endif

#endif /* LEEK_BOARD_H */
