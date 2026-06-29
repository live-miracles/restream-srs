#!/usr/bin/env bash
# Build a pinned srt-live-transmit release asset.
# This is not used by production installs; run it only when intentionally
# preparing a new GitHub release asset for scripts/server-install.sh.
#
# Usage:
#   bash scripts/build-srt-live-transmit.sh
#
# Output:
#   ./build/srt-live-transmit-linux-x86_64.tar.gz
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRT_TAG="${SRT_TAG:-v1.5.5}"
OUT_DIR="${OUT_DIR:-$REPO_DIR/build}"
OUT_TGZ="$OUT_DIR/srt-live-transmit-linux-x86_64.tar.gz"
IMAGE_TAG="restream-srs-srt-live-transmit:${SRT_TAG}"
CONTAINER_NAME="restream-srs-srt-package-$$"

step() { echo; echo "=== $* ==="; }

step "Check Docker"
if ! command -v docker &>/dev/null; then
    echo "ERROR: Docker is required to build srt-live-transmit." >&2
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
    -t "$IMAGE_TAG" \
    -f "$REPO_DIR/scripts/docker/srt-live-transmit.Dockerfile" \
    "$REPO_DIR"

step "Package asset"
docker create --name "$CONTAINER_NAME" "$IMAGE_TAG" >/dev/null
docker cp "$CONTAINER_NAME:/package/." - | tar -C "$OUT_DIR" -x
tar -C "$OUT_DIR" -czf "$OUT_TGZ" bin lib

echo
echo "=============================="
echo " Build complete"
echo "=============================="
echo "Asset:   $OUT_TGZ"
echo "Version: $SRT_TAG"
echo
echo "Next step: publish $OUT_TGZ as a GitHub release asset, then update"
echo "  SRT_RELEASE_TAG and SRT_SHA256 in scripts/server-install.sh"
echo
echo "SHA256:"
sha256sum "$OUT_TGZ" | awk '{print $1 "  " $2}'
