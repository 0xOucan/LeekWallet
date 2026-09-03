# LeekWallet main component

FILE(GLOB app_sources ${CMAKE_SOURCE_DIR}/src/*.c)

# One panel driver per board, and never two.
#
# `oled.c` is the SSD1306 over I2C; `oled-pixie.c` is the ST7789 over SPI. Both
# implement the same seven transport entry points, so building both would be a
# duplicate-symbol link error — and the glob above would happily produce one.
# `IDF_TARGET` rather than a CONFIG_* symbol, because component sources are
# collected before sdkconfig is loaded.
if(IDF_TARGET STREQUAL "esp32c3")
  list(REMOVE_ITEM app_sources ${CMAKE_SOURCE_DIR}/src/oled.c)
else()
  list(REMOVE_ITEM app_sources ${CMAKE_SOURCE_DIR}/src/oled-pixie.c)
endif()

idf_component_register(
    SRCS ${app_sources}
    REQUIRES driver nvs_flash esp_hw_support bootloader_support esp_driver_usb_serial_jtag trezor-crypto leek-wallet
    # firefly-display is registered empty off the C3, so requiring it always is
    # harmless and keeps this list from needing its own branch.
    PRIV_REQUIRES firefly-display
)
