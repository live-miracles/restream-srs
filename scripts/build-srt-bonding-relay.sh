#!/usr/bin/env bash
# Build a pinned SRT bonding relay release asset.
# This is not used by production installs; run it only when intentionally
# preparing a new GitHub release asset for scripts/server-install.sh.
#
# Usage:
#   bash scripts/build-srt-bonding-relay.sh
#
# Output:
#   ./build/srt-bonding-relay-linux-x86_64.tar.gz
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRT_TAG="${SRT_TAG:-v1.5.5}"
OUT_DIR="${OUT_DIR:-$REPO_DIR/build}"
OUT_TGZ="$OUT_DIR/srt-bonding-relay-linux-x86_64.tar.gz"
IMAGE_TAG="restream-srs-srt-bonding-relay:${SRT_TAG}"
CONTAINER_NAME="restream-srs-srt-package-$$"
SOURCE_SHA="$(sha256sum "$REPO_DIR/native/srt-bonding-relay.c" | awk '{print $1}')"

step() { echo; echo "=== $* ==="; }

step "Check Docker"
if ! command -v docker &>/dev/null; then
    echo "ERROR: Docker is required to build srt-bonding-relay." >&2
    echo "Install: https://docs.docker.com/engine/install/" >&2
    exit 1
fi
echo "Docker: $(docker --version)"

mkdir -p "$OUT_DIR"
if [[ ! -w "$OUT_DIR" ]]; then
    echo "ERROR: output directory is not writable: $OUT_DIR" >&2
    echo "Fix ownership, then rerun:" >&2
    echo "  sudo chown -R $(id -u):$(id -g) '$OUT_DIR'" >&2
    exit 1
fi

cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "Build image"
docker build \
    --build-arg "SRT_TAG=$SRT_TAG" \
    --build-arg "RELAY_SOURCE_SHA=$SOURCE_SHA" \
    -t "$IMAGE_TAG" \
    -f "$REPO_DIR/scripts/srt-bonding-relay.Dockerfile" \
    "$REPO_DIR"

step "Package asset"
docker create --name "$CONTAINER_NAME" "$IMAGE_TAG" >/dev/null
# Extract into a clean staging dir to avoid mixing leftovers from previous builds
STAGE="$(mktemp -d)"
docker cp "$CONTAINER_NAME:/package/." - | tar -C "$STAGE" -x
tar -C "$STAGE" -czf "$OUT_TGZ" bin lib
rm -rf "$STAGE"

echo
echo "=============================="
echo " Build complete"
echo "=============================="
echo "Asset:   $OUT_TGZ"
echo "Version: $SRT_TAG"
echo
echo "Next steps:"
echo "  1. Publish $OUT_TGZ as a GitHub release asset"
echo "  2. Update SRT_RELEASE_TAG and SRT_SHA256 in scripts/server-install.sh"
echo
echo "SHA256:"
sha256sum "$OUT_TGZ" | awk '{print $1 "  " $2}'
