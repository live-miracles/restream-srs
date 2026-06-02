#!/usr/bin/env bash
# Stop native Restream SRS services without disabling them.
# Services will restart automatically on next boot.
# To permanently disable:
#   sudo systemctl disable restream-srs.service srs.service
#
# Usage:
#   sudo bash /opt/restream-srs/scripts/server-down.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (sudo bash scripts/server-down.sh)" >&2
    exit 1
fi

echo "=== Stopping services ==="
systemctl stop restream-srs.service
echo "  restream-srs.service stopped"
systemctl stop srs.service
echo "  srs.service stopped"

echo
echo "=== Status ==="
systemctl status restream-srs.service --no-pager -l || true
systemctl status srs.service --no-pager -l || true
