# LeekWallet main component

FILE(GLOB app_sources ${CMAKE_SOURCE_DIR}/src/*.c)

idf_component_register(
    SRCS ${app_sources}
    REQUIRES driver nvs_flash esp_hw_support bootloader_support esp_driver_usb_serial_jtag trezor-crypto leek-wallet
)
