#!/usr/bin/env bash
# Install the SRS binary locally inside the repo for development.
# No root, no systemd, no auto-start — just places the binary at ./objs/srs.
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

# Patched SRS binary — keep in sync with SRS_RELEASE_TAG and SRS_SHA256 in server-install.sh.
SRS_VERSION=6.0-r0
SRS_RELEASE_TAG="srs-v6.0-r0-4"
SRS_FILENAME="srs"
SRS_SHA256="f3e9291b47f40f1db08dbabf1e607f8854ed0202090e21dcd64e0e658151647c"
SRS_URL="https://github.com/live-miracles/restream-srs/releases/download/${SRS_RELEASE_TAG}/${SRS_FILENAME}"

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

VERSION_MARKER="$REPO_DIR/objs/.srs-version"

if [[ -n "${SRS_LOCAL_BIN:-}" ]]; then
    # Install from a locally-built binary (e.g. built with SRT bonding patch via build-srs.sh).
    if [[ ! -x "$SRS_LOCAL_BIN" ]]; then
        echo "ERROR: SRS_LOCAL_BIN=$SRS_LOCAL_BIN is not executable" >&2
        exit 1
    fi
    install -m 755 "$SRS_LOCAL_BIN" "$SRS_OUT"
    echo "srt-bonding-${SRS_VERSION}" > "$VERSION_MARKER"
    echo "Installed from local build: $("$SRS_OUT" -v 2>&1 | head -1)"
    echo ""
    echo "Run SRS:  npm run srs"
    echo "Run app:  npm run dev"
    exit 0
fi

if [[ -x "$SRS_OUT" && -f "$VERSION_MARKER" && "$(cat "$VERSION_MARKER")" == "$SRS_RELEASE_TAG" ]]; then
    echo "SRS $SRS_VERSION ($SRS_RELEASE_TAG) already installed at $SRS_OUT"
    exit 0
fi

if ! command -v curl &>/dev/null; then
    echo "ERROR: curl is required" >&2
    exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading SRS $SRS_VERSION ($SRS_RELEASE_TAG)..."
curl -fsSL "$SRS_URL" -o "$WORK/$SRS_FILENAME"

verify_sha256 "$WORK/$SRS_FILENAME" "$SRS_SHA256"

install -m 755 "$WORK/$SRS_FILENAME" "$SRS_OUT"
echo "$SRS_RELEASE_TAG" > "$VERSION_MARKER"

echo "Installed: $("$SRS_OUT" -v 2>&1 | head -1) ($SRS_RELEASE_TAG)"
echo ""
echo "Run SRS:  npm run srs"
echo "Run app:  npm run dev"
