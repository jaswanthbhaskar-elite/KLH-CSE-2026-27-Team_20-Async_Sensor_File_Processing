#!/usr/bin/env bash
# Stops and removes the services and installed files.  sudo ./deploy/uninstall.sh [--purge]
# --purge also deletes the data directory (all files written through the server).
set -euo pipefail
PREFIX="${PREFIX:-/opt/afps}"; DATA_DIR="${DATA_DIR:-/var/lib/afps/data}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
for s in afps-web afps-server; do
  systemctl disable --now "$s.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/$s.service"
done
systemctl daemon-reload
rm -rf "$PREFIX"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$(dirname "$DATA_DIR")"; userdel afps 2>/dev/null || true
  echo "Removed services, program files, data and the afps user."
else
  echo "Removed services and program files. Data kept in $DATA_DIR (use --purge to delete it)."
fi
