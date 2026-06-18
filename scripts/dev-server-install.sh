#!/usr/bin/env bash
# Install the SRS binary locally inside the repo for development.
# No root, no systemd, no auto-start — just places the binary at ./objs/srs.
#
# Usage:
#   bash scripts/dev-server-install.sh
#
# Override version:
#   SRS_VERSION=6.0-r0 bash scripts/dev-server-install.sh
set -euo pipefail

if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "ERROR: this installer only supports x86_64 (got $(uname -m)); the SRS build it downloads is x86_64-only." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRS_VERSION="${SRS_VERSION:-6.0-r0}"
SRS_OUT="$REPO_DIR/objs/srs"

SRS_ZIP="SRS-CentOS7-x86_64-${SRS_VERSION}.zip"
SRS_URL_OVERRIDDEN="${SRS_URL+yes}"
SRS_URL="${SRS_URL:-https://github.com/ossrs/srs/releases/download/v${SRS_VERSION}/${SRS_ZIP}}"
# Pinned SHA256 for the default SRS build. Cleared (checksum skipped) when a
# custom SRS_VERSION or SRS_URL is supplied, since the hash would no longer match.
SRS_SHA256=""
if [[ "$SRS_VERSION" == "6.0-r0" && -z "$SRS_URL_OVERRIDDEN" ]]; then
    SRS_SHA256="1eb20245a76643b2d32a1be85e71015079689a0733a10f79964f9a8189c21609"
fi

# Verify a downloaded file against an expected SHA256 (sha256sum on Linux,
# shasum on macOS). An empty expected hash skips the check.
verify_sha256() {
    local file="$1" expected="$2"
    if [[ -z "$expected" ]]; then
        echo "Checksum: skipped (custom version/URL)"
        return
    fi
    local actual
    if command -v sha256sum &>/dev/null; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    else
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
    if [[ "$actual" != "$expected" ]]; then
        echo "ERROR: checksum mismatch for $(basename "$file")" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
    echo "Checksum OK: $(basename "$file")"
}

mkdir -p "$REPO_DIR/objs"

# Already installed and correct version
if [[ -x "$SRS_OUT" ]] && "$SRS_OUT" -v 2>&1 | grep -q "$SRS_VERSION"; then
    echo "SRS $SRS_VERSION already installed at $SRS_OUT"
    exit 0
fi

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

verify_sha256 "$WORK/$SRS_ZIP" "$SRS_SHA256"

unzip -q "$WORK/$SRS_ZIP" -d "$WORK/srs"
# The zip root contains an init wrapper script also named 'srs'; the real
# ELF binary lives deeper at usr/local/srs/objs/srs (~30 MB).
SRS_BIN="$(find "$WORK/srs" -type f -path '*/usr/local/srs/objs/srs' | head -1)"
if [[ -z "$SRS_BIN" ]]; then
    echo "ERROR: could not find SRS binary in $SRS_ZIP" >&2
    exit 1
fi
install -m 755 "$SRS_BIN" "$SRS_OUT"

echo "Installed: $("$SRS_OUT" -v 2>&1 | head -1)"
echo ""
echo "Run SRS:  npm run srs"
echo "Run app:  npm run dev"
