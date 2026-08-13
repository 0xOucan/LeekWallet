#!/usr/bin/env bash
# Pre-flight checks before burning eFuses on a real ESP32-S3.
#
# Run this immediately before every step of docs/BURN-PROCEDURE.md. eFuses are
# one-way: there is no undo, no reflash, no factory reset. A board that boots
# with the wrong fuse scheme is scrap, and a *scheme* that is wrong makes every
# board built from it scrap.
#
# The checks below all exist because something in this repository was once
# silently wrong in exactly that way:
#
#   - the generated sdkconfig.<env> is the truth, not sdkconfig.secure, and it
#     does NOT regenerate when the defaults change (see .gitignore);
#   - `extends` in platformio.ini does not merge sdkconfig_defaults, so a build
#     reported SUCCESS with none of the security options set;
#   - a signed bootloader outgrew the default 0x8000 partition-table offset,
#     which on hardware is a boot loop with no output at all.
#
# So: trust nothing that was written by hand. Every assertion here reads a
# generated artefact.
set -uo pipefail

ENV_NAME="${1:-esp32s3-secure}"
BUILD_DIR=".pio/build/${ENV_NAME}"
SDKCONFIG="sdkconfig.${ENV_NAME}"
SIGNING_KEY="secure_boot_signing_key.pem"

FAILURES=0
WARNINGS=0

pass() { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }

echo "==> Pre-flight for environment: ${ENV_NAME}"
echo

# ---------------------------------------------------------------------------
# 0. The generated config must exist and be newer than every input.
#
# This is the trap that bit T17 and the secure environment twice. A stale
# sdkconfig.<env> makes an edit to sdkconfig.secure a no-op while the build
# still says SUCCESS.
# ---------------------------------------------------------------------------
echo "-- Generated config reflects the defaults it was built from"
# Deliberately NOT an mtime comparison. Timestamps say nothing useful here:
# PlatformIO may leave the generated file untouched when a rebuild produces
# identical content, and a checkout reorders every mtime in the tree. What
# matters is the actual invariant - every setting written in the defaults file
# must be present, verbatim, in the generated one. If PlatformIO dropped the
# defaults (the `extends` fault), this is what catches it.
DEFAULTS_SRC="sdkconfig.secure"
if [[ ! -f "${SDKCONFIG}" ]]; then
    fail "${SDKCONFIG} missing - run: pio run -e ${ENV_NAME}"
elif [[ ! -f "${DEFAULTS_SRC}" ]]; then
    fail "${DEFAULTS_SRC} missing"
else
    pass "${SDKCONFIG} present"
    MISSING=0
    while IFS= read -r line; do
        # Kconfig resolves dependencies, so a "=n" in the defaults may legally
        # vanish from the output entirely (the symbol is simply not emitted).
        # Only the positive assertions are checkable line-for-line.
        case "${line}" in
            CONFIG_*=y|CONFIG_*=\"*\"|CONFIG_*=0x*|CONFIG_*=[0-9]*) ;;
            *) continue ;;
        esac
        # A later line in the defaults overrides an earlier one, so check only
        # the last assignment of each symbol.
        sym="${line%%=*}"
        last=$(grep "^${sym}=" "${DEFAULTS_SRC}" | tail -1)
        [[ "${last}" == "${line}" ]] || continue
        if ! grep -qxF "${line}" "${SDKCONFIG}"; then
            # Two very different causes, and only one of them is a brick.
            #
            # A setting can legitimately fail to appear because no component in
            # this project defines that symbol (dead config: CONFIG_TINYUSB_*
            # and the old CONFIG_MBEDTLS_* names are both in that state here),
            # or because Kconfig resolved a choice differently. Those are worth
            # knowing about - a line that does nothing is a lie in a config
            # file - but they do not endanger a burn.
            #
            # A missing SECURE_/PARTITION_/ESPTOOLPY_ setting is the fault that
            # ships an insecure "secure" build or bricks the board, so those
            # refuse outright.
            case "${sym}" in
                CONFIG_SECURE_*|CONFIG_PARTITION_TABLE_*|CONFIG_ESPTOOLPY_*)
                    fail "${line} is in ${DEFAULTS_SRC} but NOT in ${SDKCONFIG}"
                    MISSING=$((MISSING + 1))
                    ;;
                *)
                    warn "${line} had no effect (absent from ${SDKCONFIG})"
                    ;;
            esac
        fi
    done < "${DEFAULTS_SRC}"
    if [[ "${MISSING}" -eq 0 ]]; then
        pass "every burn-critical setting in ${DEFAULTS_SRC} survived into the build"
    else
        echo "        PlatformIO does NOT regenerate ${SDKCONFIG} when the"
        echo "        defaults change - verified, not folklore. Delete it and"
        echo "        rebuild:  rm ${SDKCONFIG} && pio run -e ${ENV_NAME}"
    fi
fi

# ---------------------------------------------------------------------------
# 1. The security options must actually be in the GENERATED config.
# ---------------------------------------------------------------------------
echo
echo "-- Security options (read from ${SDKCONFIG}, not from sdkconfig.secure)"
require_y() {
    if [[ -f "${SDKCONFIG}" ]] && grep -qx "$1=y" "${SDKCONFIG}"; then
        pass "$1=y"
    else
        fail "$1 is not set - the build is NOT secure"
    fi
}
require_y CONFIG_SECURE_FLASH_ENC_ENABLED
require_y CONFIG_SECURE_FLASH_ENCRYPTION_AES256
require_y CONFIG_SECURE_BOOT
require_y CONFIG_SECURE_BOOT_V2_ENABLED
require_y CONFIG_SECURE_BOOT_BUILD_SIGNED_BINARIES

# ---------------------------------------------------------------------------
# 2. Which flash-encryption mode. DEVELOPMENT is reflashable; RELEASE is not.
#
# Not a pass/fail: both are legitimate, at different points in the procedure.
# What matters is that the operator knows which one is about to be burned.
# ---------------------------------------------------------------------------
echo
echo "-- Flash encryption mode"
if grep -qx "CONFIG_SECURE_FLASH_ENCRYPTION_MODE_DEVELOPMENT=y" "${SDKCONFIG}" 2>/dev/null; then
    pass "DEVELOPMENT mode - the board stays reflashable (steps 1-6)"
    warn "not shippable: UART download mode can still re-encrypt arbitrary data"
elif grep -qx "CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE=y" "${SDKCONFIG}" 2>/dev/null; then
    warn "RELEASE mode - IRREVERSIBLE. This board can never be reflashed again."
    warn "Only proceed if DEVELOPMENT mode already booted on THIS board."
else
    fail "neither DEVELOPMENT nor RELEASE mode is set"
fi

# ---------------------------------------------------------------------------
# 3. The classic brick: a signed bootloader that outgrows its offset.
#
# Signing pads the bootloader to a 4 KB boundary and appends a 4 KB signature
# sector. If the result reaches the partition-table offset, the table is
# overwritten by the bootloader's own tail and the board boot-loops silently.
# On the S3 the bootloader starts at 0x0, so the budget is simply the offset.
# ---------------------------------------------------------------------------
echo
echo "-- Bootloader fit"
BL="${BUILD_DIR}/bootloader-signed.bin"
OFFSET_HEX=$(grep -oP '^CONFIG_PARTITION_TABLE_OFFSET=\K.*' "${SDKCONFIG}" 2>/dev/null)
# Resolved once, up front: the offset check below runs even when the bootloader
# is missing, and an unset OFFSET there aborts the script mid-report under -u.
OFFSET=$(( ${OFFSET_HEX:-0} ))
if [[ ! -f "${BL}" ]]; then
    fail "${BL} missing - the build did not produce a SIGNED bootloader"
elif [[ -z "${OFFSET_HEX}" ]]; then
    fail "CONFIG_PARTITION_TABLE_OFFSET not found in ${SDKCONFIG}"
else
    BL_SIZE=$(stat -c %s "${BL}")
    HEADROOM=$((OFFSET - BL_SIZE))
    printf '        signed bootloader %d bytes (0x%X), table at 0x%X\n' \
        "${BL_SIZE}" "${BL_SIZE}" "${OFFSET}"
    if [[ "${HEADROOM}" -le 0 ]]; then
        fail "bootloader overruns the partition table by $(( -HEADROOM )) bytes - THIS BRICKS THE BOARD"
    elif [[ "${HEADROOM}" -lt 4096 ]]; then
        warn "only ${HEADROOM} bytes of headroom - one more bootloader feature overruns it"
    else
        pass "${HEADROOM} bytes of headroom below the partition table"
    fi
fi

# ---------------------------------------------------------------------------
# 4. The partition table must not sit under the bootloader or the app under it.
# ---------------------------------------------------------------------------
echo
echo "-- Partition table offsets"
PT_CSV=$(grep -oP '^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="\K[^"]+' "${SDKCONFIG}" 2>/dev/null)
if [[ -n "${PT_CSV}" && -f "${PT_CSV}" ]]; then
    pass "using ${PT_CSV}"
    FIRST=$(grep -v '^\s*#' "${PT_CSV}" | grep -oP '0x[0-9A-Fa-f]+' | head -1)
    if [[ -n "${FIRST}" && "${OFFSET}" -gt 0 ]]; then
        # The table itself occupies 0x1000 (and 0x1000 more when signed).
        MIN=$(( OFFSET + 0x2000 ))
        if [[ $((FIRST)) -lt "${MIN}" ]]; then
            fail "first partition at ${FIRST} overlaps the signed partition table"
        else
            pass "first partition at ${FIRST} clears the signed table"
        fi
    fi
else
    fail "partition CSV '${PT_CSV}' not found"
fi

# ---------------------------------------------------------------------------
# 5. The signing key. Whoever holds this can sign firmware the device accepts.
#
# Refuse a missing key, refuse a placeholder, refuse a world-readable one, and
# refuse a key that lives inside the repository worktree where a stray `git add
# -f` or a backup tool can carry it off.
# ---------------------------------------------------------------------------
echo
echo "-- Secure boot signing key"
KEY_PATH=$(grep -oP '^CONFIG_SECURE_BOOT_SIGNING_KEY="\K[^"]+' "${SDKCONFIG}" 2>/dev/null)
KEY_PATH="${KEY_PATH:-${SIGNING_KEY}}"
if [[ ! -f "${KEY_PATH}" ]]; then
    fail "${KEY_PATH} missing - generate with:"
    echo "          espsecure.py generate-signing-key --version 2 --scheme rsa3072 ${KEY_PATH}"
else
    pass "${KEY_PATH} present"

    # Placeholder rejection. Any example/committed key must be unmistakably
    # unusable, and the check must key on content rather than filename so
    # renaming it is not a way round.
    if grep -qiE 'PLACEHOLDER|EXAMPLE|DO NOT USE|NOT A REAL KEY' "${KEY_PATH}"; then
        fail "${KEY_PATH} is a PLACEHOLDER, not a real signing key"
    else
        pass "not a placeholder"
    fi

    if ! openssl rsa -in "${KEY_PATH}" -noout -check >/dev/null 2>&1; then
        fail "${KEY_PATH} is not a valid RSA private key"
    else
        BITS=$(openssl rsa -in "${KEY_PATH}" -noout -text 2>/dev/null | grep -oP 'Private-Key: \(\K[0-9]+')
        if [[ "${BITS}" == "3072" ]]; then
            pass "RSA-3072 (secure boot v2 requires exactly this)"
        else
            fail "RSA-${BITS} - secure boot v2 on ESP32-S3 requires RSA-3072"
        fi
    fi

    PERMS=$(stat -c %a "${KEY_PATH}")
    if [[ "${PERMS}" != "600" && "${PERMS}" != "400" ]]; then
        fail "${KEY_PATH} mode is ${PERMS} - run: chmod 600 ${KEY_PATH}"
    else
        pass "mode ${PERMS}"
    fi

    # Not fatal, because the build needs to read it from somewhere. But the key
    # belongs on removable offline media, and being inside the worktree during a
    # burn is the moment it is most likely to leak.
    if git ls-files --error-unmatch "${KEY_PATH}" >/dev/null 2>&1; then
        fail "${KEY_PATH} IS TRACKED BY GIT - the key is compromised, generate a new one"
    else
        pass "not tracked by git"
    fi
    warn "the key is in the worktree; move it to offline media once the burn is done"
fi

# ---------------------------------------------------------------------------
# 6. Signed artefacts must exist. Merging the unsigned ones is a silent brick.
# ---------------------------------------------------------------------------
echo
echo "-- Signed artefacts"
for f in bootloader-signed.bin partitions-signed.bin firmware-signed.bin; do
    if [[ -f "${BUILD_DIR}/${f}" ]]; then
        pass "${f}"
    else
        fail "${BUILD_DIR}/${f} missing - do not flash the unsigned binaries"
    fi
done

# ---------------------------------------------------------------------------
# 7. Verify the signatures against the key that is about to be trusted forever.
#
# The eFuse burn commits a digest of this key's public half. Signing with one
# key and burning the digest of another produces a board that rejects its own
# firmware, permanently.
# ---------------------------------------------------------------------------
echo
echo "-- Signature verification against ${KEY_PATH}"
if [[ -f "${KEY_PATH}" ]] && command -v espsecure.py >/dev/null 2>&1; then
    for f in bootloader-signed.bin firmware-signed.bin; do
        if [[ -f "${BUILD_DIR}/${f}" ]] && \
           espsecure.py verify-signature --version 2 --keyfile "${KEY_PATH}" \
                "${BUILD_DIR}/${f}" >/dev/null 2>&1; then
            pass "${f} verifies against the signing key"
        else
            fail "${f} does NOT verify against ${KEY_PATH}"
        fi
    done
else
    warn "espsecure.py not on PATH - signature verification skipped"
fi

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
echo
if [[ "${FAILURES}" -gt 0 ]]; then
    printf '\033[31m====================================================\033[0m\n'
    printf '\033[31m REFUSING: %d check(s) failed. DO NOT BURN ANYTHING.\033[0m\n' "${FAILURES}"
    printf '\033[31m====================================================\033[0m\n'
    exit 1
fi

printf '\033[32mAll checks passed\033[0m (%d warning(s)).\n' "${WARNINGS}"
echo
echo "This says the build is internally consistent. It does NOT say the eFuse"
echo "scheme is right for your threat model, and it cannot: read"
echo "docs/BURN-PROCEDURE.md and know which step is the last reversible one."
