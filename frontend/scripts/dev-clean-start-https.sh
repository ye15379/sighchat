#!/usr/bin/env bash
# SignChat — HTTPS dev server (LAN + Tailscale accessible)
# Usage: ./frontend/scripts/dev-clean-start-https.sh
#
# Automatically detects Tailscale IP (if available), generates mkcert
# certificates covering all relevant IPs, and probes all three services
# (frontend, backend_tls, coturn) before printing a summary.

set -euo pipefail

# ── 0. ulimit guard ──
cur_fd="$(ulimit -n 2>/dev/null || echo 256)"
if [ "$cur_fd" -lt 10240 ]; then
  ulimit -n 10240 2>/dev/null || true
  echo "[https] ulimit -n: $cur_fd → $(ulimit -n)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"
echo "[https] frontend dir: $ROOT_DIR"

# ── 0b. Auto-generate .env + frontend/.env.local ──
source "$REPO_ROOT/scripts/dev-env.sh"

# ── 1. Kill stale port listeners ──
kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    echo "[https] killing pid $pid on :$port"
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 0.5
}
kill_port 3000
kill_port 3001
kill_port 3002

# ── 2. Clean build cache ──
echo "[https] cleaning .next cache"
rm -rf .next

# ── 3. Detect IPs ──
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
TS_IP=""
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null || true)"
fi

# Pick the "primary" IP that remote devices will use
if [ -n "$TS_IP" ]; then
  PRIMARY_IP="$TS_IP"
  echo "[https] Tailscale IP detected: $TS_IP (will be primary)"
elif [ -n "$LAN_IP" ]; then
  PRIMARY_IP="$LAN_IP"
  echo "[https] LAN IP: $LAN_IP (primary; no Tailscale found)"
else
  PRIMARY_IP="localhost"
  echo "[https] WARNING: no LAN/Tailscale IP; localhost only"
fi
export LAN_IP="${LAN_IP:-$PRIMARY_IP}"

# ── 4. Ensure mkcert certificate covers all IPs ──
CERT_DIR="$HOME/certs"
CERT_FILE="$CERT_DIR/dev.pem"
KEY_FILE="$CERT_DIR/dev-key.pem"

# Build the SAN list: always localhost + 127.0.0.1 + ::1, plus LAN and Tailscale
SAN_LIST="localhost 127.0.0.1 ::1"
[ -n "$LAN_IP" ] && [ "$LAN_IP" != "localhost" ] && SAN_LIST="$SAN_LIST $LAN_IP"
[ -n "$TS_IP" ] && SAN_LIST="$SAN_LIST $TS_IP"

needs_regen=0
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  needs_regen=1
elif [ -n "$TS_IP" ]; then
  # Check if existing cert covers the Tailscale IP
  if ! openssl x509 -in "$CERT_FILE" -noout -text 2>/dev/null | grep -q "$TS_IP"; then
    echo "[https] existing cert does not cover $TS_IP — regenerating"
    needs_regen=1
  fi
fi

if [ "$needs_regen" -eq 1 ]; then
  mkdir -p "$CERT_DIR"
  if ! command -v mkcert >/dev/null 2>&1; then
    echo "[https] ERROR: mkcert not found. Install: brew install mkcert"
    exit 1
  fi
  mkcert -install 2>/dev/null || true
  echo "[https] generating cert with SANs: $SAN_LIST"
  # shellcheck disable=SC2086
  mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" $SAN_LIST
fi
echo "[https] cert: $CERT_FILE"
echo "[https] key:  $KEY_FILE"

# ── 5. Start Next.js HTTPS on 0.0.0.0:3000 ──
echo "[https] starting: next dev --hostname 0.0.0.0 --port 3000 (HTTPS)"
npm run dev -- \
  --hostname 0.0.0.0 \
  --port 3000 \
  --experimental-https \
  --experimental-https-key "$KEY_FILE" \
  --experimental-https-cert "$CERT_FILE" &
NEXT_PID=$!

cleanup() {
  if kill -0 "$NEXT_PID" 2>/dev/null; then
    echo "[https] stopping next (pid $NEXT_PID)"
    kill "$NEXT_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

# ── 6. Probe frontend (up to 25s) ──
echo "[https] probing https://localhost:3000/match ..."
probe_ok=0
for i in $(seq 1 25); do
  code="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://localhost:3000/match" 2>/dev/null || echo "000")"
  if [ "$code" = "200" ] || [ "$code" = "304" ]; then
    probe_ok=1; echo "[https] frontend ready (${i}s)"; break
  fi
  sleep 1
done
if [ "$probe_ok" -ne 1 ]; then
  echo "[https] ERROR: frontend not ready after 25s (last code: $code)"
  lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null || true
  exit 1
fi

# ── 7. Reachability probes ──
echo ""
echo "── Reachability probes ──────────────────────────────"

# Frontend
for ip in localhost "$LAN_IP" ${TS_IP:+"$TS_IP"}; do
  [ "$ip" = "localhost" ] || [ -n "$ip" ] || continue
  c="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://${ip}:3000/match" 2>/dev/null || echo "000")"
  status="OK"; [ "$c" != "200" ] && [ "$c" != "304" ] && status="FAIL($c)"
  printf "  frontend  https://%-20s:3000  %s\n" "$ip" "$status"
done

# Backend TLS
for ip in localhost "$LAN_IP" ${TS_IP:+"$TS_IP"}; do
  [ "$ip" = "localhost" ] || [ -n "$ip" ] || continue
  c="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://${ip}:8001/health/" 2>/dev/null || echo "000")"
  status="OK"; [ "$c" = "000" ] && status="DOWN"
  printf "  backend   https://%-20s:8001  %s\n" "$ip" "$status"
done

# TURN
turn_tcp="$(lsof -nP -iTCP:3478 -sTCP:LISTEN 2>/dev/null | grep -c LISTEN || echo 0)"
turn_udp="$(lsof -nP -iUDP:3478 2>/dev/null | grep -c UDP || echo 0)"
turn_status="OK"
[ "$turn_tcp" -eq 0 ] && [ "$turn_udp" -eq 0 ] && turn_status="DOWN"
printf "  coturn    :3478 tcp=%s udp=%s  %s\n" "$turn_tcp" "$turn_udp" "$turn_status"

# ── 8. Summary ──
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  SignChat HTTPS dev server ready"
echo ""
echo "  Local:      https://localhost:3000/match"
[ "$LAN_IP" != "localhost" ] && \
echo "  LAN:        https://${LAN_IP}:3000/match"
[ -n "$TS_IP" ] && \
echo "  Tailscale:  https://${TS_IP}:3000/match"
echo ""
echo "  WSS:        wss://${PRIMARY_IP}:8001/ws/match/"
echo "  TURN:       turn:${PRIMARY_IP}:3478"
echo "════════════════════════════════════════════════════════════"
echo ""

if [ "$turn_status" = "DOWN" ]; then
  echo "  [!] coturn not running. Start with:"
  echo "      export TURN_EXTERNAL_IP=$PRIMARY_IP"
  echo "      docker compose up -d turn"
  echo ""
fi

# Keep running
wait "$NEXT_PID"
