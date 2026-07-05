#!/usr/bin/env bash
# Run the shared SRT bonding relay in the foreground for local development.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_PATH="$REPO_DIR/srt-bonding-relay.json"
BIN="$REPO_DIR/objs/srt-bonding-relay"
LIB_DIR="$REPO_DIR/objs/lib"

if [[ ! -x "$BIN" ]]; then
    echo "ERROR: relay binary not found: $BIN" >&2
    echo "Run: npm run relay:build" >&2
    exit 1
fi

LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$BIN" "$CONFIG_PATH"
