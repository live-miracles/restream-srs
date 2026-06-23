#!/usr/bin/env bash
# One-shot native setup for a Linux server.
# Installs Node.js 22, FFmpeg 7.1, SRS 6.0, builds the app,
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

SRS_VERSION="${SRS_VERSION:-6.0-r0}"
SRS_ZIP="SRS-CentOS7-x86_64-${SRS_VERSION}.zip"
SRS_URL_OVERRIDDEN="${SRS_URL+yes}"
SRS_URL="${SRS_URL:-https://github.com/ossrs/srs/releases/download/v${SRS_VERSION}/${SRS_ZIP}}"
# Pinned SHA256 for the default SRS build. Cleared (checksum skipped) when a
# custom SRS_VERSION or SRS_URL is supplied, since the hash would no longer match.
SRS_SHA256=""
if [[ "$SRS_VERSION" == "6.0-r0" && -z "$SRS_URL_OVERRIDDEN" ]]; then
    SRS_SHA256="1eb20245a76643b2d32a1be85e71015079689a0733a10f79964f9a8189c21609"
fi

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

step "1/9 System packages"
apt-get update -q
apt-get install -y -q curl tar xz-utils unzip git ca-certificates

step "2/9 Node.js 22"
if node --version 2>/dev/null | grep -q '^v22'; then
    echo "Node.js 22 already installed: $(node --version)"
else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    echo "Installed: $(node --version)"
fi

step "3/9 FFmpeg $FFMPEG_VERSION"
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
step "4/9 SRS $SRS_VERSION"
if [[ -x /usr/local/bin/srs && -f "$SRS_VERSION_MARKER" && "$(cat "$SRS_VERSION_MARKER")" == "$SRS_VERSION" ]]; then
    echo "SRS $SRS_VERSION already installed."
else
    echo "Downloading $SRS_ZIP..."
    curl -fsSL "$SRS_URL" -o "$WORK/$SRS_ZIP"
    verify_sha256 "$WORK/$SRS_ZIP" "$SRS_SHA256"
    unzip -q "$WORK/$SRS_ZIP" -d "$WORK/srs"
    # The zip root contains an init wrapper script also named 'srs'; the real
    # ELF binary lives deeper at usr/local/srs/objs/srs. Match it precisely so
    # we never install the wrapper by mistake.
    SRS_BIN="$(find "$WORK/srs" -type f -path '*/usr/local/srs/objs/srs' | head -1)"
    if [[ -z "$SRS_BIN" ]]; then
        echo "ERROR: could not find SRS binary in $SRS_ZIP" >&2
        exit 1
    fi
    install -m 755 "$SRS_BIN" /usr/local/bin/srs
    echo "$SRS_VERSION" > "$SRS_VERSION_MARKER"
    echo "Installed: $(/usr/local/bin/srs -v 2>&1 | head -1)"
fi

step "5/9 Service user and directories"
if ! id "$SERVICE_USER" &>/dev/null; then
    useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    echo "Created user: $SERVICE_USER"
else
    echo "User $SERVICE_USER already exists."
fi
mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/objs" "$LOG_DIR" "$CONF_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR" "$DATA_DIR/objs" "$LOG_DIR" "$CONF_DIR"

step "6/9 Application"
if [[ ! -d "$APP_DIR/.git" ]]; then
    git clone "$REPO_URL" "$APP_DIR"
else
    echo "Repository already present at $APP_DIR, skipping clone."
    echo "(To pull and deploy newer code, use scripts/server-update.sh instead.)"
fi
cd "$APP_DIR"
npm ci
npm run build
npm prune --omit=dev
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
echo "Build complete."

step "7/9 Config and data"
cp "$APP_DIR/srs.conf" "$CONF_DIR/srs.conf"
# Patch in server-specific log paths (not in the repo's srs.conf).
sed -i '/^[[:space:]]*srs_log_tank[[:space:]]/d; /^[[:space:]]*srs_log_file[[:space:]]/d' "$CONF_DIR/srs.conf"
sed -i "/^listen/a srs_log_tank        file;\nsrs_log_file        $LOG_DIR/srs.log;" "$CONF_DIR/srs.conf"
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
                read -rp "Existing database found at $DB_FILE. Wipe it and start fresh? [y/N] " reply
                [[ "$reply" == "y" || "$reply" == "Y" ]] && wipe_db=yes
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
chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/srs.conf" "$DB_FILE"
echo "Config: $CONF_DIR/srs.conf"
echo "Data:   $DB_FILE"

step "8/9 Logrotate"
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

step "9/9 Systemd"
cat > /etc/systemd/system/srs.service <<EOF
[Unit]
Description=SRS Streaming Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DATA_DIR
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

cat > /etc/systemd/system/restream-srs.service <<EOF
[Unit]
Description=Restream SRS Control Plane
After=network-online.target srs.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=DB_PATH=$DATA_DIR/db.sqlite
Environment=SRS_CONF_PATH=$CONF_DIR/srs.conf
Environment=SRS_LOG_PATH=$LOG_DIR/srs.log
Environment=SRS_API_URL=http://127.0.0.1:1985
Environment=SRS_RTMP_HOST=127.0.0.1
Environment=SRS_RTMP_PORT=1935
Environment=SRS_SRT_PORT=10080
Environment=FFMPEG_PATH=/usr/local/bin/ffmpeg
Environment=FFPROBE_PATH=/usr/local/bin/ffprobe
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
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable srs.service restream-srs.service
systemctl restart srs.service restream-srs.service

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
echo "Config:    $CONF_DIR/srs.conf"
echo "Data:      $DATA_DIR/db.sqlite"
echo ""
echo "Check status:"
echo "  systemctl status srs.service"
echo "  systemctl status restream-srs.service"
echo ""
echo "Follow logs:"
echo "  journalctl -u restream-srs.service -f"
echo "  journalctl -u srs.service -f"
echo ""
echo "Update later:"
echo "  sudo bash $APP_DIR/scripts/server-update.sh"
