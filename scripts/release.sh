#!/usr/bin/env bash
#
# Build a release from a tag, into a directory nobody has to trust. (T37)
#
# The point is that this script does the same thing on your machine as on
# anyone else's, so a third party can run it on the same tag and get the same
# hashes. Everything it does is therefore driven by the tag and nothing by the
# working tree: it clones, checks out, builds, and writes a manifest.
#
#   ./scripts/release.sh v0.3.0                  default (unsigned) firmware
#   ./scripts/release.sh v0.3.0 esp32s3-secure   the signed, shippable one
#
# Output lands in release/<tag>/<env>/ and is never committed.
#
# What this produces is a set of binaries and a SHA256SUMS file. Be clear about
# what that buys, because it is easy to oversell:
#
#   - a hash lets someone check that the file they downloaded is the file that
#     was published. It says nothing about who published it, and nothing about
#     any board.
#   - a *matching independent rebuild* is the real claim: it says the published
#     binary came from the published source and contains nothing else.
#   - only secure boot, with the key digest burned into a board's eFuses, makes
#     any statement about what a particular device will run.
#
# docs/RELEASE.md is the procedure this script is one step of.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TAG="${1:-}"
ENV_NAME="${2:-esp32s3}"

if [[ -z "${TAG}" ]]; then
    echo "usage: $0 <tag-or-commit> [env]  (default env: esp32s3)" >&2
    exit 2
fi
if ! command -v pio >/dev/null 2>&1; then
    echo "release: pio not on PATH" >&2
    exit 2
fi
if ! git -C "${ROOT}" rev-parse --verify --quiet "${TAG}^{commit}" >/dev/null; then
    echo "release: '${TAG}' is not a commit in this repository" >&2
    exit 2
fi

COMMIT=$(git -C "${ROOT}" rev-parse "${TAG}")
OUT="${ROOT}/release/${TAG}/${ENV_NAME}"

# ---------------------------------------------------------------------------
# The secure environment builds SIGNED binaries, which means it reads the
# secure boot signing key. Every rule about that key already lives in
# preflight-secure.sh - it refuses a placeholder, a wrong-sized key, a
# world-readable one, and a key that git is tracking. Re-implementing any of
# that here would give this project two definitions of "the key is safe to
# use", and they would drift.
#
# So this only decides *when* to call it, after the build has produced the
# artefacts it inspects.
# ---------------------------------------------------------------------------
SIGNED=0
[[ "${ENV_NAME}" == *secure* ]] && SIGNED=1

echo "==> Release ${TAG} (${COMMIT}), env ${ENV_NAME}"
[[ "${SIGNED}" -eq 1 ]] && echo "    signed build - the signing key will be read"

WORK=$(mktemp -d) || exit 2
SRC="${WORK}/src"
trap 'rm -rf "${WORK}"' EXIT

# Cloned rather than built in place: a release must not be able to contain an
# uncommitted edit, and this is the only way to be sure of that rather than to
# remember to check.
if ! git clone --quiet --shared --no-checkout "${ROOT}" "${SRC}"; then
    echo "release: clone failed" >&2
    exit 2
fi
git -C "${SRC}" checkout --quiet --detach "${COMMIT}" || exit 2

# The signing key is deliberately NOT copied into the clone. The build reads it
# at the path CONFIG_SECURE_BOOT_SIGNING_KEY names; if that is relative, it
# resolves inside the clone and the build fails loudly - which is the right
# outcome, because a key that a release script silently copies around is a key
# that ends up in a tarball. Point the config at an absolute path on removable
# media instead.

echo "-- building"
if ! pio run -d "${SRC}" -e "${ENV_NAME}" >"${WORK}/build.log" 2>&1; then
    echo "release: build failed; last lines:" >&2
    tail -40 "${WORK}/build.log" >&2
    exit 1
fi

BUILD="${SRC}/.pio/build/${ENV_NAME}"
rm -rf "${OUT}"
mkdir -p "${OUT}"

# Only what someone flashes or verifies. No ELF, no map file: they carry
# absolute paths and debug info, they are not what runs, and publishing them
# invites verifying the wrong artefact.
for f in firmware.bin bootloader.bin partitions.bin \
         firmware-signed.bin bootloader-signed.bin partitions-signed.bin; do
    [[ -f "${BUILD}/${f}" ]] && cp "${BUILD}/${f}" "${OUT}/"
done
[[ -f "${SRC}/partitions.csv" ]] && cp "${SRC}/partitions.csv" "${OUT}/"
[[ -f "${SRC}/partitions-secure.csv" ]] && cp "${SRC}/partitions-secure.csv" "${OUT}/"

if [[ "${SIGNED}" -eq 1 ]]; then
    echo
    echo "-- pre-flight (signing key, signatures, bootloader fit)"
    # Run inside the clone: preflight reads the generated sdkconfig.<env> and
    # the build directory, both of which are the clone's, not the worktree's.
    if ! (cd "${SRC}" && ./scripts/preflight-secure.sh "${ENV_NAME}"); then
        echo "release: pre-flight refused this build - not publishing it" >&2
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# The manifest. Written last, over the exact files that were copied.
# ---------------------------------------------------------------------------
(cd "${OUT}" && sha256sum -- *.bin > SHA256SUMS)

{
    echo "tag:        ${TAG}"
    echo "commit:     ${COMMIT}"
    echo "env:        ${ENV_NAME}"
    echo "platform:   $(grep -m1 '^platform *=' "${SRC}/platformio.ini" | cut -d= -f2- | tr -d ' ')"
    echo "built by:   scripts/release.sh"
    echo
    echo "Rebuild and compare:"
    echo "    git clone <repo> && cd leekwallet && git checkout ${TAG}"
    echo "    ./scripts/release.sh ${TAG} ${ENV_NAME}"
    echo "    sha256sum -c SHA256SUMS"
    echo
    echo "A matching hash proves the download is intact and, if you built it"
    echo "yourself, that it came from this source. It proves nothing about any"
    echo "device: only secure boot does that. See docs/RELEASE.md."
} > "${OUT}/BUILDINFO"

echo
echo "-- ${OUT}"
cat "${OUT}/SHA256SUMS"
echo
echo "Publish SHA256SUMS and BUILDINFO alongside the binaries, and sign"
echo "SHA256SUMS with the maintainer's GPG key - see docs/RELEASE.md."
