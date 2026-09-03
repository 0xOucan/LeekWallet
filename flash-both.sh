#!/usr/bin/env bash
# Flash both boards with v0.1.0-chaak-pool.
#
#   ./flash-both.sh provision   ERASES every wallet. Once, to get onto this
#                               release. Do NOT run it again afterwards.
#   ./flash-both.sh update      firmware only, seeds untouched. Every time after.
#
# Detects which board is on which port by chip id, so the S3 image cannot be
# written to the Pixie or the other way round -- a mismatch there gives a board
# that does not boot and no message saying why.
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-}"
case "$MODE" in
  provision) OFFSET=0x0 ;;
  update)    OFFSET=0x10000 ;;
  *) echo "usage: $0 provision|update" >&2; exit 2 ;;
esac

REL="release/v0.1.0-chaak-pool"
[[ -d "$REL" ]] || { echo "no $REL — run scripts/release.sh first" >&2; exit 2; }

if [[ "$MODE" == provision ]]; then
  echo
  echo "  PROVISION erases every wallet on every board it touches."
  echo "  Only correct for a board you are deliberately resetting."
  read -rp "  Type ERASE to continue: " ok
  [[ "$ok" == "ERASE" ]] || { echo "  stopped."; exit 1; }
fi

shopt -s nullglob
PORTS=(/dev/ttyACM* /dev/ttyUSB*)
(( ${#PORTS[@]} )) || { echo "no boards found on /dev/ttyACM* or /dev/ttyUSB*" >&2; exit 2; }

for PORT in "${PORTS[@]}"; do
  echo
  echo "== $PORT"
  CHIP=$(esptool.py --port "$PORT" chip_id 2>/dev/null | grep -oE 'ESP32-(S3|C3)' | head -1 || true)
  case "$CHIP" in
    ESP32-S3) ENV=esp32s3; BOARD=s3 ;;
    ESP32-C3) ENV=pixie;   BOARD=pixie ;;
    *) echo "   could not identify the chip on $PORT — skipping"; continue ;;
  esac

  IMG="$REL/$ENV/leekwallet-${BOARD}-0.1.0-chaak-pool-${MODE}.bin"
  [[ -f "$IMG" ]] || { echo "   missing $IMG"; continue; }

  # Verify the image against the release's own SHA256SUMS before writing it.
  ( cd "$REL/$ENV" && sha256sum -c --ignore-missing SHA256SUMS 2>/dev/null \
      | grep -q "$(basename "$IMG")" ) \
    || { echo "   checksum mismatch for $(basename "$IMG") — refusing"; continue; }

  echo "   $CHIP -> $(basename "$IMG") at $OFFSET"
  esptool.py --chip auto --port "$PORT" --baud 921600 write_flash "$OFFSET" "$IMG"
done

echo
echo "Done. Unplug and replug each board."
[[ "$MODE" == provision ]] && echo "Both are blank: set a PIN, then import your seed on each."
