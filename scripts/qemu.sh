#!/usr/bin/env bash
# Run LeekWallet firmware under Espressif's QEMU fork.
#
# Boots the same binary that would be flashed, against an emulated flash image,
# so NVS behaviour, the partition table and (crucially) eFuse-backed features
# can be exercised without hardware. See docs/QEMU.md.
set -euo pipefail

BUILD_DIR=".pio/build/esp32s3-qemu"
IMAGE="${BUILD_DIR}/qemu-flash.bin"
# Must match partitions.csv and sdkconfig. A smaller image makes the bootloader
# reject the partition table outright: "offset 0x10000 size 0x400000 exceeds
# flash chip size". QEMU caught exactly that when these drifted apart.
FLASH_SIZE="16MB"

if ! command -v qemu-system-xtensa >/dev/null 2>&1; then
    cat >&2 <<'MSG'
error: qemu-system-xtensa not found.

This needs Espressif's QEMU fork, not the distro package - upstream QEMU has no
esp32s3 machine. Install with:

    pip install esptool                       # if not already present
    python -m espressif.idf_tools install qemu-xtensa

or grab a release build:

    https://github.com/espressif/qemu/releases

then put it on PATH and re-run.
MSG
    exit 1
fi

echo "==> Building"
pio run -e esp32s3-qemu

echo "==> Merging flash image"
# ESP32-S3 boots from offset 0x0, unlike the original ESP32 at 0x1000.
esptool.py --chip esp32s3 merge_bin \
    -o "${IMAGE}" \
    --flash_mode dio --flash_freq 80m --flash_size "${FLASH_SIZE}" \
    --fill-flash-size "${FLASH_SIZE}" \
    0x0     "${BUILD_DIR}/bootloader.bin" \
    0x8000  "${BUILD_DIR}/partitions.bin" \
    0x10000 "${BUILD_DIR}/firmware.bin"

echo "==> Booting (Ctrl-A X to quit)"
exec qemu-system-xtensa \
    -nographic \
    -machine esp32s3 \
    -drive file="${IMAGE}",if=mtd,format=raw \
    "$@"
