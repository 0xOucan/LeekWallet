# Firefly's ST7789 driver, vendored. MIT — see LICENSE.md.
#
# Built only for the ESP32-C3 (the Firefly Pixie). The reference board has an
# SSD1306 over I2C and no ST7789 anywhere, so compiling this into the S3 image
# would add a driver for a panel that is not attached — dead code in a firmware
# whose whole argument is that you can read all of it.
# `IDF_TARGET`, not `CONFIG_IDF_TARGET_ESP32C3`.
#
# ESP-IDF expands component requirements in an early pass, before sdkconfig is
# loaded, so every CONFIG_* is empty at that point. Guarding on one sends this
# file down the else() branch during expansion — registering with no REQUIRES —
# and then down the if() branch when the sources are actually compiled. The
# result is a component that builds with the wrong include paths and fails on a
# header it correctly asked for. `IDF_TARGET` is set before expansion.
if(IDF_TARGET STREQUAL "esp32c3")
  idf_component_register(
    SRCS "src/display.c"
    INCLUDE_DIRS "include"
    # `esp_driver_spi` as well as `driver`: ESP-IDF 5.x split the SPI master
    # out of the monolithic driver component, and firefly-display's own
    # CMakeLists still asks only for `driver` — written against IDF 4.x, where
    # driver/spi_master.h lived there. Without this the component is found and
    # compiled and then fails on a missing header.
    REQUIRES driver esp_driver_spi
  )
else()
  idf_component_register()
endif()
