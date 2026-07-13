#!/usr/bin/env bash
# Install SRS locally inside the repo for development, and set up fail2ban
# to mirror production so Settings -> "fail2ban Currently Banned" has real
# data to test against. Linux (Ubuntu) only, like the rest of this repo's
# scripts/CI - the SRS build below is a CentOS7 x86_64 binary regardless.
#
# The SRS/relay install needs no root. The fail2ban step does (config,
# sudoers, and its control socket/ban database are all root-only) and is the
# only part of this script that calls sudo.
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
FFMPEG_OUT="$REPO_DIR/objs/ffmpeg"
FFPROBE_OUT="$REPO_DIR/objs/ffprobe"

SRS_VERSION=6.0-r0
SRS_RELEASE_TAG="v${SRS_VERSION}"
SRS_FILENAME="SRS-CentOS7-x86_64-${SRS_VERSION}.zip"
SRS_SHA256="1eb20245a76643b2d32a1be85e71015079689a0733a10f79964f9a8189c21609"
SRS_URL="https://github.com/ossrs/srs/releases/download/${SRS_RELEASE_TAG}/${SRS_FILENAME}"

# Same pinned FFmpeg build scripts/server-install.sh installs to
# /usr/local/bin in production, installed here into the repo instead so
# `npm run dev` doesn't fall back to the system package (Ubuntu ships
# FFmpeg 8, which has been observed to hang pulling from a local SRS
# instance — see restream.json's ffmpeg_path/ffprobe_path). To bump: pick a
# newer month-end tag from https://github.com/BtbN/FFmpeg-Builds/releases,
# then take the linux64-gpl (non-shared) filename and its hash from that
# release's checksums.sha256 — and update scripts/server-install.sh to match.
FFMPEG_VERSION=7.1
FFMPEG_BUILD_TAG="autobuild-2026-05-31-13-22"
FFMPEG_FILENAME="ffmpeg-n7.1.4-7-gadcf20da26-linux64-gpl-7.1.tar.xz"
FFMPEG_SHA256="ce46c711e3ff79ae1e9318bf7daa54c77f41ce37b71010c44f4a0b38f1d7a29f"
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD_TAG}/${FFMPEG_FILENAME}"

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

# Sets up the same `restream-srs` jail scripts/server-install.sh sets up in
# production, plus the helper scripts the dashboard calls via sudo for
# Settings -> IP Whitelist and "fail2ban Currently Banned". Unlike production,
# `npm run dev` runs as you rather than a dedicated service user, and isn't a
# systemd unit - so the jail's `backend = systemd` won't see real
# rejected-publish attempts from a dev run. To see the table populated, ban a
# harmless test-only IP by hand:
#   sudo fail2ban-client set restream-srs banip 203.0.113.5
setup_fail2ban_dev() {
    if ! command -v apt-get &>/dev/null; then
        echo "fail2ban: apt-get not found (non-Debian host?), skipping"
        return
    fi
    if ! command -v sudo &>/dev/null; then
        echo "fail2ban: sudo not found, skipping"
        return
    fi

    echo "Setting up fail2ban..."
    sudo apt-get install -y -q fail2ban

    # Clean up the dead srt-bonding-relay jail from any previous run of this
    # script - it can never trigger anymore (see server-install.sh).
    sudo rm -f /etc/fail2ban/filter.d/srt-bonding-relay.conf \
        /etc/fail2ban/jail.d/srt-bonding-relay.local \
        /etc/fail2ban/jail.d/srt-bonding-relay-whitelist.local

    sudo tee /etc/fail2ban/filter.d/restream-srs.conf >/dev/null <<'EOF'
[Definition]
# No leading ^: the systemd backend matches against
# "<SYSLOG_IDENTIFIER>[<pid>]: <message>", not the raw MESSAGE field, so an
# anchored regex never matches and this jail silently never bans anyone.
failregex = \[srs-hook\] rejected (?:publish|play) from <HOST>:
journalmatch = _SYSTEMD_UNIT=restream-srs.service
EOF

    sudo tee /etc/fail2ban/jail.d/restream-srs.local >/dev/null <<'EOF'
[restream-srs]
enabled = true
backend = systemd
filter = restream-srs
# Ban on all ports: an IP probing stream keys has no legitimate use here.
# protocol=all is required too - fail2ban's default action protocol is tcp,
# so without this the ban only ever blocked TCP (RTMP) and SRT (UDP) sailed
# straight through a "banned" IP.
banaction = iptables-allports
protocol = all
maxretry = 5
findtime = 600
bantime = 3600
EOF

    sudo systemctl restart fail2ban

    sudo tee /usr/local/sbin/restream-srs-fail2ban-apply >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

JAIL=restream-srs

if [[ "${1:-}" != "sync" ]]; then
    echo "usage: $0 sync <ip-or-cidr> [...]" >&2
    exit 1
fi
shift

validate_safe_ip_or_cidr_token() {
    local value="$1"
    local addr="${value%%/*}"
    local prefix=""

    [[ "$value" =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ ]] || return 1
    [[ -n "$addr" ]] || return 1

    if [[ "$value" == */* ]]; then
        prefix="${value##*/}"
        [[ "$prefix" =~ ^[0-9]+$ ]] || return 1
        if [[ "$addr" == *:* ]]; then
            (( prefix <= 128 )) || return 1
        else
            (( prefix <= 32 )) || return 1
        fi
    fi

    return 0
}

for ip in "$@"; do
    validate_safe_ip_or_cidr_token "$ip" || {
        echo "ERROR: rejecting invalid IP/CIDR: $ip" >&2
        exit 1
    }
done

CONF="/etc/fail2ban/jail.d/${JAIL}-whitelist.local"
TMP_CONF="$(mktemp "${CONF}.XXXXXX")"
{
    echo "[$JAIL]"
    if [[ $# -gt 0 ]]; then
        printf 'ignoreip = %s\n' "$*"
    fi
} > "$TMP_CONF"
chmod 644 "$TMP_CONF"
mv "$TMP_CONF" "$CONF"

if ! fail2ban-client ping >/dev/null 2>&1; then
    echo "fail2ban is not running; whitelist file written and will apply once it starts" >&2
    exit 1
fi

fail2ban-client reload "$JAIL" >/dev/null
for ip in "$@"; do
    fail2ban-client set "$JAIL" unbanip "$ip" >/dev/null 2>&1 || true
done
EOF
    sudo chmod 755 /usr/local/sbin/restream-srs-fail2ban-apply

    sudo tee /usr/local/sbin/restream-srs-fail2ban-status >/dev/null <<'PYEOF'
#!/usr/bin/env python3
import json
import re
import sqlite3
import subprocess
import sys

JAIL = "restream-srs"
DB_PATH = "/var/lib/fail2ban/fail2ban.sqlite3"


def banned_ips(jail):
    try:
        out = subprocess.run(
            ["fail2ban-client", "status", jail],
            capture_output=True, text=True, timeout=10, check=True,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    m = re.search(r"Banned IP list:\s*(.*)", out.stdout)
    return m.group(1).split() if m else []


def ban_record(conn, jail, ip):
    if conn is None:
        return None
    row = conn.execute(
        "SELECT timeofban, bantime, data FROM bans WHERE jail = ? AND ip = ? "
        "ORDER BY timeofban DESC LIMIT 1",
        (jail, ip),
    ).fetchone()
    if not row:
        return None
    timeofban, bantime, data = row
    reason = None
    if data:
        try:
            matches = json.loads(data).get("matches") or []
            if matches:
                reason = matches[-1].strip()
        except (ValueError, AttributeError):
            reason = None
    unban_at = None
    if bantime is not None and int(bantime) >= 0:
        unban_at = (int(timeofban) + int(bantime)) * 1000
    return {"bannedAt": int(timeofban) * 1000, "unbanAt": unban_at, "reason": reason}


def main():
    try:
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except sqlite3.Error:
        conn = None

    results = []
    for ip in banned_ips(JAIL):
        record = ban_record(conn, JAIL, ip) or {}
        results.append({
            "ip": ip,
            "jail": JAIL,
            "bannedAt": record.get("bannedAt"),
            "unbanAt": record.get("unbanAt"),
            "reason": record.get("reason"),
        })

    if conn is not None:
        conn.close()
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
PYEOF
    sudo chmod 755 /usr/local/sbin/restream-srs-fail2ban-status

    echo "$USER ALL=(root) NOPASSWD: /usr/local/sbin/restream-srs-fail2ban-apply, /usr/local/sbin/restream-srs-fail2ban-status" \
        | sudo tee /etc/sudoers.d/restream-srs-fail2ban-dev >/dev/null
    sudo visudo -cf /etc/sudoers.d/restream-srs-fail2ban-dev

    echo "fail2ban: jail 'restream-srs' configured; dashboard fail2ban controls wired up for $USER"
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
if ! command -v tar &>/dev/null; then
    echo "ERROR: tar is required" >&2
    exit 1
fi
if ! command -v xz &>/dev/null; then
    echo "ERROR: xz is required (apt install xz-utils)" >&2
    exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FFMPEG_VERSION_MARKER="$REPO_DIR/objs/.ffmpeg-version"
FFMPEG_PIN="${FFMPEG_BUILD_TAG}/${FFMPEG_FILENAME}"
if [[ -x "$FFMPEG_OUT" && -x "$FFPROBE_OUT" && -f "$FFMPEG_VERSION_MARKER" && "$(cat "$FFMPEG_VERSION_MARKER")" == "$FFMPEG_PIN" ]]; then
    echo "FFmpeg $FFMPEG_VERSION already installed at $FFMPEG_OUT ($FFMPEG_PIN)"
else
    echo "Downloading FFmpeg $FFMPEG_VERSION ($FFMPEG_PIN)..."
    curl -fsSL "$FFMPEG_URL" -o "$WORK/$FFMPEG_FILENAME"

    verify_sha256 "$WORK/$FFMPEG_FILENAME" "$FFMPEG_SHA256"

    tar -xJf "$WORK/$FFMPEG_FILENAME" -C "$WORK"
    FFMPEG_DIR="$(find "$WORK" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)"
    if [[ -z "$FFMPEG_DIR" || ! -x "$FFMPEG_DIR/bin/ffmpeg" || ! -x "$FFMPEG_DIR/bin/ffprobe" ]]; then
        echo "ERROR: could not find ffmpeg/ffprobe binaries in $FFMPEG_FILENAME" >&2
        exit 1
    fi
    install -m 755 "$FFMPEG_DIR/bin/ffmpeg" "$FFMPEG_OUT"
    install -m 755 "$FFMPEG_DIR/bin/ffprobe" "$FFPROBE_OUT"
    echo "$FFMPEG_PIN" > "$FFMPEG_VERSION_MARKER"
    echo "Installed: $("$FFMPEG_OUT" -version 2>&1 | head -1) ($FFMPEG_PIN)"
fi

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

bash "$REPO_DIR/scripts/relay-repo-sync.sh"
bash "$REPO_DIR/scripts/build-srt-bonding-relay-local.sh"
setup_fail2ban_dev

echo ""
echo "Run SRS:  npm run srs"
echo "Run app:  npm run dev"
echo "Run relay: npm run relay"
