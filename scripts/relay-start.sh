#!/usr/bin/env bash
# Entry point for `npm run relay`: runs the local SRT bonding relay,
# installing it (SRS + relay clone/build + dev fail2ban) only the first time,
# i.e. when ./objs/srt-bonding-relay doesn't exist yet. Once it's built,
# reruns just start it - no rebuild, no sudo. Use `npm run relay:update` to
# pull relay source changes and rebuild on demand.
#
# Usage:
#   bash scripts/relay-start.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_PATH="$REPO_DIR/srt-bonding-relay.json"
BIN="$REPO_DIR/objs/srt-bonding-relay"
LIB_DIR="$REPO_DIR/objs/lib"

if [[ ! -x "$BIN" ]]; then
    echo "Relay binary not found at $BIN; running first-time setup..."
    bash "$REPO_DIR/scripts/dev-server-install.sh"
fi

LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$BIN" "$CONFIG_PATH"
