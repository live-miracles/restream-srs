#!/usr/bin/env bash
# Build SRS from source with SRT bonding patch applied.
# Always builds inside a ubuntu:22.04 Docker container to ensure the binary
# links against GLIBC 2.35 and runs on any Ubuntu 22.04+ server.
#
# Run this once on any x86_64 machine with Docker, then publish the output
# binary as a GitHub release asset and update server-install.sh.
#
# Usage:
#   bash scripts/build-srs.sh
#
# Output:
#   ./build/srs   — patched SRS binary, ready to publish as a GitHub release asset
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRS_TAG="${SRS_TAG:-v6.0-r0}"
OUT="$REPO_DIR/build/srs"

step() { echo; echo "=== $* ==="; }

step "Check Docker"
if ! command -v docker &>/dev/null; then
    echo "ERROR: Docker is required to build SRS." >&2
    echo "Install: https://docs.docker.com/engine/install/" >&2
    exit 1
fi
echo "Docker: $(docker --version)"

step "Build SRS $SRS_TAG inside ubuntu:22.04"
echo "Repo mounted: $REPO_DIR → /work"
echo "Output:       $OUT"

docker run --rm -i \
    -e SRS_TAG="$SRS_TAG" \
    -v "$REPO_DIR:/work" \
    ubuntu:22.04 bash -euo pipefail << 'INNER'

step() { echo; echo "=== $* ==="; }

PATCH=/work/patches/srs-srt-bonding.patch
BUILD_DIR=/work/build
SRS_SRC=$BUILD_DIR/srs-src
OUT=$BUILD_DIR/srs

step "Install build dependencies"
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
    build-essential cmake git automake pkg-config unzip tcl patch perl

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

step "Build ($(nproc) cores)"
make -j"$(nproc)"

step "Copy binary"
install -m 755 "$SRS_SRC/trunk/objs/srs" "$OUT"
echo "GLIBC: $(ldd --version | head -1)"
INNER

echo
echo "=============================="
echo " Build complete"
echo "=============================="
echo "Binary:  $OUT"
echo "Version: $("$OUT" -v 2>&1 | head -1)"
echo
echo "Next step: publish $OUT as a GitHub release asset, then update"
echo "  SRS_RELEASE_TAG and SRS_SHA256 in scripts/server-install.sh"
echo "  and scripts/dev-server-install.sh"
echo
echo "SHA256:"
sha256sum "$OUT" | awk '{print $1 "  " $2}'
