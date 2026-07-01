#!/usr/bin/env bash
# Run the shared SRT bonding relay in the foreground for local development.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${SRT_BONDING_RELAY_PATH:-$REPO_DIR/objs/srt-bonding-relay}"
LIB_DIR="$REPO_DIR/objs/lib"
SRS_SRT_PORT="${SRS_SRT_PORT:-10080}"
SRT_BONDING_PORT="${SRT_BONDING_PORT:-10081}"
ENV_PATH="${SRT_BONDING_RELAY_ENV_PATH:-$REPO_DIR/srt-bonding-relay.env}"
SRT_BONDING_STATE_PATH="${SRT_BONDING_STATE_PATH:-$REPO_DIR/objs/srt-bonding-relay.state}"

if [[ -f "$ENV_PATH" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_PATH"
    set +a
fi

SRT_BONDING_INPUT_URI="${SRT_BONDING_INPUT_URI:-srt://0.0.0.0:$SRT_BONDING_PORT?mode=listener&groupconnect=1&transtype=live&latency=240}"
SRT_BONDING_OUTPUT_URI="${SRT_BONDING_OUTPUT_URI:-srt://127.0.0.1:$SRS_SRT_PORT?transtype=live&latency=200}"

if [[ ! -x "$BIN" ]]; then
    echo "ERROR: srt-bonding-relay not found or not executable: $BIN" >&2
    echo "Run: npm run dev-install" >&2
    exit 1
fi

echo "Relay:  $BIN"
echo "Input:  $SRT_BONDING_INPUT_URI"
echo "Output: $SRT_BONDING_OUTPUT_URI"
if [[ -d "$LIB_DIR" ]]; then
    export LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export SRT_BONDING_STATE_PATH
exec "$BIN" "$SRT_BONDING_INPUT_URI" "$SRT_BONDING_OUTPUT_URI"
