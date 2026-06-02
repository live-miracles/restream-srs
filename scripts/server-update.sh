#!/usr/bin/env bash
# Pull latest code, rebuild, and restart native services.
#
# Usage:
#   sudo bash /opt/restream-srs/scripts/server-update.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (sudo bash scripts/server-update.sh)" >&2
    exit 1
fi

APP_DIR=/opt/restream-srs
DATA_DIR=/var/lib/restream-srs
CONF_DIR=/etc/restream-srs
SERVICE_USER=restream-srs

echo "=== Pull latest code ==="
cd "$APP_DIR"
git pull

echo
echo "=== Rebuild ==="
npm ci
npm run build
npm prune --omit=dev
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo
echo "=== Ensure runtime paths ==="
mkdir -p "$DATA_DIR" "$CONF_DIR"
touch "$DATA_DIR/db.sqlite"
if [[ ! -f "$CONF_DIR/srs.conf" ]]; then
    cp "$APP_DIR/srs.conf" "$CONF_DIR/srs.conf"
fi
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$CONF_DIR" "$DATA_DIR/db.sqlite" "$CONF_DIR/srs.conf"

echo
echo "=== Restart services ==="
# The app writes the latest generated srs.conf on startup; restart SRS after it.
systemctl restart restream-srs.service
sleep 1
systemctl restart srs.service

echo
echo "=== Status ==="
systemctl status srs.service --no-pager -l || true
systemctl status restream-srs.service --no-pager -l || true
echo
echo "Logs:"
echo "  journalctl -u restream-srs.service -n 50 --no-pager"
echo "  journalctl -u srs.service -n 50 --no-pager"
