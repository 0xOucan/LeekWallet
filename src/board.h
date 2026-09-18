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

/*
 * ---------------------------------------------------------------------------
 * Selecting a board
 *
 * There are three boards and only two targets. The reference board and the CAM
 * board are both `esp32s3`, so the target alone stopped being enough to tell
 * them apart the moment the CAM board existed, and a header that guesses wrong
 * here drives peripherals down pins that belong to something else. That is the
 * mistake this file was written to prevent, so the board is now named
 * explicitly by the build.
 *
 * `platformio.ini` passes exactly one of `-DLEEK_BOARD_S3`,
 * `-DLEEK_BOARD_PIXIE` or `-DLEEK_BOARD_S3CAM`. A build that passes none falls
 * back to the old behaviour — C3 means Pixie, anything else means the
 * reference board — so an out-of-tree build that predates this change keeps
 * working and produces the same image. A build that passes two is a mistake
 * and is refused below rather than silently resolved.
 */

#if !defined(LEEK_BOARD_S3) && !defined(LEEK_BOARD_PIXIE) && \
    !defined(LEEK_BOARD_S3CAM)
#  if defined(CONFIG_IDF_TARGET_ESP32C3)
#    define LEEK_BOARD_PIXIE 1
#  else
#    define LEEK_BOARD_S3 1
#  endif
#endif

#if (defined(LEEK_BOARD_S3) + defined(LEEK_BOARD_PIXIE) + \
     defined(LEEK_BOARD_S3CAM)) != 1
#  error "Define exactly one of LEEK_BOARD_S3, LEEK_BOARD_PIXIE, LEEK_BOARD_S3CAM"
#endif

/*
 * ---------------------------------------------------------------------------
 * Capabilities
 *
 * Every board defines every flag, so a `#if LEEK_HAS_CAMERA` is a compile-time
 * zero rather than an undefined identifier, and a typo in a flag name fails the
 * build instead of quietly evaluating false. Capabilities are about what the
 * hardware HAS; whether a feature is enabled at runtime is a separate question
 * the firmware answers elsewhere. The radios are the clearest case: the CAM
 * board has both, and both are off until the user deliberately turns one on.
 */

#if LEEK_BOARD_PIXIE

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

#define LEEK_HAS_CAMERA         0
#define LEEK_HAS_SDCARD         0
#define LEEK_HAS_SE             0
#define LEEK_HAS_BLE            1
#define LEEK_HAS_USB            0   /* USB Serial/JTAG only; no wallet transport */
#define LEEK_VAULT_ON_SD        0

#elif LEEK_BOARD_S3

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

#define LEEK_HAS_CAMERA         0
#define LEEK_HAS_SDCARD         0
#define LEEK_HAS_SE             0
#define LEEK_HAS_BLE            1
#define LEEK_HAS_USB            1
#define LEEK_VAULT_ON_SD        0

#else

/* ------------------------------------------- ESP32-S3-N16R8 CAM + OV5640 */

/*
 * Every pin below comes from docs/BOARD-S3CAM-PINOUT.md, which transcribes the
 * pinout shipped with the board and was continuity checked on 2026-09-17.
 *
 * The camera owns GPIO 4-18 except 14, which is the whole reason this board
 * needs its own map: the reference board's I2C pins and all four of its
 * buttons are camera lines here. Nothing below touches a strapping pin
 * (0, 3, 45, 46), and UART0 on 43/44 is left alone so the logs survive.
 */

#define BOARD_NAME              "ESP32-S3 CAM"
#define BOARD_MODEL             "LeekWallet-S3CAM"

/* GPIO14 is the one pin in the 4-18 block the camera does not claim. GPIO2
   also drives the onboard LED, which is harmless for an input with a pull-up:
   it means the LED dims while that button is held. GPIO42 is JTAG MTMS, which
   is free because debugging goes over native USB. */
#define PIN_BUTTON_UP           GPIO_NUM_1    /* K1 */
#define PIN_BUTTON_DOWN         GPIO_NUM_2    /* K2 — shared with onboard LED */
#define PIN_BUTTON_CANCEL       GPIO_NUM_14   /* K3 */
#define PIN_BUTTON_ACCEPT       GPIO_NUM_42   /* K4 — MTMS */

/* SSD1306 at 0x3C, sharing the bus with the secure element when one is fitted. */
#define PIN_I2C_SDA             GPIO_NUM_47
#define PIN_I2C_SCL             GPIO_NUM_21

#define BOARD_HAS_I2C_PANEL     1
#define BOARD_HAS_SPI_PANEL     0

/* OV5640 over DVP. Mirrors esp32-camera's BOARD_ESP32S3_WROOM map. PWDN and
   RESET are not wired on this board, hence -1 and the software reset path. */
#define PIN_CAM_PWDN            (-1)
#define PIN_CAM_RESET           (-1)
#define PIN_CAM_XCLK            GPIO_NUM_15
#define PIN_CAM_SIOD            GPIO_NUM_4
#define PIN_CAM_SIOC            GPIO_NUM_5
#define PIN_CAM_D0              GPIO_NUM_11
#define PIN_CAM_D1              GPIO_NUM_9
#define PIN_CAM_D2              GPIO_NUM_8
#define PIN_CAM_D3              GPIO_NUM_10
#define PIN_CAM_D4              GPIO_NUM_12
#define PIN_CAM_D5              GPIO_NUM_18
#define PIN_CAM_D6              GPIO_NUM_17
#define PIN_CAM_D7              GPIO_NUM_16
#define PIN_CAM_VSYNC           GPIO_NUM_6
#define PIN_CAM_HREF            GPIO_NUM_7
#define PIN_CAM_PCLK            GPIO_NUM_13

/* microSD. The board brings out one data line, so 1-bit SDMMC is the only
   mode available. CLK and DATA are also MTCK and MTDO, which means using the
   card rules out EXTERNAL JTAG; native USB JTAG on 19/20 is unaffected. */
#define PIN_SD_CMD              GPIO_NUM_38
#define PIN_SD_CLK              GPIO_NUM_39
#define PIN_SD_D0               GPIO_NUM_40
#define BOARD_SD_BUS_WIDTH      1

/* Onboard WS2812, freed by moving I2C off GPIO48. One pixel, not four. */
#define PIN_PIXELS              GPIO_NUM_48
#define PIXEL_COUNT             1

#define LEEK_HAS_CAMERA         1
#define LEEK_HAS_SDCARD         1
#define LEEK_HAS_SE             0   /* ATECC608B not fitted yet; see RESEARCH-SECURE-ELEMENT.md */
#define LEEK_HAS_BLE            1   /* present, off at boot, deliberate act to enable */
#define LEEK_HAS_USB            1   /* likewise */
#define LEEK_VAULT_ON_SD        1

#endif

#endif /* LEEK_BOARD_H */
