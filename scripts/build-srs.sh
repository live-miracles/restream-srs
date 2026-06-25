#!/usr/bin/env bash
# Build SRS from source with SRT bonding patch applied.
#
# Run this once on a Linux x86_64 build machine, then use the output binary
# when installing via server-install.sh.
#
# Usage:
#   bash scripts/build-srs.sh
#
# Output:
#   ./build/srs   — patched SRS binary, ready to publish as a GitHub release asset
#
# Build dependencies (Ubuntu/Debian):
#   sudo apt-get install -y build-essential cmake git automake pkg-config
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$REPO_DIR/patches/srs-srt-bonding.patch"
BUILD_DIR="$REPO_DIR/build"
SRS_SRC="$BUILD_DIR/srs-src"
SRS_TAG="${SRS_TAG:-v6.0-r0}"
OUT="$BUILD_DIR/srs"

step() { echo; echo "=== $* ==="; }

step "Check build dependencies"
missing=()
for cmd in git cmake make g++ automake pkg-config; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
done
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: missing: ${missing[*]}" >&2
    echo "Install: sudo apt-get install -y build-essential cmake git automake pkg-config" >&2
    exit 1
fi

mkdir -p "$BUILD_DIR"

step "SRS source ($SRS_TAG)"
if [[ -d "$SRS_SRC/.git" ]]; then
    tag_sha="$(git -C "$SRS_SRC" rev-parse "refs/tags/${SRS_TAG}^{}" 2>/dev/null || true)"
    head_sha="$(git -C "$SRS_SRC" rev-parse HEAD)"
    if [[ -n "$tag_sha" && "$head_sha" == "$tag_sha" ]]; then
        echo "Source already at $SRS_TAG, resetting working tree..."
        git -C "$SRS_SRC" checkout -- .
    else
        echo "Fetching $SRS_TAG..."
        git -C "$SRS_SRC" fetch --depth 1 origin "refs/tags/${SRS_TAG}:refs/tags/${SRS_TAG}"
        git -C "$SRS_SRC" checkout "$SRS_TAG"
        git -C "$SRS_SRC" reset --hard "$SRS_TAG"
    fi
else
    git clone --branch "$SRS_TAG" --depth 1 https://github.com/ossrs/srs.git "$SRS_SRC"
fi

step "Apply SRT bonding patch"
patch -p1 -d "$SRS_SRC" < "$PATCH"
echo "Patch applied."

step "Configure (SRT enabled)"
cd "$SRS_SRC/trunk"
./configure --srt=on --sanitizer=off

step "Build (using $(nproc) cores)"
make -j"$(nproc)"

step "Copy binary"
install -m 755 "$SRS_SRC/trunk/objs/srs" "$OUT"

echo
echo "=============================="
echo " Build complete"
echo "=============================="
echo "Binary: $OUT"
echo "Version: $("$OUT" -v 2>&1 | head -1)"
echo
echo "Next step: publish $OUT as a GitHub release asset, then update"
echo "  SRS_RELEASE_TAG and SRS_SHA256 in scripts/server-install.sh and scripts/dev-server-install.sh"
echo
echo "SHA256:"
echo "  $(sha256sum "$OUT" | awk '{print $1}')  $OUT"
