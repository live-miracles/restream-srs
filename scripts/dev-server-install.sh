#!/usr/bin/env bash
# Install the SRS binary locally inside the repo for development.
# No root, no systemd, no auto-start — just places the binary at ./objs/srs.
#
# Usage:
#   bash scripts/dev-server-install.sh
#
# Override version or supply a local binary:
#   SRS_VERSION=6.0-r0 bash scripts/dev-server-install.sh
#   SRS_BINARY_PATH=/path/to/srs bash scripts/dev-server-install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRS_VERSION="${SRS_VERSION:-6.0-r0}"
SRS_BINARY_PATH="${SRS_BINARY_PATH:-}"
SRS_OUT="$REPO_DIR/objs/srs"

SRS_ZIP="SRS-CentOS7-x86_64-${SRS_VERSION}.zip"
SRS_URL="${SRS_URL:-https://github.com/ossrs/srs/releases/download/v${SRS_VERSION}/${SRS_ZIP}}"

mkdir -p "$REPO_DIR/objs"

# Already installed and correct version
if [[ -x "$SRS_OUT" ]] && "$SRS_OUT" -v 2>&1 | grep -q "$SRS_VERSION"; then
    echo "SRS $SRS_VERSION already installed at $SRS_OUT"
    exit 0
fi

if [[ -n "$SRS_BINARY_PATH" ]]; then
    echo "Installing from $SRS_BINARY_PATH..."
    install -m 755 "$SRS_BINARY_PATH" "$SRS_OUT"
else
    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        echo "ERROR: curl or wget is required" >&2
        exit 1
    fi
    if ! command -v unzip &>/dev/null; then
        echo "ERROR: unzip is required (apt install unzip)" >&2
        exit 1
    fi

    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT

    echo "Downloading SRS $SRS_VERSION..."
    if command -v curl &>/dev/null; then
        curl -fsSL "$SRS_URL" -o "$WORK/$SRS_ZIP"
    else
        wget -q "$SRS_URL" -O "$WORK/$SRS_ZIP"
    fi

    unzip -q "$WORK/$SRS_ZIP" -d "$WORK/srs"
    # The zip root contains an init wrapper script also named 'srs'; the real
    # ELF binary lives deeper at usr/local/srs/objs/srs (~30 MB).
    SRS_BIN="$(find "$WORK/srs" -type f -path '*/usr/local/srs/objs/srs' | head -1)"
    if [[ -z "$SRS_BIN" ]]; then
        echo "ERROR: could not find SRS binary in $SRS_ZIP" >&2
        exit 1
    fi
    install -m 755 "$SRS_BIN" "$SRS_OUT"
fi

echo "Installed: $("$SRS_OUT" -v 2>&1 | head -1)"
echo ""
echo "Run SRS:  npm run srs"
echo "Run app:  npm run dev"
