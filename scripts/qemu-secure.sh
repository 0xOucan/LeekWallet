#!/usr/bin/env bash
# Boot the secure target (flash encryption + secure boot v2) under QEMU.
#
# QEMU emulates eFuses, which is the entire reason this is developed here
# first. Flash encryption and secure boot are enforced by one-time-programmable
# fuses: get them wrong on a board and the board is scrap, get the *scheme*
# wrong and every board built from it is scrap. The emulated fuse file can be
# deleted and the whole thing re-run.
set -euo pipefail

BUILD_DIR=".pio/build/esp32s3-secure-qemu"
IMAGE="${BUILD_DIR}/qemu-flash.bin"
EFUSE="${BUILD_DIR}/qemu-efuse.bin"
FLASH_SIZE="16MB"

if ! command -v qemu-system-xtensa >/dev/null 2>&1; then
    echo "error: qemu-system-xtensa not found - see docs/QEMU.md" >&2
    exit 1
fi

if [[ "${1:-}" == "--fresh" ]]; then
    echo "==> Discarding emulated eFuses (a real device cannot do this)"
    rm -f "${EFUSE}"
    shift
fi

echo "==> Building the secure target"
pio run -e esp32s3-secure-qemu

echo "==> Merging flash image (signed binaries)"
# Secure boot means the *signed* artefacts, not the plain ones. Merging the
# unsigned bootloader produces a device that resets in a loop with no output,
# which is a miserable thing to debug and the reason this is done in an
# emulator first.
esptool.py --chip esp32s3 merge_bin \
    -o "${IMAGE}" \
    --flash_mode dio --flash_freq 80m --flash_size "${FLASH_SIZE}" \
    --fill-flash-size "${FLASH_SIZE}" \
    0x0     "${BUILD_DIR}/bootloader-signed.bin" \
    0xF000  "${BUILD_DIR}/partitions-signed.bin" \
    0x20000 "${BUILD_DIR}/firmware-signed.bin"

# Blank fuses on first run; afterwards they persist between boots, so the
# second boot sees an already-encrypted device exactly as hardware would.
if [[ ! -f "${EFUSE}" ]]; then
    echo "==> Creating blank eFuse block"
    dd if=/dev/zero of="${EFUSE}" bs=1 count=1024 status=none
fi

echo "==> Booting (Ctrl-A X to quit)"
exec qemu-system-xtensa \
    -nographic \
    -machine esp32s3 \
    -drive file="${IMAGE}",if=mtd,format=raw \
    -drive file="${EFUSE}",if=none,format=raw,id=efuse \
    -global driver=nvram.esp32s3.efuse,property=drive,value=efuse \
    "$@"
