/**
 * QR Code Generator for LeekWallet
 * Based on https://github.com/ricmoo/QRCode (MIT License)
 */

#ifndef QRCODE_H
#define QRCODE_H

#include <stdint.h>
#include <stdbool.h>

/* QR Code structure */
typedef struct {
    uint8_t version;
    uint8_t size;
    uint8_t ecc;
    uint8_t mode;
    uint8_t mask;
    uint8_t *modules;
} QRCode;

/* Error correction levels */
#define ECC_LOW      0
#define ECC_MEDIUM   1
#define ECC_QUARTILE 2
#define ECC_HIGH     3

/**
 * Get the buffer size required for a QR code version
 * @param version QR code version (1-40)
 * @return Buffer size in bytes
 */
uint16_t qrcode_getBufferSize(uint8_t version);

/**
 * Initialize QR code with text data
 * @param qrcode QR code structure to initialize
 * @param modules Buffer for module data (use qrcode_getBufferSize)
 * @param version QR code version (1-40, use 2 for ETH addresses)
 * @param ecc Error correction level (ECC_LOW, ECC_MEDIUM, etc.)
 * @param data Text data to encode
 * @return 0 on success, negative on error
 */
int8_t qrcode_initText(QRCode *qrcode, uint8_t *modules, uint8_t version,
                       uint8_t ecc, const char *data);

/**
 * Get a module (pixel) value at position
 * @param qrcode Initialized QR code
 * @param x X coordinate
 * @param y Y coordinate
 * @return true if module is dark, false if light
 */
bool qrcode_getModule(QRCode *qrcode, uint8_t x, uint8_t y);

#endif /* QRCODE_H */
