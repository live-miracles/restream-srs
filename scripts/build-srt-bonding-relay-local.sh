#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRT_TAG="${SRT_TAG:-v1.5.5}"
IMAGE_TAG="restream-srs-srt-bonding-relay-dev:${SRT_TAG}"
CONTAINER_NAME="restream-srs-srt-dev-$$"
OUT_BIN="${SRT_BONDING_RELAY_PATH:-$REPO_DIR/objs/srt-bonding-relay}"
OUT_LIB_DIR="${SRT_BONDING_RELAY_LIB_DIR:-$REPO_DIR/objs/lib}"

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: Docker is required to build srt-bonding-relay locally." >&2
    exit 1
fi

mkdir -p "$(dirname "$OUT_BIN")" "$OUT_LIB_DIR"

cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[relay-build] building Docker image $IMAGE_TAG"
docker build \
    --build-arg "SRT_TAG=$SRT_TAG" \
    -t "$IMAGE_TAG" \
    -f "$REPO_DIR/scripts/srt-bonding-relay.Dockerfile" \
    "$REPO_DIR"

echo "[relay-build] extracting relay package"
docker create --name "$CONTAINER_NAME" "$IMAGE_TAG" >/dev/null
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; cleanup' EXIT
docker cp "$CONTAINER_NAME:/package/." - | tar -C "$STAGE" -x

install -m 755 "$STAGE/bin/srt-bonding-relay" "$OUT_BIN"
install -d -m 755 "$OUT_LIB_DIR"
if [[ -d "$STAGE/lib" ]]; then
    install -m 755 "$STAGE"/lib/* "$OUT_LIB_DIR"/
fi

echo "Built relay: $OUT_BIN"
