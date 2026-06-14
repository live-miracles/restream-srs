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
SRS_URL="${SRS_URL:-https://github.com/ossrs/srs/releases/download/v${SRS_VERSION}/${SRS_ZIP}}"
FFMPEG_VERSION=7.1

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { echo; echo "=== $* ==="; }

step "1/8 System packages"
apt-get update -q
apt-get install -y -q curl tar xz-utils unzip git ca-certificates

step "2/8 Node.js 22"
if node --version 2>/dev/null | grep -q '^v22'; then
    echo "Node.js 22 already installed: $(node --version)"
else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    echo "Installed: $(node --version)"
fi

step "3/8 FFmpeg $FFMPEG_VERSION"
FFMPEG_FILENAME="ffmpeg-n${FFMPEG_VERSION}-latest-linux64-gpl-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_FILENAME}"

if /usr/local/bin/ffmpeg -version 2>/dev/null | grep -q "ffmpeg version n${FFMPEG_VERSION}"; then
    echo "FFmpeg $FFMPEG_VERSION already installed."
else
    echo "Downloading $FFMPEG_FILENAME..."
    curl -fsSL "$FFMPEG_URL" -o "$WORK/$FFMPEG_FILENAME"
    tar -xJf "$WORK/$FFMPEG_FILENAME" -C "$WORK"
    FFMPEG_DIR="$(find "$WORK" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)"
    install -m 755 "${FFMPEG_DIR}/bin/ffmpeg" /usr/local/bin/ffmpeg
    install -m 755 "${FFMPEG_DIR}/bin/ffprobe" /usr/local/bin/ffprobe
    echo "Installed: $(/usr/local/bin/ffmpeg -version 2>&1 | head -1)"
fi

step "4/8 SRS $SRS_VERSION"
if /usr/local/bin/srs -v 2>&1 | grep -q "$SRS_VERSION"; then
    echo "SRS $SRS_VERSION already installed."
else
    echo "Downloading $SRS_ZIP..."
    curl -fsSL "$SRS_URL" -o "$WORK/$SRS_ZIP"
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
    echo "Installed: $(/usr/local/bin/srs -v 2>&1 | head -1)"
fi

step "5/8 Service user and directories"
if ! id "$SERVICE_USER" &>/dev/null; then
    useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    echo "Created user: $SERVICE_USER"
else
    echo "User $SERVICE_USER already exists."
fi
mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR" "$CONF_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR" "$LOG_DIR" "$CONF_DIR"

step "6/8 Application"
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

step "7/8 Config and data"
if [[ ! -f "$CONF_DIR/srs.conf" ]]; then
    cp "$APP_DIR/srs.conf" "$CONF_DIR/srs.conf"
fi
touch "$DATA_DIR/db.sqlite"
chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/srs.conf" "$DATA_DIR/db.sqlite"
echo "Config: $CONF_DIR/srs.conf"
echo "Data:   $DATA_DIR/db.sqlite"

step "8/8 Systemd"
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
Environment=SRS_API_URL=http://127.0.0.1:1985
Environment=SRS_RTMP_HOST=127.0.0.1
Environment=SRS_RTMP_PORT=1935
Environment=FFMPEG_PATH=/usr/local/bin/ffmpeg
Environment=FFPROBE_PATH=/usr/local/bin/ffprobe
ExecStart=/usr/bin/node $APP_DIR/dist/index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable srs.service restream-srs.service
# srs.conf was provisioned above (step 7) and is rewritten only when the SRT
# passphrase changes, so SRS and the app have no start-order dependency.
systemctl restart srs.service restream-srs.service

echo
echo "=============================="
echo " Setup complete"
echo "=============================="
echo "Dashboard: http://<server-ip>:8080/"
echo "  Default password: admin"
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
