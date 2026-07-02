#!/usr/bin/env bash
# Install SRS locally inside the repo for development.
# No root, no systemd, no auto-start.
#
# Usage:
#   bash scripts/dev-server-install.sh
set -euo pipefail

if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "ERROR: this installer only supports x86_64 (got $(uname -m)); the SRS build it downloads is x86_64-only." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRS_OUT="$REPO_DIR/objs/srs"
RELAY_REPO_DIR="${SRT_BONDING_RELAY_REPO_DIR:-$REPO_DIR/../srt-bonding-relay}"
RELAY_REPO_URL="${SRT_BONDING_RELAY_REPO_URL:-https://github.com/live-miracles/srt-bonding-relay.git}"

SRS_VERSION=6.0-r0
SRS_RELEASE_TAG="v${SRS_VERSION}"
SRS_FILENAME="SRS-CentOS7-x86_64-${SRS_VERSION}.zip"
SRS_SHA256="1eb20245a76643b2d32a1be85e71015079689a0733a10f79964f9a8189c21609"
SRS_URL="https://github.com/ossrs/srs/releases/download/${SRS_RELEASE_TAG}/${SRS_FILENAME}"

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

ensure_relay_repo() {
    if [[ -d "$RELAY_REPO_DIR/.git" ]]; then
        echo "Relay repo already present at $RELAY_REPO_DIR"
        return
    fi

    if [[ -e "$RELAY_REPO_DIR" ]]; then
        echo "ERROR: relay repo path exists but is not a git repo: $RELAY_REPO_DIR" >&2
        exit 1
    fi

    if ! command -v git &>/dev/null; then
        echo "ERROR: git is required to clone $RELAY_REPO_URL" >&2
        exit 1
    fi

    echo "Cloning relay repo into $RELAY_REPO_DIR..."
    git clone "$RELAY_REPO_URL" "$RELAY_REPO_DIR"
}

mkdir -p "$REPO_DIR/objs"

SRS_VERSION_MARKER="$REPO_DIR/objs/.srs-version"
if [[ -n "${SRS_LOCAL_BIN:-}" ]]; then
    # Install from a local SRS binary.
    if [[ ! -x "$SRS_LOCAL_BIN" ]]; then
        echo "ERROR: SRS_LOCAL_BIN=$SRS_LOCAL_BIN is not executable" >&2
        exit 1
    fi
    install -m 755 "$SRS_LOCAL_BIN" "$SRS_OUT"
    echo "local-${SRS_VERSION}" > "$SRS_VERSION_MARKER"
    echo "Installed from local build: $("$SRS_OUT" -v 2>&1 | head -1)"
fi

if ! command -v curl &>/dev/null; then
    echo "ERROR: curl is required" >&2
    exit 1
fi
if ! command -v unzip &>/dev/null; then
    echo "ERROR: unzip is required (apt install unzip)" >&2
    exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ -z "${SRS_LOCAL_BIN:-}" ]]; then
    if [[ -x "$SRS_OUT" && -f "$SRS_VERSION_MARKER" && "$(cat "$SRS_VERSION_MARKER")" == "$SRS_RELEASE_TAG" ]]; then
        echo "SRS $SRS_VERSION ($SRS_RELEASE_TAG) already installed at $SRS_OUT"
    else
        echo "Downloading SRS $SRS_VERSION ($SRS_RELEASE_TAG)..."
        curl -fsSL "$SRS_URL" -o "$WORK/$SRS_FILENAME"

        verify_sha256 "$WORK/$SRS_FILENAME" "$SRS_SHA256"

        unzip -q "$WORK/$SRS_FILENAME" -d "$WORK/srs"
        SRS_BIN="$(find "$WORK/srs" -type f -path '*/usr/local/srs/objs/srs' | head -1)"
        if [[ -z "$SRS_BIN" ]]; then
            echo "ERROR: could not find srs binary in $SRS_FILENAME" >&2
            exit 1
        fi
        install -m 755 "$SRS_BIN" "$SRS_OUT"
        echo "$SRS_RELEASE_TAG" > "$SRS_VERSION_MARKER"
        echo "Installed: $("$SRS_OUT" -v 2>&1 | head -1) ($SRS_RELEASE_TAG)"
    fi
fi

ensure_relay_repo

echo ""
echo "Run SRS:  npm run srs"
echo "Run app:  npm run dev"
echo "Run relay watcher: npm run relay"
