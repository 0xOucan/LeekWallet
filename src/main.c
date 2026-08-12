/**
 * LeekWallet - ESP32-S3 Mini Firmware
 *
 * Hardware (from physical inspection):
 *   - ESP32-S3 Mini: No PSRAM, 4MB flash, USB-C
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

#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "leek-wallet.h"

#include "oled.h"
#include "button.h"
#include "ui.h"

static const char *TAG = "leekwallet";

void app_main(void)
{
    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "LeekWallet - ESP32-S3 Mini");
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
    WalletStatus status = wallet_get_status();
    ESP_LOGI(TAG, "Wallet status: initialized=%d, password_set=%d, unlocked=%d",
             status.initialized, status.password_set, status.unlocked);

    /* Initialize I2C */
    if (oled_i2c_init() != ESP_OK) {
        ESP_LOGE(TAG, "I2C initialization failed");
        return;
    }

    /* Initialize OLED */
    if (oled_init() != ESP_OK) {
        ESP_LOGE(TAG, "OLED initialization failed");
        return;
    }

    /* Initialize buttons */
    if (button_init() != ESP_OK) {
        ESP_LOGE(TAG, "Button initialization failed");
        return;
    }

    /* Initialize UI framework */
    ui_init();

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
