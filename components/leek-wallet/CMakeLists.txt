# LeekWallet HD wallet core
# BIP39/BIP32/BIP44 derivation and encrypted NVS storage, built on trezor-crypto

idf_component_register(
    SRCS "leek-wallet.c" "vault-kdf.c" "vault-crypt.c"
    INCLUDE_DIRS "include"
    REQUIRES trezor-crypto nvs_flash mbedtls
    PRIV_REQUIRES esp_timer
)
