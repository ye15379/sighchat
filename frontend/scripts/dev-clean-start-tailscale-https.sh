#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  SignChat — Tailscale HTTPS one-click start
#  Usage:  ./frontend/scripts/dev-clean-start-tailscale-https.sh
#
#  Single entry point for cross-network validation (Mac + iPhone cellular).
#  Does everything:
#    1. Detect Tailscale IPv4 (hard-fail if missing)
#    2. ulimit guard
#    3. Kill stale :3000 listeners
#    4. Generate / regenerate mkcert cert (SAN covers TS IP)
#    5. Start backend_tls + turn via docker compose
#    6. Write frontend/.env.local with ICE servers
#    7. Start Next.js HTTPS on 0.0.0.0:3000
#    8. Probe all three layers (frontend / backend / turn)
#    9. Print summary with access URLs
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ──
RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[0;33m'; CYN='\033[0;36m'; NC='\033[0m'
ok()   { printf "  ${GRN}✓${NC} %s\n" "$1"; }
warn() { printf "  ${YEL}!${NC} %s\n" "$1"; }
fail() { printf "  ${RED}✗${NC} %s\n" "$1"; }
hdr()  { printf "\n${CYN}── %s ──${NC}\n" "$1"; }

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$(cd "$FRONTEND_DIR/.." && pwd)"
cd "$FRONTEND_DIR"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SignChat — Tailscale HTTPS one-click start              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo "  project:  $PROJECT_DIR"
echo "  frontend: $FRONTEND_DIR"

# ═══════════════════════════════════════════════════════════════
# 1. Tailscale IP (hard requirement)
# ═══════════════════════════════════════════════════════════════
hdr "1. Tailscale IP"

TS_IP="${TAILSCALE_IP:-}"

if [ -z "$TS_IP" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    fail "tailscale CLI not found and TAILSCALE_IP not set"
    echo ""
    echo "  Install Tailscale:"
    echo "    macOS:   brew install tailscale"
    echo "    or:      https://tailscale.com/download/"
    echo ""
    echo "  Or set manually:  export TAILSCALE_IP=100.x.y.z"
    exit 1
  fi

  TS_IP="$(tailscale ip -4 2>/dev/null || true)"

  if [ -z "$TS_IP" ]; then
    fail "tailscale ip -4 returned empty — not logged in?"
    echo "  Run:  tailscale up"
    echo "  Or:   export TAILSCALE_IP=100.x.y.z"
    exit 1
  fi
fi

ok "Tailscale IPv4: $TS_IP"

# Also grab LAN IP for cert SAN (nice-to-have, not required)
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

# ═══════════════════════════════════════════════════════════════
# 2. ulimit guard
# ═══════════════════════════════════════════════════════════════
hdr "2. ulimit"

cur_fd="$(ulimit -n 2>/dev/null || echo 256)"
if [ "$cur_fd" -lt 10240 ]; then
  ulimit -n 10240 2>/dev/null || true
  ok "ulimit -n: $cur_fd → $(ulimit -n)"
else
  ok "ulimit -n already $cur_fd (>= 10240)"
fi

# ═══════════════════════════════════════════════════════════════
# 3. Kill stale :3000 listeners
# ═══════════════════════════════════════════════════════════════
hdr "3. Port cleanup"

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    echo "  killing pid $pid on :$port"
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 0.5
}

stale_3000="$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$stale_3000" ]; then
  kill_port 3000
  ok "cleared :3000"
else
  ok ":3000 free"
fi
kill_port 3001
kill_port 3002

# ═══════════════════════════════════════════════════════════════
# 4. mkcert certificate
# ═══════════════════════════════════════════════════════════════
hdr "4. TLS certificate"

CERT_DIR="$HOME/certs"
CERT_FILE="$CERT_DIR/dev.pem"
KEY_FILE="$CERT_DIR/dev-key.pem"

# Build SAN list
SAN_LIST="localhost 127.0.0.1 ::1 $TS_IP"
[ -n "$LAN_IP" ] && [ "$LAN_IP" != "$TS_IP" ] && SAN_LIST="$SAN_LIST $LAN_IP"

needs_gen=0
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  needs_gen=1
  echo "  cert not found — will generate"
elif ! openssl x509 -in "$CERT_FILE" -noout -text 2>/dev/null | grep -q "$TS_IP"; then
  needs_gen=1
  echo "  existing cert does not cover $TS_IP — regenerating"
else
  ok "cert exists and covers $TS_IP"
fi

if [ "$needs_gen" -eq 1 ]; then
  if ! command -v mkcert >/dev/null 2>&1; then
    fail "mkcert not found. Install:  brew install mkcert && mkcert -install"
    exit 1
  fi
  mkdir -p "$CERT_DIR"
  mkcert -install 2>/dev/null || true
  echo "  SANs: $SAN_LIST"
  # shellcheck disable=SC2086
  mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" $SAN_LIST
  ok "cert generated: $CERT_FILE"
fi

# ═══════════════════════════════════════════════════════════════
# 5. Docker: backend_tls + turn
# ═══════════════════════════════════════════════════════════════
hdr "5. Docker services (backend_tls + turn)"

export LAN_IP="$TS_IP"
export TURN_EXTERNAL_IP="$TS_IP"

cd "$PROJECT_DIR"

# --- backend_tls ---
echo "  starting backend_tls (LAN_IP=$TS_IP) ..."
docker compose up -d --build backend_tls 2>&1 | while IFS= read -r line; do echo "    $line"; done

# Wait for backend_tls health (up to 20s)
be_ready=0
for i in $(seq 1 20); do
  be_code="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://localhost:8001/health/" 2>/dev/null || echo "000")"
  if [ "$be_code" = "200" ]; then be_ready=1; break; fi
  sleep 1
done
if [ "$be_ready" -eq 1 ]; then
  ok "backend_tls healthy (${i}s)"
else
  warn "backend_tls not yet healthy (code=$be_code) — may still be starting"
  echo "    check: docker compose logs backend_tls --tail=30"
fi

# --- turn ---
# Check if turn service exists in compose file
if docker compose config --services 2>/dev/null | grep -q '^turn$'; then
  echo "  starting turn (TURN_EXTERNAL_IP=$TS_IP) ..."
  docker compose up -d --build turn 2>&1 | while IFS= read -r line; do echo "    $line"; done
  sleep 2
  # Quick liveness check
  turn_up=0
  lsof -nP -iTCP:3478 -sTCP:LISTEN 2>/dev/null | grep -q LISTEN && turn_up=1
  lsof -nP -iUDP:3478 2>/dev/null | grep -q UDP && turn_up=1
  if [ "$turn_up" -eq 1 ]; then
    ok "coturn listening on :3478"
  else
    warn "coturn port 3478 not detected — check: docker compose logs turn --tail=20"
  fi
else
  warn "no 'turn' service in docker-compose.yml — TURN relay won't be available"
fi

# ═══════════════════════════════════════════════════════════════
# 6. Write frontend/.env.local
# ═══════════════════════════════════════════════════════════════
hdr "6. frontend/.env.local"

cd "$FRONTEND_DIR"

ENV_LOCAL="$FRONTEND_DIR/.env.local"
ICE_JSON="[{\"urls\":[\"stun:stun.l.google.com:19302\"]},{\"urls\":[\"turn:${TS_IP}:3478?transport=udp\",\"turn:${TS_IP}:3478?transport=tcp\"],\"username\":\"signchat\",\"credential\":\"signchat\"}]"

cat > "$ENV_LOCAL" << EOF
# Auto-generated by dev-clean-start-tailscale-https.sh ($(date +%Y-%m-%dT%H:%M:%S))
# Tailscale IP: $TS_IP
# Dev credentials: signchat / signchat (match docker-compose.yml TURN_USER/TURN_PASS)
NEXT_PUBLIC_ICE_SERVERS='${ICE_JSON}'
EOF

ok "wrote $ENV_LOCAL"
echo "    TURN → turn:${TS_IP}:3478"

# ═══════════════════════════════════════════════════════════════
# 7. Start Next.js HTTPS
# ═══════════════════════════════════════════════════════════════
hdr "7. Next.js HTTPS"

echo "  cleaning .next cache ..."
rm -rf .next

echo "  starting: next dev --hostname 0.0.0.0 --port 3000 (HTTPS)"
npm run dev -- \
  --hostname 0.0.0.0 \
  --port 3000 \
  --experimental-https \
  --experimental-https-key "$KEY_FILE" \
  --experimental-https-cert "$CERT_FILE" &
NEXT_PID=$!

cleanup() {
  echo ""
  echo "[tailscale-https] stopping next (pid $NEXT_PID) ..."
  kill "$NEXT_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# ═══════════════════════════════════════════════════════════════
# 8. Probe all three layers
# ═══════════════════════════════════════════════════════════════
hdr "8. Reachability probes (waiting up to 30s for frontend)"

# --- Frontend probe (with retry) ---
fe_ok=0
for i in $(seq 1 30); do
  code="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://localhost:3000/match" 2>/dev/null || echo "000")"
  if [ "$code" = "200" ] || [ "$code" = "304" ]; then
    fe_ok=1
    break
  fi
  sleep 1
done

echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  Layer              URL / Check               Status    │"
echo "  ├─────────────────────────────────────────────────────────┤"

# Frontend — localhost
if [ "$fe_ok" -eq 1 ]; then
  printf "  │  frontend (local)   https://localhost:3000       ${GRN}OK${NC} (%ss) │\n" "$i"
else
  printf "  │  frontend (local)   https://localhost:3000       ${RED}FAIL${NC}      │\n"
fi

# Frontend — Tailscale IP
ts_fe="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://${TS_IP}:3000/match" 2>/dev/null || echo "000")"
if [ "$ts_fe" = "200" ] || [ "$ts_fe" = "304" ]; then
  printf "  │  frontend (TS)      https://%-16s:3000  ${GRN}OK${NC}        │\n" "$TS_IP"
else
  printf "  │  frontend (TS)      https://%-16s:3000  ${RED}FAIL(%s)${NC}  │\n" "$TS_IP" "$ts_fe"
fi

# Backend — Tailscale IP
ts_be="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://${TS_IP}:8001/health/" 2>/dev/null || echo "000")"
if [ "$ts_be" = "200" ]; then
  printf "  │  backend  (TS)      https://%-16s:8001  ${GRN}OK${NC}        │\n" "$TS_IP"
else
  printf "  │  backend  (TS)      https://%-16s:8001  ${YEL}%s${NC}     │\n" "$TS_IP" "$ts_be"
fi

# TURN
turn_tcp=0; turn_udp=0
lsof -nP -iTCP:3478 -sTCP:LISTEN 2>/dev/null | grep -q LISTEN && turn_tcp=1
lsof -nP -iUDP:3478 2>/dev/null | grep -q UDP && turn_udp=1
if [ "$turn_tcp" -eq 1 ] || [ "$turn_udp" -eq 1 ]; then
  printf "  │  coturn             :3478 tcp=%s udp=%s          ${GRN}OK${NC}        │\n" "$turn_tcp" "$turn_udp"
else
  printf "  │  coturn             :3478 tcp=%s udp=%s          ${RED}DOWN${NC}      │\n" "$turn_tcp" "$turn_udp"
fi

echo "  └─────────────────────────────────────────────────────────┘"

# ═══════════════════════════════════════════════════════════════
# 9. Summary
# ═══════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  SignChat — Tailscale HTTPS ready"
echo ""
echo "  Mac (local):   https://localhost:3000/match"
echo "  iPhone (VPN):  https://${TS_IP}:3000/match"
echo ""
echo "  Backend:       https://${TS_IP}:8001/health/"
echo "  WSS:           wss://${TS_IP}:8001/ws/match/"
echo "  TURN:          turn:${TS_IP}:3478 (signchat/signchat)"
echo ""
echo "  .env.local:    $ENV_LOCAL"
echo "  cert:          $CERT_FILE"
echo "════════════════════════════════════════════════════════════"
echo ""

# Actionable warnings
if [ "$fe_ok" -ne 1 ]; then
  warn "frontend not responding — check Next.js logs above"
fi
if [ "$ts_be" != "200" ]; then
  warn "backend_tls not healthy — run: docker compose logs backend_tls --tail=30"
fi
if [ "$turn_tcp" -eq 0 ] && [ "$turn_udp" -eq 0 ]; then
  warn "coturn not listening — run: docker compose logs turn --tail=20"
fi

echo "  iPhone tips:"
echo "    1. iPhone must have Tailscale VPN connected (cellular OK)"
echo "    2. First visit: Safari will warn about self-signed cert → 'Advanced' → 'Proceed'"
echo "    3. For full trust: AirDrop ~/Library/Application Support/mkcert/rootCA.pem"
echo "       to iPhone → Settings → General → VPN & Device Management → install"
echo "       → Settings → General → About → Certificate Trust Settings → enable"
echo ""
echo "  Validation checklist:"
echo "    [ ] https://localhost:3000/match loads on Mac"
echo "    [ ] https://${TS_IP}:3000/match loads on iPhone (Tailscale VPN on)"
echo "    [ ] Both click 'Find Random' → matched to same room_id"
echo "    [ ] Debug panel: iceConnectionState = connected"
echo "    [ ] Debug panel: selectedCandidatePair contains 'relay' (cross-network)"
echo "    [ ] docker compose logs -f turn shows 'traffic between' lines"
echo ""

# Keep running in foreground
wait "$NEXT_PID"
