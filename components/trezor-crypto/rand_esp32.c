/**
 * ESP32 hardware RNG implementation for TrezorCrypto
 * Uses ESP-IDF bootloader_random and esp_random APIs
 */

#include "rand.h"
#include "esp_random.h"
#include "bootloader_random.h"

// Use ESP32 hardware RNG for random32()
uint32_t random32(void) {
    return esp_random();
}

// Override weak random_buffer with ESP32 hardware RNG
void random_buffer(uint8_t *buf, size_t len) {
    esp_fill_random(buf, len);
}
