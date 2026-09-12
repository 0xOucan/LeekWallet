#!/usr/bin/env bash
# Plan a position ONCE and capture its outputs to a sourceable env file.
#
# Every plan run mints a fresh random salt and a fresh deadline, so `strategy`,
# `ship` and `strategyHash` are only consistent within a single invocation.
# Running plan-position.mjs twice and copying one line from each produces three
# fields that describe three different positions -- and the mismatch surfaces
# as an opaque revert at ship time, not as an error here.
#
# Usage: plan-capture.sh <name> [plan-position.mjs args...]
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="$1"; shift
OUT="$(mktemp -d)/${NAME}.env"; OUT="./${NAME}.env"
TXT="./${NAME}.plan.txt"

node --experimental-strip-types --disable-warning=ExperimentalWarning \
  script/plan-position.mjs "$@" | tee "$TXT"

S=$(awk '/^strategy /{print $2}'     "$TXT")
H=$(awk '/^strategyHash /{print $2}' "$TXT")
P=$(grep -oE '^0xf50b870f[0-9a-f]+$'  "$TXT" | tail -1)
D=$(awk '/^deadline /{print $2}'     "$TXT")

for v in S H P D; do
  [ -n "${!v}" ] || { echo "REFUSED: could not capture field $v from the plan" >&2; exit 1; }
done

{ echo "export STRATEGY=$S"; echo "export SHASH=$H"
  echo "export SHIP=$P";     echo "export PLAN_DEADLINE=$D"; } > "$OUT"

echo
echo "captured -> $OUT   (source it: . $OUT)"
echo "deadline $D = $(date -u -d "@$D" +%Y-%m-%dT%H:%M:%SZ)  /  local $(date -d "@$D" +%H:%M)"
