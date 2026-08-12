# TrezorCrypto component for ESP-IDF
# Provides BIP39/BIP32 HD wallet functionality

# Collect all source files
file(GLOB_RECURSE TREZOR_CRYPTO_SOURCES
    "*.c"
)

# Exclude test files and Monero-specific code (not needed for ETH/BTC)
list(FILTER TREZOR_CRYPTO_SOURCES EXCLUDE REGEX ".*test.*\\.c$")
list(FILTER TREZOR_CRYPTO_SOURCES EXCLUDE REGEX ".*/monero/.*\\.c$")
list(FILTER TREZOR_CRYPTO_SOURCES EXCLUDE REGEX ".*cardano\\.c$")

idf_component_register(
    SRCS ${TREZOR_CRYPTO_SOURCES}
    INCLUDE_DIRS "." "ed25519-donna" "aes" "chacha20poly1305"
    REQUIRES mbedtls
    PRIV_REQUIRES bootloader_support
)

# Compiler flags for TrezorCrypto
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    USE_ETHEREUM=1
    USE_KECCAK=1
    USE_BIP32_CACHE=0
    USE_BIP39_CACHE=0
    AES_VAR=1
    AES_128=1
    AES_192=1
)

# Suppress some warnings from crypto code
target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wno-unused-function
    -Wno-unused-variable
    -Wno-sign-compare
    -Wno-type-limits
)
