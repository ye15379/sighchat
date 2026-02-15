#!/usr/bin/env bash
# SignChat — HTTP dev server (local only; LAN devices need HTTPS script)
# Usage: ./frontend/scripts/dev-clean-start.sh

set -u

# ── 0. File descriptor limit ──
current_fdlimit="$(ulimit -n 2>/dev/null || echo 256)"
if [ "$current_fdlimit" -lt 10240 ]; then
  ulimit -n 10240 2>/dev/null || true
  echo "[dev] ulimit -n raised from $current_fdlimit to $(ulimit -n)"
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
echo "[dev] frontend dir: $ROOT_DIR"

# ── 1. Kill stale processes ──
kill_port_if_needed() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then return 0; fi
  for pid in $pids; do
    echo "[dev] killing pid $pid on port $port"
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 0.5
}
kill_port_if_needed 3000
kill_port_if_needed 3001
kill_port_if_needed 3002

# ── 2. Clean cache ──
echo "[dev] removing .next cache"
rm -rf .next

# ── 3. Start ──
echo "[dev] starting: next dev --hostname 0.0.0.0 --port 3000"
echo "[dev] NOTE: For LAN/mobile access, use dev-clean-start-https.sh instead"
npm run dev -- --hostname 0.0.0.0 --port 3000
