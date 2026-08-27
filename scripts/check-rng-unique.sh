#!/usr/bin/env bash
# Exactly one implementation of the RNG entry points may exist.
#
# `random_buffer()` is what `mnemonic_generate()` calls, so it is the function
# that decides whether a seed is worth anything. A second definition of it once
# sat in components/trezor-crypto/rand_esp32.c calling esp_fill_random()
# directly -- no health check, no bootloader RNG when RF is down, no user pool,
# and no abort on failure.
#
# That was not a bug that fired. The linker resolved the symbol to the checked
# copy in src/, because objects in the main application are searched before
# archive members. It was a bug waiting for a build-layout change, and its
# failure mode is the worst kind available here: no duplicate-symbol error, no
# warning, no runtime symptom, just seeds drawn from an unchecked source.
#
# So the invariant is enforced where it can be seen, rather than trusted to
# link order that nobody chose deliberately.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# The vendored trezor-crypto carries a Numerical Recipes LCG behind
# USE_INSECURE_PRNG, which upstream ships to make the library testable and
# labels "NOT SUITABLE FOR PRODUCTION USE". Defining that macro in this project
# would replace the wallet's RNG with a linear congruential generator, and the
# only outward sign would be seeds an attacker can enumerate. It is not defined
# today; this is what keeps it that way.
if grep -rq 'USE_INSECURE_PRNG' platformio.ini CMakeLists.txt sdkconfig* \
        components/*/CMakeLists.txt 2>/dev/null; then
    echo "check-rng-unique: USE_INSECURE_PRNG appears in the build configuration"
    echo "    that macro swaps the RNG for an LCG upstream calls unfit for production"
    fail=1
fi

for sym in random_buffer random32; do
    # A definition, not a call or a declaration: the symbol at the start of a
    # line, preceded by its return type, and followed by a brace-bearing body.
    # rand.c's copies live inside #ifdef USE_INSECURE_PRNG, which the check
    # above proves is never set, so that file is excluded by name rather than
    # by trying to parse preprocessor conditionals in grep.
    hits=$(grep -rlE "^(void|uint32_t)[[:space:]]+${sym}\(" \
             --include='*.c' src components 2>/dev/null \
             | grep -v 'components/trezor-crypto/rand\.c$' | sort || true)
    count=$(printf '%s' "$hits" | grep -c . || true)
    if [ "$count" -ne 1 ]; then
        echo "check-rng-unique: expected exactly 1 definition of ${sym}(), found ${count}"
        printf '%s\n' "$hits" | sed 's/^/    /'
        fail=1
    fi
done
[ "$fail" -eq 0 ] && echo "   ok"
exit "$fail"
