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
#
# Searched everywhere rather than in a list of build files, because a #define in
# a header compiles exactly as well as a -D on the command line and the previous
# list did not look at any header. components/trezor-crypto/options.h is the
# obvious place for it and was not covered. rand.c is excluded because it is the
# file that *mentions* the macro in its own #ifdef and comments; nothing else in
# the tree has a legitimate reason to name it.
insecure=$(grep -rl 'USE_INSECURE_PRNG' \
        --include='*.c' --include='*.h' --include='*.ini' --include='*.txt' \
        --include='*.cmake' --include='sdkconfig*' --include='*.py' \
        --exclude-dir=node_modules --exclude-dir=.pio --exclude-dir=.git \
        . 2>/dev/null | grep -v '^\./components/trezor-crypto/rand\.c$' || true)
if [ -n "$insecure" ]; then
    echo "check-rng-unique: USE_INSECURE_PRNG appears outside rand.c's own #ifdef"
    echo "    that macro swaps the RNG for an LCG upstream calls unfit for production"
    printf '%s\n' "$insecure" | sed 's/^/    /'
    fail=1
fi

# rand.c is excluded, and the reason matters more than the exclusion.
#
# This used to say its copies "live inside #ifdef USE_INSECURE_PRNG". That is
# true of random32() and false of random_buffer(), which sits below the #endif
# and is compiled unconditionally into libtrezor-crypto.a on every build:
#
#     $ xtensa-esp32s3-elf-nm .pio/build/esp32s3/.../libtrezor-crypto.a
#     00000000 W random_buffer
#
# It is a *weak* definition and src/rand_esp32.c's is strong, so the linker
# picks the checked one deterministically rather than by the archive-order
# accident the original defect relied on -- confirmed by addr2line against the
# built ELF, which resolves random_buffer to src/rand_esp32.c:41. That is why
# this file is excluded rather than deleted. But the exclusion rests on the
# weak/strong rule, not on the macro, and a comment that named the wrong reason
# is how the next person deletes the strong definition and does not find out.
#
# What counts as a definition, and why not a regex on the return type.
#
# The old pattern anchored on the return type being the first token of the line:
# `^(void|uint32_t)[[:space:]]+random_buffer\(`. Four shapes walk straight past
# that -- an attribute before the type, the type on its own line, a typedef'd
# type, and a definition in a directory the search does not cover -- and all
# four were confirmed to evade it. So match on the shape a definition has and a
# call or declaration does not: the symbol applied to an argument list, on a
# line that is not a statement (no `;`) and is not comment prose. That covers
# both brace styles without caring what the return type looks like.
#
# lib/ is searched too. PlatformIO compiles it to a static library and links it,
# which is precisely the archive-member shape the original bug had.
for sym in random_buffer random32; do
    hits=$(find src components lib -name '*.c' 2>/dev/null \
             | grep -v 'components/trezor-crypto/rand\.c$' | sort \
             | xargs -r awk -v sym="$sym" '
                 { line = $0
                   sub(/^[[:space:]]+/, "", line)
                   if (line ~ /^[*\/]/) next          # comment prose
                   # A call or a declaration ends in a statement and opens no
                   # body. A one-line definition has both, so the brace wins.
                   if (line ~ /;/ && line !~ /\{/) next
                   if (line ~ "(^|[^[:alnum:]_])" sym "[[:space:]]*\\(") {
                       print FILENAME } }' | sort -u || true)
    count=$(printf '%s' "$hits" | grep -c . || true)
    if [ "$count" -ne 1 ]; then
        echo "check-rng-unique: expected exactly 1 definition of ${sym}(), found ${count}"
        printf '%s\n' "$hits" | sed 's/^/    /'
        fail=1
    fi
done
[ "$fail" -eq 0 ] && echo "   ok"
exit "$fail"
