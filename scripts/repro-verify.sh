#!/usr/bin/env bash
#
# Does the whole release build to the same bytes twice? (T37)
#
# `repro-check.sh` answers that question for the firmware, and answers it well:
# it builds one commit twice from two paths of deliberately different length
# and compares what gets flashed. This script does not repeat any of that. It
# calls it, and then asks the same question of the other half of a release -
# the companion app - which nothing checked until now.
#
# That gap mattered more than it looked. The roadmap plans to publish the
# companion as GitHub releases for Linux, Windows and macOS, and to ship a
# firmware flasher inside it (T65). A flasher is a program that writes to the
# device the wallet is meant to protect, distributed as a binary most users
# will never build. If that binary is not reproducible then the checksum next
# to it proves only that the download is intact - it proves nothing about which
# source produced it, and the flasher's authority over the device rests on
# exactly nobody having checked.
#
#   ./scripts/repro-verify.sh              # firmware + companion, HEAD
#   ./scripts/repro-verify.sh firmware     # just the firmware (repro-check.sh)
#   ./scripts/repro-verify.sh companion    # just the companion
#   ./scripts/repro-verify.sh companion HEAD~1
#
# Exit status: 0 identical, 1 divergent, 2 could not run the comparison.
#
# ---------------------------------------------------------------------------
# Why the companion is built twice at the SAME path, when the firmware is
# deliberately built at two different ones
# ---------------------------------------------------------------------------
#
# Because the Rust half is not path-independent, and this was measured rather
# than assumed. Building the same commit at /tmp/reprox/a and at
# /tmp/reprox/build-two-with-a-much-longer-name-here produced two libraries
# that differ - but the interesting part is *how* they differ:
#
#     .text              SAME (233843 bytes)
#     .rodata            SAME (18536)
#     .data.rel.ro       SAME (5864)
#     .data              SAME (2472)
#     .eh_frame          DIFF (19632 vs 19632)   same size, different order
#     .gcc_except_table  DIFF (765556 vs 765580)
#
# The compiled code is byte-identical. Only the unwind and exception-handling
# metadata moves, and the 24-byte size change cascades into a 32-byte shift of
# every section header after it, which is why a naive `cmp` reports 677830
# differing bytes and looks far worse than it is. No absolute path appears
# anywhere in either binary - `strings | grep` finds zero occurrences of the
# build directory in both.
#
# `--remap-path-prefix` was tried, over the manifest directory, the workspace
# root and $HOME/.cargo, and changed neither hash by a single byte. That is the
# useful negative result: the paths are not being *embedded*, so remapping them
# has nothing to rewrite. What the path changes is cargo's `-C metadata` hash,
# which is derived from the absolute manifest path and feeds the names of the
# codegen units. Different object file names, different link order, different
# ordering inside the tables that the linker concatenates.
#
# There is no stable-Rust flag that fixes this (`-Ztrim-paths` is nightly and
# would only address embedding, which is not the problem). So the answer is the
# one the wider Rust ecosystem uses - Debian builds Rust packages this way too:
# **make the build path part of the published build recipe.** Both passes here
# run in ${LEEK_REPRO_ROOT:-/tmp/leekwallet-repro-build}, and so must anyone
# reproducing a release. It is a weaker property than the firmware's and this
# script does not pretend otherwise: it verifies that the companion is a
# function of the source *and the documented build path*, not of the source
# alone.
#
# Running with LEEK_REPRO_VARY_PATH=1 does the firmware-style thing anyway, at
# two different paths. It is expected to fail on the Rust artefact. It exists
# so the limitation above stays a measurement that anyone can re-take, rather
# than a paragraph that slowly becomes untrue in either direction.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

WHAT="${1:-all}"
REF="${2:-HEAD}"

CANON_ROOT="${LEEK_REPRO_ROOT:-/tmp/leekwallet-repro-build}"
VARY="${LEEK_REPRO_VARY_PATH:-0}"

status=0
ran_something=0

note()  { printf '  \033[33m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32mOK\033[0m    %-28s %s\n' "$1" "$2"; }
bad()   { printf '  \033[31mDIFF\033[0m  %s\n' "$1"; status=1; }

# ---------------------------------------------------------------------------
# Firmware: not reimplemented here. One definition of "the firmware is
# reproducible" is the only way the two can never disagree.
# ---------------------------------------------------------------------------
if [[ "${WHAT}" == "all" || "${WHAT}" == "firmware" ]]; then
    ran_something=1
    printf '\n\033[1m== firmware\033[0m (delegating to repro-check.sh)\n\n'
    if [[ ! -x "${ROOT}/scripts/repro-check.sh" ]]; then
        echo "repro-verify: scripts/repro-check.sh missing or not executable" >&2
        exit 2
    fi
    "${ROOT}/scripts/repro-check.sh" "${REF}"
    rc=$?
    # 2 means "could not run" - usually pio absent. That is not a divergence
    # and must not be reported as one, but it must not be reported as a pass
    # either.
    if [[ ${rc} -eq 2 ]]; then
        note "firmware check could not run (see message above); not counted"
    elif [[ ${rc} -ne 0 ]]; then
        status=1
    fi
fi

# ---------------------------------------------------------------------------
# Companion
# ---------------------------------------------------------------------------
build_companion() {
    # $1 = directory to build in (already checked out), $2 = label
    local dir="$1" label="$2"
    local app="${dir}/app"

    printf -- '-- %s: pnpm install\n' "${label}"
    if ! (cd "${app}" && pnpm install --frozen-lockfile) >"${dir}/install.log" 2>&1; then
        echo "repro-verify: pnpm install failed in ${dir}; last lines:" >&2
        tail -20 "${dir}/install.log" >&2
        return 2
    fi

    printf -- '-- %s: vite build\n' "${label}"
    if ! (cd "${app}" && pnpm build) >"${dir}/vite.log" 2>&1; then
        echo "repro-verify: vite build failed in ${dir}; last lines:" >&2
        tail -20 "${dir}/vite.log" >&2
        return 2
    fi

    # The release binary, not the bundled installer. The .deb/.msi/.dmg that a
    # user actually downloads is built by `tauri build`, which shells out to
    # dpkg-deb, WiX and hdiutil - none of which this project controls, and at
    # least the first two stamp their own timestamps into the archive. Those
    # are a separate and harder problem; claiming them here would be claiming
    # something nobody has measured. What is checked is the executable inside
    # the package, which is the part this repository's source determines.
    printf -- '-- %s: cargo build --release (several minutes)\n' "${label}"
    if ! (cd "${app}/src-tauri" && \
          SOURCE_DATE_EPOCH="${SDE}" cargo build --release --bin leekwallet-companion) \
          >"${dir}/cargo.log" 2>&1; then
        echo "repro-verify: cargo build failed in ${dir}; last lines:" >&2
        tail -30 "${dir}/cargo.log" >&2
        return 2
    fi
    return 0
}

hash_companion() {
    # $1 = build dir, $2 = output file of "sha256  name" lines. Names are made
    # relative so that two builds at two paths still compare by artefact rather
    # than by where they happened to live.
    local dir="$1" out="$2"
    : > "${out}"
    (cd "${dir}/app/dist" && find . -type f | sort | xargs sha256sum) >> "${out}" || return 1
    local bin="${dir}/app/src-tauri/target/release/leekwallet-companion"
    if [[ -f "${bin}" ]]; then
        printf '%s  ./leekwallet-companion\n' \
            "$(sha256sum "${bin}" | cut -d' ' -f1)" >> "${out}"
    fi
    return 0
}

if [[ "${WHAT}" == "all" || "${WHAT}" == "companion" ]]; then
    ran_something=1
    printf '\n\033[1m== companion\033[0m\n\n'

    for tool in pnpm cargo git; do
        if ! command -v "${tool}" >/dev/null 2>&1; then
            echo "repro-verify: ${tool} not on PATH - cannot check the companion" >&2
            exit 2
        fi
    done

    COMMIT=$(git -C "${ROOT}" rev-parse --short "${REF}") || exit 2
    echo "commit ${COMMIT} (${REF})"
    if [[ -n "$(git -C "${ROOT}" status --porcelain)" ]]; then
        note "worktree has uncommitted changes; they are NOT in this test"
    fi

    # SOURCE_DATE_EPOCH is the commit's own time, so it is a function of what
    # is being built rather than of when someone pressed the button. Nothing in
    # the two artefacts compared below currently consumes it - it is exported
    # for the packaging steps that will, and so that a tool which starts
    # reading it does not silently reintroduce wall-clock time.
    SDE=$(git -C "${ROOT}" show -s --format=%ct "${COMMIT}") || exit 2
    export SOURCE_DATE_EPOCH="${SDE}"
    echo "SOURCE_DATE_EPOCH ${SDE} (commit time)"

    RESULTS=$(mktemp -d) || exit 2
    trap 'rm -rf "${RESULTS}"' EXIT

    if [[ "${VARY}" == "1" ]]; then
        note "LEEK_REPRO_VARY_PATH=1: building at two different paths."
        note "The Rust artefact is EXPECTED to differ - see this script's header."
        DIRS=("${CANON_ROOT}-a" "${CANON_ROOT}-two-with-a-much-longer-name")
    else
        echo "build path ${CANON_ROOT} (same for both passes - see header)"
        DIRS=("${CANON_ROOT}" "${CANON_ROOT}")
    fi

    pass=0
    for dir in "${DIRS[@]}"; do
        pass=$((pass + 1))
        printf '\n'
        # Removed before *and* after: a leftover target/ from an earlier run
        # would make pass 2 an incremental build, and an incremental build that
        # matches proves nothing at all.
        rm -rf "${dir}"
        if ! git clone --quiet --shared --no-checkout "${ROOT}" "${dir}"; then
            echo "repro-verify: clone into ${dir} failed" >&2
            exit 2
        fi
        if ! git -C "${dir}" checkout --quiet --detach "${COMMIT}"; then
            echo "repro-verify: checkout of ${COMMIT} failed" >&2
            exit 2
        fi

        build_companion "${dir}" "pass ${pass}" || exit 2
        hash_companion "${dir}" "${RESULTS}/pass${pass}" || exit 2
        rm -rf "${dir}"
    done

    printf '\n-- comparing artefacts\n'
    # Compare by artefact name, so a file present in one pass and missing from
    # the other is reported as a difference rather than quietly skipped.
    all_names=$(cat "${RESULTS}/pass1" "${RESULTS}/pass2" | awk '{print $2}' | sort -u)
    while read -r name; do
        [[ -z "${name}" ]] && continue
        h1=$(awk -v n="${name}" '$2 == n {print $1}' "${RESULTS}/pass1")
        h2=$(awk -v n="${name}" '$2 == n {print $1}' "${RESULTS}/pass2")
        if [[ -z "${h1}" || -z "${h2}" ]]; then
            bad "${name} (produced by only one of the two builds)"
        elif [[ "${h1}" == "${h2}" ]]; then
            ok "${name}" "${h1:0:16}..."
        else
            bad "${name}"
            printf '        pass 1  %s\n        pass 2  %s\n' "${h1}" "${h2}"
        fi
    done <<< "${all_names}"
fi

if [[ "${ran_something}" -eq 0 ]]; then
    echo "usage: $0 [all|firmware|companion] [ref]" >&2
    exit 2
fi

printf '\n'
if [[ "${status}" -ne 0 ]]; then
    printf '\033[31mNOT REPRODUCIBLE\033[0m - see docs/RELEASE.md, section "When the check fails".\n'
    exit 1
fi

printf '\033[32mIdentical across two builds.\033[0m\n'
echo
echo "Scope, stated so it cannot be overread: this machine, this toolchain, and"
echo "for the companion, this build path. It says nothing about a different"
echo "toolchain version, nothing about the packaged installers, and nothing at"
echo "all about what is running on any board."
