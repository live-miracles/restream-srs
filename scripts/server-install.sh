#!/usr/bin/env bash
# One-shot native setup for a Linux server.
# Installs Node.js 22, FFmpeg 7.1, SRS 6.0, srt-bonding-relay, builds the app,
# and registers systemd services that start on boot.
#
# Usage:
#   sudo git clone https://github.com/live-miracles/restream-srs /opt/restream-srs
#   sudo bash /opt/restream-srs/scripts/server-install.sh
#
# Optional:
#   REPO_URL=https://github.com/your-fork/restream-srs sudo bash scripts/server-install.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (sudo bash scripts/server-install.sh)" >&2
    exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "ERROR: this installer only supports x86_64 (got $(uname -m)); the FFmpeg/SRS builds it downloads are x86_64-only." >&2
    exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/live-miracles/restream-srs}"
APP_DIR=/opt/restream-srs
DATA_DIR=/var/lib/restream-srs
LOG_DIR=/var/log/restream-srs
CONF_DIR=/etc/restream-srs
SERVICE_USER=restream-srs

SRS_VERSION=6.0-r0
SRS_RELEASE_TAG="v${SRS_VERSION}"
SRS_FILENAME="SRS-CentOS7-x86_64-${SRS_VERSION}.zip"
SRS_SHA256="1eb20245a76643b2d32a1be85e71015079689a0733a10f79964f9a8189c21609"
SRS_URL="https://github.com/ossrs/srs/releases/download/${SRS_RELEASE_TAG}/${SRS_FILENAME}"

# Pinned srt-bonding-relay binary — published from the standalone relay repo.
SRT_RELEASE_TAG="${SRT_RELEASE_TAG:-v2.0.0}"
SRT_FILENAME="srt-bonding-relay-linux-x86_64.tar.gz"
SRT_SHA256="${SRT_SHA256:-927b3881712b8de568b016d0706592395e5edc011f5344b1d84cfece5de861cc}"
SRT_URL="${SRT_URL:-https://github.com/live-miracles/srt-bonding-relay/releases/download/${SRT_RELEASE_TAG}/${SRT_FILENAME}}"

# FFmpeg is pinned to a specific immutable BtbN build (a month-end autobuild tag,
# which BtbN retains for 2 years) instead of the floating "latest" tag, so installs
# are reproducible and the SHA256 stays valid. To bump: pick a newer month-end tag
# from https://github.com/BtbN/FFmpeg-Builds/releases, then take the linux64-gpl
# (non-shared) filename and its hash from that release's checksums.sha256.
FFMPEG_VERSION=7.1
FFMPEG_BUILD_TAG="autobuild-2026-05-31-13-22"
FFMPEG_FILENAME="ffmpeg-n7.1.4-7-gadcf20da26-linux64-gpl-7.1.tar.xz"
FFMPEG_SHA256="ce46c711e3ff79ae1e9318bf7daa54c77f41ce37b71010c44f4a0b38f1d7a29f"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { echo; echo "=== $* ==="; }

# Verify a downloaded file against an expected SHA256. An empty expected hash
# skips the check (used when a custom version/URL override makes the pin moot).
verify_sha256() {
    local file="$1" expected="$2"
    if [[ -z "$expected" ]]; then
        echo "Checksum: skipped (custom version/URL)"
        return
    fi
    local actual
    actual="$(sha256sum "$file" | awk '{print $1}')"
    if [[ "$actual" != "$expected" ]]; then
        echo "ERROR: checksum mismatch for $(basename "$file")" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
    echo "Checksum OK: $(basename "$file")"
}

step "1/11 System packages"
apt-get update -q
apt-get install -y -q curl tar xz-utils unzip git ca-certificates

step "2/11 Node.js 22"
if node --version 2>/dev/null | grep -q '^v22'; then
    echo "Node.js 22 already installed: $(node --version)"
else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    echo "Installed: $(node --version)"
fi

step "3/11 FFmpeg $FFMPEG_VERSION"
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD_TAG}/${FFMPEG_FILENAME}"

if /usr/local/bin/ffmpeg -version 2>/dev/null | grep -q "ffmpeg version n${FFMPEG_VERSION}"; then
    echo "FFmpeg $FFMPEG_VERSION already installed."
else
    echo "Downloading $FFMPEG_FILENAME..."
    curl -fsSL "$FFMPEG_URL" -o "$WORK/$FFMPEG_FILENAME"
    verify_sha256 "$WORK/$FFMPEG_FILENAME" "$FFMPEG_SHA256"
    tar -xJf "$WORK/$FFMPEG_FILENAME" -C "$WORK"
    FFMPEG_DIR="$(find "$WORK" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)"
    install -m 755 "${FFMPEG_DIR}/bin/ffmpeg" /usr/local/bin/ffmpeg
    install -m 755 "${FFMPEG_DIR}/bin/ffprobe" /usr/local/bin/ffprobe
    echo "Installed: $(/usr/local/bin/ffmpeg -version 2>&1 | head -1)"
fi

SRS_VERSION_MARKER=/usr/local/bin/.srs-version
step "4/11 SRS $SRS_VERSION"
if [[ -x /usr/local/bin/srs && -f "$SRS_VERSION_MARKER" && "$(cat "$SRS_VERSION_MARKER")" == "$SRS_RELEASE_TAG" ]]; then
    echo "SRS $SRS_VERSION ($SRS_RELEASE_TAG) already installed."
else
    echo "Downloading $SRS_FILENAME ($SRS_RELEASE_TAG)..."
    curl -fsSL "$SRS_URL" -o "$WORK/$SRS_FILENAME"
    verify_sha256 "$WORK/$SRS_FILENAME" "$SRS_SHA256"
    unzip -q "$WORK/$SRS_FILENAME" -d "$WORK/srs"
    SRS_BIN="$(find "$WORK/srs" -type f -path '*/usr/local/srs/objs/srs' | head -1)"
    if [[ -z "$SRS_BIN" ]]; then
        echo "ERROR: could not find srs binary in $SRS_FILENAME" >&2
        exit 1
    fi
    install -m 755 "$SRS_BIN" /usr/local/bin/srs
    echo "$SRS_RELEASE_TAG" > "$SRS_VERSION_MARKER"
    echo "Installed: $(/usr/local/bin/srs -v 2>&1 | head -1)"
fi

SRT_VERSION_MARKER=/usr/local/bin/.srt-bonding-relay-version
step "5/11 srt-bonding-relay $SRT_RELEASE_TAG"
if [[ -x /usr/local/bin/srt-bonding-relay && -f "$SRT_VERSION_MARKER" && "$(cat "$SRT_VERSION_MARKER")" == "$SRT_RELEASE_TAG" ]]; then
    echo "srt-bonding-relay $SRT_RELEASE_TAG already installed."
else
    echo "Downloading $SRT_FILENAME ($SRT_RELEASE_TAG)..."
    curl -fsSL "$SRT_URL" -o "$WORK/$SRT_FILENAME"
    verify_sha256 "$WORK/$SRT_FILENAME" "$SRT_SHA256"
    tar -xzf "$WORK/$SRT_FILENAME" -C "$WORK"
    SRT_BIN="$(find "$WORK" -type f -name srt-bonding-relay -perm -111 | head -1)"
    if [[ -z "$SRT_BIN" ]]; then
        echo "ERROR: could not find srt-bonding-relay binary in $SRT_FILENAME" >&2
        exit 1
    fi
    if [[ -d "$WORK/lib" ]]; then
        install -d -m 755 /usr/local/lib/restream-srs-srt
        install -m 755 "$WORK"/lib/* /usr/local/lib/restream-srs-srt/
        echo /usr/local/lib/restream-srs-srt > /etc/ld.so.conf.d/restream-srs-srt.conf
        ldconfig
    fi
    install -m 755 "$SRT_BIN" /usr/local/bin/srt-bonding-relay
    echo "$SRT_RELEASE_TAG" > "$SRT_VERSION_MARKER"
    echo "Installed: /usr/local/bin/srt-bonding-relay"
fi

step "6/11 Service user and directories"
if ! id "$SERVICE_USER" &>/dev/null; then
    useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    echo "Created user: $SERVICE_USER"
else
    echo "User $SERVICE_USER already exists."
fi
mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/objs" "$LOG_DIR" "$CONF_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR" "$DATA_DIR/objs" "$LOG_DIR" "$CONF_DIR"

step "7/11 Application"
if [[ ! -d "$APP_DIR/.git" ]]; then
    git clone "$REPO_URL" "$APP_DIR"
else
    echo "Repository already present at $APP_DIR, pulling latest code."
    sudo -u "$SERVICE_USER" git -C "$APP_DIR" fetch origin
    sudo -u "$SERVICE_USER" git -C "$APP_DIR" reset --hard '@{u}'
fi
cd "$APP_DIR"
npm ci
npm run build
npm prune --omit=dev
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
echo "Build complete."

step "8/11 Config and data"
# SRT passphrase: the repo configs ship a public default, so on first install
# (when these files don't exist yet at $CONF_DIR) generate a per-server secret
# and write it to both. On reinstall, each file's currently-deployed
# passphrase is read before it gets overwritten below and simply written
# back — no comparisons, no syncing between the two files. Change or disable
# it (empty disables the check) by editing both files by hand and restarting
# the services.
NEW_SRT_PASSPHRASE="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
if [[ -f "$CONF_DIR/srs.conf" ]]; then
    SRS_SRT_PASSPHRASE="$(sed -n 's/^[[:space:]]*passphrase[[:space:]]\{1,\}\(.*\);[[:space:]]*$/\1/p' "$CONF_DIR/srs.conf" | head -1)"
    echo "SRT passphrase (srs.conf): keeping existing value"
else
    SRS_SRT_PASSPHRASE="$NEW_SRT_PASSPHRASE"
    echo "SRT passphrase (srs.conf): generated new secret"
fi
if [[ -f "$CONF_DIR/srt-bonding-relay.json" ]]; then
    RELAY_SRT_PASSPHRASE="$(node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(c.passphrase||"");' "$CONF_DIR/srt-bonding-relay.json")"
    echo "SRT passphrase (srt-bonding-relay.json): keeping existing value"
else
    RELAY_SRT_PASSPHRASE="$NEW_SRT_PASSPHRASE"
    echo "SRT passphrase (srt-bonding-relay.json): generated new secret"
fi
cp "$APP_DIR/srs.conf" "$CONF_DIR/srs.conf"
cp "$APP_DIR/srt-bonding-relay.json" "$CONF_DIR/srt-bonding-relay.json"
echo "Config: refreshed $CONF_DIR/srs.conf from repository"
echo "Config: refreshed $CONF_DIR/srt-bonding-relay.json from repository"
# Patch in server-specific log paths (not in the repo's srs.conf).
sed -i '/^[[:space:]]*srs_log_tank[[:space:]]/d; /^[[:space:]]*srs_log_file[[:space:]]/d' "$CONF_DIR/srs.conf"
sed -i "/^listen/a srs_log_tank        file;\nsrs_log_file        $LOG_DIR/srs.log;" "$CONF_DIR/srs.conf"
# Written via node, not sed -i: a hand-typed passphrase containing "&" or "\"
# would otherwise be reinterpreted as sed replacement syntax and silently
# corrupted instead of applied verbatim.
node -e 'const fs=require("fs");const [p,pass]=process.argv.slice(1);const c=fs.readFileSync(p,"utf8").replace(/^([ \t]*passphrase[ \t]+).*;/m,(_,prefix)=>prefix+pass+";");fs.writeFileSync(p,c);' \
    "$CONF_DIR/srs.conf" "$SRS_SRT_PASSPHRASE"
node -e 'const fs=require("fs");const [p,pass]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,"utf8"));c.passphrase=pass;fs.writeFileSync(p,JSON.stringify(c,null,4)+"\n");' \
    "$CONF_DIR/srt-bonding-relay.json" "$RELAY_SRT_PASSPHRASE"
cat > "$APP_DIR/restream.json" <<EOF
{
    "port": 8080,
    "database_path": "$DATA_DIR/db.sqlite",
    "srs_config_path": "$CONF_DIR/srs.conf",
    "ffmpeg_path": "/usr/local/bin/ffmpeg",
    "ffprobe_path": "/usr/local/bin/ffprobe",
    "output_watchdog": {
        "warmup_ms": 90000,
        "stall_ms": 45000,
        "interval_ms": 5000,
        "socket_warmup_ms": 15000,
        "socket_grace_ms": 30000
    }
}
EOF
echo "Config: refreshed $APP_DIR/restream.json"
# Database. We don't run data migrations, so a db.sqlite left over from an older
# version could be schema-incompatible and cause hard-to-debug issues.
DB_FILE="$DATA_DIR/db.sqlite"
fresh_db=yes
if [[ -s "$DB_FILE" ]]; then
    wipe_db=no
    case "${WIPE_DB:-}" in
        y | Y) wipe_db=yes ;;
        n | N) wipe_db=no ;;
        *)
            if [[ -t 0 ]]; then
                read -rp "Existing database found at $DB_FILE. Preserve it? [Y/n] " reply
                [[ "$reply" == "n" || "$reply" == "N" ]] && wipe_db=yes
            fi
            ;;
    esac
    if [[ "$wipe_db" == "yes" ]]; then
        rm -f "$DB_FILE"
        echo "Database wiped; defaults will be re-seeded on first boot."
    else
        fresh_db=no
        echo "Keeping existing database."
    fi
fi
touch "$DB_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/srs.conf" "$CONF_DIR/srt-bonding-relay.json" "$APP_DIR/restream.json" "$DB_FILE"
echo "Config: $CONF_DIR/srs.conf"
echo "App config: $APP_DIR/restream.json"
echo "Data:   $DB_FILE"

step "9/11 Logrotate"
cat > /etc/logrotate.d/restream-srs <<EOF
$LOG_DIR/srs.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
echo "Logrotate: /etc/logrotate.d/restream-srs"

step "10/11 fail2ban"
# Bans IPs that repeatedly hit the on_publish/on_play hooks with bad stream
# keys (i.e. brute-forcing RTMP, which has no passphrase). Reads the app's
# journald output; the log format is emitted by src/api/srs.ts.
apt-get install -y -q fail2ban
cat > /etc/fail2ban/filter.d/restream-srs.conf <<'EOF'
[Definition]
failregex = ^\[srs-hook\] rejected (?:publish|play) from <HOST>:
journalmatch = _SYSTEMD_UNIT=restream-srs.service
EOF
cat > /etc/fail2ban/jail.d/restream-srs.local <<'EOF'
[restream-srs]
enabled = true
backend = systemd
filter = restream-srs
# Ban on all ports: an IP probing stream keys has no legitimate use here.
banaction = iptables-allports
maxretry = 5
findtime = 600
bantime = 3600
EOF

# Bans IPs that repeatedly fail the SRT passphrase handshake against the
# bonding relay's own listener (10081). This is a separate journald unit
# from restream-srs.service, so it needs its own filter/jail; the log format
# is emitted by srt-bonding-relay's srt_accept() KMSTATE check.
cat > /etc/fail2ban/filter.d/srt-bonding-relay.conf <<'EOF'
[Definition]
failregex = ^\[srt-relay\] rejected connection \(bad passphrase\) from <HOST>:
journalmatch = _SYSTEMD_UNIT=srt-bonding-relay.service
EOF
cat > /etc/fail2ban/jail.d/srt-bonding-relay.local <<'EOF'
[srt-bonding-relay]
enabled = true
backend = systemd
filter = srt-bonding-relay
# Ban on all ports: an IP brute-forcing the SRT passphrase has no legitimate use here.
banaction = iptables-allports
maxretry = 5
findtime = 600
bantime = 3600
EOF

systemctl enable fail2ban
systemctl restart fail2ban
echo "fail2ban: jail 'restream-srs' active (5 rejected publishes/plays in 10 min => 1 h ban)"
echo "fail2ban: jail 'srt-bonding-relay' active (5 bad SRT passphrases in 10 min => 1 h ban)"

# Lets the dashboard (Settings -> IP Whitelist) keep trusted IPs out of the
# jail above and unban them live, without restarting fail2ban or
# restream-srs.service (a restart would kill every in-flight output ffmpeg).
# Invoked via sudo since restream-srs.service is unprivileged. The API does
# full IP/CIDR validation; this script still rejects unsafe tokens before
# writing root-owned fail2ban config.
cat > /usr/local/sbin/restream-srs-fail2ban-apply <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

JAILS=(restream-srs srt-bonding-relay)

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

# Fail2ban reads these files itself on its own next (re)start, so this write
# alone is enough regardless of whether fail2ban is up right now. Every jail
# gets the same whitelist so a trusted IP is exempt everywhere, not just on
# whichever jail happened to ban it first.
for JAIL in "${JAILS[@]}"; do
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
done

# Below is the live half, needed only to apply/unban immediately.
if ! fail2ban-client ping >/dev/null 2>&1; then
    echo "fail2ban is not running; whitelist files written and will apply once it starts" >&2
    exit 1
fi

for JAIL in "${JAILS[@]}"; do
    fail2ban-client reload "$JAIL" >/dev/null

    # ignoreip only stops *future* bans; an IP just added to the whitelist that's
    # already sitting in the jail needs an explicit unban. unbanip errors on an
    # IP that isn't currently banned, which is the common case, so ignore that.
    for ip in "$@"; do
        fail2ban-client set "$JAIL" unbanip "$ip" >/dev/null 2>&1 || true
    done
done
EOF
chown root:root /usr/local/sbin/restream-srs-fail2ban-apply
chmod 755 /usr/local/sbin/restream-srs-fail2ban-apply

# Read-only counterpart: lets the dashboard show currently banned IPs (which
# jail, when banned, when they'll be unbanned, and the log line that triggered
# it). `fail2ban-client status` gives the live banned-IP list; ban/unban times
# and the triggering match come from fail2ban's own sqlite ban database, which
# is root-only for the same reason as the control socket. Both reads are
# combined into one script so the dashboard needs only a single sudo call.
cat > /usr/local/sbin/restream-srs-fail2ban-status <<'PYEOF'
#!/usr/bin/env python3
import json
import re
import sqlite3
import subprocess
import sys

JAILS = ["restream-srs", "srt-bonding-relay"]
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
    for jail in JAILS:
        for ip in banned_ips(jail):
            record = ban_record(conn, jail, ip) or {}
            results.append({
                "ip": ip,
                "jail": jail,
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
chown root:root /usr/local/sbin/restream-srs-fail2ban-status
chmod 755 /usr/local/sbin/restream-srs-fail2ban-status

SUDOERS_TMP="$WORK/restream-srs-fail2ban.sudoers"
cat > "$SUDOERS_TMP" <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: /usr/local/sbin/restream-srs-fail2ban-apply, /usr/local/sbin/restream-srs-fail2ban-status
EOF
if ! visudo -cf "$SUDOERS_TMP"; then
    echo "ERROR: generated sudoers rule for fail2ban whitelisting failed validation" >&2
    exit 1
fi
install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/restream-srs-fail2ban
echo "fail2ban: dashboard IP whitelist wired up (Settings -> IP Whitelist)"
echo "fail2ban: dashboard ban list wired up (Settings -> Currently Banned)"

step "11/11 Systemd"
cat > /etc/systemd/system/srs.service <<EOF
[Unit]
Description=SRS Streaming Server
After=network-online.target restream-srs.service
Wants=network-online.target
Requires=restream-srs.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DATA_DIR
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 60); do curl -fsS http://127.0.0.1:8080/api/ready >/dev/null && exit 0; sleep 1; done; echo "restream-srs readiness check timed out" >&2; exit 1'
ExecStart=/usr/local/bin/srs -c $CONF_DIR/srs.conf
Restart=always
RestartSec=2
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $LOG_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/srt-bonding-relay.service <<EOF
[Unit]
Description=Shared SRT Bonding Relay
After=network-online.target restream-srs.service srs.service
Wants=network-online.target
Requires=restream-srs.service srs.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DATA_DIR
ExecStart=/usr/local/bin/srt-bonding-relay $CONF_DIR/srt-bonding-relay.json
Restart=always
RestartSec=2
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $LOG_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/restream-srs.service <<EOF
[Unit]
Description=Restream SRS Control Plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP_DIR/dist/index.js
Restart=always
RestartSec=2
# This service forks one ffmpeg per output (300+) plus ffprobe/preview helpers,
# each carrying several threads. LimitNOFILE covers the parent's pipe/socket fds;
# TasksMax/LimitNPROC lift the task (thread+process) cap, which otherwise falls
# back to systemd's default (~15% of pid_max) and would be hit during a mass
# start/restart surge — manifesting as spawn failures (EAGAIN) right when many
# outputs are recovering at once.
LimitNOFILE=1048576
TasksMax=infinity
LimitNPROC=infinity
# Intentionally omit NoNewPrivileges: the dashboard uses sudoers-limited helper
# scripts to read/apply fail2ban state.
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable srs.service srt-bonding-relay.service restream-srs.service
systemctl stop srt-bonding-relay.service srs.service restream-srs.service 2>/dev/null || true
systemctl start restream-srs.service
systemctl start srs.service
systemctl start srt-bonding-relay.service

echo
echo "=============================="
echo " Setup complete"
echo "=============================="
echo "Dashboard: http://<server-ip>:8080/"
if [[ "$fresh_db" == "yes" ]]; then
    echo "  Default password: admin"
else
    echo "  Password: unchanged (kept existing database)"
    echo "  Forgot it? Run scripts/server-reset-password.sh"
fi
echo "  Set your public host in Settings → Public Host"
echo "App config: $APP_DIR/restream.json"
echo "Config:    $CONF_DIR/srs.conf"
echo "Data:      $DATA_DIR/db.sqlite"
echo ""
echo "Security:"
echo "  RTMP now listens on 21935 (was 1935) - update your GCP firewall rule"
echo "  and encoder URLs. The dashboard shows the current publish URLs."
echo "  SRT requires a passphrase (see $CONF_DIR/srs.conf); it is included"
echo "  in the SRT publish URLs shown in the dashboard."
echo ""
echo "Check status:"
echo "  systemctl status srs.service"
echo "  systemctl status srt-bonding-relay.service"
echo "  systemctl status restream-srs.service"
echo ""
echo "Follow logs:"
echo "  journalctl -u srt-bonding-relay.service -f"
echo "  journalctl -u restream-srs.service -f"
echo "  journalctl -u srs.service -f"
echo ""
echo "Update later:"
echo "  sudo bash $APP_DIR/scripts/server-install.sh"
