# Colibri Wallet component for ESP-IDF
# HD wallet functionality using TrezorCrypto

idf_component_register(
    SRCS "colibri-wallet.c"
    INCLUDE_DIRS "include"
    REQUIRES trezor-crypto nvs_flash mbedtls
)
