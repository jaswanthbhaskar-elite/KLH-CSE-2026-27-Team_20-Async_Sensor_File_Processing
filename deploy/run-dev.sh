#!/usr/bin/env bash
# Runs both programs in the foreground, no root and no systemd. Ctrl+C stops both.
#   ./deploy/run-dev.sh [async|sync]        then open http://localhost:3000
set -euo pipefail
MODE="${1:-async}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/.dev"; mkdir -p "$WORK/data"
gcc -O2 -o "$WORK/server" "$ROOT/server.c" -lpthread -lrt
[ -f "$ROOT/webui/dist/index.html" ] || (cd "$ROOT/webui" && npm install --no-audit --no-fund && npm run build)
cleanup() { kill "$SRV" "$WEB" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
(cd "$WORK/data" && exec "$WORK/server" "$MODE") & SRV=$!
sleep 0.5
node "$ROOT/webui/bridge/server.js" & WEB=$!
wait -n "$SRV" "$WEB"
