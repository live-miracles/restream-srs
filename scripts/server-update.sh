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
LOG_DIR=/var/log/restream-srs
CONF_DIR=/etc/restream-srs
SERVICE_USER=restream-srs

echo "=== Pull latest code ==="
cd "$APP_DIR"
# Run git as the repo owner (avoids git's "dubious ownership" abort when root
# operates on a tree owned by $SERVICE_USER) and reset hard so the deploy is
# deterministic regardless of any local drift on the box.
sudo -u "$SERVICE_USER" git -C "$APP_DIR" fetch origin
sudo -u "$SERVICE_USER" git -C "$APP_DIR" reset --hard '@{u}'

echo
echo "=== Rebuild ==="
# Build as the service user (matching the git steps above) so the tree never ends
# up with root-owned files and npm lifecycle scripts don't run as root. -H gives
# npm/node a writable HOME ($APP_DIR) for their cache. A final chown stays as a
# cheap safety net in case an earlier run left anything root-owned.
sudo -u "$SERVICE_USER" -H npm ci
sudo -u "$SERVICE_USER" -H npm run build
sudo -u "$SERVICE_USER" -H npm prune --omit=dev
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo
echo "=== Ensure runtime paths ==="
mkdir -p "$DATA_DIR" "$DATA_DIR/objs" "$LOG_DIR" "$CONF_DIR"
touch "$DATA_DIR/db.sqlite"
if [[ ! -f "$CONF_DIR/srs.conf" ]]; then
    cp "$APP_DIR/srs.conf" "$CONF_DIR/srs.conf"
fi
# Always enforce log settings in case the conf pre-dates these requirements.
sed -i "s|srs_log_file.*|srs_log_file        $LOG_DIR/srs.log;|" "$CONF_DIR/srs.conf"
sed -i "s|srs_log_tank.*|srs_log_tank        file;|" "$CONF_DIR/srs.conf"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/objs" "$LOG_DIR" "$CONF_DIR" "$DATA_DIR/db.sqlite" "$CONF_DIR/srs.conf"

echo
echo "=== Restart services ==="
# srs.conf only changes when the SRT passphrase changes, so there is no
# start-order dependency between SRS and the app.
systemctl restart srs.service restream-srs.service

echo
echo "=== Status ==="
systemctl status srs.service --no-pager -l || true
systemctl status restream-srs.service --no-pager -l || true
echo
echo "Logs:"
echo "  journalctl -u restream-srs.service -n 50 --no-pager"
echo "  journalctl -u srs.service -n 50 --no-pager"
