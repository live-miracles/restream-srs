#!/usr/bin/env bash
# Install SRS and srt-live-transmit locally inside the repo for development.
# No root, no systemd, no auto-start — just places binaries in ./objs.
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
SRT_OUT="$REPO_DIR/objs/srt-live-transmit"

SRS_VERSION=6.0-r0
SRS_RELEASE_TAG="v${SRS_VERSION}"
SRS_FILENAME="srs-server-${SRS_VERSION}-linux-amd64.tar.gz"
SRS_SHA256=""
SRS_URL="https://github.com/ossrs/srs/releases/download/${SRS_RELEASE_TAG}/${SRS_FILENAME}"

SRT_VERSION=1.5.5
SRT_RELEASE_TAG="srt-v${SRT_VERSION}-1"
SRT_FILENAME="srt-live-transmit-linux-x86_64.tar.gz"
SRT_SHA256="c206bc9eceb0f0f3c1a48b2d1b9d360dbf45fa9ef98d5a3d8f61bcd235a1d6e2"
SRT_URL="https://github.com/live-miracles/restream-srs/releases/download/${SRT_RELEASE_TAG}/${SRT_FILENAME}"

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

SRS_VERSION_MARKER="$REPO_DIR/objs/.srs-version"
SRT_VERSION_MARKER="$REPO_DIR/objs/.srt-live-transmit-version"

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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ -z "${SRS_LOCAL_BIN:-}" ]]; then
    if [[ -x "$SRS_OUT" && -f "$SRS_VERSION_MARKER" && "$(cat "$SRS_VERSION_MARKER")" == "$SRS_RELEASE_TAG" ]]; then
        echo "SRS $SRS_VERSION ($SRS_RELEASE_TAG) already installed at $SRS_OUT"
    else
        echo "Downloading SRS $SRS_VERSION ($SRS_RELEASE_TAG)..."
        curl -fsSL "$SRS_URL" -o "$WORK/$SRS_FILENAME"

        verify_sha256 "$WORK/$SRS_FILENAME" "$SRS_SHA256"

        tar -xzf "$WORK/$SRS_FILENAME" -C "$WORK"
        SRS_BIN="$(find "$WORK" -type f -name srs -perm -111 | head -1)"
        if [[ -z "$SRS_BIN" ]]; then
            echo "ERROR: could not find srs binary in $SRS_FILENAME" >&2
            exit 1
        fi
        install -m 755 "$SRS_BIN" "$SRS_OUT"
        echo "$SRS_RELEASE_TAG" > "$SRS_VERSION_MARKER"
        echo "Installed: $("$SRS_OUT" -v 2>&1 | head -1) ($SRS_RELEASE_TAG)"
    fi
fi

if [[ -x "$SRT_OUT" && -f "$SRT_VERSION_MARKER" && "$(cat "$SRT_VERSION_MARKER")" == "$SRT_RELEASE_TAG" ]]; then
    echo "srt-live-transmit $SRT_VERSION ($SRT_RELEASE_TAG) already installed at $SRT_OUT"
else
    echo "Downloading srt-live-transmit $SRT_VERSION ($SRT_RELEASE_TAG)..."
    curl -fsSL "$SRT_URL" -o "$WORK/$SRT_FILENAME"

    verify_sha256 "$WORK/$SRT_FILENAME" "$SRT_SHA256"

    tar -xzf "$WORK/$SRT_FILENAME" -C "$WORK"
    SRT_BIN="$(find "$WORK" -type f -name srt-live-transmit -perm -111 | head -1)"
    if [[ -z "$SRT_BIN" ]]; then
        echo "ERROR: could not find srt-live-transmit binary in $SRT_FILENAME" >&2
        exit 1
    fi
    install -m 755 "$SRT_BIN" "$SRT_OUT"
    echo "$SRT_RELEASE_TAG" > "$SRT_VERSION_MARKER"
    echo "Installed: $SRT_OUT ($SRT_RELEASE_TAG)"
fi

echo ""
echo "Run SRS:  npm run srs"
echo "Run app:  npm run dev"
