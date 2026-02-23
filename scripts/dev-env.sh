#!/usr/bin/env bash
# SignChat — Generate local-dev environment files (.env + frontend/.env.local)
#
# Usage:
#   ./scripts/dev-env.sh            # run from repo root
#   source scripts/dev-env.sh       # run + export DEV_IP into caller
#
# Safe to call repeatedly — overwrites files idempotently.

set -euo pipefail

# ── Locate repo root (works regardless of cwd) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Detect DEV_IP ──
DEV_IP=""
DEV_IP_SOURCE=""

if command -v tailscale >/dev/null 2>&1; then
  ts_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [ -n "$ts_ip" ]; then
    DEV_IP="$ts_ip"
    DEV_IP_SOURCE="tailscale"
  fi
fi

if [ -z "$DEV_IP" ]; then
  lan_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -n "$lan_ip" ]; then
    DEV_IP="$lan_ip"
    DEV_IP_SOURCE="en0"
  fi
fi

if [ -z "$DEV_IP" ]; then
  lan_ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  if [ -n "$lan_ip" ]; then
    DEV_IP="$lan_ip"
    DEV_IP_SOURCE="en1"
  fi
fi

if [ -z "$DEV_IP" ]; then
  DEV_IP="127.0.0.1"
  DEV_IP_SOURCE="fallback"
fi

echo "[dev-env] DEV_IP=$DEV_IP (source: $DEV_IP_SOURCE)"

# ── Write root .env (consumed by docker-compose) ──
ROOT_ENV="$REPO_ROOT/.env"
cat > "$ROOT_ENV" <<EOF
TURN_EXTERNAL_IP=$DEV_IP
EOF
echo "[dev-env] wrote $ROOT_ENV"

# ── Write frontend/.env.local ──
FE_ENV="$REPO_ROOT/frontend/.env.local"

if [ -f "$FE_ENV" ]; then
  bak="$FE_ENV.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$FE_ENV" "$bak"
  echo "[dev-env] backed up existing → $bak"
fi

cat > "$FE_ENV" <<EOF
NEXT_PUBLIC_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:${DEV_IP}:3478?transport=udp","turn:${DEV_IP}:3478?transport=tcp"],"username":"signchat","credential":"signchat"}]
EOF
echo "[dev-env] wrote $FE_ENV"

# Export so callers that `source` this script can use DEV_IP
export DEV_IP
export DEV_IP_SOURCE
