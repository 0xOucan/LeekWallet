#!/usr/bin/env bash
#
# Does this tree build to the same bytes twice? (T37)
#
# Whoever assembles and flashes a board becomes its owner's trust anchor. The
# only way out of "trust me" is for the published binary to be a *function of
# the published source*, so that anyone can rebuild it and get the same hash. A
# checksum next to a download proves what was downloaded; it proves nothing
# about where those bytes came from unless someone else can produce them
# independently.
#
# So this builds the same commit twice, from two different directories, and
# compares the artefacts byte for byte. Two directories rather than two runs in
# one directory, because "same path, same machine, same minute" is the easiest
# case to pass and the least interesting one: an absolute path baked into the
# binary would sail straight through it.
#
#   ./scripts/repro-check.sh              # HEAD, env esp32s3
#   ./scripts/repro-check.sh HEAD~1       # some other commit
#   ./scripts/repro-check.sh HEAD esp32s3-secure
#
# It builds from `git clone`, not from the worktree, so uncommitted edits are
# not what gets tested - a release is built from a commit and this mirrors
# that. A dirty tree is reported, not silently included.
#
# Exit status: 0 identical, 1 divergent, 2 could not run the comparison.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

REF="${1:-HEAD}"
ENV_NAME="${2:-esp32s3}"

# The artefacts a release publishes and a device actually runs. firmware.elf is
# deliberately absent: it carries debug info that is useful to compare while
# debugging divergence but is not what gets flashed, and holding it to the same
# standard would fail the check for reasons nobody is shipping.
ARTEFACTS=(firmware.bin bootloader.bin partitions.bin)

if ! command -v pio >/dev/null 2>&1; then
    echo "repro-check: pio not on PATH - cannot build" >&2
    exit 2
fi
if ! git -C "${ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
    echo "repro-check: not a git checkout - nothing to clone" >&2
    exit 2
fi

COMMIT=$(git -C "${ROOT}" rev-parse --short "${REF}") || exit 2
echo "==> Reproducibility check: ${COMMIT} (${REF}), env ${ENV_NAME}"

if [[ -n "$(git -C "${ROOT}" status --porcelain)" ]]; then
    printf '\033[33m    note: worktree has uncommitted changes; they are NOT in this test\033[0m\n'
fi

# Deliberately different lengths as well as different names. A path baked into
# a binary usually shifts everything after it, and equal-length paths can hide
# that by producing a same-size difference in one field nobody dumps.
WORK=$(mktemp -d) || exit 2
A="${WORK}/a"
B="${WORK}/build-two-with-a-much-longer-name"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

for dir in "${A}" "${B}"; do
    if ! git clone --quiet --shared --no-checkout "${ROOT}" "${dir}"; then
        echo "repro-check: clone into ${dir} failed" >&2
        exit 2
    fi
    # --shared borrows objects from ROOT rather than copying them. Safe here:
    # nothing prunes ROOT during the run, and the clones are read-only inputs.
    if ! git -C "${dir}" checkout --quiet --detach "${COMMIT}"; then
        echo "repro-check: checkout of ${COMMIT} failed" >&2
        exit 2
    fi
done

status=0
for dir in "${A}" "${B}"; do
    printf '\n-- building in %s\n' "${dir}"
    if ! pio run -d "${dir}" -e "${ENV_NAME}" >"${dir}/build.log" 2>&1; then
        echo "repro-check: build failed in ${dir}; last lines:" >&2
        tail -30 "${dir}/build.log" >&2
        exit 2
    fi
done

printf '\n-- comparing artefacts\n'
for f in "${ARTEFACTS[@]}"; do
    fa="${A}/.pio/build/${ENV_NAME}/${f}"
    fb="${B}/.pio/build/${ENV_NAME}/${f}"
    if [[ ! -f "${fa}" || ! -f "${fb}" ]]; then
        printf '  \033[33mSKIP\033[0m  %s (not produced by this environment)\n' "${f}"
        continue
    fi
    if cmp -s "${fa}" "${fb}"; then
        printf '  \033[32mOK\033[0m    %-16s %s\n' "${f}" "$(sha256sum "${fa}" | cut -c1-16)..."
    else
        status=1
        printf '  \033[31mDIFF\033[0m  %s\n' "${f}"
        # The byte offsets are the whole diagnostic. Historically every
        # divergence here was a timestamp or a hash-of-a-timestamp, and the
        # offsets say which: 0x70/0x80 is esp_app_desc_t's time/date, 0xb0 is
        # the recorded ELF SHA-256, and the last 32 bytes are the image's own
        # appended SHA-256 - the latter two are consequences, not causes.
        printf '        differing bytes (1-based offsets, first 12):\n'
        cmp -l "${fa}" "${fb}" 2>/dev/null | head -12 | \
            awk '{ printf "          %8d  0x%X\n", $1, $1 - 1 }'
        printf '        total differing bytes: %s of %s\n' \
            "$(cmp -l "${fa}" "${fb}" 2>/dev/null | wc -l)" \
            "$(stat -c %s "${fa}")"
    fi
done

printf '\n'
if [[ "${status}" -ne 0 ]]; then
    printf '\033[31mNOT REPRODUCIBLE\033[0m - see docs/RELEASE.md, section "When the check fails".\n'
    exit 1
fi

printf '\033[32mByte-identical across two paths.\033[0m\n'
echo
echo "This says the build is a function of the source, on this machine with this"
echo "toolchain. It does NOT say a different toolchain version produces the same"
echo "bytes, and it says nothing at all about what is running on any board."
