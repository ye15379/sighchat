#!/usr/bin/env bash
# SignChat — Tailscale VPN one-click validation
# Usage: ./scripts/vpn-validate.sh
#
# Checks: Tailscale installed & connected, all 3 services reachable via TS IP,
# backend and coturn running, frontend env correct.

set -euo pipefail
RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[0;33m'; NC='\033[0m'
ok() { printf "${GRN}✓${NC} %s\n" "$1"; }
warn() { printf "${YEL}!${NC} %s\n" "$1"; }
fail() { printf "${RED}✗${NC} %s\n" "$1"; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
echo "SignChat VPN Validate — $(date)"
echo "project: $ROOT_DIR"
echo ""

PASS=0; FAIL=0; WARN=0

# ── 1. Tailscale ──
echo "── 1. Tailscale ───────────────────────────"
if ! command -v tailscale >/dev/null 2>&1; then
  fail "tailscale CLI not found"; ((FAIL++))
  echo "  Install: https://tailscale.com/download/"
  exit 1
fi

TS_STATUS="$(tailscale status --json 2>/dev/null | grep -o '"BackendState":"[^"]*"' | head -1 || echo "")"
if echo "$TS_STATUS" | grep -q "Running"; then
  ok "Tailscale backend: Running"
  ((PASS++))
else
  fail "Tailscale not running (status: $TS_STATUS)"
  ((FAIL++))
  echo "  Run: tailscale up"
fi

TS_IP="$(tailscale ip -4 2>/dev/null || true)"
if [ -n "$TS_IP" ]; then
  ok "Tailscale IPv4: $TS_IP"
  ((PASS++))
else
  fail "Could not get Tailscale IPv4"
  ((FAIL++))
  exit 1
fi

# ── 2. Certificate ──
echo ""
echo "── 2. TLS Certificate ─────────────────────"
CERT="$HOME/certs/dev.pem"
KEY="$HOME/certs/dev-key.pem"
if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  ok "cert exists: $CERT"
  ((PASS++))
  # Check SAN coverage
  if openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -q "$TS_IP"; then
    ok "cert covers $TS_IP"
    ((PASS++))
  else
    warn "cert does NOT cover $TS_IP — will regenerate"
    ((WARN++))
    if command -v mkcert >/dev/null 2>&1; then
      LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
      SAN="localhost 127.0.0.1 ::1 $TS_IP"
      [ -n "$LAN_IP" ] && SAN="$SAN $LAN_IP"
      echo "  mkcert SANs: $SAN"
      # shellcheck disable=SC2086
      mkcert -cert-file "$CERT" -key-file "$KEY" $SAN
      ok "cert regenerated"
    else
      fail "mkcert not found — cannot regenerate"
      ((FAIL++))
    fi
  fi
else
  warn "cert missing — dev-clean-start-https.sh will generate it"
  ((WARN++))
fi

# ── 3. Docker services ──
echo ""
echo "── 3. Docker Services ─────────────────────"

check_container() {
  local name="$1"
  if docker compose ps --status running 2>/dev/null | grep -q "$name"; then
    ok "$name running"
    ((PASS++))
    return 0
  else
    fail "$name not running"
    ((FAIL++))
    return 1
  fi
}

check_container "backend_tls" || echo "  Fix: export LAN_IP=$TS_IP && docker compose up -d backend_tls"
check_container "turn" || echo "  Fix: export TURN_EXTERNAL_IP=$TS_IP && docker compose up -d turn"

# ── 4. Port reachability ──
echo ""
echo "── 4. Service Reachability ────────────────"

# Frontend (may or may not be running)
fe_code="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://${TS_IP}:3000/" 2>/dev/null || echo "000")"
if [ "$fe_code" = "200" ] || [ "$fe_code" = "304" ]; then
  ok "frontend https://$TS_IP:3000 → $fe_code"
  ((PASS++))
elif [ "$fe_code" = "000" ]; then
  warn "frontend not reachable on $TS_IP:3000 (not started yet?)"
  ((WARN++))
else
  warn "frontend $TS_IP:3000 → $fe_code (may be starting)"
  ((WARN++))
fi

# Backend TLS
be_code="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://${TS_IP}:8001/health/" 2>/dev/null || echo "000")"
if [ "$be_code" = "200" ]; then
  ok "backend https://$TS_IP:8001/health/ → $be_code"
  ((PASS++))
elif [ "$be_code" = "000" ]; then
  fail "backend not reachable on $TS_IP:8001"
  ((FAIL++))
else
  warn "backend $TS_IP:8001 → $be_code"
  ((WARN++))
fi

# TURN
turn_tcp=0; turn_udp=0
lsof -nP -iTCP:3478 -sTCP:LISTEN 2>/dev/null | grep -q LISTEN && turn_tcp=1
lsof -nP -iUDP:3478 2>/dev/null | grep -q UDP && turn_udp=1
if [ "$turn_tcp" -eq 1 ] || [ "$turn_udp" -eq 1 ]; then
  ok "coturn listening (tcp=$turn_tcp udp=$turn_udp)"
  ((PASS++))
else
  fail "coturn not listening on :3478"
  ((FAIL++))
fi

# ── 5. Frontend env ──
echo ""
echo "── 5. Frontend .env.local ─────────────────"
ENV_FILE="$ROOT_DIR/frontend/.env.local"
if [ -f "$ENV_FILE" ]; then
  if grep -q "NEXT_PUBLIC_ICE_SERVERS" "$ENV_FILE"; then
    ok ".env.local has NEXT_PUBLIC_ICE_SERVERS"
    ((PASS++))
    if grep -q "$TS_IP" "$ENV_FILE"; then
      ok "ICE_SERVERS contains $TS_IP"
      ((PASS++))
    else
      warn "ICE_SERVERS does not reference $TS_IP — update it"
      ((WARN++))
      echo "  Suggested:"
      echo "  NEXT_PUBLIC_ICE_SERVERS='[{\"urls\":[\"stun:stun.l.google.com:19302\"]},{\"urls\":[\"turn:${TS_IP}:3478?transport=udp\",\"turn:${TS_IP}:3478?transport=tcp\"],\"username\":\"signchat\",\"credential\":\"signchat\"}]'"
    fi
  else
    warn ".env.local exists but no ICE_SERVERS"
    ((WARN++))
  fi
else
  warn ".env.local not found — will use STUN-only fallback"
  ((WARN++))
fi

# ── Summary ──
echo ""
echo "════════════════════════════════════════════"
printf "  PASS=%d  WARN=%d  FAIL=%d\n" "$PASS" "$WARN" "$FAIL"
echo "════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Fix the failures above, then re-run: ./scripts/vpn-validate.sh"
  exit 1
fi

echo ""
echo "All critical checks passed. To start:"
echo ""
echo "  # Terminal 1 — backend + turn (if not running)"
echo "  export TURN_EXTERNAL_IP=$TS_IP LAN_IP=$TS_IP"
echo "  docker compose up -d turn backend_tls"
echo ""
echo "  # Terminal 2 — frontend"
echo "  ./frontend/scripts/dev-clean-start-https.sh"
echo ""
echo "  Mac:    https://localhost:3000/match"
echo "  iPhone: https://$TS_IP:3000/match  (Tailscale VPN on)"
