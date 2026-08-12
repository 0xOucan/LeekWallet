#!/bin/bash
# Flash ESP32-S3 with conservative settings for unstable USB

# Use PlatformIO's esptool (system esptool may be incomplete)
ESPTOOL="$HOME/.platformio/packages/tool-esptoolpy/esptool.py"

# Use --no-stub for more reliable flashing on unstable USB connections
# Use --flash-size 4MB to override the binary header (board has 4MB flash)
python3 "$ESPTOOL" --port /dev/ttyACM0 --chip esp32s3 --baud 115200 --no-stub write_flash \
    --flash_mode dio \
    --flash_size 4MB \
    0x0 .pio/build/esp32s3/bootloader.bin \
    0x8000 .pio/build/esp32s3/partitions.bin \
    0x10000 .pio/build/esp32s3/firmware.bin
