#!/usr/bin/env bash
# Installs the file server and its web console as background services (systemd, Ubuntu).
#
#   sudo ./deploy/install.sh [async|sync] [options]
#
# Options:
#   --web-port N        port for the web console            (default 3000)
#   --localhost-only    web console listens on 127.0.0.1 only (default: all interfaces)
#   --expose-raw-port   allow other machines to reach the raw TCP port 8080
#                       (default: the C server is restricted to loopback, because it
#                        trusts file names it is sent, e.g. "WRITE ../x data")
#   --no-systemd        copy files only; do not create or start services
#   --print-units       print the generated unit files and exit
set -euo pipefail

MODE="async"; WEB_PORT=3000; WEB_HOST="0.0.0.0"; EXPOSE_RAW=0; USE_SYSTEMD=1; PRINT_ONLY=0
PREFIX="${PREFIX:-/opt/afps}"
DATA_DIR="${DATA_DIR:-/var/lib/afps/data}"
SVC_USER="afps"
RAW_PORT=8080

while [ $# -gt 0 ]; do
  case "$1" in
    async|sync) MODE="$1" ;;
    --web-port) WEB_PORT="${2:?--web-port needs a number}"; shift ;;
    --localhost-only) WEB_HOST="127.0.0.1" ;;
    --expose-raw-port) EXPOSE_RAW=1 ;;
    --no-systemd) USE_SYSTEMD=0 ;;
    --print-units) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
NODE_BIN="$(command -v node || true)"

server_unit() {
  local restrict=""
  [ "$EXPOSE_RAW" -eq 1 ] || restrict=$'IPAddressDeny=any\nIPAddressAllow=localhost'
  cat <<UNIT
[Unit]
Description=Asynchronous File Processing Server (TCP ${RAW_PORT}, ${MODE} mode)
After=network.target

[Service]
Type=simple
User=${SVC_USER}
WorkingDirectory=${DATA_DIR}
ExecStart=${PREFIX}/server/server ${MODE}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}
${restrict}

[Install]
WantedBy=multi-user.target
UNIT
}

web_unit() {
  cat <<UNIT
[Unit]
Description=Web console for the file server (HTTP ${WEB_PORT})
After=afps-server.service
Wants=afps-server.service

[Service]
Type=simple
User=${SVC_USER}
Environment=WEB_PORT=${WEB_PORT}
Environment=WEB_HOST=${WEB_HOST}
Environment=AFPS_HOST=127.0.0.1
Environment=AFPS_PORT=${RAW_PORT}
ExecStart=${NODE_BIN:-/usr/bin/node} ${PREFIX}/web/bridge/server.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
}

if [ "$PRINT_ONLY" -eq 1 ]; then
  echo "# /etc/systemd/system/afps-server.service"; server_unit; echo
  echo "# /etc/systemd/system/afps-web.service"; web_unit; exit 0
fi

die() { echo "Error: $*" >&2; exit 1; }

if [ "$USE_SYSTEMD" -eq 1 ] && [ "$(id -u)" -ne 0 ]; then
  die "run with sudo:  sudo $0 $*"
fi
command -v gcc >/dev/null  || die "gcc not found.   Install it with:  sudo apt install -y build-essential"
[ -n "$NODE_BIN" ]         || die "node not found.  Install it with:  sudo apt install -y nodejs"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 16 ]   || die "Node $NODE_MAJOR is too old (need 16+). Ubuntu 22.04's apt package is Node 12. Install a current one:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
[ -f "$ROOT/server.c" ]    || die "server.c not found in $ROOT. Unzip this add-on into your project folder (next to server.c)."

# Frontend: use the prebuilt dist/, or build it if it is missing.
if [ ! -f "$ROOT/webui/dist/index.html" ]; then
  command -v npm >/dev/null || die "webui/dist is missing and npm is not installed (sudo apt install -y npm)."
  echo "==> Building the frontend"
  (cd "$ROOT/webui" && npm install --no-audit --no-fund && npm run build)
fi

echo "==> Building the C server ($MODE mode)"
mkdir -p "$PREFIX/server" "$PREFIX/web" "$DATA_DIR"
gcc -O2 -o "$PREFIX/server/server" "$ROOT/server.c" -lpthread -lrt

echo "==> Installing the web console to $PREFIX/web"
rm -rf "$PREFIX/web/bridge" "$PREFIX/web/dist"
cp -r "$ROOT/webui/bridge" "$ROOT/webui/dist" "$PREFIX/web/"

if [ "$USE_SYSTEMD" -eq 0 ]; then
  echo
  echo "Files installed under $PREFIX (no services created). To run by hand:"
  echo "  cd $DATA_DIR && $PREFIX/server/server $MODE &"
  echo "  WEB_PORT=$WEB_PORT $NODE_BIN $PREFIX/web/bridge/server.js"
  exit 0
fi

id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
chown -R "$SVC_USER":"$SVC_USER" "$DATA_DIR"
chmod 755 "$PREFIX" "$PREFIX/server" "$PREFIX/web"
if ! su -s /bin/sh "$SVC_USER" -c "test -x '$NODE_BIN'" 2>/dev/null; then
  die "The service user '$SVC_USER' cannot run $NODE_BIN (is node installed under your home folder, e.g. nvm?). Install a system-wide Node: sudo apt install -y nodejs"
fi

echo "==> Creating systemd services"
server_unit > /etc/systemd/system/afps-server.service
web_unit    > /etc/systemd/system/afps-web.service
systemctl daemon-reload
systemctl enable afps-server.service afps-web.service >/dev/null
systemctl restart afps-server.service afps-web.service
sleep 1

echo
systemctl --no-pager --lines=0 status afps-server.service afps-web.service | grep -E "●|Active:" || true
echo
echo "Web console:   http://localhost:${WEB_PORT}"
if [ "$WEB_HOST" = "0.0.0.0" ]; then
  for ip in $(hostname -I 2>/dev/null); do echo "               http://${ip}:${WEB_PORT}"; done
fi
echo "Files live in: ${DATA_DIR}"
echo "Logs:          journalctl -u afps-server -f      journalctl -u afps-web -f"
echo "Restart:       sudo systemctl restart afps-server afps-web"
