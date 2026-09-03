/**
 * LeekWallet - ESP32-S3 firmware
 *
 * Hardware (from physical inspection):
 *   - ESP32-S3-N16R8: 16MB flash, 8MB PSRAM (off; see ROADMAP T58c), USB-C
 *   - SSD1306 OLED: 128x64, I2C address 0x3C
 *   - 4 buttons: K1-K4, active-low, directly wired to GPIOs
 *   - Header pin order: GND, VCC, SCL, SDA, K4, K3, K2, K1
 *
 * GPIO assignments:
 *   - I2C SDA: GPIO8
 *   - I2C SCL: GPIO9
 *   - K1: GPIO10 (rewired from GPIO4 which was stuck LOW)
 *   - K2: GPIO5
 *   - K3: GPIO6
 *   - K4: GPIO7
 *
 * Button mapping:
 *   - K1 = UP
 *   - K2 = DOWN
 *   - K3 = CANCEL
 *   - K4 = ACCEPT
 *
 * This is a hardware wallet with HD wallet support.
 */

#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "leek-wallet.h"
#include "vault-kdf.h"

#include "oled.h"
#include "board.h"
#include "button.h"
#include "ui.h"
#include "device-wipe.h"
#include "protocol.h"
#include "transport.h"

static const char *TAG = "leekwallet";

void app_main(void)
{
    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "LeekWallet - %s", BOARD_NAME);
    ESP_LOGI(TAG, "Hardware wallet with HD support");
    ESP_LOGI(TAG, "========================================");

    /* Initialize NVS (required for wallet and PIN storage) */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS partition truncated, erasing...");
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    ESP_LOGI(TAG, "NVS initialized");

    /* Initialize wallet subsystem */
    wallet_init();

    /* Finish any wipe that power interrupted, before anything can unlock
     * (T5). A device that comes back half-wiped and usable is a device whose
     * owner thinks their seed is gone when it is not. */
    if (device_wipe_resume()) {
        ESP_LOGW(TAG, "Completed a wipe that was interrupted by a power cut");
        wallet_init();
    }

    WalletStatus status = wallet_get_status();
    ESP_LOGI(TAG, "Wallet status: initialized=%d, password_set=%d, unlocked=%d",
             status.initialized, status.password_set, status.unlocked);

    /* Measure key derivation on this silicon - see ROADMAP T9c. */
    vault_kdf_benchmark_ms();

    /* Initialize the display.
     *
     * A missing display is not fatal. Returning here used to abandon boot
     * entirely, which meant a loose I2C wire produced a device that looked
     * dead rather than one with a blank screen, and made the firmware
     * untestable under QEMU, which has no SSD1306 to find.
     *
     * The wallet, the protocol endpoint and the buttons are all still useful
     * without a panel, so carry on and say so. Nothing that needs user
     * confirmation can be approved blind, because those confirmations are
     * button presses against rendered text that simply will not appear. */
    /*
     * One call, both boards.
     *
     * This was briefly a target-specific branch, while the C3 had no display
     * driver and had to come up headless. It does not need to be one any more:
     * `oled.c` and `oled-pixie.c` implement the same seven transport entry
     * points, and `oled_i2c_init()` on the Pixie succeeds without touching
     * anything — there is no I2C panel there, and its pins belong to a button
     * and the LED string.
     *
     * `have_display` stays, because a panel can still fail to answer, and the
     * headless path it selects was written long before this port.
     */
    bool have_display = (oled_i2c_init() == ESP_OK) && (oled_init() == ESP_OK);
    if (!have_display) {
        /* Only worth saying where a panel was expected. On a board with no I2C
           screen this used to print an error naming pins that belong to the LED
           string, which is a false lead rather than a diagnostic. */
        ESP_LOGE(TAG, "No display found - continuing headless");
#if BOARD_HAS_I2C_PANEL
        ESP_LOGE(TAG, "Check SDA=GPIO%d, SCL=GPIO%d and that the panel is at 0x3C",
                 PIN_I2C_SDA, PIN_I2C_SCL);
#endif
    }

    /* Initialize buttons */
    if (button_init() != ESP_OK) {
        ESP_LOGE(TAG, "Button initialization failed");
        return;
    }

    /* Initialize UI framework */
    ui_init();

    /* Select the one transport that may be live. Defaults to USB, and
     * explicitly leaves BLE off rather than assuming it: a wallet that
     * advertises without being asked to is discoverable by anyone in the room
     * (PROTOCOL.md 3b, ROADMAP T57).
     *
     * This must precede protocol_start(). It used to follow it, which left a
     * window of a few milliseconds between the endpoint accepting frames and
     * the transport decision being made. In that window the USB endpoint
     * answered every request -- including on a device whose stored transport
     * is BLE -- and transport_apply() mutated the receive state of a
     * protocol_task that was already parsing a frame. A host that opens the
     * port without resetting the board lands in exactly that window, and the
     * device panicked (LoadProhibited in the USB-Serial-JTAG ISR) on the third
     * request. pyserial never saw it because asserting DTR on open reboots the
     * board, so its requests wait in the FIFO until after boot. */
    transport_init();

    /* Protocol endpoint over the same USB cable used for flashing. Only now,
     * with a transport chosen, may frames be answered. */
    protocol_start();

    /* Start UI task */
    BaseType_t task_ret = xTaskCreate(
        ui_task,
        "ui_task",
        8192,  /* Larger stack for UI processing */
        NULL,
        5,
        NULL
    );

    if (task_ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create UI task");
        return;
    }

    ESP_LOGI(TAG, "Initialization complete");

    /* app_main exits; FreeRTOS scheduler runs ui_task */
}
