#!/bin/sh
# quirc is ISC licensed, which is compatible with this repository's Apache-2.0.
# It is fetched rather than vendored so the version in use is always explicit.
set -e
REV=master
[ -d quirc ] || git clone --depth 1 -b "$REV" https://github.com/dlbeer/quirc.git
echo "quirc at $(git -C quirc rev-parse --short HEAD)"
