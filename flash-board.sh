#!/usr/bin/env bash
#
# Find ONE named LeekWallet board and flash it.
#
#   ./flash-board.sh s3cam            the ESP32-S3 CAM board
#   ./flash-board.sh s3               the reference ESP32-S3 board
#   ./flash-board.sh pixie            the Firefly Pixie (ESP32-C3)
#
#   --port /dev/ttyACMx   use this port; required when the board cannot be
#                         identified, and when more than one candidate exists
#   --fresh               first flash of a blank board: bootloader, partition
#                         table and app. Without it only the app is written.
#   --no-build            flash what is already in .pio/build
#   --dry-run             say what would happen and stop
#   --yes                 skip the final confirmation
#
# ---------------------------------------------------------------------------
# Why this exists alongside flash-both.sh
#
# flash-both.sh flashes every board it finds and chooses the image from the
# chip. That was sound with one board per chip. It stopped being sound the
# day the CAM board arrived: the CAM board and the reference board are both an
# ESP32-S3 N16R8, esptool cannot tell them apart, and their pin maps collide.
# The reference image drives I2C and four buttons on GPIO 5-10, which on the
# CAM board are camera data lines.
#
# So this script never guesses. You name the board. It then:
#
#   1. finds every port whose chip matches that board, one per board (by MAC,
#      so a CAM board plugged in through both of its USB-C ports counts once);
#   2. asks each running LeekWallet which model it is (getFeatures), and
#      refuses any that answer with a different model;
#   3. flashes only if exactly one board is left, or you named its port.
#
# A board that answers with the right model gets the APP only, at 0x10000,
# with no erase - the same write as `flash-both.sh dev`. Its NVS, and the seeds
# in it, are not touched. A board that says nothing is refused unless you give
# both --port and --fresh, because silence does not identify a board: a blank
# board, a board with BLE selected, and the UART bridge port all say nothing.
#
# Nothing here ever erases flash, and nothing here provisions.
# ---------------------------------------------------------------------------

set -euo pipefail
cd "$(dirname "$0")"

usage() { sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

BOARD="${1:-}"; [[ -n "$BOARD" ]] || usage; shift
PORT=""; FRESH=0; BUILD=1; DRY=0; YES=0
while (( $# )); do
  case "$1" in
    --port)     PORT="${2:?--port needs a value}"; shift 2 ;;
    --fresh)    FRESH=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --dry-run)  DRY=1; shift ;;
    --yes)      YES=1; shift ;;
    *)          echo "unknown option: $1" >&2; usage ;;
  esac
done

case "$BOARD" in
  s3)    ENV=esp32s3;    CHIP=ESP32-S3; ESPCHIP=esp32s3; MODEL=LeekWallet-S3 ;;
  s3cam) ENV=esp32s3cam; CHIP=ESP32-S3; ESPCHIP=esp32s3; MODEL=LeekWallet-S3CAM ;;
  pixie) ENV=pixie;      CHIP=ESP32-C3; ESPCHIP=esp32c3; MODEL=LeekWallet-Pixie ;;
  *)     echo "unknown board '$BOARD' (s3, s3cam or pixie)" >&2; exit 2 ;;
esac

PROBE="${PROBE:-python3 scripts/board-model.py}"   # overridable for testing
ESPTOOL="${ESPTOOL:-esptool.py}"
command -v "$ESPTOOL" >/dev/null || ESPTOOL="$HOME/.platformio/packages/tool-esptoolpy/esptool.py"

if (( BUILD )) && (( ! DRY )); then
  echo "== building $ENV"
  pio run -e "$ENV" >/dev/null
fi
BUILDDIR=".pio/build/$ENV"
[[ -f "$BUILDDIR/firmware.bin" ]] || (( DRY )) || { echo "no $BUILDDIR/firmware.bin; build first" >&2; exit 1; }

# ---------------------------------------------------------------- discovery

shopt -s nullglob
if [[ -n "$PORT" ]]; then PORTS=("$PORT"); else PORTS=(/dev/ttyACM* /dev/ttyUSB*); fi
(( ${#PORTS[@]} )) || { echo "no boards found on /dev/ttyACM* or /dev/ttyUSB*" >&2; exit 2; }

declare -A SEEN_MAC=()
MATCH=(); UNKNOWN=(); OTHER=()

for P in "${PORTS[@]}"; do
  INFO=$("$ESPTOOL" --port "$P" chip_id 2>/dev/null || true)
  C=$(grep -oE 'ESP32-(S3|C3)' <<<"$INFO" | head -1 || true)
  MAC=$(grep -oiE 'MAC: *([0-9a-f]{2}:){5}[0-9a-f]{2}' <<<"$INFO" | head -1 | awk '{print tolower($2)}' || true)

  if [[ -z "$C" ]]; then echo "   $P: no ESP32 answered - skipped"; continue; fi
  if [[ "$C" != "$CHIP" ]]; then echo "   $P: $C, not $CHIP - skipped"; continue; fi
  if [[ -n "$MAC" && -n "${SEEN_MAC[$MAC]:-}" ]]; then
    echo "   $P: same board as ${SEEN_MAC[$MAC]} (MAC $MAC) - skipped"; continue
  fi
  [[ -n "$MAC" ]] && SEEN_MAC[$MAC]="$P"

  # chip_id resets the board, so give it time to boot before asking.
  GOT=$($PROBE "$P" 2.5 2>/dev/null || echo none)
  if [[ "$GOT" == "$MODEL" ]]; then
    echo "   $P: $GOT (MAC $MAC) - match"; MATCH+=("$P")
  elif [[ "$GOT" == "none" ]]; then
    echo "   $P: $C (MAC $MAC), did not identify itself"; UNKNOWN+=("$P")
  else
    echo "   $P: $GOT (MAC $MAC) - a different board, refused"; OTHER+=("$P")
  fi
done

# ----------------------------------------------------------------- decision

TARGET=""; MODE=""
if (( ${#MATCH[@]} == 1 )); then
  TARGET="${MATCH[0]}"; MODE=app
  (( FRESH )) && MODE=fresh
elif (( ${#MATCH[@]} > 1 )); then
  echo "more than one $MODEL is attached (${MATCH[*]}). Unplug the others or pass --port." >&2
  exit 3
elif [[ -n "$PORT" && ${#UNKNOWN[@]} -eq 1 ]]; then
  if (( ! FRESH )); then
    echo "$PORT did not identify itself as $MODEL." >&2
    echo "If it is a blank $BOARD board, re-run with --port $PORT --fresh." >&2
    echo "If it already runs LeekWallet, select USB as its transport on the device and retry." >&2
    exit 3
  fi
  TARGET="$PORT"; MODE=fresh
else
  echo "no board identified itself as $MODEL." >&2
  (( ${#UNKNOWN[@]} )) && echo "unidentified $CHIP on: ${UNKNOWN[*]} - to flash one, name it with --port and --fresh." >&2
  exit 3
fi

echo
echo "   board:  $MODEL  ($ENV)"
echo "   port:   $TARGET"
if [[ "$MODE" == app ]]; then
  echo "   write:  app only at 0x10000, no erase - wallets and PIN are kept"
else
  echo "   write:  bootloader + partition table + app (first flash), no erase"
fi
(( DRY )) && { echo "   dry run: nothing written"; exit 0; }

if (( ! YES )); then
  read -rp "   flash it? [y/N] " a
  [[ "$a" == y || "$a" == Y ]] || { echo "   nothing written"; exit 1; }
fi

# ------------------------------------------------------------------- flash

if [[ "$MODE" == app ]]; then
  "$ESPTOOL" --chip "$ESPCHIP" --port "$TARGET" write_flash 0x10000 "$BUILDDIR/firmware.bin"
else
  "$ESPTOOL" --chip "$ESPCHIP" --port "$TARGET" write_flash \
      0x0     "$BUILDDIR/bootloader.bin" \
      0x8000  "$BUILDDIR/partitions.bin" \
      0x10000 "$BUILDDIR/firmware.bin"
fi

echo "== checking what came up"
GOT=$($PROBE "$TARGET" 3 2>/dev/null || echo none)
if [[ "$GOT" == "$MODEL" ]]; then
  echo "   $TARGET now answers as $GOT"
else
  echo "   $TARGET answered '$GOT' - expected $MODEL. If this is the UART bridge port, that is normal: use the native USB port for the companion." >&2
fi
