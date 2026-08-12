#!/usr/bin/env bash
# Prove whether the seed is recoverable from a flash dump.
#
# This is the S1 test made concrete: search the emulated flash image for
# plaintext BIP39 words. With flash encryption off it finds them; the point of
# T11 is that this script should come up empty.
set -euo pipefail

IMAGE="${1:-.pio/build/esp32s3/qemu-flash.bin}"

if [[ ! -f "${IMAGE}" ]]; then
    echo "error: ${IMAGE} not found - run scripts/qemu.sh first" >&2
    exit 1
fi

echo "==> Scanning ${IMAGE} for plaintext BIP39 words"

# A handful of common wordlist entries. A real seed contains twelve of these.
HITS=$(strings -n 4 "${IMAGE}" \
    | grep -cowE 'abandon|ability|able|about|above|absent|absorb|zoo|zone|wrong' \
    || true)

echo "    matches: ${HITS}"

if [[ "${HITS}" -gt 0 ]]; then
    echo
    echo "FAIL: plaintext wordlist entries are present in the flash image."
    echo "      Note the firmware embeds the BIP39 wordlist itself, so some"
    echo "      matches are expected in the .rodata region. Check whether any"
    echo "      fall inside the NVS partition (0x9000, 24 KB) - those would be"
    echo "      a stored seed."
    exit 1
fi

echo "PASS: no plaintext wordlist entries found."
