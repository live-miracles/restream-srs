#!/usr/bin/env bash
# Run the shared SRT bonding relay in the foreground for local development.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_REPO_DIR="${SRT_BONDING_RELAY_REPO_DIR:-$REPO_DIR/../srt-bonding-relay}"
RUN_SCRIPT="$RELAY_REPO_DIR/scripts/run.sh"
CONFIG_PATH="${SRT_BONDING_RELAY_CONFIG_PATH:-$REPO_DIR/srt-bonding-relay.json}"
BIN="${SRT_BONDING_RELAY_PATH:-$REPO_DIR/objs/srt-bonding-relay}"
LIB_DIR="${SRT_BONDING_RELAY_LIB_DIR:-$REPO_DIR/objs/lib}"

if [[ ! -d "$RELAY_REPO_DIR/.git" ]]; then
    echo "ERROR: relay repo not found at $RELAY_REPO_DIR" >&2
    echo "Run: bash $REPO_DIR/scripts/dev-server-install.sh" >&2
    exit 1
fi

if [[ ! -x "$RUN_SCRIPT" ]]; then
    echo "ERROR: relay runner not found: $RUN_SCRIPT" >&2
    exit 1
fi

SRT_BONDING_RELAY_PATH="$BIN" \
SRT_BONDING_RELAY_LIB_DIR="$LIB_DIR" \
SRT_BONDING_RELAY_CONFIG_PATH="$CONFIG_PATH" \
    bash "$RUN_SCRIPT"
