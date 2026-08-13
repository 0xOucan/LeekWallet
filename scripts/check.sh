#!/usr/bin/env bash
#
# Everything that can be checked without a board attached.
#
# This is the script CI runs, and running it locally is the same thing CI does
# rather than an approximation of it. Keeping one definition means a green run
# here and a red run there cannot disagree about what "green" means.
#
#   ./scripts/check.sh            everything
#   ./scripts/check.sh sim        just the C suites
#   ./scripts/check.sh app        just the TypeScript
#   ./scripts/check.sh firmware   just the ESP-IDF build
#
# Exits non-zero on the first failure, and says which stage.

set -uo pipefail

cd "$(dirname "$0")/.."

WHAT="${1:-all}"
failed=()

run() {
    local name="$1"; shift
    printf '\n\033[1m== %s\033[0m\n' "$name"
    if "$@"; then
        printf '\033[32m   ok\033[0m\n'
    else
        printf '\033[31m   FAILED\033[0m\n'
        failed+=("$name")
    fi
}

# The C suites are the fast ones and catch the most, so they go first: a broken
# firmware invariant should not wait behind a toolchain download.
if [[ "$WHAT" == "all" || "$WHAT" == "sim" ]]; then
    run "host suites (sim)" make -C sim test
fi

if [[ "$WHAT" == "all" || "$WHAT" == "app" ]]; then
    if command -v pnpm >/dev/null 2>&1; then
        run "app tests" pnpm --dir app test
        run "app typecheck" pnpm --dir app typecheck
    else
        printf '\n\033[33m== app: skipped, pnpm not installed\033[0m\n'
    fi
fi

# Last because it is slow and needs the ESP-IDF toolchain. Note this only proves
# the firmware compiles; whether it behaves is what the host suites are for.
if [[ "$WHAT" == "all" || "$WHAT" == "firmware" ]]; then
    if command -v pio >/dev/null 2>&1; then
        run "firmware build" pio run -e esp32s3
    else
        printf '\n\033[33m== firmware: skipped, pio not installed\033[0m\n'
    fi
fi

printf '\n'
if (( ${#failed[@]} )); then
    printf '\033[31mFAILED: %s\033[0m\n' "${failed[*]}"
    exit 1
fi
printf '\033[32mAll checks passed.\033[0m\n'
