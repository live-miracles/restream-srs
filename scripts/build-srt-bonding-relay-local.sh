#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_REPO_DIR="${SRT_BONDING_RELAY_REPO_DIR:-$REPO_DIR/../srt-bonding-relay}"
OUT_BIN="${SRT_BONDING_RELAY_PATH:-$REPO_DIR/objs/srt-bonding-relay}"
OUT_LIB_DIR="${SRT_BONDING_RELAY_LIB_DIR:-$REPO_DIR/objs/lib}"

if [[ ! -d "$RELAY_REPO_DIR/.git" ]]; then
    echo "ERROR: relay repo not found at $RELAY_REPO_DIR" >&2
    echo "Run: bash $REPO_DIR/scripts/dev-server-install.sh" >&2
    exit 1
fi

SRT_BONDING_RELAY_PATH="$OUT_BIN" \
SRT_BONDING_RELAY_LIB_DIR="$OUT_LIB_DIR" \
    bash "$RELAY_REPO_DIR/scripts/build-local.sh"
